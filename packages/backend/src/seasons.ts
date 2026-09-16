import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { EARNED_REASONS, freezeWindow, seasonId, seasonRange, wearsCrown, type SeasonLength } from './coinRules.js';
import { db } from './db/index.js';
import { coinLedger, seasonResults, serverEconomy } from './db/schema.js';

/**
 * Закрытие сезона и заморозка итогов (этап 4, #117).
 *
 * 🔴 **Победитель записывается, а не вычисляется на лету.** Считай мы его запросом каждый раз —
 * поздняя правка данных (ретроначисление, выдача руками, чистка) задним числом отобрала бы корону у
 * того, кто её уже носил. Корона, которую можно отобрать вчерашним днём, — не награда.
 *
 * 🔴 **Итог считается по ЖУРНАЛУ, а не по счётчику `season_earned`.** Счётчик обнуляется ЛЕНИВО, у
 * каждого человека в свой момент — при первом начислении в новом сезоне. Значит тот, чей тик успел
 * пройти раньше заморозки, потерял бы своё место, а тот, кто не заходил, унёс бы прошлый счётчик в
 * новый сезон. Журнал такого порядка не знает: там у каждой строки своя дата.
 *
 * 🔴 **Смена разбивки (аудит помесячных сезонов, 03.09).** Сезон по новой разбивке — не «сезон с
 * этого момента», а календарное окно, в котором мы уже находимся: переключил на месяцы 15 октября —
 * текущий сезон «Октябрь» с первого числа. Отсюда три следствия, и все три живут здесь:
 *   1. старый сезон морозится только за часть ДО начала нового окна (`freezeWindow`), чтобы ни одна
 *      монета журнала не попала в два итога; сезон, начавшийся в том же окне, не подводится вовсе;
 *   2. сезонные счётчики кошельков ПЕРЕСЧИТЫВАЮТСЯ по журналу за новое окно, а не ждут ленивого
 *      обнуления — иначе живая таблица весь месяц показывала бы одно, а заморозка в конце подвела бы
 *      другое, и корона ушла бы не тому, кто был наверху;
 *   3. подведение на естественной границе ЗАМЕЩАЕТ досрочное: вернулся к временам года посреди
 *      осени — первого декабря осень подведётся целиком, а не останется с сентябрьским обрубком.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Закрыть прошедший сезон, если он сменился.
 *
 * Вызывать перед всем, что читает или пишет сезонные числа: тиком начисления и запросом таблицы
 * лидеров. Дешёвая при отсутствии смены — одно чтение строки настроек.
 *
 * ⚠️ Вся операция в ОДНОЙ транзакции с блокировкой строки настроек. Иначе два тика (или тик и
 * открытый кем-то лидерборд) заморозили бы один сезон дважды, и во второй раз — уже по частично
 * обнулённым данным.
 *
 * Возвращает идентификатор сезона, итоги которого заморожены этим вызовом, или `null`.
 */
export async function closeSeasonIfNeeded(serverId: string, now: Date): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ closed: serverEconomy.closedSeasonId, length: serverEconomy.seasonLength })
      .from(serverEconomy)
      .where(eq(serverEconomy.serverId, serverId))
      .limit(1)
      .for('update');
    if (!row) return null; // экономики на сервере нет — закрывать нечего
    // ⚠️ Разбивку читаем ВНУТРИ транзакции, вместе с отметкой: прочитай мы её снаружи, смена
    // ползунка между двумя чтениями дала бы заморозку не того сезона.
    const current = seasonId(now, row.length);

    // ⚠️ Первое наблюдение: просто запоминаем, в каком сезоне живём. Замораживать нечего — прошлого
    // сезона в этой экономике не было.
    if (row.closed === null) {
      await tx.update(serverEconomy).set({ closedSeasonId: current }).where(eq(serverEconomy.serverId, serverId));
      return null;
    }
    if (row.closed === current) return null; // сезон тот же, всё уже сделано

    // Сезон сменился: `row.closed` — тот, что кончился. Морозим его за окно ДО начала нового —
    // на естественной границе это весь сезон, при смене разбивки лишь часть, а если новый сезон
    // начался в том же окне, то ничего (`freezeWindow` → `null`).
    const finished = row.closed;
    const window = freezeWindow(finished, current);
    if (window) await freeze(tx, serverId, finished, window);
    await rebaseWallets(tx, serverId, current);

    await tx.update(serverEconomy).set({ closedSeasonId: current }).where(eq(serverEconomy.serverId, serverId));
    return window ? finished : null;
  });
}

