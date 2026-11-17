import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  PREDICTION_AUTO_CANCEL_MS,
  PREDICTION_MAX_LIVE,
  PREDICTION_PUSH_MIN_MS,
  PREDICTION_RESULT_SHOW_MS,
  type PredictionEventDto,
  type PredictionSnapshotDto,
} from '@gusvoice/shared';
import { economySeenBy, isBotUser } from './coins.js';
import { db } from './db/index.js';
import { gameRounds, gameStakes, predictionEvents, serverEconomy } from './db/schema.js';
import { cancelLiveRounds, configurePredictionAnnouncer, withGameMoney, type GameMoney, type GameTx } from './gameMoney.js';
import {
  checkPredictionWinners,
  isLiveStake,
  predictionEventDto,
  predictionSettlePlan,
  type PredictionDraft,
  type PredictionEventRow,
  type PredictionRefusal,
  type PredictionRoundData,
  type PredictionStakeRow,
} from './gamePredictionRules.js';
import type { StakeBlock } from './gameMoneyRules.js';
import { publishToServer, redisPub } from './realtime.js';
import { id as newId } from './util.js';

/**
 * Ставки на события (ГусКоины 2, этап 5) — транзакции, рассылка и такт. Правила — `gamePredictionRules.ts` +
 * `@gusvoice/shared/prediction.ts`, деньги — `gameMoney.ts` (этап 1), маршруты — `routes/gamePredictions.ts`.
 *
 * Событие — строка `prediction_events`, вопросы — `game_rounds kind='prediction'` (`data.eventId`), ставки — `game_stakes`
 * (`pick` = id варианта). `open` → «Закрыть»/таймер `lock_at` → `locked` → итог `settled` | отмена `cancelled`.
 * Вопросы меняют состояние вместе с событием, одной транзакцией.
 *
 * 🔴 Состояние — ТОЛЬКО в базе: таймеров в памяти нет (кроме сглаживания рассылки), после перезапуска первый такт
 *    подбирает созревшее (таймер закрытия, автоотмена через 7 суток, выключенные игры).
 * 🔴 Порядок замков: событие (ставка `FOR SHARE`; закрытие, итог, отмена, такт — `FOR UPDATE`) → вопрос(ы) → кошельки по
 *    `user_id` (`lockWallets`). Так же `cancelLiveRounds` без `roundIds` (выключение игр): сначала события.
 * 🔴 Одна ставка на вопрос: кошелёк блокируется ДО проверки «нет ли моей ставки в этом вопросе» — две параллельные
 *    ставки одного человека на разные варианты встают в очередь на кошельке, вторая видит первую (`already_bet`).
 *    Ключ `game_stakes` этого не гарантирует: он включает `pick`.
 * 🔴 Итог — только создатель, по ЖИВЫМ ставкам под замком (ставка удалённого аккаунта уже возвращена); выплата
 *    идемпотентна (`payStake`: условный UPDATE по `paid_at IS NULL`), повтор итога — `finished`.
 */

/** Такт: таймер закрытия с точностью до секунды. */
export const PREDICTION_TICK_MS = 1_000;
/** Переходов за такт — не больше (каждый своей транзакцией). */
const PREDICTION_TICK_BATCH = 20;
/** Замок от двойного нажатия (человек + сервер). */
const PREDICTION_ACT_LOCK_MS = 3_000;
/** Сколько событий отдаёт снимок (живых ≤ 3 + закончившиеся за сутки). */
const SNAPSHOT_EVENTS = 20;

const LIVE = ['open', 'locked'] as const;

type EventRow = typeof predictionEvents.$inferSelect;

export type PredictionResult = { ok: true; event: PredictionEventDto | null } | { ok: false; code: PredictionRefusal; field?: string };

/** Отказ внутри транзакции — откатить всё. */
class PredictionRefused extends Error {
  constructor(readonly code: PredictionRefusal) {
    super(code);
  }
}

/** Замок Redis с токеном (как у дуэли): занят — `busy`; снимается, только если ещё наш. */
async function withActLock(serverId: string, userId: string, fn: () => Promise<PredictionResult>): Promise<PredictionResult> {
  const key = `prediction:act:${serverId}:${userId}`;
  const token = randomBytes(8).toString('hex');
  if ((await redisPub.set(key, token, 'PX', PREDICTION_ACT_LOCK_MS, 'NX')) !== 'OK') return { ok: false, code: 'busy' };
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PredictionRefused) return { ok: false, code: err.code };
    throw err;
  } finally {
    await redisPub
      .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token)
      .catch(() => {});
  }
}

