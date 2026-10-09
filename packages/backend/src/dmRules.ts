/**
 * Кому можно открыть личную переписку — чистые правила, БЕЗ базы (F0 федерации, #139).
 *
 * 🔴 Раньше `POST /dm` создавал беседу с ЛЮБЫМ id инстанса: достаточно было знать id (он виден в
 * упоминаниях, аватарах, ссылках), чтобы писать человеку, с которым нет ничего общего. На публичной
 * коробке с несколькими сообществами это спам в личку кому угодно, а в федерации — ещё и гостям.
 *
 * Правило: НОВУЮ беседу можно открыть только с тем, с кем есть общий сервер. Уже существующая
 * беседа открывается всегда — у неё есть история, и отнимать её у двоих людей из-за того, что один
 * вышел из общего сервера, нельзя.
 *
 * ⚠️ Честная граница: в существующую беседу по-прежнему можно писать и без общего сервера. Спамеру
 * для этого нужно было однажды законно открыть беседу, то есть состоять с человеком в одном сервере.
 *
 * 🆕 05.10 (решение владельца, признак `users1`): политика инстанса «кто может начать личную переписку» — `dmPolicy`:
 * `shared` (как было, нет записи = она) или `anyone` — любой свой живой пользователь инстанса, найденный по @имени
 * (`userSearchRules.ts`). Защита `anyone`: не больше 10 НОВЫХ переписок в час с теми, с кем нет общего сервера
 * (`DM_NEW_LIMIT`; соседи по серверу и уже начатые беседы не считаются), получатель видит беседу только после первого
 * сообщения (`conversation_members.pending`, `conversations.ts`), блокировка работает как раньше — придержанное
 * (`blockRules.ts`) беседу получателю не показывает; гостям федерации — по-прежнему нельзя (до #141, ручки).
 */
import type { DmPolicy } from '@gusvoice/shared';

/**
 * `create` — новая беседа без предела (общий сервер, супер-админ); `create-limited` — новая беседа без общего сервера при
 * `anyone`: тратит одну из `DM_NEW_LIMIT`; `peer-unreachable` — при `anyone` собеседник не свой живой человек (удалён, не
 * подтверждён, не одобрен): для него он «не найден».
 */
export type DmOpenVerdict = 'open-existing' | 'create' | 'create-limited' | 'no-shared-server' | 'peer-unreachable';

export function decideDmOpen(input: {
  /** Беседа этой пары уже есть. */
  exists: boolean;
  /** Есть хотя бы один сервер, где состоят оба. */
  sharedServer: boolean;
  /** Открывает супер-админ инстанса: ему можно написать любому (он виртуальный участник любого сервера). */
  initiatorIsSuperAdmin: boolean;
  /** Политика инстанса (`dmPolicy`). Нет — `shared`, как до 05.10. */
  policy?: DmPolicy;
  /** Собеседник — свой живой человек (`userSearchRules.reachableUser`). Нет — живой. Читается только при `anyone`. */
  peerReachable?: boolean;
}): DmOpenVerdict {
  if (input.exists) return 'open-existing';
  if (input.sharedServer || input.initiatorIsSuperAdmin) return 'create';
  if (input.policy === 'anyone') return input.peerReachable === false ? 'peer-unreachable' : 'create-limited';
  return 'no-shared-server';
}

/** Ключ политики в `instance_settings` — та же таблица «ключ → JSON», что у `registration` (`instanceSetup.ts`). */
export const DM_POLICY_KEY = 'dm_policy';

export const DM_POLICIES = ['shared', 'anyone'] as const satisfies readonly DmPolicy[];

/**
 * Политика из сохранённого значения `{ policy }`. Нет записи или мусор → `shared`.
 * ⚠️ Мусор — как «было всегда», а не как самое открытое: битая запись не должна молча открывать личку всем.
 */
