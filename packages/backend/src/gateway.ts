import type { CustomStatus, GameActivity, GatewayClientMessage, GatewayServerMessage, PresenceStatus } from '@gusvoice/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import { superAdminId, tokenGenValid, verifyToken } from './auth.js';
import { clientIp, rateHit } from './authGuard.js';
import { isBlockedBy, onBlockChange } from './blocks.js';
import { db } from './db/index.js';
import { loadPeers } from './db/peerQueries.js';
import { conversationMembers, conversations, serverMembers, users } from './db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { env } from './env.js';
import { capAllows, parseCaps, parseEnvelope, shouldDeliver, statusBroadcastPlan } from './gatewayRules.js';
import { relayTyping, type TypingDeps } from './gatewayTyping.js';
import { getChannelAudience, getMemberContext } from './permissions.js';
import { connActive } from './pushRules.js';
import { publishToChannel } from './realtime.js';
import { createSessionVisibility, HIDDEN_OFFLINE_MS } from './sessionVisibility.js';
import { createUserVisibilityHub } from './userVisibilityHub.js';

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
  /** Возможности клиента из `identify.caps` (ЛС шаг 0.5): по ним шлюз выбирает форму события для ЭТОГО соединения. */
  caps: ReadonlySet<string>;
}

// serverId -> connections currently subscribed to that server.
const byServer = new Map<string, Set<Conn>>();

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

/**
 * Вся память шлюза о людях — чьи это соединения, кто онлайн, кто о ком может знать, какой состав
 * серверов мы видели — живёт в хабе (`userVisibilityHub.ts`, #143). Там она проверяется тестом без
 * Redis, базы и сокетов; здесь остаются только запросы в базу и сам транспорт.
 */
const hub = createUserVisibilityHub<Conn>({
  loadPeers,
  now: () => Date.now(),
  superAdminId,
  send: (conn, data) => conn.socket.send(data),
});

/**
 * «В сети» на СЕРВЕРАХ: у человека есть хоть один живой сокет шлюза (как Discord; решение владельца 42, 08.10). Опрос Steam.
 * Для ЛС — `isUserDmPresent`.
 */
export function isUserOnline(userId: string): boolean {
  return hub.isOnline(userId);
}

/**
 * «В сети» в ЛС (08.10, #211, D4, решения 42–44): есть хоть одно соединение, где человек «здесь» — приложение видно и не
 * простаивает, или он в голосе / звонке (клиент сообщает кадром `visible`; клиент без кадра — здесь всегда, как раньше).
 * Отсюда «был(а)» (`lastSeen.ts`) и «Когда будет в сети» (`scheduled.ts`).
 */
export function isUserDmPresent(userId: string): boolean {
  // Э4 (#141): человек другого инстанса — по отметкам его дома (`setRemoteDmPresence`), сокетов у теневой строки здесь нет.
  if (remoteDmPresent.has(userId)) return true;
  // Исправления ревью 12.10, п. 8: его гостевые сокеты (гость на нашем сервере) «в сети» для ЛС не делают — только его дом.
  if (fedHooks?.isRemote?.(userId)) return false;
  return (presentCount.get(userId) ?? 0) > 0;
}

/** Сколько у человека соединений «здесь» (`sessionVisibility`: видимые, скрытые уходят через `HIDDEN_OFFLINE_MS`). */
const presentCount = new Map<string, number>();

/**
 * ЛС между инстансами, Э4 (#141, `dm3`): теневые строки людей соседа, которых их дом объявил «в сети» (`POST /fed/v1/ephemeral`
 * `presence`). Пишет только `setRemoteDmPresence`; устаревание — у вызывающего (`federation/dmEphemeral.ts`).
 */
const remoteDmPresent = new Set<string>();

/**
 * Крючки Э4 (#141) — задаёт `index.ts` при `FEDERATION_DM_ENABLED` (`federation/dmEphemeral.ts`); здесь без импорта: модуль
 * шлюза проверки исполняют с закрытым перечнем зависимостей. Нет крючков — как до Э4.
 * - `typing` — «печатает» нашего человека собеседнику без соединений здесь (у человека соседа их нет никогда);
 * - `presence` — наш человек стал «в сети» / «не в сети» для ЛС (`isUserDmPresent` сменилось).
 */
