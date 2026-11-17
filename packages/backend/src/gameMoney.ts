import type { GamesLaunchDto } from '@gusvoice/shared';
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { dayStart } from './coinRules.js';
import { applyCoins, isBotUser, lockWallet, pushWallet } from './coins.js';
import { db } from './db/index.js';
import { coinBalances, coinLedger, gameRounds, gameStakes, predictionEvents, serverEconomy } from './db/schema.js';
import {
  effectiveLossLimit,
  GAMES_LAUNCH_REASON,
  GAME_LOSS_REASONS,
  gameReasons,
  gamesView,
  lossTodayFrom,
  resolveLossLimit,
  stakeBlock,
  type GamesView,
  type StakeBlock,
  type StakeCheck,
} from './gameMoneyRules.js';

/**
 * Деньги мини-игр (ГусКоины 2, этап 1) — транзакции. Правила — `gameMoneyRules.ts`, план — `docs/guscoins-v2-plan.md`.
 *
 * 🔴 Гарантии:
 * - Ставка — эскроу: строка журнала `<kind>.bet|stake` с минусом в момент ставки, монеты висят в `game_stakes`.
 *   Баланс всегда равен сумме журнала — `drift` (`routes/economy.ts`, сводка) пуст.
 * - Идемпотентность — условным UPDATE: выплата ставит `paid_at`, возврат — `refunded_at`, оба только при `IS NULL`
 *   обоих; деньги двигаются ТОЛЬКО если строка вернулась. Повтор после падения посреди выплаты не платит дважды.
 *   Второй рубеж — частичный UNIQUE журнала `coin_ledger_game_once_uq` (миграция 0160).
 * - Порядок блокировок: раунд (`FOR SHARE` у ставки; расчёт раунда берёт его UPDATE'ом) → кошельки по `user_id`
 *   (`lockWallets`, как `transferCoins.ts`). Иначе ставка и расчёт раунда встали бы крест-накрест.
 * - Шина (`pushWallet`) — только после коммита (`withGameMoney`).
 * - Выигрыш — НЕ заработок (Р6): `applyCoins` без `countsAsEarned`, сезон не растёт.
 * ⚠️ Замок от двойного нажатия (`SET NX`) — в маршрутах этапа 2, не здесь: здесь истина, там — удобство.
 */

/** Транзакция — нужны ещё и сырые запросы. */
export type GameTx = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

/** Проиграно за сутки МСК по журналу игр (по образцу пара-предела `transferCoins.ts`). */
export async function lossTodayOf(q: Pick<typeof db, 'select'>, serverId: string, userId: string, now: Date): Promise<number> {
  const [row] = await q
    .select({ total: sql<number>`COALESCE(SUM(${coinLedger.amount}), 0)::int` })
    .from(coinLedger)
    .where(
      and(
        eq(coinLedger.serverId, serverId),
        eq(coinLedger.userId, userId),
        inArray(coinLedger.reason, [...GAME_LOSS_REASONS]),
        gte(coinLedger.createdAt, dayStart(now)),
      ),
    );
  // ⚠️ Покрыто индексом `coin_ledger_wallet_idx (server_id, user_id, created_at)`; `::int` — драйвер отдаёт SUM строкой.
  return lossTodayFrom(Number(row?.total ?? 0));
}

/**
 * Заблокировать кошельки нескольких людей одного сервера в едином порядке по `user_id`, заведя недостающие строки.
 * Для дуэли (два кошелька в одной транзакции) и расчёта раунда — до первого `applyCoins`.
 * ⚠️ Ботов сюда не передавать: им кошелёк не заводится (проверка `isBotUser` — у вызывающего, до эскроу).
 */
export async function lockWallets(tx: GameTx, serverId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  for (const userId of ids) await tx.insert(coinBalances).values({ serverId, userId }).onConflictDoNothing();
  await tx
    .select({ userId: coinBalances.userId })
    .from(coinBalances)
    .where(and(eq(coinBalances.serverId, serverId), inArray(coinBalances.userId, ids)))
    .orderBy(asc(coinBalances.userId))
    .for('update');
}

export interface PlaceStakeInput {
  serverId: string;
  roundId: string;
  userId: string;
  /** Сектор/сторона/исход; у дуэли — `'duel'`. */
  pick: string;
  amount: number;
  /** Соперник в дуэли — в журнал (`ref_user_id`), для пара-предела и истории. */
  refUserId?: string;
  now?: Date;
}

