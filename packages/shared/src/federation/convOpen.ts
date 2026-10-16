/**
 * ЛС между инстансами (#141, этап Э1): «открыть беседу с человеком соседа» — провод `POST /fed/v1/conv/open` и чистые правила.
 *
 * Дом инициатора спрашивает дом получателя подписанным запросом (`docs/dm/FEDERATION.md` §1.2, §3.3). Решает ДОМ ПОЛУЧАТЕЛЯ
 * (Ф6): настройка инстанса «кто может начать переписку с людьми других инстансов» — `shared` (только общий сервер, по
 * умолчанию) или `anyone` (все, не больше `FED_DM_NEW_LIMIT` новых переписок в час от одного человека соседа).
 *
 * 🔴 Коды и причины отказа — часть протокола (как `FED_ERRORS`): не переименовываются, новая причина = новая строка;
 * незнакомую причину получатель показывает как `policy` (терпимый читатель). Блокировку получатель НЕ раскрывает — она
 * уходит как `policy` (§4.3). Исторические примеры — `fixtures/v1/conv-open-*.json` (append-only, страж `check-protocol`).
 *
 * Встречное создание (оба открыли одновременно): одна беседа на пару, побеждает МЕНЬШИЙ `conversation_id` (UUIDv7 — более
 * ранний) — `convOpenWinner`. Ключ пары у обеих сторон один (`fedDirectKey`), `UNIQUE(direct_key)` держит остальное.
 */
import { fedDisplayText, fedHash, fedId, fedUsername, FED_FIELD_LIMITS } from './fieldRules';

/** Путь запроса у соседа (под `/api`, как все `/fed/v1/*`). */
export const FED_CONV_OPEN_PATH = '/fed/v1/conv/open';

/** Причины отказа `federation.dm_refused`. */
export const FED_DM_REFUSAL = {
  /** Политика дома получателя (и замаскированная блокировка). */
  policy: 'policy',
  /** Человека нет, удалён, не подтверждён или не одобрен. */
  noUser: 'no_user',
  /** Скрыт админом от соседей (Ф11): первым ему не написать. */
  hidden: 'hidden',
  /** Предел новых переписок от этого человека соседа исчерпан. */
  rate: 'rate',
  /**
   * «Кто может мне писать» получателя (`msgpriv1`, 13.10): пишут только его контакты и те, кому он писал сам. Добавление:
   * старый сосед неизвестную причину читает как `policy` (`parseConvOpenResponse`).
   */
  privacy: 'privacy',
} as const;
export type FedDmRefusal = (typeof FED_DM_REFUSAL)[keyof typeof FED_DM_REFUSAL];

/** Настройка инстанса получателя (Ф6). Нет записи или мусор — `shared`. */
export const FED_DM_POLICIES = ['shared', 'anyone'] as const;
export type FedDmPolicy = (typeof FED_DM_POLICIES)[number];

export function parseFedDmPolicy(raw: unknown): FedDmPolicy {
  const v = (raw as { policy?: unknown } | null)?.policy ?? raw;
  return v === 'anyone' ? 'anyone' : 'shared';
}

/**
 * Флаг инстанса `FEDERATION_DM_ENABLED` (только вместе с `FEDERATION_ENABLED`) — то же условие, что `env.federation.dmEnabled`
 * бэкенда; здесь чистая функция для мест, где `env` нельзя (`instanceFeatures.ts`: `env` требует DATABASE_URL).
 */
export function fedDmEnabledFromEnv(e: Record<string, string | undefined>): boolean {
  return (e.FEDERATION_ENABLED ?? '').toLowerCase() === 'true' && (e.FEDERATION_DM_ENABLED ?? '').toLowerCase() === 'true';
}

/** Ф6: при «все» — не больше 10 новых переписок в час от одного человека соседа (и столько же у инициатора на его доме). */
export const FED_DM_NEW_LIMIT = { max: 10, windowS: 3600 } as const;

/** Общих серверов в запросе — не больше (сосед шлёт мусор). */
const SHARED_MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FedConvOpenRequest {
  instanceId: string;
  from: { userId: string; username: string; displayName: string; avatarHash: string | null };
  toUserId: string;
  conversationId: string;
  /** Мс эпохи, часы дома инициатора. */
  createdAt: number;
  /**
   * Серверы на доме ИНИЦИАТОРА, где состоят оба (инициатор — свой, получатель — гостем). Дом получателя сверяет их со
   * своим индексом членств (`federation_memberships`): своему человеку он верит, чужому списку — только в пересечении.
   */
  sharedServerIds: string[];
}

/**
 * Профиль получателя в ответе «можно/уже есть» (поле `to`): дом инициатора заводит по нему теневую строку, если человека ещё
 * нет в кеше каталога (каталог догоняет раз в минуты). Нет поля — дом инициатора берёт профиль из каталога.
 */
export interface FedConvOpenProfile {
  username: string;
  displayName: string;
  avatarHash: string | null;
}

export type FedConvOpenResponse =
  | { kind: 'ok'; conversationId: string; to?: FedConvOpenProfile | null }
  | { kind: 'exists'; conversationId: string; to?: FedConvOpenProfile | null }
  | { kind: 'refused'; reason: FedDmRefusal };

