import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  jackpotCentsOf,
  WHEEL_BET_WINDOW_MS,
  WHEEL_SPIN_MS,
  type VoiceParticipant,
  type WheelPick,
  type WheelResultDto,
  type WheelSnapshotDto,
} from '@gusvoice/shared';
import { applyCoins, economySeenBy, pushWallet, type ServerEconomy } from './coins.js';
import { db } from './db/index.js';
import { channels, coinBalances, gameRounds, gameStakes, serverEconomy, serverMembers, users } from './db/schema.js';
import { economyDefaults } from './economyDefaults.js';
import { env } from './env.js';
import { cancelLiveRounds, withGameMoney, type GameTx } from './gameMoney.js';
import { GAMES_LAUNCH_REASON, launchRecipients, WHEEL_JACKPOT_REASON, type StakeBlock } from './gameMoneyRules.js';
import {
  wheelCommit,
  wheelCooldownUntil,
  wheelForcedJackpot,
  wheelJackpotCoins,
  wheelOutcome,
  wheelRefusalOf,
  wheelResultDto,
  wheelRoundDto,
  wheelSettlePlan,
  type WheelBetRefusal,
  type WheelRoundData,
  type WheelSpinRefusal,
} from './gameWheelRules.js';
import { publishToServer, redisPub } from './realtime.js';
import { id as newId } from './util.js';

/**
 * Колесо гусей-пиратов (ГусКоины 2, этап 2) — транзакции и такт. Правила — `gameWheelRules.ts` + `@gusvoice/shared/wheel.ts`,
 * деньги — `gameMoney.ts` (этап 1), маршруты — `routes/gameWheel.ts`, план — `docs/guscoins-v2-plan.md` («Колесо»).
 *
 * Раунд: первая ставка заводит `open` (окно `WHEEL_BET_WINDOW_MS`) → такт на `lock_at` запирает: сектор и срыв джекпота
 * из зерна, `settle_at = +WHEEL_SPIN_MS` (клиенты крутят) → такт на `settle_at` рассчитывает (`settled`) → пауза
 * `WHEEL_COOLDOWN_MS` до следующего раунда. Игры выключены → `cancelled` с возвратом ставок.
 *
 * 🔴 Состояние — ТОЛЬКО в базе: таймеров в памяти нет, после перезапуска первый такт подбирает просроченное.
 * 🔴 Порядок замков везде один: раунд → строка `server_economy` (сундук) → кошельки по `user_id`. Ставка берёт раунд
 *    `FOR UPDATE` (или вставляет его), потом сундук, потом свой кошелёк (`placeStake`); расчёт — раунд `SKIP LOCKED`,
 *    сундук, кошельки (`lockWallets`). Правка настроек держит сундук → кошельки, а отмену зовёт отдельной транзакцией.
 * 🔴 Зерно (`data.seed`) наружу — только в итоге: DTO открытого/запертого раунда собираются из перечисленных полей.
 * ⚠️ Часы — процесса (он один, `docker-compose.yml`): `lock_at`/`settle_at` ставятся и сравниваются по ним же.
 */

/** Такт колеса: раз в секунду (окно 30 с, вращение 6 с — опоздание в такт незаметно). */
export const WHEEL_TICK_MS = 1_000;
/** Переходов за такт — не больше (каждый своей транзакцией). */
const WHEEL_TICK_BATCH = 20;
/** Замок от двойного нажатия «Поставить» (человек + сервер). */
const WHEEL_BET_LOCK_MS = 3_000;

/**
 * Сидит ли человек сейчас в голосовом канале ЭТОГО сервера.
 * ⚠️ Presence знает только «канал → кто» (`presence:ch:<id>`, тот же источник, что видит клиент), поэтому перебираем
 * голосовые каналы сервера одним конвейером Redis. Любая ошибка = «не в голосе» (fail-closed): ставить без голоса нельзя.
 */