export type PlaceStakeResult = { ok: true; balance: number } | { ok: false; block: StakeBlock };

type Wallet = Awaited<ReturnType<typeof lockWallet>>;

/** Вход `stakeBlock` по уже заблокированному кошельку: настройки игр сервера, предел проигрыша, проигранное за сутки. */
async function stakeCheckFor(
  tx: GameTx,
  i: { serverId: string; userId: string; amount: number; pick: string },
  isBot: boolean,
  wallet: Wallet,
  now: Date,
): Promise<StakeCheck> {
  const [economy] = await tx.select().from(serverEconomy).where(eq(serverEconomy.serverId, i.serverId)).limit(1);
  const limit = resolveLossLimit(
    { lossLimit: wallet?.gamesLossLimit ?? null, raise: wallet?.gamesLossLimitRaise ?? null, raiseAt: wallet?.gamesLossLimitRaiseAt ?? null },
    now,
  );
  const lossToday = wallet ? await lossTodayOf(tx, i.serverId, i.userId, now) : 0;
  return {
    economyEnabled: economy?.enabled ?? false,
    gamesEnabled: economy?.gamesEnabled ?? false,
    isBot,
    optedOut: wallet?.optedOut ?? false,
    gamesOptOut: wallet?.gamesOptOut ?? false,
    amount: i.amount,
    pick: i.pick,
    betMax: economy?.gamesBetMax ?? 0,
    balance: wallet?.balance ?? 0,
    lossToday,
    effectiveLimit: effectiveLossLimit(limit.lossLimit, economy?.gamesDailyLossMax ?? 0),
  };
}

/**
 * Проверка ставки БЕЗ записи (этап 3: мягкий предпросмотр вызова дуэли для ОБОИХ под `lockWallets`) — те же правила,
 * что у `placeStake`, ничего не списывается. Кошелёк блокируется и заводится при отсутствии (`lockWallet`).
 */
export async function stakeCheckOf(
  tx: GameTx,
  c: { serverId: string; userId: string; amount: number; pick: string; now?: Date },
): Promise<StakeBlock | null> {
  const isBot = await isBotUser(tx, c.userId);
  const wallet = isBot ? undefined : await lockWallet(tx, c.serverId, c.userId);
  return stakeBlock(await stakeCheckFor(tx, c, isBot, wallet, c.now ?? new Date()));
}

/**
 * Сделать ставку внутри транзакции: раунд `FOR SHARE` → кошелёк `FOR UPDATE` → проверки → строка ставки → списание.
 *
 * 🔴 Строка ставки вставляется ДО списания и `ON CONFLICT DO NOTHING`: повтор той же ставки (тот же раунд, человек,
 * выбор) получает `duplicate` и денег второй раз не теряет. Две ставки на последние монеты упираются в блокировку
 * кошелька: вторая видит уже уменьшенный баланс и получает `poor`.
 */
export async function placeStake(tx: GameTx, i: PlaceStakeInput): Promise<PlaceStakeResult> {
  const now = i.now ?? new Date();
  const [round] = await tx
    .select({ kind: gameRounds.kind, state: gameRounds.state, serverId: gameRounds.serverId })
    .from(gameRounds)
    .where(eq(gameRounds.id, i.roundId))
    .limit(1)
    .for('share');
  if (!round || round.serverId !== i.serverId || round.state !== 'open') return { ok: false, block: 'round-closed' };
  const isBot = await isBotUser(tx, i.userId);
  // Бот: кошелёк не заводим вовсе — `stakeBlock` ответит `bot` (или `games-off`).
  const wallet = isBot ? undefined : await lockWallet(tx, i.serverId, i.userId);
  // 🔴 Блокировка кошелька — раньше правил: две ставки на последние монеты упираются в неё, вторая видит остаток.
  const block = stakeBlock(await stakeCheckFor(tx, i, isBot, wallet, now));
  if (block) {
    // Повтор уже сделанной ставки (двойное нажатие, переотправка) — говорим «уже сделана», а не «не хватает монет»:
    // деньги за неё уже списаны. Истина всё равно ниже — `ON CONFLICT` по ключу ставки.
    if (block === 'poor' || block === 'loss-limit') {
      const [same] = await tx.select({ amount: gameStakes.amount }).from(gameStakes).where(stakeWhere(i)).limit(1);
      if (same) return { ok: false, block: 'duplicate' };
    }
    return { ok: false, block };
  }
  const inserted = await tx
    .insert(gameStakes)
    .values({ roundId: i.roundId, userId: i.userId, serverId: i.serverId, pick: i.pick, amount: i.amount })
    .onConflictDoNothing()
    .returning({ roundId: gameStakes.roundId });
  if (inserted.length === 0) return { ok: false, block: 'duplicate' };
  const balance = await applyCoins(tx, {
    serverId: i.serverId,
    userId: i.userId,
    amount: 0 - i.amount,
    reason: gameReasons(round.kind).stake,
    refUserId: i.refUserId,
    data: { roundId: i.roundId, pick: i.pick },
  });
  return { ok: true, balance };
}

