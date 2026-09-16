import {
  channelFromRoom,
  PRESENCE_WEBHOOK_PATH,
  roomForChannel,
  type PresenceClientMessage,
  type PresenceMap,
  type PresenceServerMessage,
  type VoiceParticipant,
} from '@gusvoice/shared';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { type ParticipantInfo, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { env } from './env.js';
import {
  admitFrame,
  admitSocket,
  buildParticipantList,
  clientIpFrom,
  newSocketBudget,
  PRESENCE_WS_LIMITS,
  visibleSnapshot,
} from './presenceRules.js';

const redis = new Redis(env.redisUrl);
const pub = new Redis(env.redisUrl);
const sub = new Redis(env.redisUrl);

const roomService = new RoomServiceClient(env.livekit.urlInternal, env.livekit.apiKey, env.livekit.apiSecret);
const receiver = new WebhookReceiver(env.livekit.apiKey, env.livekit.apiSecret);

const CHANNELS_KEY = 'presence:channels';
const channelKey = (id: string) => `presence:ch:${id}`;
/** Когда канал стал занятым. Живёт `OCCUPANCY_GRACE_S` и продлевается, пока в канале кто-то есть. */
const sinceKey = (id: string) => `voice:since:${id}`;
const UPDATE_CHANNEL = 'presence:update';

/**
 * Срок годности списка участников канала (#124, С1).
 *
 * 🔴 Раньше ключ жил вечно. Умер или завис этот процесс — списки замерзали с последним составом, а
 * тикер экономики в бэкенде продолжал читать их как истину и каждую минуту засчитывал ещё
 * шестьдесят секунд присутствия. Четверо разошлись в полночь — до утра всем капало «вчетвером», с
 * максимальным множителем, до суточного потолка. Те же часы писались в статистику присутствия,
 * отравляя разом и сухой прогон, и будущее ретро, и пересчёт под ползунками.
 *
 * ⚠️ Срок продлевается на КАЖДОМ проходе сверки (раз в 2 с) — в том числе когда состав не менялся
 * и рассылать клиентам нечего. Иначе стабильный канал, где никто не двигается, тихо истёк бы сам,
 * и присутствие пропало бы у живых людей.
 *
 * Значение выбрано так, чтобы пережить два десятка проходов сверки и при этом не дать призракам
 * больше одного среза статистики (срез — раз в минуту).
 */
const KEY_TTL_S = 45;

/**
 * Сколько канал считается «теми же посиделками» после того, как из него все вышли.
 *
 * 🔴 **Это и есть защита от сброса на ровном месте, и она здесь главная.** Сверка зовётся раз в две
 * секунды и стирает канал, как только состав пуст. У кого-то моргнула сеть, LiveKit на пару секунд
 * убрал его из комнаты — и таймер обнулился бы, хотя люди сидят третий час.
 *
 * ⚠️ Сделано СРОКОМ ЖИЗНИ КЛЮЧА, а не отдельной логикой. Пока канал занят, сверка продлевает
 * отметку каждые две секунды; опустел — продлевать некому (пустой канал выбывает из списка
 * активных), и отметка умирает сама. Вернулись в течение срока — `SET NX` находит её живой и НЕ
 * перезаписывает, то есть отсчёт продолжается с первого входа.
 *
 * ⚠️ Он же переживает перезапуск этого процесса: сверка после старта существующую отметку не
 * трогает. Потеряется только при полной чистке Redis — тогда отсчёт честно начнётся заново.
 */
const OCCUPANCY_GRACE_S = 90;

/**
 * `DisconnectReason.CLIENT_INITIATED` из протокола LiveKit — «клиент попрощался сам».
 *
 * ⚠️ Числом, а не импортом: `livekit-server-sdk` этот enum НЕ реэкспортирует (проверено в 2.15.5),
 * а тянуть в зависимости весь `@livekit/protocol` ради одного целого — плохой размен: получим
 * вторую копию пакета рядом с той, что уже стоит внутри SDK. Значение у protobuf-перечисления
 * заморожено самим форматом и поменяться не может.
 */
const LK_CLIENT_INITIATED = 1;

interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: 'message' | 'close' | 'error', cb: (...args: any[]) => void): void;
}

interface Client {
  socket: WsLike;
  token: string;
  visible: Set<string>; // voice channel ids this user may VIEW
}
const clients = new Set<Client>();