async function refusing(fn: () => Promise<PredictionResult>): Promise<PredictionResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PredictionRefused) return { ok: false, code: err.code };
    throw err;
  }
}

const eventIdOf = sql<string>`${gameRounds.data}->>'eventId'`;

function questionsWhere(eventIds: string[]) {
  // ⚠️ Выражение — ровно как в частичном индексе `game_rounds_prediction_event_idx` (0164).
  return and(eq(gameRounds.kind, 'prediction'), sql`(${gameRounds.data}->>'eventId') IN (${sql.join(eventIds.map((e) => sql`${e}`), sql`, `)})`);
}

async function eventRow(q: GameTx | typeof db, serverId: string, eventId: string, lock: 'update' | 'share' | null): Promise<EventRow | undefined> {
  const base = q
    .select()
    .from(predictionEvents)
    .where(and(eq(predictionEvents.id, eventId), eq(predictionEvents.serverId, serverId)))
    .limit(1);
  const [row] = lock ? await base.for(lock) : await base;
  return row;
}

/** Вопросы события `FOR UPDATE` по id (порядок замков). */
async function lockQuestions(tx: GameTx, eventId: string) {
  return tx
    .select({ id: gameRounds.id, state: gameRounds.state, data: gameRounds.data })
    .from(gameRounds)
    .where(questionsWhere([eventId]))
    .orderBy(asc(gameRounds.id))
    .for('update');
}

/** DTO событий одним набором запросов. `viewerId` null — для общей рассылки (`mine` пусто). */
async function eventDtos(q: GameTx | typeof db, rows: EventRow[], viewerId: string | null): Promise<PredictionEventDto[]> {
  if (rows.length === 0) return [];
  const rounds = await q
    .select({ id: gameRounds.id, data: gameRounds.data, eventId: eventIdOf })
    .from(gameRounds)
    .where(questionsWhere(rows.map((r) => r.id)));
  const stakes =
    rounds.length === 0
      ? []
      : await q
          .select({
            roundId: gameStakes.roundId,
            userId: gameStakes.userId,
            pick: gameStakes.pick,
            amount: gameStakes.amount,
            payout: gameStakes.payout,
            paidAt: gameStakes.paidAt,
            refundedAt: gameStakes.refundedAt,
          })
          .from(gameStakes)
          .where(inArray(gameStakes.roundId, rounds.map((r) => r.id)))
          .orderBy(asc(gameStakes.createdAt), asc(gameStakes.userId));
  const byRound = new Map<string, PredictionStakeRow[]>();
  for (const s of stakes) byRound.set(s.roundId, [...(byRound.get(s.roundId) ?? []), s]);
  return rows.map((ev) =>
    predictionEventDto(ev as PredictionEventRow, rounds.filter((r) => r.eventId === ev.id), byRound, viewerId),
  );
}

async function eventDto(q: GameTx | typeof db, serverId: string, eventId: string, viewerId: string | null): Promise<PredictionEventDto | null> {
  const row = await eventRow(q, serverId, eventId, null);
  if (!row) return null;
  return (await eventDtos(q, [row], viewerId))[0] ?? null;
}

// --- Рассылка -----------------------------------------------------------------------------------------------------

const lastPush = new Map<string, number>();
const pendingPush = new Map<string, ReturnType<typeof setTimeout>>();

