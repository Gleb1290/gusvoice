/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — живые звонки и их итог.
 *
 * Звонок живёт в памяти бэкенда (он у инстанса один): перезапуск рвёт идущие звонки — их участники увидят конец по `ping`
 * (404 → клиент кладёт трубку). Медиа — комната LiveKit `dmcall_<id>` (`callRules.callRoomName`), пропуск — тот же
 * `createVoiceToken`, что у голосовых каналов, с правом только на микрофон. Каждая смена фазы — событие `call.state`
 * всем устройствам обоих участников; конец — запись о звонке в ленту (`ConvCallService`) от имени звонившего.
 */
import { randomUUID } from 'node:crypto';
import {
  CALL_DROP_MS,
  CALL_RING_TIMEOUT_MS,
  FEATURE_FEDCALL1,
  FED_CALL_ACTIVE_MAX_MS,
  FED_CALL_GRACE_MS,
  FED_ERRORS,
  callServiceFallback,
  type CallEndReason,
  type CallJoinResponse,
  type ConvCallService,
  type DmCall,
  type FedCallState,
  Permission,
} from '@gusvoice/shared';
import { and, eq } from 'drizzle-orm';
import {
  callDurationSec,
  callRecordPlan,
  callRoomName,
  callTransition,
  inCall,
  incomingCallPush,
  orphanCallEnd,
  ringPushOver,
  silentParticipant,
  type CallAction,
} from './callRules.js';
import { deliver, loadAccess, markRead, sendMessage } from './conversations.js';
import { fanOutSend } from './convSendFanout.js';
import { contactNamesFor } from './contacts.js';
import { db } from './db/index.js';
import { conversationMembers, users } from './db/schema.js';
import { env } from './env.js';
import { createVoiceToken, removeFromOtherRooms } from './livekit.js';
import { sendPushToUsers, sendReadSyncPush } from './push.js';
import { publishToUser, redisPub } from './realtime.js';

interface LiveCall {
  call: DmCall;
  ring: ReturnType<typeof setTimeout> | null;
  seen: { caller: number; callee: number };
  /**
   * Э6 (#141): собеседник — человек другого инстанса (id его дома). Звонок и комната у нас; будит его, шлёт ему `call.state`
   * и пуш его дом — по приглашению и снимкам фазы (`fedCalls`), а не мы напрямую теневой строке.
   */
  home?: string;
}