export function parseDmPolicy(value: unknown): DmPolicy {
  const p = (value as { policy?: unknown } | null | undefined)?.policy;
  return typeof p === 'string' && (DM_POLICIES as readonly string[]).includes(p) ? (p as DmPolicy) : 'shared';
}

/**
 * Предел НОВЫХ переписок с теми, с кем нет общего сервера: 10 в час на человека (`rateHit('dm-new:' + me, …)` в ОБЕИХ
 * ручках — `POST /api/conv/direct` и старой `POST /api/dm`). Тратится только на `create-limited` и только перед вставкой.
 */
export const DM_NEW_LIMIT = { max: 10, windowS: 3600 } as const;

/**
 * Машинные причины отказа открыть переписку — поле `reason` рядом с `error` (добавление, правило 11): клиент ветвится
 * по ним, а не по тексту. Не переименовываются.
 */
export const DM_OPEN_REASONS = { noSharedServer: 'dm.no_shared_server', newLimit: 'dm.new_limit' } as const;

/** Текст отказа — показывается человеку как есть (клиент выводит `error` в тосте). */
export const DM_NO_SHARED_SERVER_ERROR = 'Написать можно только тому, с кем у вас есть общий сервер';

/** Текст отказа, когда собеседника больше нет. */
export const DM_PEER_GONE_ERROR = 'Собеседник удалил аккаунт';

/** Текст 404 при `anyone`, когда собеседник не свой живой человек: удалён, не подтвердил почту или ждёт одобрения. */
export const DM_PEER_UNREACHABLE_ERROR = 'Пользователь не найден';