export interface GatewayFedHooks {
  typing(dmId: string, senderId: string, peerId: string, action: string): void;
  presence(userId: string, online: boolean): void;
  /** Исправления ревью 12.10, п. 8: человек другого инстанса (теневая строка) — синхронно (`dmEphemeral.isKnownShadow`). */
  isRemote?(userId: string): boolean;
  /** Э7 часть 3 (#141): наш человек печатает в группе — участникам других инстансов (через хост, `dmGroupTyping.ts`). */
  groupTyping?(dmId: string, senderId: string, action: string): void;
}
let fedHooks: GatewayFedHooks | null = null;
export function configureGatewayFed(hooks: GatewayFedHooks | null): void {
  fedHooks = hooks;
}

/** Э4: сообщить крючку, если «в сети для ЛС» сменилось (`was` — значение до правки счётчика). */
function noteDmPresence(userId: string, was: boolean): void {
  const now = isUserDmPresent(userId);
  if (now !== was) fedHooks?.presence(userId, now);
}

/**
 * Э4 (#141): человек соседа (теневая строка `userId`) в сети / вышел — по отметке его дома. Для наших людей он становится
 * таким же «в сети», как местный: серверный онлайн (`hub`, `online.update` тем, кому можно о нём знать — собеседникам без
 * блокировки), «в сети для ЛС» (`isUserDmPresent` → «был(а)», `/users/:id/last-seen`). Счётчик `hub` — ровно одна единица за
 * отметку: гостевые сокеты того же человека (F3) считаются отдельно и не сбиваются.
 */
export function setRemoteDmPresence(userId: string, online: boolean): void {
  if (remoteDmPresent.has(userId) === online) return;
  if (online) {
    remoteDmPresent.add(userId);
    if (hub.goOnline(userId)) hub.deliverAboutUser(userId, { t: 'online.update', userId, online: true });
  } else {
    remoteDmPresent.delete(userId);
    if (hub.goOffline(userId)) hub.deliverAboutUser(userId, { t: 'online.update', userId, online: false });
  }
  syncDmAway(userId);
}

/**
 * «Не в сети для ЛС» при открытом сокете (`presence5`): пересчитать и, если поменялось, разослать `online.away` и отметить
 * «был(а)». Звать после каждой смены `presentCount` и после рассылки `online.update` о выходе (тогда уходит `away: false`).
 */
function syncDmAway(userId: string): void {
  const away = hub.isOnline(userId) && !isUserDmPresent(userId);
  if (hub.setDmAway(userId, away)) touchLastSeen(userId);
}

/**
 * Видимость соединений (D4): в счёт «здесь» для ЛС попадают только видимые; скрытое уходит через `HIDDEN_OFFLINE_MS`.
 * Серверный онлайн (`hub.goOnline`/`goOffline`) — по сокетам, как раньше.
 */
const visibility = createSessionVisibility<Conn>({
  graceMs: HIDDEN_OFFLINE_MS,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  show: (conn) => {
    if (!conn.userId) return;
    const wasPresent = isUserDmPresent(conn.userId);
    presentCount.set(conn.userId, (presentCount.get(conn.userId) ?? 0) + 1);
    syncDmAway(conn.userId);
    noteDmPresence(conn.userId, wasPresent);
  },
  hide: (conn) => {
    if (!conn.userId) return;
    const wasPresent = isUserDmPresent(conn.userId);
    const n = (presentCount.get(conn.userId) ?? 1) - 1;
    if (n <= 0) presentCount.delete(conn.userId);
    else presentCount.set(conn.userId, n);
    syncDmAway(conn.userId);
    noteDmPresence(conn.userId, wasPresent);
  },
});

/**
 * «За устройством сидят» (08.10, #211, G38, `push2`): последний кадр `{ t: 'active', on: true }` каждого соединения
 * человека. Кадр `on: false` (окно потеряло фокус) и закрытие соединения запись снимают.
 */