/** Заморозить итоги сезона `finished` за окно `w` — по журналу заработков. */
async function freeze(tx: Tx, serverId: string, finished: string, w: { from: Date; to: Date }): Promise<void> {
  const totals = await tx
    .select({
      userId: coinLedger.userId,
      earned: sql<number>`SUM(${coinLedger.amount})::int`,
    })
    .from(coinLedger)
    .where(
      and(
        eq(coinLedger.serverId, serverId),
        inArray(coinLedger.reason, [...EARNED_REASONS]),
        gte(coinLedger.createdAt, w.from),
        lt(coinLedger.createdAt, w.to),
      ),
    )
    .groupBy(coinLedger.userId)
    // Места считаем по порядку запроса. 🔴 Ничья разрешается СТАБИЛЬНО — по сумме, потом по
    // идентификатору. Раньше второй ключ был только в комментарии, а не в запросе: при равных
    // суммах повторный расчёт мог поменять победителя местами.
    .orderBy(sql`SUM(${coinLedger.amount}) DESC`, coinLedger.userId);

  // 🔴 Досрочное подведение — временное, естественное его ЗАМЕЩАЕТ. Досрочный итог осени, снятый в
  // октябре при переходе на месяцы, содержит один сентябрь; если потом вернуться к временам года,
  // первого декабря осень подводится ещё раз — уже целиком. Оставь мы первую запись, корона за
  // осень досталась бы победителю сентября, а октябрь с ноябрём не считались бы ни в одном итоге.
  // Корону, которую носят СЕЙЧАС, это не трогает: она живёт в сезоне своей выдачи (`wearsCrown`)
  // и к естественной границе уже истекла. Повтор после сбоя между вставкой и отметкой безопасен по
  // той же причине — то же окно даёт те же строки.
  await tx
    .delete(seasonResults)
    .where(and(eq(seasonResults.serverId, serverId), eq(seasonResults.seasonId, finished)));

  const rows = totals.filter((t) => t.earned > 0);
  if (rows.length === 0) return;
  await tx.insert(seasonResults).values(
    rows.map((t, idx) => ({
      serverId,
      seasonId: finished,
      userId: t.userId,
      earned: t.earned,
      place: idx + 1,
    })),
  );
}

/**
 * Перевести кошельки сервера на сезон `current`: идентификатор и счётчик заработанного ЗА ЕГО ОКНО
 * по журналу.
 *
 * 🔴 Зачем, если `rollPeriods` и так обнулит счётчик при первом начислении. Обнуление верно на
 * естественной границе — там новое окно ещё пустое. При смене разбивки окно нового сезона уже
 * содержит заработанное (октябрь начался первого, переключили пятнадцатого), и обнулённый счётчик
 * показывал бы в таблице пять дней, а заморозка первого ноября посчитала бы по журналу все
 * тридцать. Корона ушла бы не тому, кого весь месяц видели наверху. Журнал — единственный
 * источник, с которым сверяется заморозка, поэтому и счётчик ставим по нему.
 *
 * ⚠️ Только те строки, где сезон ещё старый. Под `READ COMMITTED` строка, которую в этот момент
 * перекатывает тик или перевод, дождётся их фиксации и перепроверится по условию — сезон в ней
 * уже новый, и мы её не тронем. Так мы никогда не перезаписываем счётчик, который кто-то прямо
 * сейчас увеличивает.
 */
async function rebaseWallets(tx: Tx, serverId: string, current: string): Promise<void> {
  const { from } = seasonRange(current);
  await tx.execute(sql`
    UPDATE coin_balances b
       SET season_id = ${current},
           season_earned = COALESCE((
             SELECT SUM(l.amount)::int
               FROM coin_ledger l
              WHERE l.server_id = b.server_id
                AND l.user_id = b.user_id
                AND l.reason IN (${sql.join(EARNED_REASONS.map((r) => sql`${r}`), sql`, `)})
                AND l.created_at >= ${from}
           ), 0)
     WHERE b.server_id = ${serverId}
       AND b.season_id <> ${current}
  `);
}

/**
 * Победитель последнего ЗАКРЫТОГО сезона — тот, кто носит корону сейчас.
 *
 * ⚠️ Читается из замороженных итогов, а не считается. В этом весь смысл заморозки.
 */
export async function crownHolder(
  serverId: string,
  now: Date,
  length: SeasonLength,
): Promise<{ userId: string; seasonId: string; earned: number } | null> {
  const [row] = await db
    .select({
      userId: seasonResults.userId,
      seasonId: seasonResults.seasonId,
      earned: seasonResults.earned,
      frozenAt: seasonResults.frozenAt,
    })
    .from(seasonResults)
    .where(and(eq(seasonResults.serverId, serverId), eq(seasonResults.place, 1)))
    // Последний по времени заморозки — он же последний закрытый сезон.
    .orderBy(sql`${seasonResults.frozenAt} DESC`)
    .limit(1);
  // ⚠️ Корона висит ровно один сезон — тот, в котором её выдали (`wearsCrown`). Раньше срок считали
  // по моменту ОКОНЧАНИЯ закрытого сезона, и смена разбивки это ломала: осень, подведённая в
  // октябре, кончается первого декабря, а под месяцами это уже «Декабрь» — корона исчезала сразу
  // после переключения и всплывала через полтора месяца.
  if (!row || !wearsCrown(row.frozenAt, now, length)) return null;
  return { userId: row.userId, seasonId: row.seasonId, earned: row.earned };
}