const live = new Map<string, LiveCall>();
let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Э6 (#141): входящие звонки людей соседей нашим людям — копии у дома собеседника. Сам звонок у инстанса звонящего
 * (`DmCall.host`); здесь только «звонит / идёт» для устройств нашего человека: `call.state` соединениям с `fedcall1`, пуш
 * звонка, занятость линии. Конец — по снимку `call.state` соседа или по своему сроку (`FED_CALL_GRACE_MS`, `FED_CALL_ACTIVE_MAX_MS`).
 */
interface RemoteCall {
  call: DmCall;
  timer: ReturnType<typeof setTimeout> | null;
}
const remote = new Map<string, RemoteCall>();

/**
 * Что звонкам нужно от федерации (Э6) — подключает `index.ts` (`federation/dmCalls.ts`), а не импорт: модуль без ключей и связок.
 * `invite` — дому собеседника-теневого синхронно (отказ — `{ status, error }` для ручки), `state` — снимок фазы событием связки.
 */
export interface FedCallHooks {
  invite(call: DmCall, home: string): Promise<null | { status: number; error: string }>;
  state(call: DmCall, home: string): void;
}
let fedCalls: FedCallHooks | null = null;
export function configureFedCalls(hooks: FedCallHooks | null): void {
  fedCalls = hooks;
}

function allCalls(): DmCall[] {
  return [...[...live.values()].map((l) => l.call), ...[...remote.values()].map((r) => r.call)];
}

/**
 * Копия живых звонков в Redis (`calls2`): поле — id звонка, значение — `{ call, seen }` (последний знак жизни, мс). Звонок
 * в памяти процесса; копия нужна только затем, чтобы после перезапуска бэкенда закрыть оборванные звонки записью в ленте
 * (`closeOrphanCalls`), а не потерять их молча.
 */
const LIVE_KEY = 'gv:calls:live';

function save(l: LiveCall): void {
  const seen = Math.max(l.seen.caller, l.seen.callee);
  void redisPub.hset(LIVE_KEY, l.call.id, JSON.stringify({ call: l.call, seen, ...(l.home ? { home: l.home } : {}) })).catch(() => {});
}

function forget(id: string): void {
  void redisPub.hdel(LIVE_KEY, id).catch(() => {});
}

/**
 * Старт бэкенда: звонки из Redis, которых нет в памяти, оборвал перезапуск. Каждому — конец (`orphanCallEnd`): событие
 * `call.state` обоим (клиент кладёт трубку) и запись в ленте, как при обрыве связи. Возвращает, сколько закрыто.
 */
export async function closeOrphanCalls(): Promise<number> {
  const all = await redisPub.hgetall(LIVE_KEY);
  let closed = 0;
  for (const [id, raw] of Object.entries(all)) {
    if (live.has(id)) continue;
    await redisPub.hdel(LIVE_KEY, id);
    let saved: { call?: DmCall; seen?: number; home?: string };
    try {
      saved = JSON.parse(raw) as { call?: DmCall; seen?: number; home?: string };
    } catch {
      continue;
    }
    if (!saved.call || saved.call.phase === 'ended') continue;
    const seen = typeof saved.seen === 'number' ? saved.seen : Date.now();
    const { reason } = orphanCallEnd(saved.call, seen);
    const home = typeof saved.home === 'string' ? saved.home : undefined;
    await end({ call: saved.call, ring: null, seen: { caller: seen, callee: seen }, ...(home ? { home } : {}) }, reason, seen).catch((e) =>
      console.error('[calls] orphan close failed:', e),
    );
    closed++;
  }
  return closed;
}

/**
 * Мой текущий звонок (звонит или идёт). `withRemote` (Э6, `GET /calls/active?fed=1` клиента с `fedcall1`) — и входящий с
 * другого инстанса (`DmCall.host`); без него — как раньше, только звонки этого инстанса.
 */
export function callOf(userId: string, withRemote = false): DmCall | null {
  for (const l of live.values()) if (l.call.callerId === userId || l.call.calleeId === userId) return l.call;
  if (withRemote) for (const r of remote.values()) if (r.call.calleeId === userId) return r.call;
  return null;
}

export function callById(id: string): DmCall | null {
  return live.get(id)?.call ?? null;
}

/** Собеседник с другого инстанса (Э6): `call.state` ему шлёт его дом, не мы — снимком фазы (`fedCalls.state`). */
async function publish(call: DmCall, home?: string): Promise<void> {
  const msg = { t: 'call.state' as const, call };
  if (home) {
    fedCalls?.state(call, home);
    await publishToUser(call.callerId, msg).catch(() => {});
    return;
  }
  await Promise.all([publishToUser(call.callerId, msg), publishToUser(call.calleeId, msg)]).catch(() => {});
}

/**
 * Пропуск в комнату звонка: микрофон, камера и показ экрана (`calls2` — `canPublishSources` через те же биты, что у голосового
 * канала: `VIDEO` → камера, `SHARE_SCREEN` → показ и его звук); из других комнат — вон (одна линия, Р-9).
 */
export async function callJoin(call: DmCall, userId: string): Promise<CallJoinResponse> {
  const [u] = await db.select({ displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId)).limit(1);
  const room = callRoomName(call.id);
  await removeFromOtherRooms(userId, room);
  const token = await createVoiceToken({
    identity: userId,
    name: u?.displayName ?? '',
    room,
    permissions: Permission.CONNECT | Permission.SPEAK | Permission.VIDEO | Permission.SHARE_SCREEN,
    avatarUrl: u?.avatarUrl ?? null,
  });
  return { call, url: env.livekit.urlExternal, token, room };
}

function ensureWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    for (const l of live.values()) {
      if (silentParticipant(l.call, l.seen, now, CALL_DROP_MS)) void finish(l, null, 'drop');
    }
    if (live.size === 0 && watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }, 5_000);
  watchdog.unref?.();
}