/** Текст 429 предела новых переписок: через сколько минут можно снова (не меньше одной). Старые клиенты покажут его же. */
export function dmNewLimitError(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Слишком много новых переписок за час. Написать новому человеку можно будет через ${minutes} мин.`;
}

/**
 * Пара беседы всегда в одном порядке (`a < b`) — так строка пары одна независимо от того, кто первым
 * нажал «Написать», и уникальный индекс ловит гонку двух одновременных открытий.
 */
export function dmPair(one: string, two: string): [string, string] {
  return one < two ? [one, two] : [two, one];
}

export type DmWriteVerdict = 'ok' | 'not-a-member' | 'peer-gone';

/**
 * Можно ли писать в эту беседу (F0 #139).
 *
 * ⚠️ Не участник — это `not-a-member` и ответ 404, а не 403: иначе по коду ответа можно перебирать,
 * какие беседы вообще существуют.
 * ⚠️ Собеседник удалил аккаунт — история остаётся читаемой, но писать больше некому. Пропавшая
 * строка пользователя приравнивается к удалённому: получатель не найден в обоих случаях.
 */
export function canWriteDm(input: { member: boolean; peerExists: boolean; peerDeleted: boolean }): DmWriteVerdict {
  if (!input.member) return 'not-a-member';
  if (!input.peerExists || input.peerDeleted) return 'peer-gone';
  return 'ok';
}

export interface OpenDmIo<Row> {
  /** Существующая беседа этой пары (аргументы уже упорядочены `dmPair`). */
  findExisting(a: string, b: string): Promise<Row | null>;
  /** Есть ли сервер, где состоят оба. Спрашивается только когда беседы ещё нет. */
  shareServer(me: string, other: string): Promise<boolean>;
  /** Открывает супер-админ инстанса. */
  initiatorIsSuperAdmin(): boolean;
  /** Создать беседу; `null` — строка уже появилась (гонка двух «Написать»). */
  create(a: string, b: string): Promise<Row | null>;
  /**
   * Политика инстанса (`dmPolicy`, 05.10). Нет метода — `shared`, как было. Спрашивается, только когда беседы нет, общего
   * сервера нет и открывает не супер-админ.
   */
  policy?(): Promise<DmPolicy>;
  /** Собеседник — свой живой человек (`userSearchRules.reachableUser`). Нет метода — живой. Спрашивается только при `anyone`. */
  peerReachable?(): boolean | Promise<boolean>;
  /**
   * Потратить одну новую переписку из предела `DM_NEW_LIMIT`: секунды до сброса окна или 0 — можно. Зовётся только на
   * `create-limited` и только перед вставкой. Нет метода — предела нет.
   */
  spendNewDm?(): Promise<number>;
}

export type OpenDmResult<Row> =
  | { ok: true; row: Row }
  | { ok: false; reason: 'no-shared-server' | 'peer-unreachable' }
  | { ok: false; reason: 'new-limit'; retryAfter: number };

/**
 * Отказ открыть переписку → ответ ручки, один на обе (`POST /api/conv/direct`, старая `POST /api/dm`): 403 «нет общего
 * сервера» (как с 15.09, плюс `reason`), 404 «не найден» при `anyone` и неживом собеседнике, 429 предела новых
 * переписок с `Retry-After`. Текст `error` — для человека как есть: 0.8.x покажут его в тосте без доработки.
 */
export function dmOpenRefusal(r: Extract<OpenDmResult<unknown>, { ok: false }>): {
  status: 403 | 404 | 429;
  retryAfter?: number;
  body: { error: string; reason?: string };
} {
  if (r.reason === 'new-limit') {
    return { status: 429, retryAfter: r.retryAfter, body: { error: dmNewLimitError(r.retryAfter), reason: DM_OPEN_REASONS.newLimit } };
  }
  if (r.reason === 'peer-unreachable') return { status: 404, body: { error: DM_PEER_UNREACHABLE_ERROR } };
  return { status: 403, body: { error: DM_NO_SHARED_SERVER_ERROR, reason: DM_OPEN_REASONS.noSharedServer } };
}

/**
 * Открыть беседу: найти существующую, иначе проверить право и создать (#143).
 *
 * Вынесено из маршрута целиком, потому что интересное здесь — не запросы, а порядок: общий сервер
 * спрашиваем ТОЛЬКО когда беседы ещё нет (у существующей права уже были), а на гонке двух
 * одновременных открытий вставка ничего не вернёт — и тогда беседу надо перечитать, а не падать.
 * Политику и «живой ли собеседник» (05.10) — только когда нет ни беседы, ни общего сервера и открывает не супер-админ;
 * предел новых переписок тратится последним, прямо перед вставкой: отказ по любой другой причине его не съедает.
 */
export async function openDm<Row>(io: OpenDmIo<Row>, me: string, otherId: string): Promise<OpenDmResult<Row>> {
  const [a, b] = dmPair(me, otherId);
  const existing = await io.findExisting(a, b);

  const sharedServer = existing ? false : await io.shareServer(me, otherId);
  const initiatorIsSuperAdmin = io.initiatorIsSuperAdmin();
  const stranger = !existing && !sharedServer && !initiatorIsSuperAdmin;
  const policy: DmPolicy = stranger && io.policy ? await io.policy() : 'shared';
  const peerReachable = policy === 'anyone' && io.peerReachable ? await io.peerReachable() : true;
  const verdict = decideDmOpen({ exists: !!existing, sharedServer, initiatorIsSuperAdmin, policy, peerReachable });
  if (verdict === 'no-shared-server' || verdict === 'peer-unreachable') return { ok: false, reason: verdict };
  if (existing) return { ok: true, row: existing };
  if (verdict === 'create-limited' && io.spendNewDm) {
    const retryAfter = await io.spendNewDm();
    if (retryAfter > 0) return { ok: false, reason: 'new-limit', retryAfter };
  }

  const created = await io.create(a, b);
  if (created) return { ok: true, row: created };
  // Гонка: вставка ничего не вернула, значит строку успел создать параллельный запрос — берём её.
  const raced = await io.findExisting(a, b);
  if (raced) return { ok: true, row: raced };
  // Ни вставки, ни строки: такого быть не должно. Раньше это давало TypeError у сериализации —
  // пусть хотя бы называет себя.
  throw new Error('не удалось ни создать беседу, ни найти созданную параллельно');
}