export interface StakeKey {
  roundId: string;
  userId: string;
  pick: string;
}

export interface PayStakeInput extends StakeKey {
  /** Сколько выплатить по этой ставке; 0 — ставка проиграла (отметка без строки журнала). */
  payout: number;
  /**
   * Соперник (дуэль). 🔴 У `duel.win` обязателен: выигрыш дуэли идёт в суточный предел пары наравне с `tip.in`
   * (`transferCoins.ts`) — иначе дуэль «на проигрыш» стала бы переводом в обход пределов.
   */
  refUserId?: string;
}

/** Результат выплаты/возврата: `null` — ставка уже закрыта (повтор), деньги не двигались. */
export type SettleResult = { serverId: string; amount: number } | null;

/**
 * Выплатить ставку: условный UPDATE `paid_at` (только при `paid_at IS NULL AND refunded_at IS NULL`), и лишь при
 * вернувшейся строке — `applyCoins` +payout причиной `<kind>.win`. В `data.net` — чистый перевод от соперника
 * (выплата минус своя ставка): по нему считается пара-предел.
 * ⚠️ Кошельки участников раунда блокировать заранее и по порядку (`lockWallets`); выплаты вести в порядке `user_id`.
 */
export async function payStake(tx: GameTx, i: PayStakeInput): Promise<SettleResult> {
  if (!Number.isInteger(i.payout) || i.payout < 0) throw new Error(`payStake: неверная выплата ${i.payout}`);
  const [stake] = await tx
    .update(gameStakes)
    .set({ paidAt: new Date(), payout: i.payout })
    .where(and(stakeWhere(i), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
    .returning({ serverId: gameStakes.serverId, amount: gameStakes.amount });
  if (!stake) return null;
  if (i.payout > 0) {
    const kind = await kindOf(tx, i.roundId);
    await applyCoins(tx, {
      serverId: stake.serverId,
      userId: i.userId,
      amount: i.payout,
      reason: gameReasons(kind).win,
      refUserId: i.refUserId,
      data: { roundId: i.roundId, pick: i.pick, net: i.payout - stake.amount },
    });
  }
  return { serverId: stake.serverId, amount: i.payout };
}

/** Вернуть ставку: так же, через `refunded_at`; причина `<kind>.refund`, сумма — сама ставка. */
export async function refundStake(tx: GameTx, i: StakeKey): Promise<SettleResult> {
  const [stake] = await tx
    .update(gameStakes)
    .set({ refundedAt: new Date() })
    .where(and(stakeWhere(i), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
    .returning({ serverId: gameStakes.serverId, amount: gameStakes.amount });
  if (!stake) return null;
  const kind = await kindOf(tx, i.roundId);
  await applyCoins(tx, {
    serverId: stake.serverId,
    userId: i.userId,
    amount: stake.amount,
    reason: gameReasons(kind).refund,
    data: { roundId: i.roundId, pick: i.pick },
  });
  return { serverId: stake.serverId, amount: stake.amount };
}

/**
 * Удаление аккаунта (`accountDelete.ts`): вернуть все незакрытые ставки человека ДО обезличивания, в той же
 * транзакции. Иначе эскроу повис бы навсегда, а раунд нельзя было бы закрыть честно.
 * Возвращает серверы, где что-то вернулось.
 */
export async function refundOpenStakesOf(tx: GameTx, userId: string): Promise<string[]> {
  const open = await tx
    .select({ roundId: gameStakes.roundId, pick: gameStakes.pick, serverId: gameStakes.serverId })
    .from(gameStakes)
    .where(and(eq(gameStakes.userId, userId), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
    .orderBy(asc(gameStakes.serverId), asc(gameStakes.roundId), asc(gameStakes.pick));
  const servers = new Set<string>();
  for (const s of open) {
    const done = await refundStake(tx, { roundId: s.roundId, userId, pick: s.pick });
    if (done) servers.add(done.serverId);
  }
  return [...servers];
}

/** Деньги игр одной транзакцией: методы помнят тронутые кошельки, `pushWallet` — после коммита. */
export interface GameMoney {
  tx: GameTx;
  placeStake(i: PlaceStakeInput): Promise<PlaceStakeResult>;
  payStake(i: PayStakeInput): Promise<SettleResult>;
  refundStake(i: StakeKey): Promise<SettleResult>;
  lockWallets(serverId: string, userIds: string[]): Promise<void>;
}

export async function withGameMoney<T>(fn: (m: GameMoney) => Promise<T>): Promise<T> {
  const touched = new Map<string, { serverId: string; userId: string }>();
  const touch = (serverId: string, userId: string) => touched.set(`${serverId}\u0000${userId}`, { serverId, userId });
  const result = await db.transaction(async (tx) =>
    fn({
      tx,
      placeStake: async (i) => {
        const r = await placeStake(tx, i);
        if (r.ok) touch(i.serverId, i.userId);
        return r;
      },
      payStake: async (i) => {
        const r = await payStake(tx, i);
        if (r && r.amount > 0) touch(r.serverId, i.userId);
        return r;
      },
      refundStake: async (i) => {
        const r = await refundStake(tx, i);
        if (r) touch(r.serverId, i.userId);
        return r;
      },
      lockWallets: (serverId, userIds) => lockWallets(tx, serverId, userIds),
    }),
  );
  // 🔴 Только после коммита: откатившаяся транзакция не должна показывать людям чужие числа.
  for (const w of touched.values()) await pushWallet(w.serverId, w.userId);
  return result;
}

/**
 * Игры сервера выключены (владелец снял `gamesEnabled` или экономику — `PATCH …/economy`; такт колеса увидел выключенное):
 * живые (`open|locked`) раунды сервера → `cancelled`, каждой незакрытой ставке — возврат `<kind>.refund`. `roundIds` —
 * только эти раунды (такт колеса отменяет тот, что держит), без него — все живые раунды сервера.
 *
 * 🔴 Порядок замков как у расчёта: раунды `FOR UPDATE` (по id) → кошельки по `user_id` → возвраты. Звать в ОТДЕЛЬНОЙ
 * транзакции от правки настроек: та держит строку `server_economy`, а ставка колеса берёт раунд раньше неё — вместе
 * они встали бы крест-накрест. Взнос в сундук колеса не возвращается: он из доли дома, а не сверху ставки.
 * Возвращает отменённые раунды — вызывающий рассылает события своей игры (дуэли — `announceCancelledDuels`).
 * `reason` (дуэль, этап 3: `games-off`) пишется в `data.reason` отменённых раундов — клиент показывает, почему.
 *
 * Ставки на события (этап 5): вопрос — раунд `kind='prediction'`, его событие (`prediction_events`) тоже переводится в
 * `cancelled` с `cancel_reason = reason` (по умолчанию `games-off`). 🔴 Замок события — ПЕРВЫМ (ставка берёт событие
 * `FOR SHARE` раньше вопроса): без `roundIds` блокируются все живые события сервера; с `roundIds` вопросов событие
 * обязан заблокировать вызывающий (`gamePredictions.ts`). У отменённого вопроса в ответе — `eventId`.
 */
export async function cancelLiveRounds(
  m: GameMoney,
  serverId: string,
  roundIds?: string[],
  reason?: string,
): Promise<{ id: string; kind: string; eventId?: string }[]> {
  if (roundIds && roundIds.length === 0) return [];
  if (!roundIds) {
    await m.tx
      .select({ id: predictionEvents.id })
      .from(predictionEvents)
      .where(and(eq(predictionEvents.serverId, serverId), inArray(predictionEvents.state, ['open', 'locked'])))
      .orderBy(asc(predictionEvents.id))
      .for('update');
  }
  const rounds = await m.tx
    .select({ id: gameRounds.id, kind: gameRounds.kind, eventId: sql<string | null>`${gameRounds.data}->>'eventId'` })
    .from(gameRounds)
    .where(
      and(
        eq(gameRounds.serverId, serverId),
        inArray(gameRounds.state, ['open', 'locked']),
        roundIds ? inArray(gameRounds.id, roundIds) : undefined,
      ),
    )
    .orderBy(asc(gameRounds.id))
    .for('update');
  if (rounds.length === 0) return [];
  const ids = rounds.map((r) => r.id);
  const open = await m.tx
    .select({ roundId: gameStakes.roundId, userId: gameStakes.userId, pick: gameStakes.pick })
    .from(gameStakes)
    .where(and(inArray(gameStakes.roundId, ids), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
    .orderBy(asc(gameStakes.userId), asc(gameStakes.roundId), asc(gameStakes.pick));
  await m.lockWallets(serverId, open.map((s) => s.userId));
  for (const s of open) await m.refundStake(s);
  await m.tx
    .update(gameRounds)
    .set(reason ? { state: 'cancelled', data: sql`${gameRounds.data} || jsonb_build_object('reason', ${reason}::text)` } : { state: 'cancelled' })
    .where(inArray(gameRounds.id, ids));
  const eventIds = [...new Set(rounds.filter((r) => r.kind === 'prediction' && r.eventId).map((r) => r.eventId as string))];
  if (eventIds.length > 0) {
    await m.tx
      .update(predictionEvents)
      .set({ state: 'cancelled', settledAt: new Date(), cancelReason: reason ?? 'games-off' })
      .where(and(inArray(predictionEvents.id, eventIds), inArray(predictionEvents.state, ['open', 'locked'])));
  }
  return rounds.map((r) => (r.kind === 'prediction' && r.eventId ? { id: r.id, kind: r.kind, eventId: r.eventId } : { id: r.id, kind: r.kind }));
}

/** Отменённая дуэль — для рассылки после коммита (`announceCancelledDuels`). */
export interface CancelledDuel {
  id: string;
  serverId: string;
  /** Чьи ставки вернулись (кошелькам — `pushWallet`). */
  refunded: string[];
}

/**
 * Удаление аккаунта посреди дуэли (этап 3, «дыра удаления»): живые (`open|locked`) дуэли человека → `cancelled` с
 * `data.reason = 'player-deleted'`, ставки — назад ОБОИМ. Звать в транзакции удаления ДО `refundOpenStakesOf`.
 *
 * 🔴 Без этого `refundOpenStakesOf` вернул бы только ставку удаляемого, а такт потом заплатил бы оставшемуся `duel.win`
 * из банка, половины которого уже нет, — монеты из воздуха, и `drift` (журнал = баланс) этого не видит.
 * Находит и вызовы без ставок (`data.challengerId/targetId`), и партии по ставкам. Порядок замков как у расчёта:
 * раунды `FOR UPDATE` по id → кошельки по `user_id` → возвраты. После коммита — `announceCancelledDuels`.
 */
export async function cancelDuelsOf(tx: GameTx, userId: string): Promise<CancelledDuel[]> {
  const rounds = await tx
    .select({ id: gameRounds.id, serverId: gameRounds.serverId })
    .from(gameRounds)
    .where(
      and(
        eq(gameRounds.kind, 'duel'),
        inArray(gameRounds.state, ['open', 'locked']),
        or(
          sql`${gameRounds.data}->>'challengerId' = ${userId}`,
          sql`${gameRounds.data}->>'targetId' = ${userId}`,
          sql`${gameRounds.id} IN (SELECT ${gameStakes.roundId} FROM ${gameStakes} WHERE ${gameStakes.userId} = ${userId})`,
        ),
      ),
    )
    .orderBy(asc(gameRounds.id))
    .for('update');
  const out: CancelledDuel[] = [];
  for (const round of rounds) {
    const open = await tx
      .select({ roundId: gameStakes.roundId, userId: gameStakes.userId, pick: gameStakes.pick })
      .from(gameStakes)
      .where(and(eq(gameStakes.roundId, round.id), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
      .orderBy(asc(gameStakes.userId), asc(gameStakes.pick));
    await lockWallets(tx, round.serverId, open.map((s) => s.userId));
    const refunded: string[] = [];
    for (const s of open) if (await refundStake(tx, s)) refunded.push(s.userId);
    await tx
      .update(gameRounds)
      .set({ state: 'cancelled', data: sql`${gameRounds.data} || jsonb_build_object('reason', 'player-deleted')` })
      .where(eq(gameRounds.id, round.id));
    out.push({ id: round.id, serverId: round.serverId, refunded });
  }
  return out;
}

type DuelAnnouncer = (serverId: string, roundIds: string[]) => Promise<void>;
let duelAnnouncer: DuelAnnouncer | null = null;

/**
 * Рассылку `duel.state` подключает модуль дуэли (`gameDuel.ts`) при загрузке. Обратная зависимость нарочно перевёрнута:
 * удаление аккаунта и правка экономики знают только деньги игр, а не DTO и шину дуэли. Модуль дуэли не загружен
 * (экономика выключена) — живых дуэлей нет, рассылать нечего.
 */
export function configureDuelAnnouncer(fn: DuelAnnouncer | null): void {
  duelAnnouncer = fn;
}

/**
 * После коммита отмены: кошельки, куда вернулись ставки (кроме `skipUserId` — удалённого), и `duel.state` по каждой
 * отменённой дуэли. Best-effort: деньги уже в базе, сбой шины — только в лог.
 */
export async function announceCancelledDuels(duels: CancelledDuel[], skipUserId?: string): Promise<void> {
  for (const d of duels) {
    for (const userId of d.refunded) if (userId !== skipUserId) await pushWallet(d.serverId, userId).catch(() => {});
  }
  const byServer = new Map<string, string[]>();
  for (const d of duels) byServer.set(d.serverId, [...(byServer.get(d.serverId) ?? []), d.id]);
  for (const [serverId, ids] of byServer) {
    try {
      await duelAnnouncer?.(serverId, ids);
    } catch (err) {
      console.warn(`[duel] duel.state после отмены ${serverId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Отменённое событие для ставок (этап 5) — для рассылки после коммита (`announceCancelledPredictions`). */
export interface CancelledPrediction {
  id: string;
  serverId: string;
  /** Чьи ставки вернулись (кошелькам — `pushWallet`). */
  refunded: string[];
}

/**
 * Удаление аккаунта СОЗДАТЕЛЯ события (этап 5): его живые (`open|locked`) события → `cancelled`
 * (`cancel_reason = 'creator-deleted'`), все ставки всех вопросов — назад. Звать в транзакции удаления ДО
 * `refundOpenStakesOf`. Без этого событие висело бы до автоотмены (итог подводит только создатель), а эскроу — с ним.
 * Ставки самого удаляемого в чужих событиях возвращает `refundOpenStakesOf`: итог считает только живые ставки.
 * Порядок замков как у итога: событие `FOR UPDATE` → вопросы `FOR UPDATE` по id → кошельки по `user_id` → возвраты.
 */
export async function cancelPredictionsOf(tx: GameTx, userId: string): Promise<CancelledPrediction[]> {
  const events = await tx
    .select({ id: predictionEvents.id, serverId: predictionEvents.serverId })
    .from(predictionEvents)
    .where(and(eq(predictionEvents.createdBy, userId), inArray(predictionEvents.state, ['open', 'locked'])))
    .orderBy(asc(predictionEvents.id))
    .for('update');
  const out: CancelledPrediction[] = [];
  for (const ev of events) {
    const rounds = await tx
      .select({ id: gameRounds.id })
      .from(gameRounds)
      .where(and(eq(gameRounds.kind, 'prediction'), sql`${gameRounds.data}->>'eventId' = ${ev.id}`, inArray(gameRounds.state, ['open', 'locked'])))
      .orderBy(asc(gameRounds.id))
      .for('update');
    const ids = rounds.map((r) => r.id);
    const open =
      ids.length === 0
        ? []
        : await tx
            .select({ roundId: gameStakes.roundId, userId: gameStakes.userId, pick: gameStakes.pick })
            .from(gameStakes)
            .where(and(inArray(gameStakes.roundId, ids), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
            .orderBy(asc(gameStakes.userId), asc(gameStakes.roundId), asc(gameStakes.pick));
    await lockWallets(tx, ev.serverId, open.map((s) => s.userId));
    const refunded = new Set<string>();
    for (const s of open) if (await refundStake(tx, s)) refunded.add(s.userId);
    if (ids.length > 0) {
      await tx
        .update(gameRounds)
        .set({ state: 'cancelled', data: sql`${gameRounds.data} || jsonb_build_object('reason', 'creator-deleted')` })
        .where(inArray(gameRounds.id, ids));
    }
    await tx
      .update(predictionEvents)
      .set({ state: 'cancelled', settledAt: new Date(), cancelReason: 'creator-deleted' })
      .where(eq(predictionEvents.id, ev.id));
    out.push({ id: ev.id, serverId: ev.serverId, refunded: [...refunded] });
  }
  return out;
}

type PredictionAnnouncer = (serverId: string, eventIds: string[]) => Promise<void>;
let predictionAnnouncer: PredictionAnnouncer | null = null;

/** Рассылку `prediction.state` подключает `gamePredictions.ts` при загрузке — как `configureDuelAnnouncer`. */
export function configurePredictionAnnouncer(fn: PredictionAnnouncer | null): void {
  predictionAnnouncer = fn;
}

/**
 * После коммита отмены событий (удаление создателя, выключение игр): кошельки, куда вернулись ставки (кроме `skipUserId`),
 * и `prediction.state` по каждому событию. Best-effort: деньги уже в базе.
 */
export async function announceCancelledPredictions(events: CancelledPrediction[], skipUserId?: string): Promise<void> {
  for (const e of events) {
    for (const userId of e.refunded) if (userId !== skipUserId) await pushWallet(e.serverId, userId).catch(() => {});
  }
  const byServer = new Map<string, string[]>();
  for (const e of events) byServer.set(e.serverId, [...(byServer.get(e.serverId) ?? []), e.id]);
  for (const [serverId, ids] of byServer) {
    try {
      await predictionAnnouncer?.(serverId, ids);
    } catch (err) {
      console.warn(`[prediction] prediction.state после отмены ${serverId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Снимок «игр» для кошелька (`GET /servers/:id/economy` → `wallet.games`). Только чтение: наступившее отложенное
 * повышение применяется виртуально.
 */
export async function gamesViewOf(
  serverId: string,
  wallet: { userId: string; gamesOptOut: boolean; gamesLossLimit: number | null; gamesLossLimitRaise: number | null; gamesLossLimitRaiseAt: Date | null },
  serverMax: number,
  now: Date,
): Promise<GamesView> {
  return gamesView({
    gamesOptOut: wallet.gamesOptOut,
    limit: { lossLimit: wallet.gamesLossLimit, raise: wallet.gamesLossLimitRaise, raiseAt: wallet.gamesLossLimitRaiseAt },
    serverMax,
    lossToday: await lossTodayOf(db, serverId, wallet.userId, now),
    now,
  });
}

function stakeWhere(i: StakeKey) {
  return and(eq(gameStakes.roundId, i.roundId), eq(gameStakes.userId, i.userId), eq(gameStakes.pick, i.pick));
}

async function kindOf(tx: GameTx, roundId: string) {
  const [round] = await tx.select({ kind: gameRounds.kind }).from(gameRounds).where(eq(gameRounds.id, roundId)).limit(1);
  if (!round) throw new Error(`раунд ${roundId} не найден`);
  return round.kind;
}

/**
 * Запуск игр сервера для снимка экономики («Запустить игры», 29.10; `gameWheel.launchGames`): `null` — не запускали.
 * `mine` — подарок ЭТОМУ человеку (строка журнала `games.launch`; одна на человека и сервер по UNIQUE 0166).
 */
export async function gamesLaunchViewOf(server: string, who: string): Promise<GamesLaunchDto | null> {
  const [row] = await db
    .select({ at: serverEconomy.gamesLaunchedAt, gift: serverEconomy.gamesLaunchGift })
    .from(serverEconomy)
    .where(eq(serverEconomy.serverId, server))
    .limit(1);
  if (!row?.at) return null;
  const [mine] = await db
    .select({ amount: coinLedger.amount })
    .from(coinLedger)
    .where(and(eq(coinLedger.reason, GAMES_LAUNCH_REASON), eq(coinLedger.serverId, server), eq(coinLedger.userId, who)))
    .limit(1);
  return { at: row.at.toISOString(), gift: row.gift ?? 0, mine: mine?.amount ?? 0 };
}
