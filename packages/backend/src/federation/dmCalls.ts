/**
 * ЛС между инстансами, этап Э6 (#141, признак `dmcall1`, `docs/dm/FEDERATION.md` §3.7) — звонки 1:1 с людьми соседей.
 *
 * SFU — инстанса звонящего: звонок заводится у него обычным `calls.startCall` (комната `dmcall_<id>` на его LiveKit), но вместо
 * местной доставки собеседнику-теневому — синхронное приглашение его дому (`inviteRemote` → `POST /fed/v1/call/invite`) и снимки
 * фазы событием связки (`sendCallState`, вид `call.state`). Дом собеседника (`acceptCallInvite`) проверяет беседу, блок и
 * «кто может звонить» и заводит «звонит» своему человеку (`calls.ringRemote`: `call.state` с `DmCall.host` клиентам с
 * `fedcall1` и пуш звонка). Приложение собеседника берёт гостевую сессию на инстансе звонящего (`GET /conv/:id/fallback?for=call`
 * — механизм Э5/F3) и отвечает туда (`/api/calls/:id/answer|decline|hangup|ping`). Запись о звонке — сообщение звонившего,
 * доезжает копией (Э2); её «прочитано» и тишину для состоявшегося звонка дом собеседника ставит сам (`callRecordCopied`).
 *
 * Крючки, не импорты, там, где модули проверяются с закрытым перечнем зависимостей: `calls.configureFedCalls`,
 * `conversations` (`noCalls` в `configureFederatedConv`), `convAccept.configureFedCallRecord`, `routes/conv` (`fallback`).
 */
import {
  CALL_BUSY_ERROR,
  CALL_PRIVACY_ERROR,
  CALL_RING_TIMEOUT_MS,
  FED_CALL_INVITE_PATH,
  FED_CALL_STATE_EVENT,
  FED_ERRORS,
  FED_FEATURES,
  parseCallInvite,
  parseCallInviteAnswer,
  parseCallState,
  serializeCallInvite,
  serializeCallInviteAnswer,
  serializeCallState,
  type CallEndReason,
  type DmCall,
  type FedCallInviteAnswer,
} from '@gusvoice/shared';
import { eq, inArray } from 'drizzle-orm';
import { isBlockedBy } from '../blocks.js';
import { callAllowedFor } from '../callPrivacy.js';
import { callRecordPlan } from '../callRules.js';
import { applyRemoteState, ringRemote } from '../calls.js';
import { deliver, loadAccess, markRead } from '../conversations.js';
import { db } from '../db/index.js';
import { federationLinks, users } from '../db/schema.js';
import { refreshCapabilities } from './directorySync.js';
import { onFedEvent, sendEventTo } from './eventStream.js';
import { shadowUserFor } from './guestHost.js';
import { federation } from './instance.js';
import { readInstanceMeta } from './instanceMeta.js';
import { linkVerdict } from './linkRules.js';
import { getLink } from './links.js';
import type { StoredLink } from './linkService.js';
import { postSignedToPeer } from './peerClient.js';

type Q = Pick<typeof db, 'select'>;
const CALL_UNAVAILABLE = 'Позвонить нельзя';

async function hasDmCall(link: { instanceId: string; apiBase: string; features: string[] }, now: number): Promise<boolean> {
  if (link.features.includes(FED_FEATURES.dmcall1)) return true;
  return (await refreshCapabilities(link, now).catch(() => link.features)).includes(FED_FEATURES.dmcall1);
}

// ─── Инстанс звонящего ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Пригласить дом собеседника-теневого (`calls.startCall`, крючок `invite`). `null` — звонит; иначе отказ для ручки
 * `POST /conv/:id/call`: занят — 409 `line_busy`, «кто может звонить» — 403 `call_privacy`, нельзя — 403, сосед без `dmcall1`
 * — 409 `federation.unsupported`, связка не работает — 409 её код, сосед лежит — 503 `federation.peer_unreachable`.
 */