async function publishPrediction(serverId: string, eventId: string): Promise<void> {
  try {
    const event = await eventDto(db, serverId, eventId, null);
    await publishToServer(serverId, { t: 'prediction.state', serverId, eventId, event, serverNow: new Date().toISOString() });
    if (!event || event.state === 'settled' || event.state === 'cancelled') lastPush.delete(eventId);
  } catch (err) {
    console.warn(`[prediction] prediction.state ${eventId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `prediction.state` события — не чаще `PREDICTION_PUSH_MIN_MS`: частые ставки сливаются в один хвостовой пуш, который
 * читает СВЕЖЕЕ состояние из базы (последнее изменение доезжает всегда). Звать после коммита. Сбой шины — в лог.
 */
export function schedulePredictionPush(serverId: string, eventId: string): void {
  if (pendingPush.has(eventId)) return;
  const wait = Math.max(0, (lastPush.get(eventId) ?? 0) + PREDICTION_PUSH_MIN_MS - Date.now());
  const fire = () => {
    pendingPush.delete(eventId);
    lastPush.set(eventId, Date.now());
    void publishPrediction(serverId, eventId);
  };
  if (wait === 0) {
    fire();
    return;
  }
  const timer = setTimeout(fire, wait);
  timer.unref?.();
  pendingPush.set(eventId, timer);
}

// Удаление аккаунта создателя и выключение игр отменяют события в модуле денег — рассылку он зовёт через этот вход.
configurePredictionAnnouncer(async (serverId, eventIds) => {
  for (const eventId of eventIds) schedulePredictionPush(serverId, eventId);
});

// --- Снимок -------------------------------------------------------------------------------------------------------

/**
 * Снимок для человека (`GET /servers/:id/predictions`): живые события и закончившиеся за сутки, новые сверху, со
 * ставкой зрителя (`mine`). Экономика ему не видна или игры выключены — `enabled: false` без событий.
 */
export async function predictionSnapshot(serverId: string, viewerId: string, canManage: boolean, now = new Date()): Promise<PredictionSnapshotDto> {
  const economy = await economySeenBy(serverId, viewerId);
  const enabled = (economy?.enabled ?? false) && (economy?.gamesEnabled ?? false);
  const base = { serverId, serverNow: now.toISOString(), enabled, betMax: economy?.gamesBetMax ?? 0, canManage };
  if (!enabled) return { ...base, events: [] };
  const rows = await db
    .select()
    .from(predictionEvents)
    .where(
      and(
        eq(predictionEvents.serverId, serverId),
        or(inArray(predictionEvents.state, [...LIVE]), gte(predictionEvents.settledAt, new Date(now.getTime() - PREDICTION_RESULT_SHOW_MS))),
      ),
    )
    .orderBy(desc(predictionEvents.createdAt))
    .limit(SNAPSHOT_EVENTS);
  return { ...base, events: await eventDtos(db, rows, viewerId) };
}

// --- Действия -----------------------------------------------------------------------------------------------------

/**
 * Завести событие (проверку права `canRunPredictions` — `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`/владелец — делает маршрут). Предел живых на сервер — под
 * транзакционным замком сервера (`pg_advisory_xact_lock`): два создания в одну миллисекунду не проскочат его вдвоём.
 * Комиссия замораживается из `games_fee_percent`.
 */
export async function createPrediction(serverId: string, userId: string, draft: PredictionDraft, now = new Date()): Promise<PredictionResult> {
  if (await isBotUser(db, userId)) return { ok: false, code: 'bot' };
  const eventId = newId();
  const res = await refusing(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`prediction:create:${serverId}`}))`);
      const [economy] = await tx
        .select({ enabled: serverEconomy.enabled, gamesEnabled: serverEconomy.gamesEnabled, feePercent: serverEconomy.gamesFeePercent })
        .from(serverEconomy)
        .where(eq(serverEconomy.serverId, serverId))
        .limit(1);
      if (!economy?.enabled || !economy.gamesEnabled) throw new PredictionRefused('games-off');
      const [live] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(predictionEvents)
        .where(and(eq(predictionEvents.serverId, serverId), inArray(predictionEvents.state, [...LIVE])));
      if (Number(live?.n ?? 0) >= PREDICTION_MAX_LIVE) throw new PredictionRefused('too_many');
      const feePercent = Math.min(100, Math.max(0, Math.floor(economy.feePercent)));
      await tx.insert(predictionEvents).values({
        id: eventId,
        serverId,
        createdBy: userId,
        title: draft.title,
        state: 'open',
        feePercent,
        lockAt: draft.lockInSec === null ? null : new Date(now.getTime() + draft.lockInSec * 1000),
        createdAt: now,
      });
      for (let pos = 0; pos < draft.questions.length; pos++) {
        const q = draft.questions[pos];
        const data: PredictionRoundData = { eventId, pos, question: q.question, options: q.options, feePercent };
        // ⚠️ `lock_at`/`settle_at` вопроса пусты: таймер — у события, такты колеса и дуэли строки без них не трогают.
        await tx.insert(gameRounds).values({ id: newId(), serverId, kind: 'prediction', state: 'open', createdBy: userId, createdAt: now, data: { ...data } });
      }
    });
    return { ok: true, event: null };
  });
  if (!res.ok) return res;
  schedulePredictionPush(serverId, eventId);
  return { ok: true, event: await eventDto(db, serverId, eventId, userId) };
}

export interface PredictionBetInput {
  serverId: string;
  eventId: string;
  questionId: string;
  optionId: string;
  userId: string;
  amount: number;
}

