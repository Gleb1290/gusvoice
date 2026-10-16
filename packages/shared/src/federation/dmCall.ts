/**
 * ЛС между инстансами, этап Э6 (#141, признак `dmcall1`, `docs/dm/FEDERATION.md` §3.7) — провод звонков 1:1. ЧИСТЫЙ модуль.
 *
 * SFU — инстанса звонящего: звонок живёт в памяти его бэкенда, комната `dmcall_<id>` — на его LiveKit. Дом собеседника:
 * - получает приглашение СИНХРОННЫМ подписанным `POST /fed/v1/call/invite` — ответом «звоню» или отказом (занят, «кто может
 *   звонить», нельзя): звонящий узнаёт отказ сразу, как у местного звонка, а лежащий дом собеседника — сразу «недоступен»,
 *   а не 90 с гудков в пустоту;
 * - дальше ловит снимки фазы событием `call.state` по каналу событий связки (номер, очередь, повтор, порядок): ответ где-то
 *   (`active` + `callee_device`), конец (`ended` + причина) — это и есть `call.cancel` / `call.answered_elsewhere` / `call.end`
 *   плана одним видом: снимок идемпотентен, а порядок «ответили → положили» держит номер события.
 * Устаревшее (`expires_at` прошёл) дом собеседника не звонит.
 */
import { fedId } from './fieldRules';

export const FED_CALL_INVITE_PATH = '/fed/v1/call/invite';
export const FED_CALL_STATE_EVENT = 'call.state';

/** Причины отказа дома собеседника. Незнакомая — как `unavailable`. */
export const FED_CALL_REFUSALS = ['busy', 'privacy', 'unavailable'] as const;
export type FedCallRefusal = (typeof FED_CALL_REFUSALS)[number];

/** Запас поверх срока гудков звонящего: дом собеседника сам гасит «звонит», если конец так и не доехал. */
export const FED_CALL_GRACE_MS = 15_000;
/** Сколько дом собеседника держит копию ИДУЩЕГО звонка без вести о конце (звонящий пропал насовсем). */
export const FED_CALL_ACTIVE_MAX_MS = 4 * 60 * 60 * 1000;

const DEVICE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface FedCallInvite {
  instanceId: string;
  callId: string;
  conversationId: string;
  /** Звонящий — человек отправителя (его id у себя дома). */
  fromUserId: string;
  /** Кому — человек получателя (его местный id). */
  toUserId: string;
  video: boolean;
  createdAt: number;
  expiresAt: number;
}

export function serializeCallInvite(v: FedCallInvite): Record<string, unknown> {
  return {
    instance_id: v.instanceId,
    call_id: v.callId,
    conversation_id: v.conversationId,
    from: { user_id: v.fromUserId },
    to_user_id: v.toUserId,
    video: v.video,
    created_at: v.createdAt,
    expires_at: v.expiresAt,
  };
}

export function parseCallInvite(raw: unknown): FedCallInvite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = r.from && typeof r.from === 'object' ? (r.from as Record<string, unknown>) : null;
  const instanceId = fedId(r.instance_id);
  const callId = fedId(r.call_id);
  const conversationId = fedId(r.conversation_id);
  const fromUserId = fedId(from?.user_id);
  const toUserId = fedId(r.to_user_id);
  const createdAt = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? r.created_at : null;
  const expiresAt = typeof r.expires_at === 'number' && Number.isFinite(r.expires_at) ? r.expires_at : null;
  if (!instanceId || !callId || !conversationId || !fromUserId || !toUserId || createdAt === null || expiresAt === null) return null;
  return { instanceId, callId, conversationId, fromUserId, toUserId, video: r.video === true, createdAt, expiresAt };
}

/** Ответ на приглашение: `{ ok: true }` или `{ refused: причина }`. */
export type FedCallInviteAnswer = { ok: true } | { refused: FedCallRefusal };

export function serializeCallInviteAnswer(a: FedCallInviteAnswer): Record<string, unknown> {
  return 'ok' in a ? { ok: true } : { refused: a.refused };
}

export function parseCallInviteAnswer(raw: unknown): FedCallInviteAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.ok === true) return { ok: true };
  if (typeof r.refused === 'string') {
    return { refused: (FED_CALL_REFUSALS as readonly string[]).includes(r.refused) ? (r.refused as FedCallRefusal) : 'unavailable' };
  }
  return null;
}

/** Снимок фазы звонка от инстанса звонящего (событие `call.state`). */
export interface FedCallState {
  callId: string;
  conversationId: string;
  phase: 'active' | 'ended';
  /** Устройство собеседника, которым ответили (`active`): остальные его устройства гасят входящий. */
  calleeDevice?: string;
  answeredAt?: number;
  reason?: 'missed' | 'busy' | 'hangup' | 'disconnect';
  duration?: number;
  video?: boolean;
}

const REASONS = ['missed', 'busy', 'hangup', 'disconnect'] as const;

export function serializeCallState(s: FedCallState): Record<string, unknown> {
  return {
    call_id: s.callId,
    conversation_id: s.conversationId,
    phase: s.phase,
    ...(s.calleeDevice ? { callee_device: s.calleeDevice } : {}),
    ...(s.answeredAt !== undefined ? { answered_at: s.answeredAt } : {}),
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.duration !== undefined ? { duration: s.duration } : {}),
    ...(s.video ? { video: true } : {}),
  };
}

/** Незнакомая фаза — `null` (сосед новее: не угадываем); незнакомая причина конца — `hangup`. */
export function parseCallState(raw: unknown): FedCallState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const callId = fedId(r.call_id);
  const conversationId = fedId(r.conversation_id);
  const phase = r.phase === 'active' || r.phase === 'ended' ? r.phase : null;
  if (!callId || !conversationId || !phase) return null;
  const out: FedCallState = { callId, conversationId, phase };
  if (typeof r.callee_device === 'string' && DEVICE_RE.test(r.callee_device)) out.calleeDevice = r.callee_device;
  if (typeof r.answered_at === 'number' && Number.isFinite(r.answered_at)) out.answeredAt = r.answered_at;
  if (phase === 'ended') out.reason = (REASONS as readonly unknown[]).includes(r.reason) ? (r.reason as FedCallState['reason']) : 'hangup';
  if (typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration >= 0) out.duration = Math.floor(r.duration);
  if (r.video === true) out.video = true;
  return out;
}