export async function inviteRemote(call: DmCall, home: string, now = Date.now()): Promise<null | { status: number; error: string }> {
  const key = federation.signingKey();
  if (!federation.identity() || !key) return { status: 409, error: FED_ERRORS.dmUnavailable };
  const link = await getLink(home);
  if (!link) return { status: 409, error: FED_ERRORS.noLink };
  const refusal = linkVerdict(link, (await readInstanceMeta()).paused);
  if (refusal) return { status: 409, error: refusal };
  if (!(await hasDmCall(link, now))) return { status: 409, error: FED_ERRORS.unsupported };
  const [callee] = await db.select({ homeUserId: users.homeUserId }).from(users).where(eq(users.id, call.calleeId)).limit(1);
  if (!callee?.homeUserId) return { status: 403, error: CALL_UNAVAILABLE };
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return { status: 409, error: FED_ERRORS.noLink };
  }
  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: `/api${FED_CALL_INVITE_PATH}`,
    payload: serializeCallInvite({
      instanceId: federation.identity()!.instanceId,
      callId: call.id,
      conversationId: call.conversationId,
      fromUserId: call.callerId,
      toUserId: callee.homeUserId,
      video: call.video === true,
      createdAt: Date.parse(call.createdAt) || now,
      expiresAt: (Date.parse(call.createdAt) || now) + CALL_RING_TIMEOUT_MS,
    }),
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now,
  });
  if (!res.ok || res.value.status >= 500 || res.value.status === 429) return { status: 503, error: FED_ERRORS.peerUnreachable };
  // Маршрута нет — у соседа выключен `FEDERATION_DM_ENABLED` (визитка устарела).
  if (res.value.status === 404) return { status: 409, error: FED_ERRORS.unsupported };
  let answer: FedCallInviteAnswer | null = null;
  try {
    answer = parseCallInviteAnswer(JSON.parse(res.value.body));
  } catch {
    answer = null;
  }
  if (!answer) return { status: 503, error: FED_ERRORS.peerUnreachable };
  if ('ok' in answer) return null;
  if (answer.refused === 'busy') return { status: 409, error: CALL_BUSY_ERROR };
  if (answer.refused === 'privacy') return { status: 403, error: CALL_PRIVACY_ERROR };
  return { status: 403, error: CALL_UNAVAILABLE };
}

/** Снимок фазы — дому собеседника событием связки (номер, очередь, повтор, порядок «ответили → положили»). */
export function sendCallState(call: DmCall, home: string): void {
  if (call.phase === 'ringing') return;
  const payload = serializeCallState({
    callId: call.id,
    conversationId: call.conversationId,
    phase: call.phase,
    ...(call.calleeDevice ? { calleeDevice: call.calleeDevice } : {}),
    ...(call.answeredAt ? { answeredAt: Date.parse(call.answeredAt) } : {}),
    ...(call.reason ? { reason: call.reason } : {}),
    ...(call.duration !== undefined ? { duration: call.duration } : {}),
    ...(call.video ? { video: true } : {}),
  });
  void sendEventTo(home, FED_CALL_STATE_EVENT, payload).catch((e) => console.error('[dmCalls] state event failed:', e));
}

// ─── Дом собеседника ─────────────────────────────────────────────────────────────────────────────────────────────────

function answer(a: FedCallInviteAnswer): { status: number; body: Record<string, unknown> } {
  return { status: 200, body: serializeCallInviteAnswer(a) };
}

/**
 * `POST /fed/v1/call/invite` соседа (`routes/fedCalls.ts`): беседа 1:1 его человека с нашим (та же `id` у обоих), наш не удалён,
 * блока нет ни в одну сторону, «кто может звонить» нашего пускает → `calls.ringRemote`. Блок не раскрывается (`unavailable`).
 */
