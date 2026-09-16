import type { CustomStatus, GameActivity, GatewayClientMessage, GatewayServerMessage, PresenceStatus } from '@gusvoice/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import { superAdminId, tokenGenValid, verifyToken } from './auth.js';
import { clientIp, rateHit } from './authGuard.js';
import { db } from './db/index.js';
import { dmChannels, serverMembers } from './db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { env } from './env.js';
import {
  mayObserveUser,
  membershipDiff,
  parseEnvelope,
  shouldDeliver,
  typingRoute,
  visibleOnline,
} from './gatewayRules.js';
import { getChannelAudience, getMemberContext } from './permissions.js';
import { publishToChannel } from './realtime.js';

interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: 'message' | 'close' | 'error', cb: (...args: any[]) => void): void;
}

interface Conn {
  socket: WsLike;
  userId: string | null;
  servers: Set<string>;
  /** Token generation this socket identified with — re-validated on pings (session revocation). */
  tokenGen?: number;
}

// serverId -> connections currently subscribed to that server.
const byServer = new Map<string, Set<Conn>>();

// userId -> that user's own connections (for direct-message fan-out).
const byUser = new Map<string, Set<Conn>>();

// General online presence: userId -> active gateway connection count (online while > 0).
const online = new Map<string, number>();
const allConns = new Set<Conn>();

// --- Unauth-DoS guards (#2, P0-2). Cheap in-process caps so an unauthenticated client can neither
// pile up sockets nor flood frames before it identifies. Keyed by the real client IP (clientIp reads
// X-Forwarded-For behind NPM, falls back to the socket peer).
const MAX_CONNS_PER_IP = 30; // concurrent gateway sockets per client IP (tabs/devices — generous)
const MAX_TOTAL_CONNS = 10_000; // global backstop across all IPs
const AUTH_DEADLINE_MS = 10_000; // identify within this window or the socket is closed
const MAX_PREAUTH_FRAMES = 10; // frames tolerated before identify (a normal client sends ~1)
const MAX_FRAME_BYTES = 16 * 1024; // any single frame larger than this is abuse (identify JWT is small)
const connsByIp = new Map<string, number>();

/** Whether the user currently has ≥1 live gateway socket — used to gate offline push (push.ts). */
export function isUserOnline(userId: string): boolean {
  return (online.get(userId) ?? 0) > 0;
}

function addUserConn(conn: Conn, userId: string): void {
  let set = byUser.get(userId);
  if (!set) byUser.set(userId, (set = new Set()));
  set.add(conn);
}

function removeUserConn(conn: Conn): void {
  if (!conn.userId) return;
  const set = byUser.get(conn.userId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) byUser.delete(conn.userId);
}

/**
 * С кем у человека есть общий сервер или ЛС (#136) — кому можно знать о его онлайне и статусе.
 *
 * ⚠️ В кэше лежит ПРОМИС, а не готовый набор: два события подряд об одном человеке (статус, затем
 * игра) дожидаются одного и того же запроса и уходят в том порядке, в каком возникли. С готовым
 * набором второе могло бы проскочить мимо первого, пока тот ждёт базу, и клиент остался бы со
 * старым статусом.
 * ⚠️ Срок короткий, а состав серверов шлюз отслеживает сам (`onServerInvalidate`): кэш нужен не для
 * точности, а чтобы частые события не били в базу. ЛС в сроке догоняются сами.
 * ⚠️ Ошибка базы — пустой набор (никто лишний не получит) и запись из кэша удаляется, чтобы следующий
 * вызов спросил заново, а не держал человека «невидимым» весь срок.
 * 🔴 **Ещё не ответивший запрос не протухает** (нашёл Codex 15.09): срок считается от ОТВЕТА, а не от
 * начала. Раньше событие A запускало зависший запрос, через 60 с событие B считало запись старой и
 * запускало второй; второй отвечал первым — и получатель видел B раньше A. Сам запрос ограничен
 * `PEERS_LOAD_TIMEOUT_MS`, поэтому ожидание не бесконечно: по таймауту — пустой набор и новая попытка.
 */