export type StartResult =
  | { kind: 'ok'; call: DmCall; answered?: true }
  | { kind: 'busy' }
  /** Э6: дом собеседника с другого инстанса отказал или недоступен — ручка отвечает `status` и `error` как есть. */
  | { kind: 'refused'; status: number; error: string };

/**
 * Позвонить собеседнику беседы 1:1 (права проверила ручка). Собеседник уже звонит мне в этой беседе — это встречный
 * звонок: отвечаю на него (как Telegram при одновременном вызове). Я или он заняты другим звонком — `busy`.
 */
export async function startCall(me: string, peerId: string, conversationId: string, device: string): Promise<StartResult> {
  const mine = callOf(me);
  if (mine && mine.phase === 'ringing' && mine.callerId === peerId && mine.conversationId === conversationId) {
    const res = await act(me, mine.id, 'answer', device);
    return res.kind === 'ok' ? { kind: 'ok', call: res.call, answered: true } : { kind: 'busy' };
  }
  const calls = allCalls();
  if (inCall(calls, me) || inCall(calls, peerId)) return { kind: 'busy' };
  // Э6: собеседник — человек другого инстанса. Звонок и комната у нас, будит его дом — по приглашению (синхронно: отказ сразу).
  const [peerRow] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, peerId)).limit(1);
  const home = peerRow?.home ?? null;
  if (home && !fedCalls) return { kind: 'refused', status: 409, error: FED_ERRORS.dmUnavailable };
  const call: DmCall = {
    id: randomUUID(),
    conversationId,
    callerId: me,
    calleeId: peerId,
    phase: 'ringing',
    createdAt: new Date().toISOString(),
    callerDevice: device,
  };
  const now = Date.now();
  const l: LiveCall = { call, ring: null, seen: { caller: now, callee: now }, ...(home ? { home } : {}) };
  l.ring = setTimeout(() => void finish(l, null, 'timeout'), CALL_RING_TIMEOUT_MS);
  l.ring.unref?.();
  live.set(call.id, l);
  if (home && fedCalls) {
    // В карте ДО приглашения: собеседник может ответить раньше, чем вернётся ответ его дома.
    const refusal = await fedCalls.invite(call, home).catch(() => ({ status: 503, error: FED_ERRORS.peerUnreachable }));
    if (refusal) {
      if (live.get(call.id) === l) {
        live.delete(call.id);
        if (l.ring) clearTimeout(l.ring);
      }
      return { kind: 'refused', ...refusal };
    }
    if (live.get(call.id) !== l) return { kind: 'ok', call: l.call };
  }
  save(l);
  ensureWatchdog();
  await publish(l.call, l.home);
  if (!l.home) void ringPush(call);
  return { kind: 'ok', call: l.call };
}

/**
 * Пуш «Входящий звонок» на телефоны собеседника (`calls3`): шлюз будит только открытое приложение, а телефон в фоне без
 * пуша не зазвонит (у Telegram Android — `phoneCallRequested` через FCM). Сразу (`noDefer`: отсрочка `pushDefer` звонку
 * не годится), высоким приоритетом (`push.ts`), без заглушек беседы — как звонок по сокету. Ошибки глотаются.
 */
async function ringPush(call: DmCall): Promise<void> {
  try {
    const [caller] = await db
      .select({ displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, call.callerId))
      .limit(1);
    if (!caller) return;
    // Подпись звонящего в контактах того, кому звонят (решение владельца 08.10 п.27, как Telegram).
    const label = (await contactNamesFor(call.callerId, [call.calleeId])).get(call.calleeId);
    await sendPushToUsers([call.calleeId], incomingCallPush(call, label ? { ...caller, displayName: label } : caller), undefined, {
      noDefer: true,
    });
  } catch (e) {
    console.error('[calls] ring push failed:', e);
  }
}

/**
 * Снять «Входящий звонок» со шторки (`calls3`): тихий `type: "read"` с «прочитано до» собеседника — приложение (`read1`)
 * перерисует уведомление беседы непрочитанными сообщениями (в том числе «Пропущенным звонком») или уберёт его совсем.
 * Тот же механизм, что «прочитано на другом устройстве» (`push.sendReadSyncPush`). Ошибки глотаются.
 */