export async function inVoiceOfServer(serverId: string, userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), eq(channels.type, 'voice')));
    if (rows.length === 0) return false;
    const pipe = redisPub.pipeline();
    for (const r of rows) pipe.get(`presence:ch:${r.id}`);
    const res = (await pipe.exec()) ?? [];
    for (const [err, raw] of res) {
      if (err || typeof raw !== 'string') continue;
      try {
        const list = JSON.parse(raw) as VoiceParticipant[];
        if (Array.isArray(list) && list.some((p) => p?.userId === userId)) return true;
      } catch {
        /* мусор в ключе — этот канал пропускаем */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Сундук сервера, сотые. */
async function jackpotCentsOfServer(q: Pick<typeof db, 'select'>, serverId: string): Promise<number> {
  const [row] = await q.select({ cents: serverEconomy.wheelJackpotCents }).from(serverEconomy).where(eq(serverEconomy.serverId, serverId)).limit(1);
  return Number(row?.cents ?? 0);
}

const LIVE = ['open', 'locked'] as const;

async function liveRound(q: GameTx | typeof db, serverId: string, lock: boolean) {
  const base = q
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.serverId, serverId), eq(gameRounds.kind, 'wheel'), inArray(gameRounds.state, [...LIVE])))
    .limit(1);
  const [row] = lock ? await base.for('update') : await base;
  return row;
}

async function lastSettled(q: GameTx | typeof db, serverId: string) {
  const [row] = await q
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.serverId, serverId), eq(gameRounds.kind, 'wheel'), eq(gameRounds.state, 'settled'), isNotNull(gameRounds.settledAt)))
    .orderBy(desc(gameRounds.settledAt))
    .limit(1);
  return row;
}

async function stakesOf(q: GameTx | typeof db, roundId: string) {
  return q
    .select({ userId: gameStakes.userId, pick: gameStakes.pick, amount: gameStakes.amount, refundedAt: gameStakes.refundedAt })
    .from(gameStakes)
    .where(eq(gameStakes.roundId, roundId))
    .orderBy(asc(gameStakes.createdAt), asc(gameStakes.userId), asc(gameStakes.pick));
}

/**
 * Снимок колеса для человека (`GET /servers/:id/wheel`, ответ на ставку). Экономика не видна ему или игры выключены —
 * `enabled: false` и пустой раунд. 🔴 Зерно здесь только у `last` (раунд уже рассчитан).
 */
export async function wheelSnapshot(serverId: string, viewerId: string, now = new Date()): Promise<WheelSnapshotDto> {
  const economy = await economySeenBy(serverId, viewerId);
  const enabled = (economy?.enabled ?? false) && (economy?.gamesEnabled ?? false);
  const betMax = (economy ?? economyDefaults(serverId)).gamesBetMax;
  const base = { serverId, serverNow: now.toISOString(), enabled, betMax };
  if (!enabled) return { ...base, jackpot: 0, round: null, last: null, cooldownUntil: null };
  const [cents, live, last] = await Promise.all([jackpotCentsOfServer(db, serverId), liveRound(db, serverId, false), lastSettled(db, serverId)]);
  const round = live ? wheelRoundDto(live, await stakesOf(db, live.id)) : null;
  const cooldown = wheelCooldownUntil(last?.settledAt ?? null, now);
  return {
    ...base,
    jackpot: wheelJackpotCoins(cents),
    round,
    last: last ? wheelResultDto(last) : null,
    cooldownUntil: cooldown ? cooldown.toISOString() : null,
  };
}

/** Отказ внутри транзакции ставки — откатить заведённый раунд и взнос в сундук. */
class BetRefused extends Error {
  constructor(readonly code: WheelBetRefusal, readonly retryAt?: Date) {
    super(code);
  }
}

export type WheelBetResult = { ok: true; roundId: string } | { ok: false; code: WheelBetRefusal; retryAt?: string };

/**
 * Ставка в колесо. Членство, видимость экономики и «сидит в голосе» проверяет маршрут; здесь — замок от двойного нажатия
 * и сама транзакция: живой раунд `FOR UPDATE` или новый (частичный UNIQUE `game_rounds_wheel_live_uq`, `ON CONFLICT DO
 * NOTHING`), взнос в сундук, `placeStake` этапа 1 (лимиты, баланс, повтор). После коммита — кошелёк и `wheel.state`.
 */
