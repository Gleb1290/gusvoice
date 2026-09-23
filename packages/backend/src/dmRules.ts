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
 */

export type DmOpenVerdict = 'open-existing' | 'create' | 'no-shared-server';

export function decideDmOpen(input: {
  /** Беседа этой пары уже есть. */
  exists: boolean;
  /** Есть хотя бы один сервер, где состоят оба. */
  sharedServer: boolean;
  /** Открывает супер-админ инстанса: ему можно написать любому (он виртуальный участник любого сервера). */
  initiatorIsSuperAdmin: boolean;
}): DmOpenVerdict {
  if (input.exists) return 'open-existing';
  if (input.sharedServer || input.initiatorIsSuperAdmin) return 'create';
  return 'no-shared-server';
}

/** Текст отказа — показывается человеку как есть (клиент выводит `error` в тосте). */
export const DM_NO_SHARED_SERVER_ERROR = 'Написать можно только тому, с кем у вас есть общий сервер';

/** Текст отказа, когда собеседника больше нет. */
export const DM_PEER_GONE_ERROR = 'Собеседник удалил аккаунт';

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
}

export type OpenDmResult<Row> = { ok: true; row: Row } | { ok: false; reason: 'no-shared-server' };

/**
 * Открыть беседу: найти существующую, иначе проверить право и создать (#143).
 *
 * Вынесено из маршрута целиком, потому что интересное здесь — не запросы, а порядок: общий сервер
 * спрашиваем ТОЛЬКО когда беседы ещё нет (у существующей права уже были), а на гонке двух
 * одновременных открытий вставка ничего не вернёт — и тогда беседу надо перечитать, а не падать.
 */
export async function openDm<Row>(io: OpenDmIo<Row>, me: string, otherId: string): Promise<OpenDmResult<Row>> {
  const [a, b] = dmPair(me, otherId);
  const existing = await io.findExisting(a, b);

  const verdict = decideDmOpen({
    exists: !!existing,
    sharedServer: existing ? false : await io.shareServer(me, otherId),
    initiatorIsSuperAdmin: io.initiatorIsSuperAdmin(),
  });
  if (verdict === 'no-shared-server') return { ok: false, reason: 'no-shared-server' };
  if (existing) return { ok: true, row: existing };

  const created = await io.create(a, b);
  if (created) return { ok: true, row: created };
  // Гонка: вставка ничего не вернула, значит строку успел создать параллельный запрос — берём её.
  const raced = await io.findExisting(a, b);
  if (raced) return { ok: true, row: raced };
  // Ни вставки, ни строки: такого быть не должно. Раньше это давало TypeError у сериализации —
  // пусть хотя бы называет себя.
  throw new Error('не удалось ни создать беседу, ни найти созданную параллельно');
}