async function unringPush(call: DmCall): Promise<void> {
  try {
    const [m] = await db
      .select({ lastReadKey: conversationMembers.lastReadKey })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, call.conversationId), eq(conversationMembers.userId, call.calleeId)))
      .limit(1);
    await sendReadSyncPush(call.calleeId, call.conversationId, m?.lastReadKey ?? 0);
  } catch (e) {
    console.error('[calls] unring push failed:', e);
  }
}

export type ActResult = { kind: 'ok'; call: DmCall } | { kind: 'forbidden' } | { kind: 'gone' };

/** Ответить / отклонить / положить трубку. */
export async function act(me: string, id: string, action: CallAction, device?: string): Promise<ActResult> {
  const l = live.get(id);
  if (!l) return { kind: 'gone' };
  const t = callTransition(l.call, me, action);
  if (t.kind === 'forbidden' || t.kind === 'gone') return t;
  if (t.kind === 'answer') {
    if (l.ring) clearTimeout(l.ring);
    l.ring = null;
    l.seen.callee = Date.now();
    const prev = l.call;
    l.call = { ...l.call, phase: 'active', answeredAt: new Date().toISOString(), calleeDevice: device ?? '' };
    save(l);
    await publish(l.call, l.home);
    if (!l.home && ringPushOver(prev, l.call)) void unringPush(l.call);
    return { kind: 'ok', call: l.call };
  }
  return { kind: 'ok', call: await end(l, t.reason) };
}

/**
 * Знак жизни участника идущего звонка (`CALL_PING_MS`); чужой или кончившийся — `false`. `video` (`calls2`) — у него
 * включена камера: звонок становится видеозвонком до конца (как у Telegram: включали видео — «Видеозвонок» в ленте).
 */
export function ping(me: string, id: string, video = false): boolean {
  const l = live.get(id);
  if (!l) return false;
  if (me === l.call.callerId) l.seen.caller = Date.now();
  else if (me === l.call.calleeId) l.seen.callee = Date.now();
  else return false;
  if (video && !l.call.video) l.call = { ...l.call, video: true };
  save(l);
  return true;
}

async function finish(l: LiveCall, actor: string | null, action: CallAction): Promise<void> {
  if (live.get(l.call.id) !== l) return;
  const t = callTransition(l.call, actor, action);
  if (t.kind === 'end') await end(l, t.reason).catch((e) => console.error('[calls] end failed:', e));
}

async function end(l: LiveCall, reason: CallEndReason, endedAt = Date.now()): Promise<DmCall> {
  live.delete(l.call.id);
  forget(l.call.id);
  if (l.ring) clearTimeout(l.ring);
  const now = endedAt;
  const duration = callDurationSec(l.call.answeredAt, now);
  const prev = l.call;
  l.call = { ...l.call, phase: 'ended', reason, ...(duration > 0 ? { duration } : {}) };
  await publish(l.call, l.home);
  await record(l.call, reason, duration, l.home).catch((e) => console.error('[calls] record failed:', e));
  // После записи: «прочитано до» уже учитывает её, а «Пропущенный звонок» остаётся в шторке непрочитанным.
  if (!l.home && ringPushOver(prev, l.call)) void unringPush(l.call);
  return l.call;
}

/** Запись о звонке в ленту — от звонившего; пропущенный — пуш и счётчик собеседнику, остальное сразу прочитано им. */
async function record(call: DmCall, reason: CallEndReason, duration: number, home?: string): Promise<void> {
  const access = await loadAccess(call.conversationId, call.callerId);
  if (!access) return;
  const mark: ConvCallService = { kind: 'call', callId: call.id, reason, duration, ...(call.video ? { video: true } : {}) };
  const plan = callRecordPlan(reason);
  const content = callServiceFallback(mark);
  const sent = await sendMessage(call.callerId, access, { clientId: null, content, attachments: [], replyToId: null, withheld: false, service: mark });
  if (sent.kind !== 'created') return;
  await fanOutSend({
    me: call.callerId,
    peerId: call.calleeId,
    conversationId: call.conversationId,
    row: sent.row,
    delivery: sent.delivery,
    notifyRecipient: plan.notify,
    content,
    attachments: [],
    silent: plan.silent,
  });
  // Э6: собеседник с другого инстанса — «прочитано» ставит его дом по своей копии записи (`federation/dmCalls.callRecordCopied`).
  if (home || !plan.markRead || sent.row.sortKey == null) return;
  const peerAccess = await loadAccess(call.conversationId, call.calleeId);
  if (!peerAccess) return;
  const read = await markRead(call.calleeId, peerAccess, sent.row.sortKey);
  if (read.kind === 'ok') await deliver(read.delivery);
}