export function serializeConvOpenRequest(r: FedConvOpenRequest): Record<string, unknown> {
  return {
    instance_id: r.instanceId,
    from: {
      user_id: r.from.userId,
      username: r.from.username,
      display_name: r.from.displayName,
      avatar_hash: r.from.avatarHash,
    },
    to_user_id: r.toUserId,
    conversation_id: r.conversationId,
    created_at: r.createdAt,
    shared_server_ids: r.sharedServerIds.slice(0, SHARED_MAX),
  };
}

/** Терпимый разбор: незнакомые поля игнорируются; негодный конверт — `null`. */
export function parseConvOpenRequest(raw: unknown): FedConvOpenRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const from = (o.from ?? null) as Record<string, unknown> | null;
  const instanceId = fedId(o.instance_id);
  const userId = from ? fedId(from.user_id) : null;
  const username = from ? fedUsername(from.username) : null;
  const toUserId = fedId(o.to_user_id);
  const conversationId = typeof o.conversation_id === 'string' && UUID_RE.test(o.conversation_id) ? o.conversation_id : null;
  const createdAt = typeof o.created_at === 'number' && Number.isFinite(o.created_at) && o.created_at > 0 ? o.created_at : null;
  if (!instanceId || !from || !userId || !username || !toUserId || !conversationId || createdAt === null) return null;
  const shared = Array.isArray(o.shared_server_ids) ? o.shared_server_ids : [];
  return {
    instanceId,
    from: {
      userId,
      username,
      displayName: fedDisplayText(from.display_name, FED_FIELD_LIMITS.displayName, username),
      avatarHash: fedHash(from.avatar_hash),
    },
    toUserId,
    conversationId,
    createdAt,
    sharedServerIds: shared.slice(0, SHARED_MAX).map(fedId).filter((v): v is string => v !== null),
  };
}

export function serializeConvOpenResponse(r: FedConvOpenResponse): Record<string, unknown> {
  const to = r.kind !== 'refused' && r.to ? { to: { username: r.to.username, display_name: r.to.displayName, avatar_hash: r.to.avatarHash } } : {};
  if (r.kind === 'ok') return { ok: true, conversation_id: r.conversationId, ...to };
  if (r.kind === 'exists') return { exists: r.conversationId, ...to };
  return { error: 'federation.dm_refused', reason: r.reason };
}

/**
 * Ответ соседа. Отказ с незнакомой причиной — `policy` (сосед новее нас). Не ответ и не отказ — `null` (дом инициатора
 * показывает «инстанс ответил непонятно» как недоступность).
 */
export function parseConvOpenResponse(raw: unknown): FedConvOpenResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
  const t = (o.to ?? null) as Record<string, unknown> | null;
  const toName = t ? fedUsername(t.username) : null;
  const to: FedConvOpenProfile | null =
    t && toName
      ? { username: toName, displayName: fedDisplayText(t.display_name, FED_FIELD_LIMITS.displayName, toName), avatarHash: fedHash(t.avatar_hash) }
      : null;
  if (o.ok === true && id(o.conversation_id)) return { kind: 'ok', conversationId: id(o.conversation_id)!, to };
  if (id(o.exists)) return { kind: 'exists', conversationId: id(o.exists)!, to };
  if (o.error === 'federation.dm_refused') {
    const known = Object.values(FED_DM_REFUSAL) as string[];
    const reason = typeof o.reason === 'string' && known.includes(o.reason) ? (o.reason as FedDmRefusal) : 'policy';
    return { kind: 'refused', reason };
  }
  return null;
}

/**
 * Решение дома получателя (порядок важен): беседа уже есть → `exists` (у существующей права уже были); человека нет →
 * `no_user`; скрыт от соседей → `hidden`; заблокировал инициатора → `policy` (не раскрываем); общий сервер → можно; политика
 * `shared` → `policy`; `anyone` → предел (`rate`) или можно. Предел тратится вызывающим только на `create-limited`.
 */
export function decideFedDmOpen(input: {
  exists: boolean;
  targetOk: boolean;
  hidden: boolean;
  blocked: boolean;
  sharedServer: boolean;
  policy: FedDmPolicy;
}): 'exists' | 'create' | 'create-limited' | FedDmRefusal {
  if (input.exists) return 'exists';
  if (!input.targetOk) return FED_DM_REFUSAL.noUser;
  if (input.hidden) return FED_DM_REFUSAL.hidden;
  if (input.blocked) return FED_DM_REFUSAL.policy;
  if (input.sharedServer) return 'create';
  return input.policy === 'anyone' ? 'create-limited' : FED_DM_REFUSAL.policy;
}

/** Встречное создание: побеждает меньший id (UUIDv7 сортируется по времени — более ранний). */
export function convOpenWinner(mine: string, theirs: string): 'mine' | 'theirs' {
  return mine <= theirs ? 'mine' : 'theirs';
}

/**
 * Поиск человека соседа: `@имя@домен` или `имя@домен` → части; без домена — `null` (ищем как раньше, только среди своих и
 * по имени в кеше каталога). Домен — как в визитке: хост с необязательным портом, в нижнем регистре.
 */
export function parseRemoteHandle(raw: string): { username: string; domain: string } | null {
  const m = /^@?([A-Za-z0-9_.-]{1,32})@([A-Za-z0-9.-]+(?::\d{1,5})?)$/.exec(raw.trim());
  return m ? { username: m[1]!.toLowerCase(), domain: m[2]!.toLowerCase() } : null;
}