/**
 * Ставка (сидит ли человек в голосе сервера и видны ли игры — проверяет маршрут). Событие `FOR SHARE` (итог и закрытие
 * ждут) → вопрос `FOR SHARE` → кошелёк → «нет ли моей ставки в вопросе» → `placeStake` этапа 1 (лимиты, баланс, повтор).
 */
export async function placePredictionBet(i: PredictionBetInput, now = new Date()): Promise<PredictionResult> {
  const res = await withActLock(i.serverId, i.userId, async () => {
    await withGameMoney(async (m) => {
      const ev = await eventRow(m.tx, i.serverId, i.eventId, 'share');
      if (!ev) throw new PredictionRefused('not_found');
      if (ev.state !== 'open' || (ev.lockAt !== null && ev.lockAt.getTime() <= now.getTime())) {
        throw new PredictionRefused(ev.state === 'open' || ev.state === 'locked' ? 'not_open' : 'finished');
      }
      if (ev.createdBy === i.userId) throw new PredictionRefused('creator');
      const [q] = await m.tx
        .select({ id: gameRounds.id, data: gameRounds.data })
        .from(gameRounds)
        .where(and(eq(gameRounds.id, i.questionId), eq(gameRounds.serverId, i.serverId), eq(gameRounds.kind, 'prediction')))
        .limit(1)
        .for('share');
      const data = q?.data as unknown as PredictionRoundData | undefined;
      if (!q || data?.eventId !== i.eventId) throw new PredictionRefused('not_found');
      if (!data.options.some((o) => o.id === i.optionId)) throw new PredictionRefused('bad-pick');
      // Бот: кошелёк не заводим (`lockWallets` его бы завёл) — отказ раньше.
      if (await isBotUser(m.tx, i.userId)) throw new PredictionRefused('bot');
      // 🔴 Кошелёк — ДО проверки «одна ставка на вопрос»: параллельная ставка на другой вариант ждёт здесь и видит первую.
      await m.lockWallets(i.serverId, [i.userId]);
      const [mine] = await m.tx
        .select({ pick: gameStakes.pick })
        .from(gameStakes)
        .where(and(eq(gameStakes.roundId, q.id), eq(gameStakes.userId, i.userId)))
        .limit(1);
      if (mine) throw new PredictionRefused(mine.pick === i.optionId ? 'duplicate' : 'already_bet');
      const r = await m.placeStake({ serverId: i.serverId, roundId: q.id, userId: i.userId, pick: i.optionId, amount: i.amount, now });
      if (!r.ok) throw new PredictionRefused(r.block as StakeBlock);
    });
    return { ok: true, event: null };
  });
  if (!res.ok) return res;
  schedulePredictionPush(i.serverId, i.eventId);
  return { ok: true, event: await eventDto(db, i.serverId, i.eventId, i.userId) };
}

/** Закрыть приём ставок: событие и его открытые вопросы → `locked` (вызывающий держит событие `FOR UPDATE`). */
async function lockEvent(tx: GameTx, eventId: string, now: Date): Promise<void> {
  await tx.update(predictionEvents).set({ state: 'locked', lockedAt: now }).where(and(eq(predictionEvents.id, eventId), eq(predictionEvents.state, 'open')));
  await tx
    .update(gameRounds)
    .set({ state: 'locked' })
    .where(and(questionsWhere([eventId]), eq(gameRounds.state, 'open')));
}

/** «Закрыть приём» вручную: только создатель. Прежний аргумент прав оставлен для совместимости вызовов и игнорируется. */
export async function closePrediction(serverId: string, eventId: string, userId: string, _canManage: boolean, now = new Date()): Promise<PredictionResult> {
  const res = await refusing(async () => {
    await db.transaction(async (tx) => {
      const ev = await eventRow(tx, serverId, eventId, 'update');
      if (!ev) throw new PredictionRefused('not_found');
      if (ev.createdBy !== userId) throw new PredictionRefused('forbidden');
      if (ev.state !== 'open') throw new PredictionRefused(ev.state === 'locked' ? 'not_open' : 'finished');
      await lockEvent(tx, eventId, now);
    });
    return { ok: true, event: null };
  });
  if (!res.ok) return res;
  schedulePredictionPush(serverId, eventId);
  return { ok: true, event: await eventDto(db, serverId, eventId, userId) };
}