export async function placeWheelBet(serverId: string, userId: string, pick: WheelPick, amount: number, now = new Date()): Promise<WheelBetResult> {
  const lockKey = `wheel:bet:${serverId}:${userId}`;
  const token = randomBytes(8).toString('hex');
  if ((await redisPub.set(lockKey, token, 'PX', WHEEL_BET_LOCK_MS, 'NX')) !== 'OK') return { ok: false, code: 'busy' };
  let roundId: string;
  try {
    roundId = await withGameMoney(async (m) => {
      let round = await liveRound(m.tx, serverId, true);
      if (!round) {
        // Пауза после итога: колесо показывает прошлый результат `WHEEL_COOLDOWN_MS`, новый раунд — после неё.
        const last = await lastSettled(m.tx, serverId);
        const until = wheelCooldownUntil(last?.settledAt ?? null, now);
        if (until) throw new BetRefused('cooldown', until);
        const id = newId();
        const seed = randomBytes(32).toString('hex');
        const data: WheelRoundData = { commit: wheelCommit(id, seed), seed };
        const inserted = await m.tx
          .insert(gameRounds)
          .values({ id, serverId, kind: 'wheel', state: 'open', createdBy: userId, lockAt: new Date(now.getTime() + WHEEL_BET_WINDOW_MS), data: { ...data } })
          .onConflictDoNothing()
          .returning();
        // Гонка первых ставок: раунд завёл соседний запрос (он уже закоммичен — UNIQUE ждал его) — ставим в него.
        round = inserted[0] ?? (await liveRound(m.tx, serverId, true));
        if (!round) throw new BetRefused('round_locked');
      }
      if (round.state !== 'open' || !round.lockAt || round.lockAt.getTime() <= now.getTime()) throw new BetRefused('round_locked');
      // Сундук — до кошелька (порядок замков: раунд → сундук → кошельки). Отказ ниже откатит и взнос.
      await m.tx
        .update(serverEconomy)
        .set({ wheelJackpotCents: sql`${serverEconomy.wheelJackpotCents} + ${jackpotCentsOf(amount)}` })
        .where(eq(serverEconomy.serverId, serverId));
      const r = await m.placeStake({ serverId, roundId: round.id, userId, pick: String(pick), amount, now });
      if (!r.ok) throw new BetRefused(wheelRefusalOf(r.block as StakeBlock));
      return round.id;
    });
  } catch (err) {
    if (err instanceof BetRefused) return { ok: false, code: err.code, ...(err.retryAt ? { retryAt: err.retryAt.toISOString() } : {}) };
    throw err;
  } finally {
    // Снять замок, только если он ещё наш (мог истечь и достаться следующему нажатию).
    await redisPub
      .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token)
      .catch(() => {});
  }
  await publishRoundState(serverId);
  return { ok: true, roundId };
}

