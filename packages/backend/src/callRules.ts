/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, `calls1`) — чистые правила: кто что может сделать со звонком в какой фазе и чем он
 * кончается. Состояние и таймеры — `calls.ts`, ручки — `routes/calls.ts`. Поведение — Telegram (tdesktop `calls_call.cpp`,
 * `Call::hangup` / `Call::answer`, причины `PhoneCallDiscardReason`).
 */
import type { CallEndReason, DmCall, LastSeenPrivacy } from '@gusvoice/shared';
import { sharesLastSeen, type LastSeenException } from './lastSeenRules.js';

/** Комната LiveKit звонка. Не `channel_*` — presence её не трогает (`channelFromRoom`). */
export function callRoomName(callId: string): string {
  return `dmcall_${callId}`;
}

/** Действие над звонком: ответить, отклонить, положить трубку, истёк срок звонка, пропала связь у участника. */
export type CallAction = 'answer' | 'decline' | 'hangup' | 'timeout' | 'drop';

/**
 * Что будет со звонком от действия `action` участника `actor` (`null` у `timeout` / `drop` — решает сервер):
 * `answer` — только собеседник и только пока звонит; `decline` — собеседник, пока звонит (`busy`, как «Отклонить» у
 * Telegram); `hangup` — звонивший до ответа — отмена (`missed`: у собеседника «Пропущенный»), собеседник до ответа — то же,
 * что «Отклонить», любой после ответа — `hangup`; `timeout` — не ответили (`missed`); `drop` — пропала связь у участника
 * (`disconnect` после ответа, `missed` до него). `forbidden` — не участник или не его действие, `gone` — звонок уже кончился.
 */
export function callTransition(
  call: Pick<DmCall, 'phase' | 'callerId' | 'calleeId'>,
  actor: string | null,
  action: CallAction,
): { kind: 'answer' } | { kind: 'end'; reason: CallEndReason } | { kind: 'forbidden' } | { kind: 'gone' } {
  if (call.phase === 'ended') return { kind: 'gone' };
  const isCaller = actor === call.callerId;
  const isCallee = actor === call.calleeId;
  if (actor !== null && !isCaller && !isCallee) return { kind: 'forbidden' };
  const ringing = call.phase === 'ringing';
  switch (action) {
    case 'answer':
      return isCallee && ringing ? { kind: 'answer' } : { kind: 'forbidden' };
    case 'decline':
      return isCallee && ringing ? { kind: 'end', reason: 'busy' } : { kind: 'forbidden' };
    case 'hangup':
      if (!isCaller && !isCallee) return { kind: 'forbidden' };
      if (!ringing) return { kind: 'end', reason: 'hangup' };
      return { kind: 'end', reason: isCaller ? 'missed' : 'busy' };
    case 'timeout':
      return ringing ? { kind: 'end', reason: 'missed' } : { kind: 'gone' };
    case 'drop':
      return { kind: 'end', reason: ringing ? 'missed' : 'disconnect' };
  }
}

/** Длительность разговора, с: от ответа до конца, вниз до целой секунды; не отвечали — 0. */
export function callDurationSec(answeredAt: string | undefined, endedAtMs: number): number {
  if (!answeredAt) return 0;
  const from = Date.parse(answeredAt);
  return Number.isFinite(from) ? Math.max(0, Math.floor((endedAtMs - from) / 1000)) : 0;
}

/**
 * Что делать с записью о звонке у собеседника: пропущенный (`missed`) — обычное новое сообщение со звуком, счётчиком и
 * пушем «Пропущенный звонок»; остальное — без звука и пуша, и сразу «прочитано» собеседником (он и так видел звонок).
 */
export function callRecordPlan(reason: CallEndReason): { notify: boolean; silent: boolean; markRead: boolean } {
  const missed = reason === 'missed';
  return { notify: missed, silent: !missed, markRead: !missed };
}

/** Кто из участников затих: последний знак жизни старше `dropMs` — его id (звонивший проверяется первым), иначе `null`. */
export function silentParticipant(
  call: Pick<DmCall, 'phase' | 'callerId' | 'calleeId'>,
  lastSeen: { caller: number; callee: number },
  now: number,
  dropMs: number,
): string | null {
  if (call.phase === 'ended') return null;
  if (now - lastSeen.caller > dropMs) return call.callerId;
  if (call.phase === 'active' && now - lastSeen.callee > dropMs) return call.calleeId;
  return null;
}

/** Занят ли человек звонком (звонит или идёт разговор) — у Telegram одна линия. */
export function inCall(calls: Iterable<Pick<DmCall, 'phase' | 'callerId' | 'calleeId'>>, userId: string): boolean {
  for (const c of calls) if (c.phase !== 'ended' && (c.callerId === userId || c.calleeId === userId)) return true;
  return false;
}