const activeAt = new Map<string, Map<Conn, number>>();

function noteConnActive(conn: Conn, on: boolean): void {
  if (!conn.userId) return;
  let m = activeAt.get(conn.userId);
  if (on) {
    if (!m) activeAt.set(conn.userId, (m = new Map()));
    m.set(conn, Date.now());
    return;
  }
  m?.delete(conn);
  if (m && m.size === 0) activeAt.delete(conn.userId);
}

/**
 * Человек прямо сейчас за каким-то своим устройством (ПК, вкладка, открытое приложение): пуш ЛС на телефон
 * откладывается (`pushDefer.ts`). Окно — `pushRules.ACTIVE_WINDOW_MS`.
 */
export function isUserActive(userId: string): boolean {
  const m = activeAt.get(userId);
  if (!m) return false;
  const now = Date.now();
  // D10 (08.10): скрытое соединение (свёрнутое приложение, спрятанная вкладка) «за устройством» не считается.
  for (const [conn, at] of m) if (!visibility.isHidden(conn) && connActive(at, now)) return true;
  return false;
}

/**
 * Кто-то мог вступить в сервер или уйти из него — отдать хабу новый состав (#136). Сам
 * `server.invalidate` летит и на правку канала, и на роль, поэтому решение «менялся ли состав»
 * принимает хаб, а здесь только запрос.
 */
async function onServerInvalidate(serverId: string): Promise<void> {
  const rows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
  await hub.applyServerMembers(serverId, new Set(rows.map((r) => r.userId)));
}

/**
 * Разослать смену статуса человека (P2). Клиенты обновляют цветную точку и строку статуса;
 * чужой «невидимый» маскируют в «не в сети» сами. Получатели — см. `deliverAboutUser` (#136).
 */
export function broadcastUserStatus(userId: string, status: PresenceStatus, customStatus: CustomStatus | null): void {
  // Сперва флаг «Невидимый» (соседям уйдёт online.update «вышел/зашёл»), потом само событие статуса.
  const plan = statusBroadcastPlan(userId, status, customStatus);
  hub.setInvisible(userId, plan.invisible);
  hub.deliverAboutUser(userId, plan.event);
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
  hub.deliverAboutUser(userId, { t: 'user.update', userId, displayName, avatarUrl, animatedAvatarUrl });
}

/**
 * Разослать смену игровой активности (#40). `activity: null` — перестал играть. Сама активность
 * живёт в эфемерном хранилище (activity.ts), здесь только дельта. Получатели — `deliverAboutUser` (#136).
 */
