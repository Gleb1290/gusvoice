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
  callServiceFallback,
  type CallEndReason,
  type CallJoinResponse,
  type ConvCallService,
  type DmCall,
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
}

const live = new Map<string, LiveCall>();
let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Копия живых звонков в Redis (`calls2`): поле — id звонка, значение — `{ call, seen }` (последний знак жизни, мс). Звонок
 * в памяти процесса; копия нужна только затем, чтобы после перезапуска бэкенда закрыть оборванные звонки записью в ленте
 * (`closeOrphanCalls`), а не потерять их молча.
 */
const LIVE_KEY = 'gv:calls:live';

function save(l: LiveCall): void {
  const seen = Math.max(l.seen.caller, l.seen.callee);
  void redisPub.hset(LIVE_KEY, l.call.id, JSON.stringify({ call: l.call, seen })).catch(() => {});
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
    let saved: { call?: DmCall; seen?: number };
    try {
      saved = JSON.parse(raw) as { call?: DmCall; seen?: number };
    } catch {
      continue;
    }
    if (!saved.call || saved.call.phase === 'ended') continue;
    const seen = typeof saved.seen === 'number' ? saved.seen : Date.now();
    const { reason } = orphanCallEnd(saved.call, seen);
    await end({ call: saved.call, ring: null, seen: { caller: seen, callee: seen } }, reason, seen).catch((e) =>
      console.error('[calls] orphan close failed:', e),
    );
    closed++;
  }
  return closed;
}

/** Мой текущий звонок (звонит или идёт). */
export function callOf(userId: string): DmCall | null {
  for (const l of live.values()) if (l.call.callerId === userId || l.call.calleeId === userId) return l.call;
  return null;
}

export function callById(id: string): DmCall | null {
  return live.get(id)?.call ?? null;
}

async function publish(call: DmCall): Promise<void> {
  const msg = { t: 'call.state' as const, call };
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

export type StartResult = { kind: 'ok'; call: DmCall; answered?: true } | { kind: 'busy' };

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
  const calls = [...live.values()].map((l) => l.call);
  if (inCall(calls, me) || inCall(calls, peerId)) return { kind: 'busy' };
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
  const l: LiveCall = { call, ring: null, seen: { caller: now, callee: now } };
  l.ring = setTimeout(() => void finish(l, null, 'timeout'), CALL_RING_TIMEOUT_MS);
  l.ring.unref?.();
  live.set(call.id, l);
  save(l);
  ensureWatchdog();
  await publish(call);
  void ringPush(call);
  return { kind: 'ok', call };
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
    await publish(l.call);
    if (ringPushOver(prev, l.call)) void unringPush(l.call);
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
  await publish(l.call);
  await record(l.call, reason, duration).catch((e) => console.error('[calls] record failed:', e));
  // После записи: «прочитано до» уже учитывает её, а «Пропущенный звонок» остаётся в шторке непрочитанным.
  if (ringPushOver(prev, l.call)) void unringPush(l.call);
  return l.call;
}

/** Запись о звонке в ленту — от звонившего; пропущенный — пуш и счётчик собеседнику, остальное сразу прочитано им. */
async function record(call: DmCall, reason: CallEndReason, duration: number): Promise<void> {
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
  if (!plan.markRead || sent.row.sortKey == null) return;
  const peerAccess = await loadAccess(call.conversationId, call.calleeId);
  if (!peerAccess) return;
  const read = await markRead(call.calleeId, peerAccess, sent.row.sortKey);
  if (read.kind === 'ok') await deliver(read.delivery);
}