/**
 * Звонок, оставшийся незавершённым после перезапуска бэкенда (`calls2`; состояние лежит в Redis, `calls.ts`), — чем его
 * закрыть. Шёл разговор — `disconnect`, длительность до последнего знака жизни (простой бэкенда в разговор не входит);
 * ещё звонил — `missed` (собеседник не ответил, у него — «Пропущенный звонок»).
 */
export function orphanCallEnd(call: Pick<DmCall, 'phase' | 'answeredAt'>, lastSeenMs: number): { reason: CallEndReason; duration: number } {
  if (call.phase === 'active') return { reason: 'disconnect', duration: callDurationSec(call.answeredAt, lastSeenMs) };
  return { reason: 'missed', duration: 0 };
}

/**
 * Текст пуша входящего звонка (`calls3`): tdesktop `lng_call_incoming` / `lng_call_video_incoming` — «Входящий звонок» /
 * «Входящий видеозвонок». Заголовок — звонящий (его прячет настройка показа, `pushRules.maskPushPayload`).
 */
export function incomingCallPushBody(video: boolean): string {
  return video ? 'Входящий видеозвонок' : 'Входящий звонок';
}

/**
 * Пуш «Входящий звонок» собеседнику (`calls3`) — как `phoneCallRequested` у Telegram Android через FCM: на все телефоны,
 * сразу. `dmId` — тап открывает беседу; `callId` / `video` — для будущего нативного экрана звонка. Аватар — только
 * http(s), как у пуша сообщения (`convSendFanout.conversationNotice`).
 */
export function incomingCallPush(
  call: Pick<DmCall, 'id' | 'conversationId' | 'callerId' | 'video' | 'createdAt'>,
  caller: { displayName: string | null; username: string; avatarUrl: string | null },
): {
  type: 'call';
  title: string;
  body: string;
  dmId: string;
  callId: string;
  author: string;
  authorId: string;
  avatar?: string;
  ts: number;
  video?: true;
} {
  const name = caller.displayName?.trim() || caller.username;
  const avatar = caller.avatarUrl && /^https?:\/\//i.test(caller.avatarUrl) ? caller.avatarUrl : undefined;
  const ts = Date.parse(call.createdAt);
  return {
    type: 'call',
    title: name,
    body: incomingCallPushBody(!!call.video),
    dmId: call.conversationId,
    callId: call.id,
    author: name,
    authorId: call.callerId,
    ...(avatar ? { avatar } : {}),
    ts: Number.isFinite(ts) ? ts : Date.now(),
    ...(call.video ? { video: true as const } : {}),
  };
}

/**
 * Снять пуш «Входящий звонок» (`calls3`): звонок перестал звонить — ответили (на любом устройстве), отклонили, отменили,
 * не дождались, оборвался. Снимает тихий `type: "read"` (как «прочитано на другом устройстве»), см. `calls.ts`.
 */
export function ringPushOver(prev: Pick<DmCall, 'phase'>, next: Pick<DmCall, 'phase'>): boolean {
  return prev.phase === 'ringing' && next.phase !== 'ringing';
}

/**
 * «Кто может звонить» (08.10, #211, решение владельца, `presence4`) — как у Telegram `PrivacyKeyPhoneCall` (tdesktop
 * `settings_privacy_controllers.cpp` `CallsPrivacyController`): Все / Собеседники и люди с общих серверов / Никто + исключения
 * «Всегда разрешать» / «Никогда не разрешать» (`privacy_exceptions`, ключ `calls`). По умолчанию — Все (как было до настройки).
 */
export const DEFAULT_CALL_PRIVACY: LastSeenPrivacy = 'everyone';

export function normalizeCallPrivacy(v: unknown): LastSeenPrivacy {
  return v === 'everyone' || v === 'peers' || v === 'nobody' ? v : DEFAULT_CALL_PRIVACY;
}

/**
 * Разрешает ли хозяин настройки `privacy` звонок человеку, который `isPeer` с ним (с 08.10, п.26, — принятый собеседник:
 * `peerQueries.isAcceptedPeer`: общий сервер, контакт или беседа, где хозяин отвечал; незнакомец с плашкой — нет),
 * с исключением хозяина для него. «Никогда» сильнее «Всегда», исключение сильнее правила — та же лестница, что у «Времени
 * захода» (`sharesLastSeen` без «Невидимого»: статус на звонки не влияет). Блокировка и удалённый аккаунт — отдельно
 * (`routes/calls.ts`).
 */
export function callAllowed(privacy: LastSeenPrivacy, isPeer: boolean, exception: LastSeenException = null): boolean {
  return sharesLastSeen(privacy, false, isPeer, exception);
}