export function broadcastUserActivity(userId: string, activity: GameActivity | null): void {
  hub.deliverAboutUser(userId, { t: 'user.activity', userId, activity });
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
 * Состав беседы 1:1 НЕИЗМЕНЯЕМ (с шага 1б ЛС — `conversation_members`; выход из беседы — этап 3, групп). Поэтому
 * кэш вечный — один запрос на диалог за жизнь процесса, инвалидировать нечего.
 *
 * ⚠️ Получатель ВЫВОДИТСЯ из строки диалога, а не берётся из `recipientId` клиента. Проверять
 * присланный id было бы полумерой; правильный ответ — перестать ему верить.
 */
const dmPeers = new Map<string, [string, string]>();

async function dmPeerOf(dmId: string, senderId: string): Promise<string | null> {
  let pair = dmPeers.get(dmId);
  if (!pair) {
    const rows = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      // Только 1:1 (07.10, `groups1`): группа из двоих — не пара, и пара в кеше устарела бы с первым добавленным.
      .where(and(eq(conversationMembers.conversationId, dmId), eq(conversations.kind, 'direct')))
      .limit(3);
    // Не беседа 1:1 (нет такой или в ней не двое) — отрицательные ответы НЕ кэшируем, иначе память растёт от мусорных id.
    if (rows.length !== 2) return null;
    if (dmPeers.size > 5000) dmPeers.clear(); // грубый потолок
    dmPeers.set(dmId, (pair = [rows[0].userId, rows[1].userId]));
  }
  if (pair[0] === senderId) return pair[1];
  if (pair[1] === senderId) return pair[0];
  return null;
}

/**
 * Беседа уже показана человеку (`conversations.conversationShownTo`, 05.10) — для «печатает». Показанная обратно не
 * прячется, поэтому «да» помним до конца процесса; «нет» не помним — его снимет первое же дошедшее сообщение.
 * ⚠️ Модуль бесед — лениво: шлюз грузят и тесты на PGlite (через `routes/users.ts`), им лишний граф ни к чему.
 */
const shownConvs = new Set<string>();

async function convShownTo(dmId: string, userId: string): Promise<boolean> {
  const key = `${dmId}:${userId}`;
  if (shownConvs.has(key)) return true;
  const { conversationShownTo } = await import('./conversations.js');
  const shown = await conversationShownTo(dmId, userId);
  if (shown) {
    if (shownConvs.size > 20_000) shownConvs.clear(); // грубый потолок
    shownConvs.add(key);
  }
  return shown;
}

/** Зависимости пересылки «печатает…» — настоящие; в тесте Codex подставляет свои (`gatewayTyping.ts`). */
const typingDeps: TypingDeps<WsLike> = {
  rateHit,
  dmPeerOf,
  isBlockedBy,
  shownTo: convShownTo,
  // Группа (07.10, `groups1`): остальные действующие участники. Модуль — лениво, как `convShownTo`.
  groupPeersOf: async (dmId, senderId) => (await import('./convGroups.js')).groupPeersOf(dmId, senderId),
  connsOf: (userId) => hub.connsOf(userId),
  send,
  getChannelAudience,
  publishToChannel: (serverId, channelId, msg, audience) => publishToChannel(serverId, channelId, msg, audience),
  // Э4 (#141): собеседник — человек соседа — «печатает» уходит его дому (`configureGatewayFed`).
  remoteTyping: (dmId, senderId, peerId, action) => fedHooks?.typing(dmId, senderId, peerId, action),
  // Исправления ревью 12.10, п. 8: собеседник — человек соседа — «печатает» только его дому, не в гостевой сокет.
  isRemote: (userId) => fedHooks?.isRemote?.(userId) ?? false,
  // Э7 часть 3 (#141): в группе есть участники других инстансов — «печатает» уходит и им (хосту / от хоста).
  remoteGroupTyping: (dmId, senderId, action) => fedHooks?.groupTyping?.(dmId, senderId, action),
};

/**
 * Э4 (#141): «печатает» человека соседа (теневая строка `shadowId`) в беседе `dmId` — нашим людям тем же путём, что местное
 * (`relayTyping`: участник беседы, блокировка, показ беседы, предел `typing:<id>`, `round` → `voice` старым соединениям).
 */
export function relayFedTyping(shadowId: string, dmId: string, action: string | undefined): Promise<void> {
  return relayTyping(typingDeps, { userId: shadowId, servers: new Set<string>() }, { dmId, action });
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
  // Блокировка и разблокировка (05.10): связь «через беседу» между этими двумя появилась или пропала (`loadPeers`) —
  // забыть их соседей и прислать им свежий снимок онлайна, а не ждать срока кэша (60 с).
  onBlockChange((blockerId, blockedId) => void hub.refreshPeers([blockerId, blockedId]).catch(() => {}));
  sub.on('pmessage', (_pattern, channel, message) => {
    const env = parseEnvelope(message);
    if (!env) return; // fail-closed: неразобранное не рассылаем (см. gatewayRules)
    const payload = JSON.stringify(env.m); // наружу — только событие, без списка получателей
    if (channel.startsWith('gw:server:')) {
      const serverId = channel.slice('gw:server:'.length);
      const set = byServer.get(serverId);
      if (set) for (const conn of set) if (shouldDeliver(env, conn.userId, conn.caps)) conn.socket.send(payload);
      // Состав/права могли измениться — снимаем подписки у тех, кто больше не участник (#91).
      if (env.m.t === 'server.invalidate') {
        void dropRevokedSubscribers(serverId);
        // Кто-то вступил или ушёл — пересобрать, кто чей онлайн видит (#136).
        void onServerInvalidate(serverId).catch(() => {});
      }
    } else if (channel.startsWith('gw:user:')) {
      for (const conn of hub.connsOf(channel.slice('gw:user:'.length)))
        if (capAllows(env, conn.caps)) conn.socket.send(payload);
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
    const conn: Conn = { socket, userId: null, servers: new Set(), caps: new Set() };
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
    const handleIdentify = async (token: string, caps: unknown, hidden: boolean): Promise<void> => {
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
            // Только при ПЕРВОМ `identify`: повторный на том же соединении не меняет форму уже идущих событий.
            conn.caps = parseCaps(caps);
            // Невидимый ли человек — узнать ДО `goOnline`: его «зашёл в сеть» соседям не рассылается. Не ответила база —
            // остаётся последняя известная шлюзу запись.
            try {
              const [row] = await db.select({ s: users.presenceStatus }).from(users).where(eq(users.id, claims.sub)).limit(1);
              if (row) hub.setInvisible(claims.sub, row.s === 'invisible');
            } catch {
              /* последняя известная запись */
            }
            hub.attach(conn, claims.sub);
            // Первый сокет человека — только тогда «зашёл в сеть» (вкладок и устройств бывает много).
            const first = hub.goOnline(claims.sub);
            // ЛС (D4): сокет, открытый уже в фоне (`identify.hidden`), «здесь» не считается, пока клиент не скажет `visible`.
            // `online.away` — ДО `online.update`: иначе соседский клиент на миг покажет в ЛС «в сети».
            visibility.open(conn, hidden);
            syncDmAway(claims.sub);
            if (first) {
              hub.deliverAboutUser(claims.sub, { t: 'online.update', userId: claims.sub, online: true });
              touchLastSeen(claims.sub);
            }
          }
          send(socket, { t: 'ready', userId: conn.userId });
          // Только те, с кем есть общий сервер или ЛС, — а не весь инстанс (#136).
          await hub.sendOnlineSnapshot(conn);
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
        identifying = handleIdentify(msg.token, msg.caps, msg.hidden === true);
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
        case 'active':
          // G38 (`push2`): признак жизни устройства — только для отложенного пуша, никому не рассылается.
          return noteConnActive(conn, msg.on === true);
        case 'visible':
          // D4 (08.10): «здесь / нет» для ЛС — в сети в ЛС только такие соединения; ушедшее — через `HIDDEN_OFFLINE_MS`.
          if (msg.on !== true) noteConnActive(conn, false);
          return visibility.set(conn, msg.on !== true);
        case 'typing':
          // Ephemeral, cosmetic — но граница авторизации тут такая же, как у сообщений (#88); вся ветка — `gatewayTyping.ts`.
          return relayTyping(typingDeps, { userId: conn.userId, servers: conn.servers }, msg);
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
      noteConnActive(conn, false);
      hub.detach(conn);
      for (const serverId of conn.servers) byServer.get(serverId)?.delete(conn);
      conn.servers.clear();
      // Ушёл последний сокет — только тогда «вышел из сети».
      if (conn.userId && hub.goOffline(conn.userId)) {
        hub.deliverAboutUser(conn.userId, { t: 'online.update', userId: conn.userId, online: false });
        touchLastSeen(conn.userId);
      }
      // ЛС (D4): после `online.update` — тогда соседям уходит и `online.away: false`, если человек был «не здесь».
      visibility.close(conn);
      if (conn.userId) syncDmAway(conn.userId);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

/**
 * «Был(а) в сети» (С1, #211): момент входа в сеть и выхода из неё — первый и последний сокет человека. Пока он в сети,
 * клиент показывает «в сети», так что время между ними не нужно. Ошибка базы не мешает шлюзу: отметка просто старше.
 */
function touchLastSeen(userId: string): void {
  void db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, userId))
    .catch(() => {
      /* следующая отметка поправит */
    });
}