/**
 * Итог — только создатель, только после закрытия (истёкший таймер, который такт ещё не подобрал, закрывается здесь же).
 * `winners` — на каждый вопрос id варианта или null («вопрос не состоялся» → возврат по вопросу). Одна транзакция:
 * событие `FOR UPDATE` → вопросы `FOR UPDATE` → кошельки ВСЕХ поставивших → по каждому вопросу `splitParimutuel` по
 * живым ставкам → `payStake`/`refundStake`. Повтор итога — `finished`, денег второй раз не двигает.
 */
export async function settlePrediction(
  serverId: string,
  eventId: string,
  userId: string,
  winners: Record<string, unknown>,
  now = new Date(),
): Promise<PredictionResult> {
  const res = await refusing(async () => {
    await withGameMoney(async (m) => {
      const ev = await eventRow(m.tx, serverId, eventId, 'update');
      if (!ev) throw new PredictionRefused('not_found');
      if (ev.createdBy !== userId) throw new PredictionRefused('not_creator');
      if (ev.state === 'settled' || ev.state === 'cancelled') throw new PredictionRefused('finished');
      if (ev.state === 'open') {
        if (ev.lockAt === null || ev.lockAt.getTime() > now.getTime()) throw new PredictionRefused('not_locked');
        await lockEvent(m.tx, eventId, now);
      }
      const rounds = (await lockQuestions(m.tx, eventId)).filter((r) => r.state === 'locked');
      const plan = checkPredictionWinners(
        rounds.map((r) => ({ id: r.id, options: (r.data as unknown as PredictionRoundData).options })),
        winners,
      );
      if (!plan) throw new PredictionRefused('bad_winners');
      await settleQuestions(m, serverId, ev, rounds, plan, now);
    });
    return { ok: true, event: null };
  });
  if (!res.ok) return res;
  schedulePredictionPush(serverId, eventId);
  return { ok: true, event: await eventDto(db, serverId, eventId, userId) };
}

async function settleQuestions(
  m: GameMoney,
  serverId: string,
  ev: EventRow,
  rounds: { id: string; data: Record<string, unknown> }[],
  winners: Map<string, string | null>,
  now: Date,
): Promise<void> {
  const ids = rounds.map((r) => r.id);
  const stakes =
    ids.length === 0
      ? []
      : await m.tx
          .select({
            roundId: gameStakes.roundId,
            userId: gameStakes.userId,
            pick: gameStakes.pick,
            amount: gameStakes.amount,
            payout: gameStakes.payout,
            paidAt: gameStakes.paidAt,
            refundedAt: gameStakes.refundedAt,
          })
          .from(gameStakes)
          .where(inArray(gameStakes.roundId, ids))
          .orderBy(asc(gameStakes.userId), asc(gameStakes.roundId), asc(gameStakes.pick));
  await m.lockWallets(serverId, stakes.filter(isLiveStake).map((s) => s.userId));
  for (const r of rounds) {
    const data = r.data as unknown as PredictionRoundData;
    const winner = winners.get(r.id) ?? null;
    const mine = stakes.filter((s) => s.roundId === r.id);
    const plan = predictionSettlePlan(mine, winner, typeof data.feePercent === 'number' ? data.feePercent : ev.feePercent);
    if (plan.refund) {
      for (const s of mine.filter(isLiveStake)) await m.refundStake({ roundId: r.id, userId: s.userId, pick: s.pick });
    } else {
      for (const p of plan.payouts) await m.payStake({ roundId: r.id, userId: p.userId, pick: p.pick, payout: p.payout });
    }
    const result: PredictionRoundData = { ...data, winnerOptionId: winner, void: winner === null, pool: plan.pool, fee: plan.fee };
    await m.tx.update(gameRounds).set({ state: 'settled', settledAt: now, data: { ...result } }).where(eq(gameRounds.id, r.id));
  }
  await m.tx.update(predictionEvents).set({ state: 'settled', settledAt: now }).where(eq(predictionEvents.id, ev.id));
}

/** Отменить с возвратом всех ставок: создатель или `MANAGE_PREDICTIONS`/`MANAGE_ECONOMY`/владелец; в любом состоянии до итога. */
export async function cancelPrediction(serverId: string, eventId: string, userId: string, canManage: boolean, now = new Date()): Promise<PredictionResult> {
  const res = await refusing(async () => {
    await withGameMoney(async (m) => {
      const ev = await eventRow(m.tx, serverId, eventId, 'update');
      if (!ev) throw new PredictionRefused('not_found');
      if (ev.createdBy !== userId && !canManage) throw new PredictionRefused('forbidden');
      if (ev.state === 'settled' || ev.state === 'cancelled') throw new PredictionRefused('finished');
      await cancelEvent(m, ev, ev.createdBy === userId ? 'creator' : 'moderator', now);
    });
    return { ok: true, event: null };
  });
  if (!res.ok) return res;
  schedulePredictionPush(serverId, eventId);
  return { ok: true, event: await eventDto(db, serverId, eventId, userId) };
}

