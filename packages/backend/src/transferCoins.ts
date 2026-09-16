import { and, eq, sql } from 'drizzle-orm';
import { dayStart, rollPeriods, type SeasonLength } from './coinRules.js';
import { db } from './db/index.js';
import { coinBalances, coinLedger } from './db/schema.js';
import { id } from './util.js';

/**
 * Перевод монет между людьми ОДНОЙ транзакцией с блокировкой обоих кошельков (#123).
 *
 * 🔴 Зачем отдельная функция, а не пара вызовов `moveCoins`. Прежний порядок был «прочитали
 * состояние → решили, можно ли → изменили тремя запросами». Между чтением и записью ничего не
 * держало состояние, поэтому два одновременных типа проходили проверку по одному и тому же старому
 * числу: человек с десятью монетами отправлял два раза по десять и уходил в минус, а суточные
 * пределы (включая тот, что защищает от травли) обходились тем же способом.
 *
 * Здесь проверка и изменение неразделимы: строки кошельков блокируются, состояние перечитывается
 * ВНУТРИ блокировки, и только потом меняется.
 *
 * ⚠️ Блокируем в едином порядке по `userId`. Иначе двое, типающие друг друга в одно мгновение,
 * возьмут блокировки крест-накрест и встанут намертво.
 */

export type TransferBlock = 'poor' | 'out-limit' | 'in-limit' | 'pair-limit';

export interface TransferInput {
  serverId: string;
  fromUserId: string;
  toUserId: string;
  /** Сколько списываем с отправителя. */
  debit: number;
  /** Сколько доходит до получателя (остальное сгорает налогом). */
  credit: number;
  /** Сгоревшее — только для журнала. */
  burned: number;
  /** Суточный предел отдачи. 0 — без предела. */
  dailyOut: number;
  /** Суточный предел приёма. 0 — без предела. */
  dailyIn: number;
  /** Сколько ОДИН отправитель может донести ОДНОМУ получателю за сутки. 0 — без предела. */
  dailyPair: number;
  /** Сколько РАЗНЫХ людей за сутки идёт получателю в признание (источник уровня). */
  maxTippersPerDay: number;
  /**
   * Разбивка сезона на сервере.
   *
   * 🔴 Обязательна. Без неё перекат считал по временам года, и на сервере с помесячными сезонами
   * КАЖДЫЙ тип «видел смену сезона» и обнулял сезонный счёт ОБОИМ — отправителю и получателю, —
   * выкидывая их из таблицы лидеров (аудит помесячных сезонов, 03.09).
   */
  seasonLength: SeasonLength;
  /** Текущий момент. ⚠️ Аргументом: часов внутри этого модуля нет — их не подменить в тесте. */
  now: Date;
}

export interface TransferResult {
  /** Причина отказа или `null`, если перевод состоялся. */
  block: TransferBlock | null;
  /** Сколько получатель принял за сутки ДО этого перевода — для отбивки «на сегодня хватит». */
  receivedBefore: number;
  /** И сколько стало. */
  receivedAfter: number;
}

/** Поля суток и сезона — пишем ТОЛЬКО когда действительно перекатились. */
function dayFields(r: {
  rolled: boolean;
  seasonRolled: boolean;
  next: { day: string; seasonId: string; seasonEarned: number };
}) {
  return {
    ...(r.rolled ? { day: r.next.day, secondsToday: 0, earnedToday: 0 } : {}),
    ...(r.seasonRolled ? { seasonId: r.next.seasonId, seasonEarned: 0 } : {}),
  };
}