const PEERS_TTL_MS = 60_000;
const PEERS_LOAD_TIMEOUT_MS = 10_000;
const peersCache = new Map<string, { at: number; settled: boolean; p: Promise<Set<string>> }>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('peers load timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function loadPeers(userId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT b.user_id AS id FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id
      WHERE a.user_id = ${userId}
    UNION SELECT user_b AS id FROM dm_channels WHERE user_a = ${userId}
    UNION SELECT user_a AS id FROM dm_channels WHERE user_b = ${userId}
  `);
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

function peersOf(userId: string): Promise<Set<string>> {
  const hit = peersCache.get(userId);
  if (hit && (!hit.settled || Date.now() - hit.at < PEERS_TTL_MS)) return hit.p;
  if (peersCache.size > 5000) {
    // Грубый потолок. Выкидываем только ответившие: ожидающий запрос держит порядок событий (см. выше).
    for (const [k, e] of peersCache) if (e.settled) peersCache.delete(k);
  }
  const entry = { at: Date.now(), settled: false, p: Promise.resolve(new Set<string>()) };
  entry.p = withTimeout(loadPeers(userId), PEERS_LOAD_TIMEOUT_MS).then(
    (peers) => {
      entry.settled = true;
      entry.at = Date.now();
      return peers;
    },
    () => {
      entry.settled = true;
      if (peersCache.get(userId) === entry) peersCache.delete(userId);
      return new Set<string>();
    },
  );
  peersCache.set(userId, entry);
  return entry.p;
}

/**
 * Разослать событие О ЧЕЛОВЕКЕ только тем, кому о нём можно знать (#136). Замена прежнего
 * `broadcastAll`, который слал всем сокетам, в том числе не представившимся.
 *
 * ⚠️ Обходим только представившихся (`byUser`) — безымянных соединений там нет по построению, а
 * `mayObserveUser` отбивает их ещё раз.
 */
function deliverAboutUser(subjectId: string, msg: GatewayServerMessage): void {
  void peersOf(subjectId).then((peers) => {
    const data = JSON.stringify(msg);
    const su = superAdminId();
    for (const [uid, set] of byUser) {
      if (!mayObserveUser(uid, subjectId, peers, su)) continue;
      for (const c of set) c.socket.send(data);
    }
  });
}

/** Снимок «кто онлайн» для одного соединения — только те, о ком ему можно знать (#136). */
async function sendOnlineSnapshot(conn: Conn): Promise<void> {
  const uid = conn.userId;
  if (!uid) return;
  const peers = await peersOf(uid);
  if (conn.userId !== uid) return;
  send(conn.socket, { t: 'online.snapshot', users: visibleOnline(online.keys(), uid, peers, superAdminId()) });
}

/**
 * Последний известный шлюзу состав сервера — чтобы на `server.invalidate` понять, менялся ли он (#136).
 * Сам `server.invalidate` летит и на правку канала, и на роль; пересылать снимки всему серверу
 * имеет смысл, только когда кто-то вступил или ушёл.
 */
const serverMembersSeen = new Map<string, Set<string>>();

async function onServerInvalidate(serverId: string): Promise<void> {
  const rows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
  const next = new Set(rows.map((r) => r.userId));
  const { changed, affected } = membershipDiff(serverMembersSeen.get(serverId), next);
  if (next.size === 0) serverMembersSeen.delete(serverId);
  else serverMembersSeen.set(serverId, next);
  if (!changed) return;
  for (const uid of affected) peersCache.delete(uid);
  for (const uid of affected) for (const c of byUser.get(uid) ?? []) void sendOnlineSnapshot(c);
}

/**
 * Разослать смену статуса человека (P2). Клиенты обновляют цветную точку и строку статуса;
 * чужой «невидимый» маскируют в «не в сети» сами. Получатели — см. `deliverAboutUser` (#136).
 */
export function broadcastUserStatus(userId: string, status: PresenceStatus, customStatus: CustomStatus | null): void {
  deliverAboutUser(userId, { t: 'user.status', userId, status, customStatus });
}

/**
 * Разослать смену профиля (ник / аватар), чтобы список участников, авторы в чате и список ЛС
 * обновились без перезахода этого человека. Получатели — см. `deliverAboutUser` (#136).
 *
 * ⚠️ Плитки голоса статичный аватар берут из метаданных участника LiveKit, и те клиент обновляет
 * сам при смене — но АНИМИРОВАННЫЙ туда не кладётся вовсе, его все поверхности читают из ростера.
 * Значит ростер обязан ехать отсюда: без этого поля смена анимации не долетала ни до кого (#129).
 */
export function broadcastUserProfile(
  userId: string,
  displayName: string,
  avatarUrl: string | null,
  animatedAvatarUrl: string | null,
): void {
  deliverAboutUser(userId, { t: 'user.update', userId, displayName, avatarUrl, animatedAvatarUrl });
}

/**
 * Разослать смену игровой активности (#40). `activity: null` — перестал играть. Сама активность
 * живёт в эфемерном хранилище (activity.ts), здесь только дельта. Получатели — `deliverAboutUser` (#136).
 */
export function broadcastUserActivity(userId: string, activity: GameActivity | null): void {
  deliverAboutUser(userId, { t: 'user.activity', userId, activity });
}

function subscribe(conn: Conn, serverId: string): void {
  conn.servers.add(serverId);
  let set = byServer.get(serverId);
  if (!set) byServer.set(serverId, (set = new Set()));
  set.add(conn);
}

function unsubscribe(conn: Conn, serverId: string): void {
  conn.servers.delete(serverId);
  byServer.get(serverId)?.delete(conn);
}

function send(socket: WsLike, msg: GatewayServerMessage): void {
  socket.send(JSON.stringify(msg));
}

/**
 * Собеседник по диалогу — или `null`, если отправитель в нём не состоит (#88).
 *
 * Состав диалога НЕИЗМЕНЯЕМ: в `dm_channels` за всю жизнь правится только `lastMessageAt`. Поэтому
 * кэш вечный — один запрос на диалог за жизнь процесса, инвалидировать нечего.
 *
 * ⚠️ Получатель ВЫВОДИТСЯ из строки диалога, а не берётся из `recipientId` клиента. Проверять
 * присланный id было бы полумерой; правильный ответ — перестать ему верить.
 */
const dmPeers = new Map<string, [string, string]>();

async function dmPeerOf(dmId: string, senderId: string): Promise<string | null> {
  let pair = dmPeers.get(dmId);
  if (!pair) {
    const [row] = await db
      .select({ a: dmChannels.userA, b: dmChannels.userB })
      .from(dmChannels)
      .where(eq(dmChannels.id, dmId))
      .limit(1);
    if (!row) return null; // отрицательные ответы НЕ кэшируем — иначе память растёт от мусорных id
    if (dmPeers.size > 5000) dmPeers.clear(); // грубый потолок
    dmPeers.set(dmId, (pair = [row.a, row.b]));
  }
  if (pair[0] === senderId) return pair[1];
  if (pair[1] === senderId) return pair[0];
  return null;
}

/**
 * Снять подписку на сервер у тех локальных соединений, чей владелец больше не участник (#91).
 *
 * Подписка выдавалась один раз и не перепроверялась, поэтому кикнутый продолжал получать поток
 * сервера, пока держал сокет. Полагаться на то, что клиент увидит `server.invalidate` и отпишется
 * сам, нельзя: это не граница безопасности, а просьба.
 *
 * Проверяем ПО РАЗУ НА ПОЛЬЗОВАТЕЛЯ, а не на сокет: у одного человека их обычно несколько.
 */
async function dropRevokedSubscribers(serverId: string): Promise<void> {
  const set = byServer.get(serverId);
  if (!set || set.size === 0) return;
  const userIds = new Set<string>();
  for (const c of set) if (c.userId) userIds.add(c.userId);
  await Promise.all(
    [...userIds].map(async (uid) => {
      const ctx = await getMemberContext(serverId, uid).catch(() => null);
      if (ctx) return;
      for (const c of byServer.get(serverId) ?? []) if (c.userId === uid) unsubscribe(c, serverId);
    }),
  );
}

export function registerGateway(app: FastifyInstance): void {
  // Single shared subscriber fans redis events out to local connections — both
  // server-scoped events (gw:server:<id>) and per-user DM events (gw:user:<id>).
  const sub = new Redis(env.redisUrl);
  sub.psubscribe('gw:server:*', 'gw:user:*');
  sub.on('pmessage', (_pattern, channel, message) => {
    const env = parseEnvelope(message);
    if (!env) return; // fail-closed: неразобранное не рассылаем (см. gatewayRules)
    const payload = JSON.stringify(env.m); // наружу — только событие, без списка получателей
    if (channel.startsWith('gw:server:')) {
      const serverId = channel.slice('gw:server:'.length);
      const set = byServer.get(serverId);
      if (set) for (const conn of set) if (shouldDeliver(env, conn.userId)) conn.socket.send(payload);
      // Состав/права могли измениться — снимаем подписки у тех, кто больше не участник (#91).
      if (env.m.t === 'server.invalidate') {
        void dropRevokedSubscribers(serverId);
        // Кто-то вступил или ушёл — пересобрать, кто чей онлайн видит (#136).
        void onServerInvalidate(serverId).catch(() => {});
      }
    } else if (channel.startsWith('gw:user:')) {
      const set = byUser.get(channel.slice('gw:user:'.length));
      if (set) for (const conn of set) conn.socket.send(payload);
    }
  });

  app.get('/gateway', { websocket: true }, (socket: WsLike, req: FastifyRequest) => {
    const ip = clientIp(req);
    // Per-IP + global connection caps: a client can't open thousands of sockets to exhaust us.
    if (allConns.size >= MAX_TOTAL_CONNS || (connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      return;
    }
    const conn: Conn = { socket, userId: null, servers: new Set() };
    allConns.add(conn);
    connsByIp.set(ip, (connsByIp.get(ip) ?? 0) + 1);

    // Auth-handshake deadline: an unauthenticated socket that never identifies is closed, so idle
    // unauth sockets can't accumulate. Cleared the moment we identify (below).
    let preAuthFrames = 0;
    let authTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      authTimer = null;
      if (!conn.userId) socket.close();
    }, AUTH_DEADLINE_MS);

    /**
     * Идущее прямо сейчас `identify`. Всё остальное на этом соединении его ДОЖИДАЕТСЯ — см. разбор
     * ниже по месту ожидания (#126).
     */
    let identifying: Promise<void> | null = null;

    /** Разбор `identify` одним куском: его дожидаются остальные сообщения этого соединения (#126). */
    const handleIdentify = async (token: string): Promise<void> => {
        try {
          const claims = verifyToken(token);
          // Session revocation: a bumped generation (logout-everywhere / password change)
          // must not open a live gateway socket.
          if (claims.typ === '2fa' || !(await tokenGenValid(claims.sub, claims.gen))) {
            send(socket, { t: 'error', message: 'invalid token' });
            socket.close();
            return;
          }
          if (!conn.userId) {
            if (authTimer) {
              clearTimeout(authTimer);
              authTimer = null;
            }
            conn.userId = claims.sub;
            conn.tokenGen = claims.gen ?? 0;
            addUserConn(conn, claims.sub);
            const was = online.get(claims.sub) ?? 0;
            online.set(claims.sub, was + 1);
            if (was === 0) deliverAboutUser(claims.sub, { t: 'online.update', userId: claims.sub, online: true });
          }
          send(socket, { t: 'ready', userId: conn.userId });
          // Только те, с кем есть общий сервер или ЛС, — а не весь инстанс (#136).
          await sendOnlineSnapshot(conn);
        } catch {
          send(socket, { t: 'error', message: 'invalid token' });
          socket.close();
        }
    };

    socket.on('message', async (raw: Buffer) => {
      // Oversized frames are abuse regardless of auth state (identify carries only a small JWT).
      if (raw.length > MAX_FRAME_BYTES) return socket.close();
      // Pre-auth frame flood: a socket spamming frames before it identifies is closed.
      if (!conn.userId && ++preAuthFrames > MAX_PREAUTH_FRAMES) return socket.close();

      let msg: GatewayClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { t: 'error', message: 'bad json' });
      }

      if (msg.t === 'identify') {
        identifying = handleIdentify(msg.token);
        await identifying;
        identifying = null;
        return;
      }

      /**
       * 🔴 **Ждём `identify`, а не отклоняем пришедшее вплотную за ним** (#126).
       *
       * Обработчик сообщений асинхронный, а `identify` внутри делает `await` на проверку поколения
       * токена. Пока он ждёт, следующий кадр из того же TCP-сегмента успевал выполниться — и
       * заставал соединение ещё безымянным. Клиент шлёт `identify` и `subscribe` подряд, поэтому на
       * КАЖДОМ переподключении подписка отклонялась «identify first», клиент отказ не слушал, и
       * человек оставался без всех серверных событий до перезапуска приложения. Симптом, который
       * это давало у людей: «пропал звук типа и оверлей», причём баланс обновляется (личный канал)
       * и список в голосе живой (свой сокет) — то есть связь выглядит исправной.
       *
       * Порядок «сначала представься» — это правило протокола, а не гонка, и здесь оно теперь
       * выражено ожиданием. Клиент со своей стороны ждёт `ready` — держим обе стороны.
       */
      if (identifying) await identifying;
      if (!conn.userId) {
        return send(socket, {
          t: 'error',
          message: 'identify first',
          serverId: msg.t === 'subscribe' ? msg.serverId : undefined,
        });
      }

      switch (msg.t) {
        case 'ping': {
          // Revocation for ALREADY-OPEN sockets: the 30s client keepalive re-validates the
          // generation (10s-cached in auth.ts → ~free); a revoked session dies within ~40s
          // instead of living until the socket happens to drop.
          const uid = conn.userId;
          void tokenGenValid(uid, conn.tokenGen).then((ok) => {
            if (!ok && conn.userId === uid) socket.close();
          });
          return send(socket, { t: 'pong' });
        }
        case 'subscribe': {
          const ctx = await getMemberContext(msg.serverId, conn.userId);
          // ⚠️ `serverId` обязателен: без него клиент не может пометить сервер для повторной
          // попытки, а молча забытая подписка = человек без всех серверных событий (#126).
          if (!ctx) return send(socket, { t: 'error', message: 'not a member', serverId: msg.serverId });
          subscribe(conn, msg.serverId);
          return;
        }
        case 'unsubscribe':
          return unsubscribe(conn, msg.serverId);
        case 'typing': {
          // Ephemeral, cosmetic — но граница авторизации тут такая же, как у сообщений (#88).
          const uid = conn.userId;
          if (await rateHit(`typing:${uid}`, 20, 10)) return; // честный клиент шлёт ≤1 / 2.5с
          const peerId = msg.dmId ? await dmPeerOf(msg.dmId, uid) : null;
          const route = typingRoute(msg, { userId: uid, servers: conn.servers }, () => peerId);
          if (!route) return;
          if (route.kind === 'dm') {
            const set = byUser.get(route.peerId);
            if (set) for (const c of set) send(c.socket, { t: 'typing', dmId: route.dmId, userId: uid });
            return;
          }
          // Канал: аудитория считается по факту, и отправитель обязан в неё входить — иначе можно
          // было бы «печатать» в канал, который сам не видишь.
          const audience = await getChannelAudience(route.channelId);
          if (!audience || audience.serverId !== route.serverId || !audience.userIds.includes(uid)) return;
          await publishToChannel(
            route.serverId,
            route.channelId,
            { t: 'typing', channelId: route.channelId, userId: uid },
            audience.userIds.filter((id) => id !== uid), // себе «печатает…» не показываем
          );
          return;
        }
      }
    });

    let cleaned = false;
    const cleanup = () => {
      // ws fires 'error' THEN 'close' on a failed socket → cleanup must be idempotent, else the
      // per-IP counter (and the online count) double-decrement.
      if (cleaned) return;
      cleaned = true;
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      const n = (connsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsByIp.delete(ip);
      else connsByIp.set(ip, n);
      allConns.delete(conn);
      removeUserConn(conn);
      for (const serverId of conn.servers) byServer.get(serverId)?.delete(conn);
      conn.servers.clear();
      if (conn.userId) {
        const n = (online.get(conn.userId) ?? 1) - 1;
        if (n <= 0) {
          online.delete(conn.userId);
          deliverAboutUser(conn.userId, { t: 'online.update', userId: conn.userId, online: false });
        } else {
          online.set(conn.userId, n);
        }
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