/** Отмена события под его замком: вопросы через `cancelLiveRounds` (возврат всем), событие — `cancelled`. */
async function cancelEvent(m: GameMoney, ev: EventRow, reason: string, now: Date): Promise<void> {
  const rounds = await lockQuestions(m.tx, ev.id);
  await cancelLiveRounds(
    m,
    ev.serverId,
    rounds.map((r) => r.id),
    reason,
  );
  // `cancelLiveRounds` переводит и событие; без живых вопросов (не бывает, но) — здесь.
  await m.tx
    .update(predictionEvents)
    .set({ state: 'cancelled', settledAt: now, cancelReason: reason })
    .where(and(eq(predictionEvents.id, ev.id), inArray(predictionEvents.state, [...LIVE])));
}

// --- Такт ---------------------------------------------------------------------------------------------------------

type StepOutcome = { serverId: string; eventId: string } | null;

/**
 * Один переход одного созревшего события — своей транзакцией: таймер `lock_at` наступил (→ `locked`), закрыто без итога
 * `PREDICTION_AUTO_CANCEL_MS` (→ отмена `expired`), игры или экономика сервера выключены (→ отмена `games-off`).
 * `SKIP LOCKED`: событие, на которое прямо сейчас ставят или подводят итог, ждёт следующего такта.
 */
async function predictionStep(now: Date, skip: string[]): Promise<StepOutcome> {
  return withGameMoney(async (m): Promise<StepOutcome> => {
    const [found] = await m.tx
      .select({ row: predictionEvents, economyOn: serverEconomy.enabled, gamesOn: serverEconomy.gamesEnabled })
      .from(predictionEvents)
      .leftJoin(serverEconomy, eq(serverEconomy.serverId, predictionEvents.serverId))
      .where(
        and(
          inArray(predictionEvents.state, [...LIVE]),
          skip.length > 0 ? sql`${predictionEvents.id} NOT IN (${sql.join(skip.map((s) => sql`${s}`), sql`, `)})` : undefined,
          or(
            and(eq(predictionEvents.state, 'open'), lte(predictionEvents.lockAt, now)),
            and(eq(predictionEvents.state, 'locked'), lte(predictionEvents.lockedAt, new Date(now.getTime() - PREDICTION_AUTO_CANCEL_MS))),
            isNull(serverEconomy.serverId),
            eq(serverEconomy.enabled, false),
            eq(serverEconomy.gamesEnabled, false),
          ),
        ),
      )
      .orderBy(asc(predictionEvents.createdAt))
      .limit(1)
      .for('update', { of: predictionEvents, skipLocked: true });
    if (!found) return null;
    const ev = found.row;
    skip.push(ev.id);
    if (!found.economyOn || !found.gamesOn) {
      await cancelEvent(m, ev, 'games-off', now);
    } else if (ev.state === 'open') {
      await lockEvent(m.tx, ev.id, now);
    } else {
      await cancelEvent(m, ev, 'expired', now);
    }
    return { serverId: ev.serverId, eventId: ev.id };
  });
}

export interface PredictionTickReport {
  steps: number;
}

/** Такт: созревшие события по одному переходу, не больше `PREDICTION_TICK_BATCH`. Рассылка — после коммита каждого. */
export async function runPredictionTick(now = new Date()): Promise<PredictionTickReport> {
  const report: PredictionTickReport = { steps: 0 };
  const skip: string[] = [];
  for (let i = 0; i < PREDICTION_TICK_BATCH; i++) {
    const step = await predictionStep(now, skip);
    if (!step) break;
    report.steps += 1;
    schedulePredictionPush(step.serverId, step.eventId);
  }
  return report;
}

let started = false;

/**
 * Запустить такт (`routes/gamePredictions.ts`, `onListen` — тесты на `inject` его не заводят). Первый такт — сразу;
 * новый поверх незавершённого не стартует.
 */
export function startPredictionWorker(): void {
  if (started) return;
  started = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runPredictionTick()
      .catch((err: unknown) => {
        console.warn(`[prediction] такт упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, PREDICTION_TICK_MS);
  timer.unref();
}