export async function acceptCallInvite(link: StoredLink, raw: unknown, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
  const inv = parseCallInvite(raw);
  if (!inv || inv.instanceId !== link.instanceId) return { status: 400, body: { error: 'bad-request' } };
  if (inv.expiresAt <= now) return answer({ refused: 'unavailable' });
  const caller = await shadowUserFor(link.instanceId, inv.fromUserId);
  if (!caller) return answer({ refused: 'unavailable' });
  const access = await loadAccess(inv.conversationId, inv.toUserId);
  if (!access || access.kind !== 'direct' || access.saved || access.peerId !== caller.id) return answer({ refused: 'unavailable' });
  const [callee] = await db.select({ home: users.homeInstanceId, deletedAt: users.deletedAt }).from(users).where(eq(users.id, inv.toUserId)).limit(1);
  if (!callee || callee.home !== null || callee.deletedAt) return answer({ refused: 'unavailable' });
  if ((await isBlockedBy(caller.id, inv.toUserId)) || (await isBlockedBy(inv.toUserId, caller.id))) return answer({ refused: 'unavailable' });
  if (!(await callAllowedFor(caller.id, inv.toUserId))) return answer({ refused: 'privacy' });
  const call: DmCall = {
    id: inv.callId,
    conversationId: inv.conversationId,
    callerId: caller.id,
    calleeId: inv.toUserId,
    phase: 'ringing',
    createdAt: new Date(inv.createdAt).toISOString(),
    callerDevice: 'remote',
    ...(inv.video ? { video: true } : {}),
    host: { instanceId: link.instanceId, apiBase: link.apiBase },
  };
  const rung = await ringRemote(call, inv.expiresAt, now);
  return rung === 'busy' ? answer({ refused: 'busy' }) : answer({ ok: true });
}

/**
 * Копия записи о звонке от дома звонившего (`convAccept.applyMessage`, крючок `configureFedCallRecord`): как у местной записи
 * (`calls.record` → `callRecordPlan`) — пропущенный будит пушем, остальное тихо и сразу «прочитано» нашим человеком.
 */
export function callRecordPlanFor(service: { kind?: unknown; reason?: unknown }): { notify: boolean; silent: boolean; markRead: boolean } | null {
  if (service.kind !== 'call') return null;
  const reason: CallEndReason = service.reason === 'busy' || service.reason === 'hangup' || service.reason === 'disconnect' ? service.reason : 'missed';
  return callRecordPlan(reason);
}

export async function callRecordCopied(conversationId: string, recipientId: string, sortKey: number): Promise<void> {
  const access = await loadAccess(conversationId, recipientId);
  if (!access) return;
  const read = await markRead(recipientId, access, sortKey);
  if (read.kind === 'ok') await deliver(read.delivery);
}

/** Сводка беседы (`ConvSummary.fedNoCalls`): из этих инстансов — те, чья связка не объявила `dmcall1` (визитка — в фоне). */
export async function homesWithoutCalls(homes: readonly string[], q: Q = db): Promise<Set<string>> {
  const uniq = [...new Set(homes)];
  if (uniq.length === 0) return new Set();
  const rows = await q
    .select({ instanceId: federationLinks.instanceId, apiBase: federationLinks.apiBase, features: federationLinks.features })
    .from(federationLinks)
    .where(inArray(federationLinks.instanceId, uniq));
  const byId = new Map(rows.map((r) => [r.instanceId, r]));
  const out = new Set<string>();
  for (const h of uniq) {
    const link = byId.get(h);
    if (link?.features.includes(FED_FEATURES.dmcall1)) continue;
    out.add(h);
    if (link) void refreshCapabilities(link, Date.now()).catch(() => {});
  }
  return out;
}

/** Обработчик снимков фазы от соседей (`index.ts`, только при `FEDERATION_DM_ENABLED`). */
export function startDmCalls(): void {
  onFedEvent(FED_CALL_STATE_EVENT, async ({ instanceId, event }) => {
    const s = parseCallState(event.payload);
    if (s) await applyRemoteState(instanceId, s);
  });
}
