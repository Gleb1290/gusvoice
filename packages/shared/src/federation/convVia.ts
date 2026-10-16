/**
 * ЛС между инстансами, этап Э5 часть 1 (#141, `docs/dm/FEDERATION.md` §1.5, §4 п. 1 (б), Ф2): «мой дом лежит — пишу через
 * инстанс собеседника». ЧИСТЫЙ модуль: провод и правила, без базы и сети.
 *
 * Как это устроено (A — дом автора, B — инстанс собеседника, у B признак `dm4`):
 * 1. Пока A на связи, он заранее заводит своему человеку долгую сессию на B — тем же входом гостя (токен личности →
 *    `POST /fed/v1/session`), поэтому B попадает в «хосты, где ручались» (`grantHostsOf`), и «выйти везде» её гасит.
 * 2. A лёг — клиент пишет в беседу через B по этой сессии. B хранит сообщение как копию с пометкой «через A, не
 *    подтверждено» (`ConvMessage.via`) и показывает его своему человеку как обычно.
 * 3. A поднялся — клиент отдаёт дому список отправленного в обход (`client_id` + отпечаток), A забирает у B «через»-сообщения
 *    своих людей (`GET /fed/v1/conv/via`, подписанный) и сверяет: совпало — принимает как своё (та же `id`) и отвечает B
 *    `confirmed`; лишнее (дом за него не ручается) — `rejected`: B ставит надгробие и пишет держателю «возможна подделка».
 */
import { fedHash, fedId } from './fieldRules';
import { parseConvMessageWire, type FedConvMessageWire } from './convWire';

/** Подписанный GET соседа: «через»-сообщения его людей, которые ждут решения его дома. */
export const FED_VIA_PATH = '/fed/v1/conv/via';
/** Решение дома автора по одному «через»-сообщению — событием по каналу связки (`sendEventTo`). */
export const FED_VIA_VERDICT_EVENT = 'conv.via_verdict';

/**
 * - `confirmed` — клиент автора отчитался этим сообщением: дом принял его своим, пометка «не подтверждено» снимается.
 * - `rejected` — дом за него не ручается (клиент назвал другой отпечаток, отчёта нет, а `client_id` пуст, или беседа/автор
 *   не сходятся): надгробие у собеседника + оповещение держателю «возможна подделка».
 * - `duplicate` — то же сообщение уже есть у дома под другим id (клиент отправил его и домой): надгробие без оповещения,
 *   копия дома доедет обычным журналом.
 * - `unverified` — клиент так и не отчитался за `FED_VIA_LIMITS.claimWaitMs`: сообщение остаётся у собеседника с пометкой
 *   «не подтверждено» навсегда, дом его своим не делает и больше о нём не спрашивает.
 */
export const FED_VIA_VERDICTS = ['confirmed', 'rejected', 'duplicate', 'unverified'] as const;
export type FedViaVerdict = (typeof FED_VIA_VERDICTS)[number];

export const FED_VIA_LIMITS = {
  /** Сообщений на страницу `GET /fed/v1/conv/via`. */
  page: 200,
  /** Строк в одном отчёте клиента (`POST /conv/via-claims`). */
  claimsMax: 500,
  /** Сколько дом ждёт отчёта клиента о «через»-сообщении, прежде чем решить `unverified`. */
  claimWaitMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * Отчёт клиента — это вся его очередь отправленного в обход. Сообщение без строки в отчёте — «лишнее» (возможна подделка),
   * но решается это не сразу после отчёта: у человека может быть второе устройство, которое писало через соседа и ещё не
   * вернулось. Час на то, чтобы отчитались остальные.
   */
  reportGraceMs: 60 * 60 * 1000,
  /** Сколько дом хранит отчёт клиента, для которого ещё не пришло сообщение от соседа. */
  claimKeepMs: 14 * 24 * 60 * 60 * 1000,
} as const;

/** Состояние «через»-сообщения у инстанса собеседника (колонка `conversation_messages.via_state`). */
export type FedViaState = 'pending' | 'confirmed' | 'unverified';

// ─── Страница «через»-сообщений ──────────────────────────────────────────────────────────────────────────────────────

/** Сообщения уже в проводе (`serializeConvMessageWire`). */
export function serializeViaPage(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { items: [...items] };
}

/** Терпимый разбор: негодные строки выбрасываются, не страница целиком. */
export function parseViaPage(raw: unknown): FedConvMessageWire[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out: FedConvMessageWire[] = [];
  for (const it of items.slice(0, FED_VIA_LIMITS.page)) {
    const w = parseConvMessageWire(it);
    if (w) out.push(w);
  }
  return out;
}

// ─── Решение дома ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FedViaVerdictPayload {
  conversationId: string;
  messageId: string;
  verdict: FedViaVerdict;
}

export function serializeViaVerdict(v: FedViaVerdictPayload): Record<string, unknown> {
  return { conversation_id: v.conversationId, message_id: v.messageId, verdict: v.verdict };
}

/** Незнакомое решение — `null` (сосед новее: не угадываем). */
export function parseViaVerdict(raw: unknown): FedViaVerdictPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const conversationId = fedId(r.conversation_id);
  const messageId = fedId(r.message_id);
  const verdict = (FED_VIA_VERDICTS as readonly unknown[]).includes(r.verdict) ? (r.verdict as FedViaVerdict) : null;
  if (!conversationId || !messageId || !verdict) return null;
  return { conversationId, messageId, verdict };
}

// ─── Отчёт клиента ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Строка отчёта клиента: что он отправил в обход дома. `payloadHash` — `convRules.payloadHash` (sha256, hex). */
export interface FedViaClaim {
  conversationId: string;
  clientId: string;
  payloadHash: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Отчёт клиента (`POST /conv/via-claims` `{ items }`): негодные строки выбрасываются, больше `claimsMax` — `null`. */
export function parseViaClaims(raw: unknown): FedViaClaim[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length > FED_VIA_LIMITS.claimsMax) return null;
  const out: FedViaClaim[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const conversationId = fedId(r.conversationId);
    const clientId = fedId(r.clientId);
    const payloadHash = fedHash(r.payloadHash);
    if (conversationId && clientId && payloadHash && HEX64.test(payloadHash)) out.push({ conversationId, clientId, payloadHash });
  }
  return out;
}

/**
 * Сверка одного «через»-сообщения (дом автора). `claimHash` — отпечаток из отчёта клиента по тому же `client_id` (`null` —
 * отчёта нет); `wireHash` — отпечаток, который дом СЧИТАЕТ САМ по тексту и ответу из копии соседа (отпечатку соседа не
 * верим: подделавший текст подделал бы и его). `wait` — ещё ждать отчёта.
 */
export function viaVerdictFor(input: {
  clientId: string | null;
  claimHash: string | null;
  wireHash: string;
  /** Сколько сообщение ждёт у дома (от забора у соседа). */
  ageMs: number;
  /** Сколько прошло с последнего отчёта клиента этого человека (`null` — не отчитывался с тех пор, как сообщение пришло). */
  sinceReportMs: number | null;
}): FedViaVerdict | 'wait' {
  if (!input.clientId) return 'rejected';
  if (input.claimHash !== null) return input.claimHash === input.wireHash ? 'confirmed' : 'rejected';
  // Клиент отчитался, а этого сообщения в отчёте нет: лишнее — но после часа на отчёт других устройств.
  if (input.sinceReportMs !== null && input.sinceReportMs >= FED_VIA_LIMITS.reportGraceMs) return 'rejected';
  return input.ageMs >= FED_VIA_LIMITS.claimWaitMs ? 'unverified' : 'wait';
}