/** `wheel.state` с текущим живым раундом сервера (или `null`). Ошибка шины — только в лог: деньги уже в базе. */
async function publishRoundState(serverId: string): Promise<void> {
  try {
    const [cents, live] = await Promise.all([jackpotCentsOfServer(db, serverId), liveRound(db, serverId, false)]);
    const round = live ? wheelRoundDto(live, await stakesOf(db, live.id)) : null;
    await publishToServer(serverId, { t: 'wheel.state', serverId, round, jackpot: wheelJackpotCoins(cents), serverNow: new Date().toISOString() });
  } catch (err) {
    console.warn(`[wheel] wheel.state ${serverId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function publishResult(serverId: string, last: WheelResultDto): Promise<void> {
  try {
    const cents = await jackpotCentsOfServer(db, serverId);
    const now = new Date();
    const cooldown = wheelCooldownUntil(new Date(last.settledAt), now);
    await publishToServer(serverId, {
      t: 'wheel.result',
      serverId,
      last,
      jackpot: wheelJackpotCoins(cents),
      cooldownUntil: cooldown ? cooldown.toISOString() : null,
      serverNow: now.toISOString(),
    });
  } catch (err) {
    console.warn(`[wheel] wheel.result ${serverId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Игры сервера выключены (`PATCH …/economy`): отменить живое колесо с возвратом ставок и сказать клиентам `round: null`.
 * Зовётся ПОСЛЕ коммита правки настроек, своей транзакцией (порядок замков — шапка). Возвращает число отменённых раундов.
 */
export async function cancelWheelRounds(serverId: string): Promise<number> {
  const cancelled = await withGameMoney((m) => cancelLiveRounds(m, serverId));
  if (cancelled.some((r) => r.kind === 'wheel')) await publishRoundState(serverId);
  return cancelled.length;
}

type StepOutcome = { kind: 'locked' | 'cancelled'; serverId: string } | { kind: 'settled'; serverId: string; last: WheelResultDto | null } | null;

/**
 * Один переход одного созревшего раунда — своей транзакцией. Созрел: открытый с `lock_at <= now`, запертый с
 * `settle_at <= now`, либо любой живой на сервере, где игры (или экономика) выключены — тот отменяется.
 * `SKIP LOCKED`: раунд, в который прямо сейчас ставят, ждёт следующего такта, а не держит такт.
 */
async function wheelStep(now: Date, skip: string[], only?: string): Promise<StepOutcome> {
  const jackpotUsers: string[] = [];
  const outcome = await withGameMoney(async (m): Promise<StepOutcome> => {
    const [round] = await m.tx
      .select({
        id: gameRounds.id,
        serverId: gameRounds.serverId,
        state: gameRounds.state,
        data: gameRounds.data,
        lockAt: gameRounds.lockAt,
        settleAt: gameRounds.settleAt,
        economyOn: serverEconomy.enabled,
        gamesOn: serverEconomy.gamesEnabled,
      })
      .from(gameRounds)
      .leftJoin(serverEconomy, eq(serverEconomy.serverId, gameRounds.serverId))
      .where(
        and(
          eq(gameRounds.kind, 'wheel'),
          inArray(gameRounds.state, [...LIVE]),
          // ⚠️ Только раунды, заведённые колесом (у них всегда есть `lock_at`), — чужие строки `kind='wheel'` не трогаем.
          isNotNull(gameRounds.lockAt),
          skip.length > 0 ? sql`${gameRounds.id} NOT IN (${sql.join(skip.map((s) => sql`${s}`), sql`, `)})` : undefined,
          // «Крутить сейчас»: только этот раунд (такт по всем серверам из запроса человека не гоняем).
          only ? eq(gameRounds.id, only) : undefined,
          or(
            and(eq(gameRounds.state, 'open'), lte(gameRounds.lockAt, now)),
            and(eq(gameRounds.state, 'locked'), lte(gameRounds.settleAt, now)),
            isNull(serverEconomy.serverId),
            eq(serverEconomy.enabled, false),
            eq(serverEconomy.gamesEnabled, false),
          ),
        ),
      )
      .orderBy(asc(gameRounds.lockAt))
      .limit(1)
      .for('update', { of: gameRounds, skipLocked: true });
    if (!round) return null;
    skip.push(round.id);

    if (!round.economyOn || !round.gamesOn) {
      await cancelLiveRounds(m, round.serverId, [round.id]);
      return { kind: 'cancelled', serverId: round.serverId };
    }

    const data = round.data as unknown as WheelRoundData;
    if (round.state === 'open') {
      const { sector, jackpotHit } = wheelOutcome(round.id, data.seed);
      await m.tx
        .update(gameRounds)
        .set({ state: 'locked', settleAt: new Date(now.getTime() + WHEEL_SPIN_MS), data: { ...data, sector, jackpotHit } })
        .where(eq(gameRounds.id, round.id));
      return { kind: 'locked', serverId: round.serverId };
    }

    // locked → settled. Сектор — уже записанный при блокировке (его видели клиенты), не пересчёт.
    const sector = typeof data.sector === 'number' ? data.sector : wheelOutcome(round.id, data.seed).sector;
    const natural = typeof data.jackpotHit === 'boolean' ? data.jackpotHit : wheelOutcome(round.id, data.seed).jackpotHit;
    const [eco] = await m.tx
      .select({ cents: serverEconomy.wheelJackpotCents })
      .from(serverEconomy)
      .where(eq(serverEconomy.serverId, round.serverId))
      .limit(1)
      .for('update');
    // 🔴 Флаг тестового инстанса: навязанный срыв помечается `forced` — в итоге и в проверке честности, не прячется.
    const { jackpotHit, forced } = wheelForcedJackpot(natural, env.wheelForceJackpot, Number(eco?.cents ?? 0));
    const stakes = await m.tx
      .select({ userId: gameStakes.userId, pick: gameStakes.pick, amount: gameStakes.amount })
      .from(gameStakes)
      .where(and(eq(gameStakes.roundId, round.id), isNull(gameStakes.paidAt), isNull(gameStakes.refundedAt)))
      .orderBy(asc(gameStakes.userId), asc(gameStakes.pick));
    const plan = wheelSettlePlan(stakes, sector, jackpotHit, Number(eco?.cents ?? 0));
    await m.lockWallets(round.serverId, stakes.map((s) => s.userId));
    for (let i = 0; i < stakes.length; i++) {
      await m.payStake({ roundId: round.id, userId: stakes[i].userId, pick: stakes[i].pick, payout: plan.payouts[i] });
    }
    for (const share of plan.jackpotShares) {
      await applyCoins(m.tx, {
        serverId: round.serverId,
        userId: share.userId,
        amount: share.coins,
        reason: WHEEL_JACKPOT_REASON,
        data: { roundId: round.id, pick: 'jackpot' },
      });
      jackpotUsers.push(share.userId);
    }
    if (jackpotHit) {
      await m.tx.update(serverEconomy).set({ wheelJackpotCents: plan.leftCents }).where(eq(serverEconomy.serverId, round.serverId));
    }
    const settledAt = new Date(now.getTime());
    const settledData: WheelRoundData = {
      ...data,
      sector,
      jackpotHit,
      ...(forced ? { forced: true } : {}),
      jackpotPaid: plan.jackpotPaid,
      pool: plan.pool,
      fee: plan.fee,
      jackpotCents: plan.jackpotCents,
      winners: plan.winners,
    };
    await m.tx
      .update(gameRounds)
      .set({ state: 'settled', settledAt, data: { ...settledData } })
      .where(eq(gameRounds.id, round.id));
    return {
      kind: 'settled',
      serverId: round.serverId,
      last: wheelResultDto({ id: round.id, state: 'settled', settledAt, data: { ...settledData } }),
    };
  });
  // Доли сундука прошли мимо `withGameMoney` (у них нет ставки) — их кошельки шлём сами, тоже после коммита.
  if (outcome?.serverId) for (const userId of new Set(jackpotUsers)) await pushWallet(outcome.serverId, userId);
  return outcome;
}

/**
 * «Крутить сейчас» (решение владельца 30.10): любой, кто поставил в текущем раунде, закрывает приём досрочно — дальше та
 * же блокировка, что по истечении окна (`wheelStep`: сектор из уже загаданного зерна, замок и зерно не меняются —
 * честность та же). Шаг 1 — своей транзакцией: живой раунд `FOR UPDATE` (ждём идущую ставку, а не обходим её), он
 * `open` и у вызвавшего есть неотменённая ставка → `lock_at = now`; с этого мига ставка получит `round_locked`.
 * Шаг 2 — переход этого раунда (`wheelStep` с `only`) и `wheel.state` всем. 🔴 Гонка с тактом идемпотентна: переход
 * берёт строку `SKIP LOCKED` и перечитывает состояние — кто первый запер, тот и шлёт событие, второй ничего не находит;
 * раунд уже `locked` (нажали двое, или такт успел) — ответ «да», без второго перехода.
 */
export async function spinWheelNow(serverId: string, userId: string, now = new Date()): Promise<{ ok: true } | { ok: false; code: WheelSpinRefusal }> {
  const closed = await db.transaction(async (tx) => {
    const round = await liveRound(tx, serverId, true);
    if (!round) return { ok: false as const, code: 'no_round' as const };
    const [bet] = await tx
      .select({ userId: gameStakes.userId })
      .from(gameStakes)
      .where(and(eq(gameStakes.roundId, round.id), eq(gameStakes.userId, userId), isNull(gameStakes.refundedAt)))
      .limit(1);
    if (!bet) return { ok: false as const, code: 'no_bet' as const };
    if (round.state !== 'open') return { ok: true as const, roundId: null };
    if (round.lockAt && round.lockAt.getTime() > now.getTime()) {
      await tx
        .update(gameRounds)
        .set({ lockAt: now, data: { ...(round.data as unknown as WheelRoundData), closedBy: userId } })
        .where(and(eq(gameRounds.id, round.id), eq(gameRounds.state, 'open')));
    }
    return { ok: true as const, roundId: round.id };
  });
  if (!closed.ok) return closed;
  if (closed.roundId) {
    const step = await wheelStep(now, [], closed.roundId);
    // Строку держит такт или ставка (`SKIP LOCKED`) — её запрёт ближайший такт (≤ 1 с) и сам разошлёт `wheel.state`.
    if (step) await publishRoundState(step.serverId);
  }
  return { ok: true };
}

export interface WheelTickReport {
  locked: number;
  settled: number;
  cancelled: number;
}

/** Такт: созревшие раунды по одному переходу, не больше `WHEEL_TICK_BATCH`. События — после коммита каждого перехода. */
export async function runWheelTick(now = new Date()): Promise<WheelTickReport> {
  const report: WheelTickReport = { locked: 0, settled: 0, cancelled: 0 };
  const skip: string[] = [];
  for (let i = 0; i < WHEEL_TICK_BATCH; i++) {
    const step = await wheelStep(now, skip);
    if (!step) break;
    report[step.kind] += 1;
    if (step.kind === 'settled') {
      if (step.last) await publishResult(step.serverId, step.last);
    } else {
      await publishRoundState(step.serverId);
    }
  }
  return report;
}

let started = false;

/**
 * Запустить такт колеса (`routes/gameWheel.ts`, `onListen` — тесты на `inject` его не заводят). Первый такт — сразу:
 * раунды, созревшие за время перезапуска, рассчитываются без ожидания. Новый такт поверх незавершённого не стартует.
 */
export function startWheelWorker(): void {
  if (started) return;
  started = true;
  if (env.wheelForceJackpot) {
    // 🔴 Громко: флаг только для тестового инстанса — увидеть его в логе прода значит снять немедленно.
    console.warn('[wheel] ⚠️⚠️⚠️ WHEEL_FORCE_JACKPOT ВКЛЮЧЁН: каждый раунд колеса срывает сундук (помечается «принудительный»). ТОЛЬКО dev — на проде снять!');
  }
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runWheelTick()
      .catch((err: unknown) => {
        console.warn(`[wheel] такт упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, WHEEL_TICK_MS);
  timer.unref();
}

/*
 * ——— «Запустить игры» (ГусКоины 2, решения владельца 29.10, пп. 8–9) ———
 * Разовая отметка, включение игр и подарок каждому, кто в момент запуска сидит в голосовых каналах сервера. Маршрут —
 * `POST /servers/:id/games/launch` (`routes/gameWheel.ts`), правила — `gameMoneyRules.ts` (раздел «Запустить игры»).
 * Здесь, рядом с `inVoiceOfServer`, а не отдельным модулем: те же presence-ключи и закрытые перечни импортов в проверках.
 *
 * Подарок — ЭМИССИЯ, как ретроначисление (`routes/economy.ts`, `economy.retro`), а не перевод из сундука колеса: у сервера
 * нет казны, из которой платят люди, а сундук — чужие проигрыши, раздавать их «за то, что пришёл» нельзя. Строка журнала
 * `games.launch` с `countsAsEarned: false` — подарок не растит `earnedTotal`/сезон (уровни и таблица подарком не
 * покупаются). Баланс и журнал идут вместе через `applyCoins`, поэтому `drift` сводки остаётся нулём.
 */

/**
 * Кто сейчас сидит в голосовых каналах сервера — presence в Redis (`presence:ch:<id>`, как `inVoiceOfServer`). Redis
 * недоступен или ключ испорчен — канал пропускаем: подарок не достаётся, но запуск не падает.
 */
export async function voiceUsersOfServer(serverId: string): Promise<string[]> {
  const out = new Set<string>();
  try {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.type, 'voice'), eq(channels.serverId, serverId)));
    if (rows.length === 0) return [];
    const pipe = redisPub.pipeline();
    for (const r of rows) pipe.get(`presence:ch:${r.id}`);
    const res = (await pipe.exec()) ?? [];
    for (const [err, raw] of res) {
      if (err || typeof raw !== 'string') continue;
      try {
        const list = JSON.parse(raw) as VoiceParticipant[];
        if (!Array.isArray(list)) continue;
        for (const p of list) if (typeof p?.userId === 'string') out.add(p.userId);
      } catch {
        /* мусор в ключе — этот канал пропускаем */
      }
    }
  } catch {
    /* шина недоступна — сидящих не знаем */
  }
  return [...out];
}

export type LaunchOutcome = { ok: true; at: Date; gift: number; userIds: string[] } | { ok: false; code: 'already-launched' };

/**
 * Запуск ОДНОЙ транзакцией: отметка (`games_launched_at IS NULL` — замок от второго нажатия: параллельный запрос ждёт на
 * строке настроек и видит её занятой), `games_enabled = true` и подарки. Падение на середине откатывает всё — кнопка
 * остаётся доступной. Второй рубеж от двойного подарка — частичный UNIQUE `coin_ledger_games_launch_uq` (0166).
 * ⚠️ Порядок замков как у ретро: строка `server_economy`, потом кошельки (`applyCoins` → `lockWallet`).
 * Шина (кошельки, `games.launched`, `server.invalidate`) — за коммитом, у `announceLaunch`.
 */
export async function launchGames(
  economy: Pick<ServerEconomy, 'serverId' | 'seasonLength'>,
  byUserId: string,
  gift: number,
  inVoice: readonly string[],
): Promise<LaunchOutcome> {
  const serverId = economy.serverId;
  return db.transaction(async (tx) => {
    const at = new Date();
    const marked = await tx
      .update(serverEconomy)
      .set({ gamesEnabled: true, gamesLaunchedAt: at, gamesLaunchedBy: byUserId, gamesLaunchGift: gift, updatedAt: at })
      .where(and(eq(serverEconomy.serverId, serverId), isNull(serverEconomy.gamesLaunchedAt)))
      .returning({ serverId: serverEconomy.serverId });
    if (marked.length === 0) return { ok: false as const, code: 'already-launched' as const };
    const ids = [...new Set(inVoice)];
    if (gift <= 0 || ids.length === 0) return { ok: true as const, at, gift, userIds: [] };

    // Только участники сервера (в голосе может сидеть гость связки без членства) и не боты.
    const members = await tx
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, ids), eq(users.bot, false)));
    // Отказавшиеся от экономики (`optedOut`) или от игр (`gamesOptOut`) подарка не получают.
    const declined = await tx
      .select({ userId: coinBalances.userId, optedOut: coinBalances.optedOut, gamesOptOut: coinBalances.gamesOptOut })
      .from(coinBalances)
      .where(and(eq(coinBalances.serverId, serverId), inArray(coinBalances.userId, ids)));
    const memberSet = new Set(members.map((m) => m.userId));
    const declinedSet = new Set(declined.filter((d) => d.optedOut || d.gamesOptOut).map((d) => d.userId));
    const recipients = launchRecipients(ids, (u) => memberSet.has(u) && !declinedSet.has(u));

    for (const userId of recipients) {
      await applyCoins(tx, {
        serverId,
        userId,
        amount: gift,
        reason: GAMES_LAUNCH_REASON,
        refUserId: byUserId,
        data: { launchedAt: at.toISOString() },
        seasonLength: economy.seasonLength,
        countsAsEarned: false,
      });
    }
    return { ok: true as const, at, gift, userIds: recipients };
  });
}

/** После коммита: кошельки одарённых, `games.launched` всем участникам сервера и `server.invalidate` (снимки экономики). */
export async function announceLaunch(serverId: string, out: { at: Date; gift: number; userIds: string[] }): Promise<void> {
  for (const userId of out.userIds) await pushWallet(serverId, userId);
  try {
    await publishToServer(serverId, {
      t: 'games.launched',
      serverId,
      at: out.at.toISOString(),
      gift: out.gift,
      giftedUserIds: out.userIds,
    });
    // Старый клиент `games.launched` не знает — включённые игры он увидит по перечитанному снимку экономики.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
  } catch {
    /* шина недоступна — карточку покажет вход (снимок несёт `gamesLaunch`) */
  }
}