/**
 * Ask the backend (with the user's own token) which voice channels they may VIEW.
 * `null` — бэкенд отверг токен (401/403): сессия отозвана. Сбой сети или 5xx — пустой набор, а не `null`:
 * бэкенд в момент выкатки не должен выкидывать всех из presence.
 */
async function fetchVisible(token: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${env.backendUrlInternal}/api/me/voice-visibility`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) return new Set();
    const data = (await res.json()) as { channelIds: string[] };
    return new Set(data.channelIds);
  } catch {
    return new Set();
  }
}

const serverMuteKey = (channelId: string) => `vmute:${channelId}`;

/** Rebuild a channel's authoritative participant list from LiveKit and broadcast it. */
async function reconcile(channelId: string, room: string): Promise<void> {
  let parts: ParticipantInfo[] = [];
  try {
    parts = await roomService.listParticipants(room);
  } catch {
    parts = []; // room gone / no participants
  }
  const serverMutedIds = new Set(await redis.smembers(serverMuteKey(channelId)));
  // Весь расчёт (склейка «#screen» с владельцем, отсев ghost-участника, протухший server-mute,
  // стабильная сортировка) — в presenceRules.ts; здесь остаются только Redis и LiveKit.
  const { list, staleMutedIds } = buildParticipantList(parts, serverMutedIds);
  if (staleMutedIds.length) await redis.srem(serverMuteKey(channelId), ...staleMutedIds);
  const key = channelKey(channelId);
  if (list.length === 0) {
    const existed = await redis.del(key);
    await redis.srem(CHANNELS_KEY, channelId);
    // ⚠️ Отметку занятости НЕ трогаем: пусть доживает свой grace. Сотри её здесь — и любой
    // двухсекундный провал состава (моргнула сеть, реконнект LiveKit) обнулял бы таймер у людей,
    // которые никуда не уходили.
    if (existed) await pub.publish(UPDATE_CHANNEL, JSON.stringify({ channelId }));
    return;
  }
  /**
   * Канал занят: ставим отметку, если её ещё нет, и продлеваем срок.
   *
   * ⚠️ ДО раннего выхода ниже. Стабильный канал, где никто не двигается, каждый проход уходит в
   * ветку «состав не менялся» — и если продлевать только при изменениях, отметка тихо истекла бы
   * посреди живых посиделок. Та же ловушка, что уже описана у `KEY_TTL_S`.
   * ⚠️ `NX` обязателен: без него каждый проход переписывал бы начало, и таймер вечно показывал ноль.
   */
  await redis.set(sinceKey(channelId), String(Date.now()), 'EX', OCCUPANCY_GRACE_S, 'NX');
  await redis.expire(sinceKey(channelId), OCCUPANCY_GRACE_S);
  // Only write + broadcast when something actually changed — the periodic poll below calls
  // reconcile constantly, and we don't want to churn every client every tick.
  const next = JSON.stringify(list);
  const prev = await redis.get(key);
  if (prev === next) {
    // Состав тот же: клиентов не трогаем, но срок ключа продлеваем — живой срок и есть признак
    // того, что этот процесс на месте и данным можно верить.
    await redis.expire(key, KEY_TTL_S);
    return;
  }
  await redis.set(key, next, 'EX', KEY_TTL_S);
  await redis.sadd(CHANNELS_KEY, channelId);
  await pub.publish(UPDATE_CHANNEL, JSON.stringify({ channelId }));
}

async function clearChannel(channelId: string): Promise<void> {
  await redis.del(channelKey(channelId));
  await redis.srem(CHANNELS_KEY, channelId);
  await pub.publish(UPDATE_CHANNEL, JSON.stringify({ channelId }));
}

/** Сколько канал занят прямо сейчас, миллисекунды. `null` — пуст или отметка истекла. */
async function occupiedMsOf(channelId: string): Promise<number | null> {
  const raw = await redis.get(sinceKey(channelId));
  if (!raw) return null;
  const since = Number(raw);
  if (!Number.isFinite(since)) return null;
  return Math.max(0, Date.now() - since);
}

async function snapshot(): Promise<PresenceMap> {
  const ids = await redis.smembers(CHANNELS_KEY);
  const map: PresenceMap = {};
  if (ids.length === 0) return map;
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(channelKey(id));
  const res = await pipeline.exec();
  res?.forEach(([err, val], i) => {
    if (!err && typeof val === 'string') map[ids[i]] = JSON.parse(val) as VoiceParticipant[];
  });
  return map;
}

/** Занятость по всем активным каналам — для стартового снимка. */
async function occupiedSnapshot(): Promise<Record<string, number>> {
  const ids = await redis.smembers(CHANNELS_KEY);
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(sinceKey(id));
  const res = await pipeline.exec();
  const now = Date.now();
  res?.forEach(([err, val], i) => {
    if (err || typeof val !== 'string') return;
    const since = Number(val);
    if (Number.isFinite(since)) out[ids[i]] = Math.max(0, now - since);
  });
  return out;
}

/** Тот же отсев по видимости, что и у состава: занятость чужого канала — тоже утечка. */
function visibleOccupied(all: Record<string, number>, visible: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ms] of Object.entries(all)) if (visible.has(id)) out[id] = ms;
  return out;
}

function send(socket: WsLike, msg: PresenceServerMessage): void {
  socket.send(JSON.stringify(msg));
}

// Fan webhook-driven updates out only to clients who may VIEW the channel (works across instances).
sub.subscribe(UPDATE_CHANNEL);
sub.on('message', async (_channel, message) => {
  const { channelId } = JSON.parse(message) as { channelId: string };
  const val = await redis.get(channelKey(channelId));
  const participants = val ? (JSON.parse(val) as VoiceParticipant[]) : [];
  const occupiedMs = participants.length ? await occupiedMsOf(channelId) : null;
  const data = JSON.stringify({ t: 'presence.channel', channelId, participants, occupiedMs });
  for (const c of clients) if (c.visible.has(channelId)) c.socket.send(data);
});

// Permissions / channels can change mid-session; refresh each client's visible set and push
// a fresh snapshot when it changed (so newly-allowed channels appear, revoked ones disappear).
setInterval(() => {
  void (async () => {
    if (clients.size === 0) return;
    const full = await snapshot();
    for (const c of clients) {
      if (!c.token) continue;
      const fetched = await fetchVisible(c.token);
      // Сессию отозвали посреди жизни сокета — закрыть: клиент переподключится и получит отказ на identify.
      if (fetched === null) {
        closeQuietly(c.socket);
        continue;
      }
      const next = fetched;
      const changed = next.size !== c.visible.size || [...next].some((id) => !c.visible.has(id));
      c.visible = next;
      if (changed)
        c.socket.send(
          JSON.stringify({
            t: 'presence.snapshot',
            channels: visibleSnapshot(full, next),
            occupied: visibleOccupied(await occupiedSnapshot(), next),
          }),
        );
    }
  })();
}, 20000);

// Mic mute/unmute keeps the track published (no webhook), and attribute changes (deafen) are
// silent too — so webhooks alone never refresh those. Poll active rooms a few times a second;
// reconcile() only broadcasts when the participant list actually changed.
setInterval(() => {
  void (async () => {
    const ids = await redis.smembers(CHANNELS_KEY);
    for (const id of ids) {
      try {
        await reconcile(id, roomForChannel(id));
      } catch {
        /* room gone between smembers and reconcile — ignore */
      }
    }
  })();
}, 2000);

const app = Fastify({ logger: true });
await app.register(websocket);

// LiveKit posts webhooks as application/webhook+json — capture the raw body so the
// receiver can validate the signed JWT in the Authorization header.
app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) =>
  done(null, body),
);

app.get('/health', async () => ({ ok: true }));

app.post(PRESENCE_WEBHOOK_PATH, async (req, reply) => {
  let event;
  try {
    event = await receiver.receive(req.body as string, req.headers.authorization);
  } catch (err) {
    req.log.warn({ err }, 'rejected webhook');
    return reply.code(401).send({ error: 'invalid signature' });
  }

  const room = event.room?.name;
  const channelId = room ? channelFromRoom(room) : null;
  if (channelId && room) {
    if (event.event === 'room_finished') {
      await clearChannel(channelId);
    } else {
      await reconcile(channelId, room);
      /**
       * 🔴 **Осознанный выход последнего человека снимает отсчёт СРАЗУ, без grace-периода**
       * (02.09: «вышел и зашёл, таймер не сбросился»). Grace существует ради ОБРЫВОВ, а не
       * ради того, чтобы человек, нажавший «Выйти», пять минут видел чужой отсчёт.
       *
       * 🔴 Отличаем по `disconnectReason` от самого LiveKit: `CLIENT_INITIATED` ставится, когда
       * клиент попрощался сам. Обрыв, тайм-аут и падение сервера приходят с другими причинами и
       * grace не теряют. Это надёжнее, чем спрашивать клиента: работает и для мобильного, и для
       * десктопа, и для того, кто закрыл вкладку, — нам не нужно, чтобы уходящий успел что-то
       * прислать.
       *
       * ⚠️ Снимаем, только если канал ПОСЛЕ сверки действительно пуст: осознанный уход одного из
       * пятерых отсчёт не трогает — посиделки продолжаются.
       */
      if (
        event.event === 'participant_left' &&
        Number(event.participant?.disconnectReason) === LK_CLIENT_INITIATED &&
        !(await redis.exists(channelKey(channelId)))
      ) {
        await redis.del(sinceKey(channelId));
      }
    }
  }
  return reply.send({ ok: true });
});

// Сокеты с каждого адреса — предел из `PRESENCE_WS_LIMITS` (F0, #139).
const socketsByIp = new Map<string, number>();

function closeQuietly(socket: WsLike): void {
  try {
    socket.close();
  } catch {
    /* уже закрыт */
  }
}

// Client presence socket.
app.get('/', { websocket: true }, (socket: WsLike, req: FastifyRequest) => {
  // Пределы (срок на identify, кадры, число сокетов с адреса) — `presenceRules.ts`, там же почему.
  const ip = clientIpFrom(req.headers['x-forwarded-for'], req.ip);
  if (!admitSocket({ total: clients.size, fromIp: socketsByIp.get(ip) ?? 0 })) return closeQuietly(socket);

  const client: Client = { socket, token: '', visible: new Set() };
  clients.add(client);
  socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1);
  let budget = newSocketBudget(Date.now());

  let authTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    authTimer = null;
    if (!client.token) closeQuietly(socket);
  }, PRESENCE_WS_LIMITS.authDeadlineMs);

  socket.on('message', async (raw: Buffer) => {
    // Размер — до разбора: мегабайтный JSON не должен даже парситься.
    if (raw.length > PRESENCE_WS_LIMITS.maxFrameBytes) return closeQuietly(socket);
    let msg: PresenceClientMessage | null = null;
    try {
      msg = JSON.parse(raw.toString()) as PresenceClientMessage;
    } catch {
      /* битый JSON тоже кадр — засчитывается ниже */
    }
    // ⚠️ Счётчик — до ответа «bad json»: иначе поток мусора шёл бы мимо предела кадров.
    const verdict = admitFrame(budget, { bytes: raw.length, isIdentify: msg?.t === 'identify' }, Date.now());
    budget = verdict.budget;
    if (!verdict.ok) return closeQuietly(socket);
    if (!msg || typeof msg !== 'object') return send(socket, { t: 'error', message: 'bad json' });

    if (msg.t === 'ping') return send(socket, { t: 'pong' });

    if (msg.t === 'identify') {
      let claims: { typ?: string };
      try {
        claims = jwt.verify(msg.token, env.jwtSecret) as { typ?: string };
      } catch {
        send(socket, { t: 'error', message: 'invalid token' });
        return closeQuietly(socket);
      }
      // A 2FA CHALLENGE token must not open a presence socket (P3-7) — it's only for /auth/login/totp.
      if (claims.typ === '2fa') {
        send(socket, { t: 'error', message: 'invalid token' });
        return closeQuietly(socket);
      }
      const visible = await fetchVisible(msg.token);
      // Отозванный токен («выйти везде», смена пароля): бэкенд ответил 401 — сокет бесполезен, и держать
      // его открытым значит раз в 20 с бить бэкенд чужим мёртвым токеном. Сеть или 5xx (выкатка) — не повод.
      if (visible === null) {
        send(socket, { t: 'error', message: 'invalid token' });
        return closeQuietly(socket);
      }
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      budget = { ...budget, identified: true };
      client.token = msg.token;
      client.visible = visible;
      send(socket, {
        t: 'presence.snapshot',
        channels: visibleSnapshot(await snapshot(), client.visible),
        occupied: visibleOccupied(await occupiedSnapshot(), client.visible),
      });
    }
  });

  let cleaned = false;
  const cleanup = () => {
    // ws шлёт 'error', затем 'close' — счётчик адреса не должен уменьшиться дважды.
    if (cleaned) return;
    cleaned = true;
    if (authTimer) clearTimeout(authTimer);
    clients.delete(client);
    const n = (socketsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) socketsByIp.delete(ip);
    else socketsByIp.set(ip, n);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

try {
  await app.listen({ host: '0.0.0.0', port: env.port });
  app.log.info(`presence listening on :${env.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