// ─── Э6: входящий звонок с другого инстанса (мы — дом собеседника) ───────────────────────────────────────────────────

async function publishRemote(call: DmCall): Promise<void> {
  // Только клиентам, которые умеют ответить у инстанса звонящего (`fedcall1`): старому нечем — ему запись «Пропущенный».
  await publishToUser(call.calleeId, { t: 'call.state', call }, { cap: FEATURE_FEDCALL1 }).catch(() => {});
}

function remoteTimer(id: string, ms: number, reason: CallEndReason): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    const r = remote.get(id);
    if (r) void finishRemote(r, { reason });
  }, Math.max(0, ms));
  t.unref?.();
  return t;
}

/**
 * Приглашение соседа (`federation/dmCalls.acceptCallInvite` уже проверил беседу, блок и «кто может звонить»): завести «звонит»
 * нашему человеку — `call.state` его устройствам с `fedcall1` и пуш звонка (как у местного). Он занят — `busy`. Повтор — `ok`.
 */
export async function ringRemote(call: DmCall, expiresAt: number, now = Date.now()): Promise<'ok' | 'busy'> {
  if (remote.has(call.id)) return 'ok';
  if (inCall(allCalls(), call.calleeId)) return 'busy';
  const r: RemoteCall = { call, timer: null };
  r.timer = remoteTimer(call.id, expiresAt - now + FED_CALL_GRACE_MS, 'missed');
  remote.set(call.id, r);
  await publishRemote(call);
  void ringPush(call);
  return 'ok';
}

/** Снимок фазы от инстанса звонящего (`call.state` соседа): ответили (где-то) — «идёт», конец — убрать. Чужое — молча. */
export async function applyRemoteState(hostInstanceId: string, s: FedCallState): Promise<void> {
  const r = remote.get(s.callId);
  if (!r || r.call.host?.instanceId !== hostInstanceId || r.call.conversationId !== s.conversationId) return;
  if (s.phase === 'ended') {
    await finishRemote(r, { reason: s.reason ?? 'hangup', duration: s.duration, video: s.video });
    return;
  }
  if (r.call.phase !== 'ringing') return;
  const prev = r.call;
  r.call = {
    ...r.call,
    phase: 'active',
    answeredAt: new Date(s.answeredAt ?? Date.now()).toISOString(),
    calleeDevice: s.calleeDevice ?? '',
    ...(s.video ? { video: true } : {}),
  };
  if (r.timer) clearTimeout(r.timer);
  r.timer = remoteTimer(r.call.id, FED_CALL_ACTIVE_MAX_MS, 'disconnect');
  await publishRemote(r.call);
  if (ringPushOver(prev, r.call)) void unringPush(r.call);
}

async function finishRemote(r: RemoteCall, fin: { reason: CallEndReason; duration?: number; video?: boolean }): Promise<void> {
  if (remote.get(r.call.id) !== r) return;
  remote.delete(r.call.id);
  if (r.timer) clearTimeout(r.timer);
  const prev = r.call;
  r.call = {
    ...r.call,
    phase: 'ended',
    reason: fin.reason,
    ...(fin.duration && fin.duration > 0 ? { duration: fin.duration } : {}),
    ...(fin.video ? { video: true } : {}),
  };
  await publishRemote(r.call);
  // Запись «Пропущенный» придёт копией от дома звонившего (`convAccept`) своим пушем; здесь только снять «Входящий».
  if (ringPushOver(prev, r.call)) void unringPush(r.call);
}