export async function transferCoins(i: TransferInput): Promise<TransferResult> {
  return db.transaction(async (tx) => {
    // 🔴 Строки кошельков создаём САМИ, до блокировки. Маршрут читает их через `walletOf`, который
    // отдаёт виртуальные нули и строку НЕ создаёт, — а `FOR UPDATE` блокирует только существующие.
    // Без этого первый же тип новому человеку возвращал «не хватает монет»: строки получателя ещё
    // нет, блокировка её не находит (нашёл Codex; регресс появился вместе с самой транзакцией).
    // ⚠️ Порядок вставки тоже по `user_id` — по той же причине, что и порядок блокировки.
    for (const uid of [i.fromUserId, i.toUserId].sort()) {
      await tx.insert(coinBalances).values({ serverId: i.serverId, userId: uid }).onConflictDoNothing();
    }

    // 🔴 Блокировка ОБОИХ кошельков до единого чтения. Порядок по `user_id` — против взаимного
    // дедлока, когда двое типают друг друга одновременно.
    const locked = await tx.execute(sql`
      SELECT user_id, balance, given_today, received_today, recognition_today,
             day, season_id, seconds_today, earned_today, season_earned
        FROM coin_balances
       WHERE server_id = ${i.serverId}
         AND user_id IN (${i.fromUserId}, ${i.toUserId})
       ORDER BY user_id
         FOR UPDATE
    `);

    interface LockedRow {
      user_id: string;
      balance: number;
      given_today: number;
      received_today: number;
      day: string;
      recognition_today: number;
      season_id: string;
      seconds_today: number;
      earned_today: number;
      season_earned: number;
    }
    const rows = (locked.rows ?? []) as unknown as LockedRow[];

    /**
     * 🔴 Перекат суток ПРЯМО ЗДЕСЬ (#124, С3). Раньше сутки перекатывало только начисление, а оно
     * выходит раньше записи для тех, кто отказался от участия в экономике. Такой человек типать
     * может, но его `given_today` не обнулялся НИКОГДА: накопив однажды суточный предел отдачи, он
     * навсегда получал «на сегодня монеты кончились — завтра снова», и завтра не наступало.
     *
     * ⚠️ Катим ВСЕ суточные поля, а не только счётчики типов. Тронь `day` в одиночку — и начисление
     * решит, что сутки уже перекатаны, и не сбросит потолок с затуханием: вчерашние `seconds_today`
     * и `earned_today` поехали бы в новый день. `rollPeriods` — та же функция, которой пользуется
     * начисление, поэтому «перекатать» здесь и там означает ровно одно и то же.
     */
    const roll = (r: LockedRow) => {
      const next = rollPeriods(
        {
          day: r.day,
          seasonId: r.season_id,
          secondsToday: r.seconds_today,
          earnedToday: r.earned_today,
          seasonEarned: r.season_earned,
        },
        i.now,
        i.seasonLength,
      );
      const rolled = next.day !== r.day;
      return {
        rolled,
        seasonRolled: next.seasonId !== r.season_id,
        next,
        givenToday: rolled ? 0 : r.given_today,
        receivedToday: rolled ? 0 : r.received_today,
        recognitionToday: rolled ? 0 : r.recognition_today,
      };
    };

    const mineRow = rows.find((r) => r.user_id === i.fromUserId);
    const theirsRow = rows.find((r) => r.user_id === i.toUserId);

    // Строки только что созданы выше — если их всё равно нет, это рассинхрон, а не «ноль монет».
    // Отказываем по бедности: направление ошибки должно быть в сторону НЕ списать.
    if (!mineRow || !theirsRow) return { block: 'poor' as const, receivedBefore: 0, receivedAfter: 0 };

    // Сколько типов от этого человека уже было сегодня — нужно и потолку пары, и признанию.
    let pairCountToday = 0;

    // Перекат считаем ОДИН раз и им же пользуемся и в проверках, и в записи: посчитай дважды — и
    // однажды они разойдутся.
    const rolledMine = roll(mineRow);
    const rolledTheirs = roll(theirsRow);
    const mine = { ...mineRow, given_today: rolledMine.givenToday };
    const theirs = { ...theirsRow, received_today: rolledTheirs.receivedToday };

    // Перепроверяем ВНУТРИ блокировки, а не доверяем тому, что прочитал маршрут до неё.
    if (mine.balance < i.debit) return { block: 'poor' as const, receivedBefore: theirs.received_today, receivedAfter: theirs.received_today };
    if (i.dailyOut > 0 && mine.given_today + i.debit > i.dailyOut) {
      return { block: 'out-limit' as const, receivedBefore: theirs.received_today, receivedAfter: theirs.received_today };
    }
    if (i.dailyIn > 0 && theirs.received_today + i.credit > i.dailyIn) {
      return { block: 'in-limit' as const, receivedBefore: theirs.received_today, receivedAfter: theirs.received_today };
    }

    // 🔴 Потолок ПАРЫ (#124, В2): сколько именно этот отправитель донёс именно этому получателю за
    // сутки. Без него один человек двадцатью типами забивал жертве весь суточный приём — и до утра
    // её не мог типнуть больше никто, а она двадцать раз слышала «динь».
    //
    // ⚠️ Считаем по ЖУРНАЛУ, а не по новому счётчику. Счётчик пары пришлось бы держать отдельным
    // состоянием на каждую пару людей и перекатывать по суткам; журнал уже содержит точный ответ,
    // лежит в той же транзакции и покрыт индексом `(server_id, user_id, created_at)`. Меньше
    // состояния — меньше того, что может разъехаться.
    // ⚠️ Запрос идёт ВСЕГДА, а не только при включённом потолке пары. Сначала он стоял под
    // `if (i.dailyPair > 0)`, и при выключенном потолке `pairCountToday` оставался нулём — то есть
    // признание (ниже) начислялось бы за КАЖДЫЙ тип одного и того же человека, а не за первый.
    // Ползунок, выключающий чужую защиту, — классическая форма этой ошибки.
    const paired = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::int AS total, COUNT(*)::int AS n
        FROM coin_ledger
       WHERE server_id = ${i.serverId}
         AND user_id = ${i.toUserId}
         AND reason = 'tip.in'
         AND ref_user_id = ${i.fromUserId}
         AND created_at >= ${dayStart(i.now)}
    `);
    const pairRow = paired.rows?.[0] as { total: number | string; n: number | string } | undefined;
    pairCountToday = Number(pairRow?.n ?? 0);
    if (i.dailyPair > 0 && Number(pairRow?.total ?? 0) + i.credit > i.dailyPair) {
      return { block: 'pair-limit' as const, receivedBefore: theirs.received_today, receivedAfter: theirs.received_today };
    }

    /**
     * 🔴 ПРИЗНАНИЕ — источник уровня получателя (решение 2026-09-01): «тип это благодарность
     * за хорошую шутку, она должна что-то значить».
     *
     * Считаем не монеты, а факт: этот человек типнул тебя сегодня ВПЕРВЫЕ. Сумму можно занести с
     * альта, разных людей — нет, поэтому в уровень идут именно люди.
     * ⚠️ Суточный потолок обязателен: без него компания из пятнадцати человек за вечер выдавала бы
     * уровень быстрее, чем само присутствие.
     * ⚠️ Считается по ЧИСЛУ строк журнала, а не по сумме: при налоге 100 % до получателя доходит
     * ноль, и «первый тип» по сумме был бы неотличим от «типов не было».
     */
    const firstFromThisPersonToday = pairCountToday === 0;
    const recognise =
      firstFromThisPersonToday && rolledTheirs.recognitionToday < i.maxTippersPerDay && i.maxTippersPerDay > 0;

    // ⚠️ Счётчик суток пишется АБСОЛЮТНО, когда сутки перекатились (обнулить и прибавить), и
    // инкрементом, когда нет: инкремент поверх вчерашнего числа как раз и был бы потерей переката.
    await tx
      .update(coinBalances)
      .set({
        balance: sql`${coinBalances.balance} - ${i.debit}`,
        givenToday: rolledMine.rolled ? i.debit : sql`${coinBalances.givenToday} + ${i.debit}`,
        ...dayFields(rolledMine),
      })
      .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.fromUserId)));

    await tx
      .update(coinBalances)
      .set({
        balance: sql`${coinBalances.balance} + ${i.credit}`,
        receivedToday: rolledTheirs.rolled ? i.credit : sql`${coinBalances.receivedToday} + ${i.credit}`,
        // Признание: и пожизненный счётчик, и суточный — оба только когда человек новый за сегодня.
        ...(recognise
          ? {
              recognitionTippers: sql`${coinBalances.recognitionTippers} + 1`,
              recognitionToday: rolledTheirs.rolled ? 1 : sql`${coinBalances.recognitionToday} + 1`,
            }
          : rolledTheirs.rolled
            ? { recognitionToday: 0 }
            : {}),
        ...dayFields(rolledTheirs),
      })
      .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.toUserId)));

    // ⚠️ `earnedTotal` и `seasonEarned` НЕ трогаем: входящий тип — не заработок. Иначе уровни и
    // место в сезонной таблице покупались бы переводом с альта.
    await tx.insert(coinLedger).values([
      {
        id: id(),
        serverId: i.serverId,
        userId: i.fromUserId,
        amount: -i.debit,
        reason: 'tip.out',
        refUserId: i.toUserId,
        data: { burned: i.burned },
      },
      {
        id: id(),
        serverId: i.serverId,
        userId: i.toUserId,
        amount: i.credit,
        reason: 'tip.in',
        refUserId: i.fromUserId,
        data: { burned: i.burned },
      },
    ]);

    return {
      block: null,
      receivedBefore: theirs.received_today,
      receivedAfter: theirs.received_today + i.credit,
    };
  });
}
