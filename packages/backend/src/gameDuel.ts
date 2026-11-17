import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import {
  DUEL_INVITE_MS,
  DUEL_DICE_WINS,
  DUEL_CHOICE_GAMES,
  DUEL_REMATCH_PAUSE_MS,
  DUEL_ROLL_TURN_MS,
  DUEL_SERIES_LEASE_MS,
  FEATURE_DUEL2,
  FEATURE_DUEL21,
  isDuelChoiceGame,
  isRpsHand,
  previewAllows,
  type DuelDto,
  type DuelGame,
  type DuelSnapshotDto,
  type DuelSeriesDto,
  type DuelSeriesPulse,
  type RpsHand,
} from '@gusvoice/shared';
import { dayStart } from './coinRules.js';
import { economySeenBy, isBotUser } from './coins.js';
import { db } from './db/index.js';
import { channels, coinLedger, gameMoves, gameRounds, gameStakes, serverEconomy, serverMembers, users } from './db/schema.js';
import { economyDefaults } from './economyDefaults.js';
import { env } from './env.js';
import { cancelLiveRounds, configureDuelAnnouncer, stakeCheckOf, withGameMoney, type GameMoney, type GameTx } from './gameMoney.js';
import {
  DUEL_PAIR_COOLDOWN_MS,
  DUEL_RESULT_SHOW_MS,
  duelCommit,
  duelDto,
  duelDtoFor,
  duelPairKey,
  duelRefusalOf,
  duelReveal,
  duelSettlePlan,
  duelSideOf,
  duelStartData,
  duelTurnMs,
  duelWinNet,
  greedyAct,
  greedyTimeout,
  pairBlocked,
  rpsMarkReady,
  rpsResolve,
  rpsTimeout,
  thinkMsOf,
  withAuto,
  withThink,
  twentyOneAct,
  twentyOneTimeout,
  seriesBothReady,
  seriesControl,
  seriesLeaseExpired,
  seriesOffered,
  seriesPaused,
  seriesScore,
  seriesStopped,
  type DuelRefusal,
  type DuelRoundData,
  type DuelSide,
} from './gameDuelRules.js';
import { publishToChannel, publishToUser, redisPub } from './realtime.js';
import { id as newId } from './util.js';
import { inVoiceChannel, voiceParticipantIds } from './voicePresence.js';

/**
 * Гусиная дуэль (ГусКоины 2, этап 3) — транзакции и такт. Правила — `gameDuelRules.ts` + `@gusvoice/shared/duel.ts`,
 * деньги — `gameMoney.ts` (этап 1), маршруты — `routes/gameDuel.ts`, контракт — `docs/guscoins-v2-plan.md` («Дуэли»).
 *
 * Партия — строка `game_rounds kind='duel'`: вызов `open` (БЕЗ ставок, `lock_at` = срок ответа) → принятие одной
 * транзакцией ставит ОБЕ ставки и решает все броски (`locked`, `data.phase='playing'`, `settle_at` = дедлайн нажатия) →
 * нажатия «Бросить» раскрывают кости, по сроку их раскрывает такт → `phase='done'`, `settle_at` = конец анимации → такт
 * рассчитывает (`settled`). Отказ, отзыв, молчание, выключение игр, удаление аккаунта — `cancelled` с `data.reason`.
 *
 * Этап 4 — игры с выбором (`rps`, `greedy`): после принятия `phase='moving'`, `settle_at` = срок хода (`DUEL_MOVE_MS`).
 * Ходы — `moveDuel` (строки `game_moves`, идемпотентно по `(round, user, seq)`), просрочку разбирает такт (КНБ — поражение
 * молчавшего или возврат обоим, Жадный гусь — автостоп/автобросок, `GREEDY_MAX_TIMEOUTS` подряд — поражение). Исход —
 * `data.outcome`, дальше `done` → тот же расчёт. Вызов и принятие проверяют суточный предел пары (`pairLimited`).
 * 🔴 Рука КНБ до раскрытия — только в `game_moves` и в личном ответе игроку (`myHand`), не в DTO и не в `duel.state`.
 *
 * 🔴 Состояние — ТОЛЬКО в базе: таймеров в памяти нет, после перезапуска первый такт подбирает просроченное.
 * 🔴 Порядок замков как у колеса: раунд → (строка `server_economy` — дуэль её не блокирует) → кошельки по `user_id`
 *    (`lockWallets`). Вызов раунда ещё не имеет — берёт кошельки обоих, потом вставляет строку.
 * 🔴 Зерно и нераскрытые кости наружу — только через `duelDto` (зерно — в итоге).
 * 🔴 Предохранитель расчёта: обе ставки на месте и не закрыты — иначе отмена с возвратом оставшимся, а не выплата банка,
 *    которого уже нет (удаление аккаунта, `gameMoney.cancelDuelsOf`).
 */

/** Такт дуэлей: раз в секунду (срок ответа 30 с, нажатия 15 с, анимация 1.5 с). */
export const DUEL_TICK_MS = 1_000;
/** Переходов за такт — не больше (каждый своей транзакцией). */
const DUEL_TICK_BATCH = 20;
/** Замок от двойного нажатия (человек + сервер). */
const DUEL_ACT_LOCK_MS = 3_000;

const LIVE = ['open', 'locked'] as const;

type DuelRow = typeof gameRounds.$inferSelect;

/** `myHand` (этап 4) — только в ответе на ход КНБ самому игроку: своя рука текущего раунда. */
export type DuelResult = { ok: true; duel: DuelDto | null; myHand?: RpsHand | null } | { ok: false; code: DuelRefusal; retryAt?: string };

/** Отказ внутри транзакции — откатить всё (ставки, строку вызова). */
class DuelRefused extends Error {
  constructor(readonly code: DuelRefusal) {
    super(code);
  }
}

class SeriesNotReady extends Error {
  constructor(readonly reason: 'lease_expired' | 'not_ready') { super(reason); }
}

/** Замок Redis с токеном: занят — `busy`; снимается, только если ещё наш (мог истечь и достаться следующему нажатию). */
async function withActLock(serverId: string, userId: string, fn: () => Promise<DuelResult>): Promise<DuelResult> {
  const key = `duel:act:${serverId}:${userId}`;
  const token = randomBytes(8).toString('hex');
  if ((await redisPub.set(key, token, 'PX', DUEL_ACT_LOCK_MS, 'NX')) !== 'OK') return { ok: false, code: 'busy' };
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DuelRefused) return { ok: false, code: err.code };
    throw err;
  } finally {
    await redisPub
      .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token)
      .catch(() => {});
  }
}

async function duelRow(q: GameTx | typeof db, serverId: string, duelId: string, lock: boolean): Promise<DuelRow | undefined> {
  const base = q
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.id, duelId), eq(gameRounds.serverId, serverId), eq(gameRounds.kind, 'duel')))
    .limit(1);
  const [row] = lock ? await base.for('update') : await base;
  return row;
}

const dataOf = (row: { data: Record<string, unknown> }) => row.data as unknown as DuelRoundData;

/** Coordinator is always locked alone; money workers never need to lock it while holding a child row. */
async function seriesCurrent(anchor: DuelRow, q: GameTx | typeof db = db): Promise<DuelRow> {
  const control = dataOf(anchor).seriesControl;
  return control && control.currentId !== anchor.id ? (await duelRow(q, anchor.serverId, control.currentId, false)) ?? anchor : anchor;
}

async function withSeriesView(row: DuelRow, q: GameTx | typeof db = db): Promise<DuelRow> {
  const local = dataOf(row).series;
  if (!local) return row;
  const anchor = await duelRow(q, row.serverId, local.id, false);
  const data = anchor && dataOf(anchor);
  if (!data?.series) return row;
  let view = { ...data.series, round: local.round };
  // Settlement is independently durable; expose its score even before the coordinator's next tick.
  if (row.state === 'settled' && (data.seriesControl?.countedRound ?? 0) < local.round) view.score = local.score;
  if (row.state === 'settled' && view.status === 'active') {
    view = { ...view, status: 'waiting', nextAt: new Date(row.settledAt!.getTime() + DUEL_REMATCH_PAUSE_MS).toISOString() };
  }
  if (row.state === 'cancelled' && view.status !== 'stopped') view = seriesStopped(view, 'cancelled');
  return { ...row, data: { ...row.data, series: view } };
}

async function seriesReply(row: DuelRow, viewerId: string): Promise<DuelDto | null> {
  return duelDtoFor(await withSeriesView(row), viewerId);
}

async function seriesResult(result: DuelResult, viewerId: string): Promise<DuelResult> {
  if (!result.ok || !result.duel?.series) return result;
  const row = await duelRow(db, result.duel.serverId, result.duel.id, false);
  if (!row) return result;
  const anchor = await duelRow(db, row.serverId, result.duel.series.id, false);
  const current = anchor ? await seriesCurrent(anchor) : row;
  return { ...result, duel: await seriesReply(current, viewerId), ...(current.id !== row.id && result.myHand !== undefined ? { myHand: null } : {}) };
}

/** Shared escrow entry for ordinary accept and EVERY automatic round. Caller owns row + both wallets. */
async function startDuelRound(m: GameMoney, round: DuelRow, data: DuelRoundData, now: Date): Promise<DuelRow> {
  await m.lockWallets(round.serverId, [data.challengerId, data.targetId]);
  if (isDuelChoiceGame(data.game) && await pairLimited(m.tx, round.serverId, data.challengerId, data.targetId, data.amount, data.feePercent, now)) {
    throw new DuelRefused('pair_limit');
  }
  for (const [uid, rival, mine] of [[data.targetId, data.challengerId, true], [data.challengerId, data.targetId, false]] as const) {
    const stake = await m.placeStake({ serverId: round.serverId, roundId: round.id, userId: uid, pick: 'duel', amount: data.amount, refUserId: rival, now });
    if (!stake.ok) throw new DuelRefused(duelRefusalOf(stake.block, mine));
  }
  const [started] = await m.tx.update(gameRounds)
    .set({ state: 'locked', settleAt: new Date(now.getTime() + duelTurnMs(data.game)), data: { ...duelStartData(round.id, data, now) } })
    .where(eq(gameRounds.id, round.id)).returning();
  return started;
}

/**
 * Чистый поток пары за сутки МСК в играх с выбором (этап 4): выигрыши `a` у `b` минус выигрыши `b` у `a` — по `duel.win` с
 * `ref_user_id` и `data.net` (`gameMoney.payStake`); строки без `net` — всей суммой. Кубики не считаются: игра раунда
 * берётся из `game_rounds.data.game` (в журнале её нет).
 */
async function pairFlowOf(q: GameTx, serverId: string, a: string, b: string, now: Date): Promise<number> {
  const [row] = await q
    .select({
      flow: sql<number>`COALESCE(SUM(CASE WHEN ${coinLedger.userId} = ${a} THEN 1 ELSE -1 END * GREATEST(COALESCE((${coinLedger.data}->>'net')::int, ${coinLedger.amount}), 0)), 0)::int`,
    })
    .from(coinLedger)
    .innerJoin(gameRounds, sql`${gameRounds.id} = ${coinLedger.data}->>'roundId'`)
    .where(
      and(
        eq(coinLedger.serverId, serverId),
        eq(coinLedger.reason, 'duel.win'),
        inArray(sql<string>`${gameRounds.data}->>'game'`, [...DUEL_CHOICE_GAMES]),
        or(and(eq(coinLedger.userId, a), eq(coinLedger.refUserId, b)), and(eq(coinLedger.userId, b), eq(coinLedger.refUserId, a))),
        gte(coinLedger.createdAt, dayStart(now)),
      ),
    );
  return Number(row?.flow ?? 0);
}

/**
 * Упрётся ли новая партия пары в суточный предел игр с выбором (`games_pair_daily_max`, 0 — без предела). Звать под
 * замками кошельков обоих (`lockWallets`): одна живая дуэль на человека — поток пары между проверкой и ставкой не сдвинется.
 */
async function pairLimited(q: GameTx, serverId: string, a: string, b: string, amount: number, feePercent: number, now: Date): Promise<boolean> {
  const [eco] = await q
    .select({ max: serverEconomy.gamesPairDailyMax })
    .from(serverEconomy)
    .where(eq(serverEconomy.serverId, serverId))
    .limit(1);
  const max = eco?.max ?? economyDefaults(serverId).gamesPairDailyMax;
  if (!(max > 0)) return false;
  return pairBlocked(await pairFlowOf(q, serverId, a, b, now), duelWinNet(amount, feePercent), max);
}

/**
 * Разослать состояние дуэли. Вызов (`open`) и его отмена до принятия — лично обоим игрокам; партия и её итог — сидящим в
 * голосовом канале и обоим игрокам. Сбой шины — только в лог: деньги уже в базе, клиент доберёт снимком.
 */
async function publishDuel(row: DuelRow): Promise<void> {
  // Only series rows need the coordinator lookup; ordinary publication stays independent of DB IO.
  if (dataOf(row).series) {
    const current = await duelRow(db, row.serverId, row.id, false);
    row = await withSeriesView(current ?? row);
  }
  const data = dataOf(row);
  const duel = duelDto(row);
  if (!duel) return;
  const serverNow = new Date().toISOString();
  const msgFor = (viewerId: string | null) => ({ t: 'duel.state' as const, serverId: row.serverId, channelId: data.channelId, duel: duelDtoFor(row, viewerId), serverNow });
  try {
    if (!data.phase) {
      await publishToUser(data.challengerId, msgFor(data.challengerId));
      await publishToUser(data.targetId, msgFor(data.targetId));
      return;
    }
    const audience = new Set(await voiceParticipantIds(data.channelId));
    // Счёт Жадного гуся скрыт, пока идут ходы (29.10, `duelDtoFor`): игрокам — лично, каждому со своей стороной; зрителям
    // канала — маска целиком. Остальное (кубики, КНБ, итог, отмена) — одной рассылкой, как раньше.
    if ((data.game === 'greedy' && row.state === 'locked' && data.phase === 'moving') ||
        (data.game === 'twentyone' && data.twentyOne && !data.twentyOne.finished)) {
      await publishToUser(data.challengerId, msgFor(data.challengerId));
      await publishToUser(data.targetId, msgFor(data.targetId));
      audience.delete(data.challengerId);
      audience.delete(data.targetId);
      if (audience.size > 0) await publishToChannel(row.serverId, data.channelId, msgFor(null), [...audience]);
      return;
    }
    audience.add(data.challengerId);
    audience.add(data.targetId);
    await publishToChannel(row.serverId, data.channelId, msgFor(null), [...audience]);
  } catch (err) {
    console.warn(`[duel] duel.state ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function publishDuelById(serverId: string, duelId: string): Promise<DuelDto | null> {
  const row = await duelRow(db, serverId, duelId, false);
  if (!row) return null;
  await publishDuel(row);
  return duelDto(row);
}

// Удаление аккаунта и выключение игр отменяют дуэли в модуле денег — рассылку `duel.state` он зовёт через этот вход.
configureDuelAnnouncer(async (serverId, roundIds) => {
  for (const duelId of roundIds) await publishDuelById(serverId, duelId);
});

/** Пауза повторного вызова пары (Redis). Сбой Redis — без паузы: это удобство, не деньги. */
async function setPairPause(serverId: string, challengerId: string, targetId: string, ms: number): Promise<void> {
  await redisPub.set(duelPairKey(serverId, challengerId, targetId), '1', 'PX', ms).catch(() => {});
}

/**
 * Снимок для человека: партия канала (живая или закончившаяся не раньше `DUEL_RESULT_SHOW_MS`) — только сидящему в этом
 * канале или игроку; вызов (`open`) — только его игрокам. `myInvite` — входящий вызов мне на этом сервере.
 */
export async function duelSnapshot(serverId: string, channelId: string, viewerId: string, now = new Date()): Promise<DuelSnapshotDto> {
  const base: DuelSnapshotDto = { duel: null, myInvite: null, serverNow: now.toISOString() };
  const economy = await economySeenBy(serverId, viewerId);
  if (!economy?.enabled || !economy.gamesEnabled) return base;
  // Потолок и комиссия — для формы вызова у обычного участника: настройки сервера видят только управляющие.
  base.betMax = economy.gamesBetMax;
  base.feePercent = economy.gamesFeePercent;
  const [invite] = await db
    .select()
    .from(gameRounds)
    .where(
      and(
        eq(gameRounds.serverId, serverId),
        eq(gameRounds.kind, 'duel'),
        eq(gameRounds.state, 'open'),
        gt(gameRounds.lockAt, now),
        sql`${gameRounds.data}->>'targetId' = ${viewerId}`,
      ),
    )
    .orderBy(desc(gameRounds.createdAt))
    .limit(1);
  base.myInvite = invite ? duelDtoFor(invite, viewerId) : null;
  const inChannel = channelId ? sql`${gameRounds.data}->>'channelId' = ${channelId}` : sql`false`;
  const [live] = await db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.serverId, serverId), eq(gameRounds.kind, 'duel'), inArray(gameRounds.state, [...LIVE]), inChannel))
    .limit(1);
  const [recent] = live
    ? [live]
    : await db
        .select()
        .from(gameRounds)
        .where(
          and(
            eq(gameRounds.serverId, serverId),
            eq(gameRounds.kind, 'duel'),
            inArray(gameRounds.state, ['settled', 'cancelled']),
            inChannel,
            // Только сыгранные (принятые) — отменённый вызов чужим не показывается.
            sql`(${gameRounds.data}->>'phase') IS NOT NULL`,
            gt(gameRounds.settledAt, new Date(now.getTime() - DUEL_RESULT_SHOW_MS)),
          ),
        )
        .orderBy(desc(gameRounds.settledAt))
        .limit(1);
  // Paused sessions retain their score beyond the ordinary 30 s result window. Players only.
  let visible = recent;
  if (!visible) {
    const [anchor] = await db.select().from(gameRounds).where(and(
      eq(gameRounds.serverId, serverId), eq(gameRounds.kind, 'duel'), inChannel,
      sql`${gameRounds.data}->'seriesControl' IS NOT NULL`,
      sql`${gameRounds.data}->'series'->>'status' <> 'stopped'`,
      or(sql`${gameRounds.data}->>'challengerId' = ${viewerId}`, sql`${gameRounds.data}->>'targetId' = ${viewerId}`),
    )).orderBy(desc(gameRounds.createdAt)).limit(1);
    if (anchor) visible = await seriesCurrent(anchor);
  }
  if (!visible) return base;
  const data = dataOf(visible);
  const player = duelSideOf(data, viewerId) !== null;
  if (visible.state === 'open' && !player) return base;
  // 🔴 Подсмотр: зритель — только сидящий в этом канале (presence, fail-closed); игрок видит свою партию и вне голоса.
  if (!player && !(await inVoiceChannel(data.channelId, viewerId))) return base;
  base.duel = await seriesReply(visible, viewerId);
  // Этап 4: своя рука КНБ текущего раунда — только лично игроку (в общий DTO и `duel.state` она не попадает).
  if (player && visible.state === 'locked' && data.game === 'rps' && data.phase === 'moving' && data.rps) {
    base.myHand = await myHandOf(db, visible.id, viewerId, data.rps.rounds.length);
  }
  return base;
}

/** Своя рука КНБ в раунде `seq` (ход не сделан — null). */
async function myHandOf(q: GameTx | typeof db, roundId: string, userId: string, seq: number): Promise<RpsHand | null> {
  const prev = await moveOf(q, roundId, userId, seq);
  const hand = prev?.hand;
  return isRpsHand(hand) ? hand : null;
}

/** Ход игрока `seq` из `game_moves` (нет — undefined). */
async function moveOf(q: GameTx | typeof db, roundId: string, userId: string, seq: number): Promise<Record<string, unknown> | undefined> {
  const [row] = await q
    .select({ move: gameMoves.move })
    .from(gameMoves)
    .where(and(eq(gameMoves.roundId, roundId), eq(gameMoves.userId, userId), eq(gameMoves.seq, seq)))
    .limit(1);
  return row?.move;
}

export interface ChallengeInput {
  serverId: string;
  channelId: string;
  challengerId: string;
  targetId: string;
  game: DuelGame;
  amount: number;
  series?: boolean;
}

/**
 * Вызов. Членство обоих и видимость экономики проверяет маршрут; здесь — канал, боты, «оба в этом голосовом канале»
 * (fail-closed), пауза пары, замок от двойного нажатия и транзакция: кошельки ОБОИХ под замком → «никто из пары не в
 * живой дуэли» → мягкая проверка ставки обоих БЕЗ записи → строка вызова (частичный UNIQUE «одна живая дуэль на канал»).
 */
export async function challengeDuel(i: ChallengeInput, now = new Date()): Promise<DuelResult> {
  if (i.challengerId === i.targetId) return { ok: false, code: 'self' };
  const [channel] = await db
    .select({ serverId: channels.serverId, type: channels.type })
    .from(channels)
    .where(eq(channels.id, i.channelId))
    .limit(1);
  if (!channel || channel.serverId !== i.serverId || channel.type !== 'voice') return { ok: false, code: 'not_voice_channel' };
  if (await isBotUser(db, i.targetId)) return { ok: false, code: 'target_unavailable' };
  if (!(await inVoiceChannel(i.channelId, i.challengerId))) return { ok: false, code: 'not_in_voice' };
  if (!(await inVoiceChannel(i.channelId, i.targetId))) return { ok: false, code: 'target_unavailable' };
  const pause = await redisPub.pttl(duelPairKey(i.serverId, i.challengerId, i.targetId)).catch(() => -2);
  if (pause > 0) return { ok: false, code: 'cooldown', retryAt: new Date(now.getTime() + pause).toISOString() };

  let created: DuelRow | undefined;
  const result = await withActLock(i.serverId, i.challengerId, async () => {
    created = await withGameMoney(async (m) => {
      // «Одна живая дуэль на человека» — на ВСЁМ инстансе, а кошельки у каждого сервера свои: два вызова одного человека
      // на разных серверах под замками своих кошельков оба видели бы «свободен» (найдено R332). Поэтому сначала —
      // транзакционный замок на самих людей (по возрастанию id, как кошельки), он один на инстанс; дальше кошельки.
      for (const uid of [i.challengerId, i.targetId].sort()) {
        await m.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`duel-user:${uid}`}))`);
      }
      await m.lockWallets(i.serverId, [i.challengerId, i.targetId]);
      const [busy] = await m.tx
        .select({ id: gameRounds.id })
        .from(gameRounds)
        .where(
          and(
            eq(gameRounds.kind, 'duel'),
            inArray(gameRounds.state, [...LIVE]),
            or(
              sql`${gameRounds.data}->>'challengerId' IN (${i.challengerId}, ${i.targetId})`,
              sql`${gameRounds.data}->>'targetId' IN (${i.challengerId}, ${i.targetId})`,
            ),
          ),
        )
        .limit(1);
      if (busy) throw new DuelRefused('in_duel');
      const mine = await stakeCheckOf(m.tx, { serverId: i.serverId, userId: i.challengerId, amount: i.amount, pick: 'duel', now });
      if (mine) throw new DuelRefused(duelRefusalOf(mine, true));
      const theirs = await stakeCheckOf(m.tx, { serverId: i.serverId, userId: i.targetId, amount: i.amount, pick: 'duel', now });
      if (theirs) throw new DuelRefused(duelRefusalOf(theirs, false));
      const [eco] = await m.tx
        .select({ feePercent: serverEconomy.gamesFeePercent })
        .from(serverEconomy)
        .where(eq(serverEconomy.serverId, i.serverId))
        .limit(1);
      // Этап 4: предел пары в играх с выбором — мягко, без записи (жёстко — при принятии). Причина про пару, а не про
      // чужой кошелёк: называется как есть.
      if (isDuelChoiceGame(i.game) && (await pairLimited(m.tx, i.serverId, i.challengerId, i.targetId, i.amount, eco?.feePercent ?? 0, now))) {
        throw new DuelRefused('pair_limit');
      }
      const id = newId();
      const seed = randomBytes(32).toString('hex');
      const data: DuelRoundData = {
        channelId: i.channelId,
        challengerId: i.challengerId,
        targetId: i.targetId,
        game: i.game,
        ...(i.game === 'dice' ? { diceTarget: DUEL_DICE_WINS } : {}),
        amount: i.amount,
        feePercent: eco?.feePercent ?? 0,
        commit: duelCommit(id, seed),
        seed,
        ...(i.series ? { series: seriesOffered(id) } : {}),
      };
      const [row] = await m.tx
        .insert(gameRounds)
        .values({
          id,
          serverId: i.serverId,
          kind: 'duel',
          state: 'open',
          createdBy: i.challengerId,
          lockAt: new Date(now.getTime() + DUEL_INVITE_MS),
          data: { ...data },
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new DuelRefused('channel_busy');
      return row;
    });
    return { ok: true, duel: duelDtoFor(created, i.challengerId) };
  });
  if (result.ok && created) await publishDuel(created);
  return result;
}

/**
 * Принятие — ОДНА транзакция: вызов `FOR UPDATE` (ещё `open` и не просрочен) → кошельки обоих → ставка цели и ставка
 * вызвавшего (`placeStake` этапа 1, `pick:'duel'`, `refUserId` — соперник) → все броски из зерна → `locked`. Любой отказ
 * откатывает всё: никто ничего не теряет. Причина отказа вызвавшего принимающему не раскрывается.
 */
export async function acceptDuel(serverId: string, duelId: string, userId: string, now = new Date(), series = false): Promise<DuelResult> {
  const pre = await duelRow(db, serverId, duelId, false);
  if (!pre) return { ok: false, code: 'not_found' };
  const preData = dataOf(pre);
  if (preData.targetId !== userId) return { ok: false, code: 'not_player' };
  if (pre.state !== 'open' || !pre.lockAt || pre.lockAt.getTime() <= now.getTime()) return { ok: false, code: 'expired' };
  if (preData.game === 'twentyone') {
    const { userHasCap } = await import('./gateway.js');
    if (!userHasCap(userId, FEATURE_DUEL21) || !userHasCap(preData.challengerId, FEATURE_DUEL21)) return { ok: false, code: 'target_unavailable' };
  }
  if (!(await inVoiceChannel(preData.channelId, userId))) return { ok: false, code: 'not_in_voice' };
  if (!(await inVoiceChannel(preData.channelId, preData.challengerId))) return { ok: false, code: 'target_unavailable' };

  let started: DuelRow | undefined;
  const result = await withActLock(serverId, userId, async () => {
    started = await withGameMoney(async (m) => {
      const round = await duelRow(m.tx, serverId, duelId, true);
      if (!round || round.state !== 'open' || !round.lockAt || round.lockAt.getTime() <= now.getTime()) throw new DuelRefused('expired');
      let data = dataOf(round);
      if (data.targetId !== userId) throw new DuelRefused('not_player');
      if (data.series?.status === 'offered' && series) {
        data = { ...data, series: { ...data.series, status: 'active' }, seriesControl: seriesControl(round.id, now) };
      } else {
        // Legacy accept (including empty body) deliberately opts into ONE round only.
        const { series: _offer, seriesControl: _control, ...single } = data;
        data = single;
      }
      return startDuelRound(m, round, data, now);
    });
    return { ok: true, duel: duelDtoFor(started, userId) };
  });
  if (result.ok && started) await publishDuel(started);
  return seriesResult(result, userId);
}

/** Отказ (цель) или отзыв (вызвавший) — условный UPDATE `open → cancelled`. После отказа — пауза пары 60 с. */
export async function endInvite(serverId: string, duelId: string, userId: string, how: 'declined' | 'withdrawn', now = new Date()): Promise<DuelResult> {
  const who = how === 'declined' ? 'targetId' : 'challengerId';
  const [row] = await db
    .update(gameRounds)
    .set({ state: 'cancelled', settledAt: now, data: sql`${gameRounds.data} || jsonb_build_object('reason', ${how}::text)` })
    .where(
      and(
        eq(gameRounds.id, duelId),
        eq(gameRounds.serverId, serverId),
        eq(gameRounds.kind, 'duel'),
        eq(gameRounds.state, 'open'),
        sql`${gameRounds.data}->>${who} = ${userId}`,
      ),
    )
    .returning();
  if (!row) {
    const cur = await duelRow(db, serverId, duelId, false);
    if (!cur) return { ok: false, code: 'not_found' };
    if (dataOf(cur)[who] !== userId) return { ok: false, code: 'not_player' };
    return { ok: false, code: 'expired' };
  }
  const data = dataOf(row);
  if (how === 'declined') await setPairPause(serverId, data.challengerId, data.targetId, DUEL_PAIR_COOLDOWN_MS);
  await publishDuel(row);
  return { ok: true, duel: duelDtoFor(row, userId) };
}

/** «Бросить»: раскрыть свои кости текущего броска. Идемпотентно; денег не касается — только строка раунда. */
export async function rollDuel(serverId: string, duelId: string, userId: string, now = new Date(), expectedRollNo?: number): Promise<DuelResult> {
  let changed: DuelRow | undefined;
  const out = await db.transaction(async (tx): Promise<DuelResult> => {
    const round = await duelRow(tx, serverId, duelId, true);
    if (!round) return { ok: false, code: 'not_found' };
    const data = dataOf(round);
    const side = duelSideOf(data, userId);
    if (!side) return { ok: false, code: 'not_player' };
    if (round.state !== 'locked') return { ok: false, code: 'not_playing' };
    // Новые клиенты передают номер виденного броска: поздний повтор не раскрывает следующий. Старый вызов совместим.
    if (expectedRollNo !== undefined && expectedRollNo !== (data.rollNo ?? 0)) return { ok: true, duel: duelDtoFor(round, userId) };
    const r = duelReveal(data, [side], now);
    if (!r.changed) return { ok: true, duel: duelDtoFor(round, userId) };
    // Сколько думал (этап 4, для званий): от начала броска (дедлайн минус срок нажатия) до нажатия.
    const think = round.settleAt ? Math.max(0, DUEL_ROLL_TURN_MS - (round.settleAt.getTime() - now.getTime())) : null;
    const [row] = await tx
      .update(gameRounds)
      .set({ data: { ...withThink(r.data, side, think), ...(data.series ? { manual: { ...data.manual, [side]: true } } : {}) }, ...(r.settleAt ? { settleAt: r.settleAt } : {}) })
      .where(eq(gameRounds.id, round.id))
      .returning();
    changed = row;
    return { ok: true, duel: duelDtoFor(row, userId) };
  });
  if (changed) await publishDuel(changed);
  return seriesResult(out, userId);
}

/**
 * Ход в игре с выбором (этап 4): `seq` — номер, который видел клиент (КНБ — раунд, Жадный гусь — действие партии), `move` —
 * рука КНБ (`rock|paper|scissors`) или `roll|stop`. Одна транзакция под замком раунда; денег не касается — расчёт делает такт.
 * 🔴 Идемпотентно: ход пишется `INSERT … ON CONFLICT DO NOTHING` по `(round, user, seq)` — повтор (двойное нажатие, повтор
 * после обрыва, нажатие после автохода сервера) возвращает текущее состояние и ничего не меняет; передумать нельзя.
 * КНБ: рука ложится только в `game_moves`, в данные раунда — флаг «готов»; второй ход раунда раскрывает обе руки разом.
 */
export async function moveDuel(serverId: string, duelId: string, userId: string, seq: number, move: string, now = new Date()): Promise<DuelResult> {
  let changed: DuelRow | undefined;
  const out = await db.transaction(async (tx): Promise<DuelResult> => {
    const round = await duelRow(tx, serverId, duelId, true);
    if (!round) return { ok: false, code: 'not_found' };
    const data = dataOf(round);
    const side = duelSideOf(data, userId);
    if (!side) return { ok: false, code: 'not_player' };
    const moving = round.state === 'locked' && data.phase === 'moving';
    const write = async (record: Record<string, unknown>, thinkMs: number | null) =>
      (await tx.insert(gameMoves).values({ roundId: round.id, userId, seq, move: record, thinkMs }).onConflictDoNothing().returning({ seq: gameMoves.seq })).length > 0;
    const save = async (next: DuelRoundData, settleAt?: Date) => {
      const [row] = await tx
        .update(gameRounds)
        .set({ data: { ...next, ...(data.series ? { manual: { ...data.manual, [side]: true } } : {}) }, ...(settleAt ? { settleAt } : {}) })
        .where(eq(gameRounds.id, round.id))
        .returning();
      changed = row;
      return row;
    };

    if (data.game === 'rps') {
      if (!isRpsHand(move)) return { ok: false, code: 'bad_move' };
      const cur = data.rps?.rounds.length ?? 0;
      if (!moving || !data.rps || seq !== cur) {
        // Повтор хода уже раскрытого раунда или после итога — без изменений; чужой номер — «обнови партию».
        if (await moveOf(tx, round.id, userId, seq)) return { ok: true, duel: duelDtoFor(round, userId), myHand: moving && seq === cur ? await myHandOf(tx, round.id, userId, seq) : null };
        return { ok: false, code: moving ? 'stale_seq' : 'not_playing' };
      }
      if (!(await write({ hand: move }, thinkMsOf(data, now)))) {
        return { ok: true, duel: duelDtoFor(round, userId), myHand: await myHandOf(tx, round.id, userId, seq) };
      }
      const ready = rpsMarkReady(data, side);
      if (!ready.rps!.ready.challenger || !ready.rps!.ready.target) {
        const row = await save(ready);
        return { ok: true, duel: duelDtoFor(row, userId), myHand: move };
      }
      const both = await tx
        .select({ userId: gameMoves.userId, move: gameMoves.move })
        .from(gameMoves)
        .where(and(eq(gameMoves.roundId, round.id), eq(gameMoves.seq, seq)));
      const handOf = (uid: string) => both.find((b) => b.userId === uid)?.move?.hand;
      const c = handOf(data.challengerId);
      const t = handOf(data.targetId);
      if (!isRpsHand(c) || !isRpsHand(t)) throw new Error(`duel ${round.id}: ход КНБ ${seq} без руки`);
      const r = rpsResolve(ready, { challenger: c, target: t }, now);
      const row = await save(r.data, r.settleAt);
      return { ok: true, duel: duelDtoFor(row, userId), myHand: null };
    }

    if (data.game === 'greedy' || data.game === 'twentyone') {
      if (move !== 'roll' && move !== 'stop') return { ok: false, code: 'bad_move' };
      const g = data.game === 'twentyone' ? data.twentyOne : data.greedy;
      if (!moving || !g || seq !== g.seq) {
        if (await moveOf(tx, round.id, userId, seq)) return { ok: true, duel: duelDtoFor(round, userId) };
        return { ok: false, code: moving ? 'stale_seq' : 'not_playing' };
      }
      if (g.turn !== side) return { ok: false, code: 'not_your_turn' };
      const acted = data.game === 'twentyone' ? twentyOneAct(round.id, data, move, now) : greedyAct(round.id, data, move, now);
      if (!acted) return { ok: false, code: 'bad_move' };
      if (!(await write({ ...acted.record }, thinkMsOf(data, now)))) return { ok: true, duel: duelDtoFor(round, userId) };
      const row = await save(acted.data, acted.settleAt);
      return { ok: true, duel: duelDtoFor(row, userId) };
    }

    return { ok: false, code: 'not_playing' };
  });
  if (changed) await publishDuel(changed);
  return seriesResult(out, userId);
}

/** Same transaction as the new escrow: fresh membership/account, economy visibility, voice, SDK support.
 * Gateway/auth are loaded only for series; the ordinary duel publisher has no new runtime dependencies.
 */
async function seriesAvailability(q: GameTx, row: DuelRow): Promise<'ready' | 'not_ready' | 'unavailable'> {
  const data = dataOf(row);
  const { isSuperAdmin } = await import('./auth.js');
  const { asUserId } = await import('./superAdminRules.js');
  const { isUserOnline, userHasCap } = await import('./gateway.js');
  const [channel] = await q.select({ serverId: channels.serverId, type: channels.type }).from(channels).where(eq(channels.id, data.channelId)).limit(1);
  if (!channel || channel.serverId !== row.serverId || channel.type !== 'voice') return 'unavailable';
  const [economy] = await q.select({ enabled: serverEconomy.enabled, gamesEnabled: serverEconomy.gamesEnabled }).from(serverEconomy).where(eq(serverEconomy.serverId, row.serverId)).limit(1);
  if (!economy?.enabled || !economy.gamesEnabled) return 'unavailable';
  for (const uid of [data.challengerId, data.targetId]) {
    if (!previewAllows(env.economyPreviewUsers, uid)) return 'unavailable';
    const [user] = await q.select({ deletedAt: users.deletedAt, bot: users.bot }).from(users).where(eq(users.id, uid)).limit(1);
    if (!user || user.deletedAt || user.bot) return 'unavailable';
    const [member] = await q.select({ state: serverMembers.state }).from(serverMembers).where(and(eq(serverMembers.serverId, row.serverId), eq(serverMembers.userId, uid))).limit(1);
    if ((!member || member.state !== 'active') && !isSuperAdmin(asUserId(uid))) return 'unavailable';
    if (!isUserOnline(uid) || !(await inVoiceChannel(data.channelId, uid))) return 'not_ready';
    if (isDuelChoiceGame(data.game) && !userHasCap(uid, data.game === 'twentyone' ? FEATURE_DUEL21 : FEATURE_DUEL2)) return 'not_ready';
  }
  return 'ready';
}

/** Resolve ANY round of a series, then lock ONLY its original row. Never trust client-provided session/player IDs. */
async function seriesAnchor(q: GameTx, serverId: string, duelId: string, userId: string): Promise<DuelRow | DuelRefusal> {
  const pre = await duelRow(q, serverId, duelId, false);
  if (!pre) return 'not_found';
  if (!duelSideOf(dataOf(pre), userId)) return 'not_player';
  const id = dataOf(pre).series?.id;
  if (!id) return 'expired';
  const anchor = await duelRow(q, serverId, id, true);
  if (!anchor || !dataOf(anchor).series) return 'expired';
  if (!duelSideOf(dataOf(anchor), userId)) return 'not_player';
  return anchor;
}

export async function controlDuelSeries(
  serverId: string, duelId: string, userId: string, action: 'pulse' | 'pause' | 'stop', pulse?: DuelSeriesPulse, now = new Date(),
): Promise<DuelResult> {
  const enteredAt = Date.now();
  const requestedAt = now.getTime();
  let changed: DuelRow | undefined;
  const result = await db.transaction(async (tx): Promise<DuelResult> => {
    const found = await seriesAnchor(tx, serverId, duelId, userId);
    if (typeof found === 'string') return { ok: false, code: found };
    now = new Date(requestedAt + Math.max(0, Date.now() - enteredAt));
    const data = dataOf(found);
    let series = data.series!;
    let c = data.seriesControl;
    const current = await seriesCurrent(found, tx);
    const side = duelSideOf(data, userId)!;
    const save = async (cancelOffer = false) => {
      const [anchor] = await tx.update(gameRounds).set({
        data: { ...data, ...(cancelOffer ? { reason: 'withdrawn' } : {}), series, ...(c ? { seriesControl: c } : {}) },
        ...(cancelOffer ? { state: 'cancelled' as const, settledAt: now } : {}),
      }).where(eq(gameRounds.id, found.id)).returning();
      const view = await withSeriesView(current.id === anchor.id ? anchor : current, tx);
      changed = view;
      return { ok: true as const, duel: duelDtoFor(view, userId) };
    };
    if (c && current.id !== c.currentId) {
      series = seriesStopped(series, 'cancelled');
      c = { ...c, leases: {}, next: undefined, finished: true };
      return save();
    }
    if (action === 'stop') {
      if (series.status !== 'stopped') series = seriesStopped(series, 'user_stop');
      if (c) c = { ...c, leases: {}, next: undefined, sleeping: false };
      return save(!c && found.state === 'open');
    }
    if (series.status === 'stopped' || !c) return { ok: true, duel: duelDtoFor(await withSeriesView(current, tx), userId) };
    if (action === 'pulse' && (!pulse || pulse.roundId !== c.currentId)) return { ok: false, code: 'stale_seq' };
    if (action === 'pause' || !pulse?.visible || !pulse.ready) {
      series = seriesPaused(series, 'not_ready');
      c = { ...c, leases: {}, next: undefined, sleeping: false };
      return save();
    }
    const ownLease = c.leases[side];
    if (c.owners[side] && c.owners[side] !== pulse.clientId && ownLease && ownLease.until > now.getTime()) return { ok: false, code: 'busy' };
    if (series.status !== 'paused' && seriesLeaseExpired(c, now)) {
      series = seriesPaused(series, 'lease_expired');
      c = { ...c, leases: {}, next: undefined };
    }
    const available = await seriesAvailability(tx, current);
    if (available === 'unavailable') {
      series = seriesStopped(series, 'unavailable');
      c = { ...c, leases: {}, next: undefined, sleeping: false };
      return save();
    }
    if (available === 'not_ready') {
      series = seriesPaused(series, 'not_ready');
      c = { ...c, leases: {}, next: undefined, sleeping: false };
      return save();
    }
    now = new Date(requestedAt + Math.max(0, Date.now() - enteredAt));
    if (series.status !== 'paused' && seriesLeaseExpired(c, now)) {
      series = seriesPaused(series, 'lease_expired'); c = { ...c, leases: {}, next: undefined };
    }
    c = { ...c, owners: { ...c.owners, [side]: pulse.clientId }, leases: { ...c.leases, [side]: { roundId: c.currentId, until: now.getTime() + DUEL_SERIES_LEASE_MS } }, sleeping: false };
    if (series.status === 'paused' && seriesBothReady(c, now)) {
      const { pauseReason: _p, ...resumed } = series;
      series = { ...resumed, status: current.state === 'settled' ? 'waiting' : 'active', nextAt: current.state === 'settled' ? new Date(now.getTime() + DUEL_REMATCH_PAUSE_MS).toISOString() : null };
      c.graceUntil = now.getTime() + DUEL_SERIES_LEASE_MS;
    }
    return save();
  });
  if (changed) await publishDuel(changed);
  return result;
}

/** One coordinator transition. The anchor is the DB exactly-once cursor and the stop/advance linearization point.
 * No child row locks: settlement/deletion can finish independently, their immutable terminal row is read next tick.
 */
async function duelSeriesStep(now: Date, skip: string[]): Promise<DuelRow | null> {
  const enteredAt = Date.now();
  let attempting: { serverId: string; anchorId: string; currentId: string } | undefined;
  try {
    return await withGameMoney(async (m): Promise<DuelRow | null> => {
      const [anchor] = await m.tx.select().from(gameRounds).where(and(
        eq(gameRounds.kind, 'duel'),
        sql`${gameRounds.data}->'seriesControl' IS NOT NULL`,
        sql`COALESCE((${gameRounds.data}->'seriesControl'->>'finished')::boolean, false) = false`,
        sql`COALESCE((${gameRounds.data}->'seriesControl'->>'sleeping')::boolean, false) = false`,
        skip.length ? sql`${gameRounds.id} NOT IN (${sql.join(skip.map((id) => sql`${id}`), sql`, `)})` : undefined,
      )).orderBy(asc(gameRounds.createdAt)).limit(1).for('update', { skipLocked: true });
      if (!anchor) return null;
      skip.push(anchor.id);
      const data = dataOf(anchor);
      let s = data.series!;
      let c = { ...data.seriesControl! };
      const current = await seriesCurrent(anchor, m.tx);
      const cur = dataOf(current);
      const save = async (): Promise<DuelRow> => {
        const [saved] = await m.tx.update(gameRounds).set({ data: { ...data, series: s, seriesControl: c } }).where(eq(gameRounds.id, anchor.id)).returning();
        return withSeriesView(current.id === saved.id ? saved : current, m.tx);
      };
      const stop = async (reason: NonNullable<DuelSeriesDto['stopReason']>) => {
        s = seriesStopped(s, reason);
        c = { ...c, leases: {}, next: undefined, finished: current.state === 'settled' || current.state === 'cancelled' };
        return save();
      };
      if (current.id !== c.currentId || !cur.series || cur.series.id !== anchor.id) return stop('cancelled');
      if (current.state === 'cancelled') return stop('cancelled');
      if (current.state === 'settled' && c.countedRound < cur.series.round) {
        s = { ...s, score: cur.series.score, round: cur.series.round };
        c.countedRound = cur.series.round;
      }
      if (s.status === 'stopped') { c.finished = current.state === 'settled'; return save(); }
      // No new wagers by an open-but-idle scene, even if it keeps sending perfect heartbeats.
      if (current.state === 'settled' && (!cur.manual?.challenger || !cur.manual?.target || cur.reason === 'timeout')) return stop('idle');
      if (s.status !== 'paused' && seriesLeaseExpired(c, now)) {
        s = seriesPaused(s, 'lease_expired'); c = { ...c, leases: {}, next: undefined };
      }
      if (s.status === 'paused') { c.sleeping = current.state === 'settled'; return save(); }
      if (current.state !== 'settled') return save();
      if (!s.nextAt) s = { ...s, status: 'waiting', nextAt: new Date(current.settledAt!.getTime() + DUEL_REMATCH_PAUSE_MS).toISOString() };
      if (!c.next) {
        const id = newId(); const seed = randomBytes(32).toString('hex');
        c.next = { id, seed, commit: duelCommit(id, seed) };
        s = { ...s, nextRoundId: id, nextCommit: c.next.commit };
        return save(); // Commit must be observable BEFORE the transaction that charges the next stakes.
      }
      if (Date.parse(s.nextAt!) > now.getTime() || !seriesBothReady(c, now)) return save();
      attempting = { serverId: anchor.serverId, anchorId: anchor.id, currentId: c.currentId };
      for (const uid of [data.challengerId, data.targetId].sort()) {
        // Anchor is already locked. Never wait in the reverse direction when another operation
        // (notably account deletion) owns the user lock before locking live rounds.
        const [lock] = await m.tx.select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${`duel-user:${uid}`}))` })
          .from(gameRounds).where(eq(gameRounds.id, anchor.id)).limit(1);
        if (!lock?.acquired) return save();
      }
      await m.lockWallets(anchor.serverId, [data.challengerId, data.targetId]);
      // A wallet/DB lock can wait longer than the whole lease. Never start from the pre-wait clock.
      const startNow = new Date(now.getTime() + Math.max(0, Date.now() - enteredAt));
      if (!seriesBothReady(c, startNow)) {
        s = seriesPaused(s, 'lease_expired'); c = { ...c, leases: {}, next: undefined }; return save();
      }
      const available = await seriesAvailability(m.tx, current);
      if (available === 'unavailable') return stop('unavailable');
      if (available === 'not_ready') {
        s = seriesPaused(s, 'not_ready'); c = { ...c, leases: {}, next: undefined }; return save();
      }
      const [eco] = await m.tx.select({ fee: serverEconomy.gamesFeePercent }).from(serverEconomy).where(eq(serverEconomy.serverId, anchor.serverId)).limit(1);
      if (!eco || eco.fee !== data.feePercent) return stop('settings_changed');
      // A newer invite/game involving either participant ends this session, including an old paused one.
      const [foreign] = await m.tx.select({ id: gameRounds.id }).from(gameRounds).where(and(
        eq(gameRounds.kind, 'duel'),
        sql`COALESCE(${gameRounds.data}->'series'->>'id', '') <> ${anchor.id}`,
        or(inArray(gameRounds.state, [...LIVE]), gt(gameRounds.createdAt, anchor.createdAt)),
        or(sql`${gameRounds.data}->>'challengerId' IN (${data.challengerId}, ${data.targetId})`, sql`${gameRounds.data}->>'targetId' IN (${data.challengerId}, ${data.targetId})`),
      )).limit(1);
      if (foreign) return stop('unavailable');
      for (const uid of [data.challengerId, data.targetId]) {
        if (await stakeCheckOf(m.tx, { serverId: anchor.serverId, userId: uid, amount: data.amount, pick: 'duel', now: startNow })) return stop('unavailable');
      }
      if (isDuelChoiceGame(data.game) && await pairLimited(m.tx, anchor.serverId, data.challengerId, data.targetId, data.amount, data.feePercent, startNow)) return stop('unavailable');
      const next = c.next;
      const { stopReason: _s, pauseReason: _p, nextRoundId: _i, nextCommit: _c, ...rest } = s;
      s = { ...rest, status: 'active', nextAt: null, round: s.round + 1 };
      const nextData: DuelRoundData = {
        channelId: data.channelId, challengerId: data.challengerId, targetId: data.targetId, game: data.game,
        amount: data.amount, feePercent: data.feePercent, seed: next.seed, commit: next.commit, series: s,
        ...(data.game === 'dice' ? { diceTarget: DUEL_DICE_WINS } : {}),
      };
      const [child] = await m.tx.insert(gameRounds).values({
        id: next.id, serverId: anchor.serverId, kind: 'duel', state: 'open', createdBy: data.challengerId,
        lockAt: startNow, data: { ...nextData },
      }).onConflictDoNothing().returning();
      if (!child) throw new DuelRefused('channel_busy');
      const started = await startDuelRound(m, child, nextData, startNow);
      const committedAt = new Date(now.getTime() + Math.max(0, Date.now() - enteredAt));
      if (!seriesBothReady(c, committedAt)) throw new SeriesNotReady('lease_expired');
      const stillAvailable = await seriesAvailability(m.tx, current);
      if (stillAvailable === 'not_ready') throw new SeriesNotReady('not_ready');
      if (stillAvailable !== 'ready') throw new DuelRefused('target_unavailable');
      const confirmedAt = new Date(now.getTime() + Math.max(0, Date.now() - enteredAt));
      if (!seriesBothReady(c, confirmedAt)) throw new SeriesNotReady('lease_expired');
      c = { ...c, currentId: child.id, next: undefined, graceUntil: confirmedAt.getTime() + DUEL_SERIES_LEASE_MS };
      await m.tx.update(gameRounds).set({ data: { ...data, series: s, seriesControl: c } }).where(eq(gameRounds.id, anchor.id));
      return started;
    });
  } catch (err) {
    // A failed second stake MUST roll back the child and first stake too. Only then durably stop the session.
    if (!(err instanceof DuelRefused || err instanceof SeriesNotReady) || !attempting) throw err;
    const a = attempting;
    return db.transaction(async (tx) => {
      const anchor = await duelRow(tx, a.serverId, a.anchorId, true);
      if (!anchor) return null;
      const data = dataOf(anchor);
      if (!data.series || !data.seriesControl || data.seriesControl.currentId !== a.currentId) return null;
      if (data.series.status === 'stopped') return withSeriesView(await seriesCurrent(anchor, tx), tx);
      const [saved] = await tx.update(gameRounds).set({ data: { ...data,
        series: err instanceof SeriesNotReady ? seriesPaused(data.series, err.reason) : seriesStopped(data.series, 'unavailable'),
        seriesControl: { ...data.seriesControl, leases: {}, next: undefined, ...(err instanceof SeriesNotReady ? { sleeping: true } : { finished: true }) },
      } }).where(eq(gameRounds.id, anchor.id)).returning();
      return withSeriesView(await seriesCurrent(saved, tx), tx);
    });
  }
}

type StepOutcome = { row: DuelRow; pause?: { ms: number; pairs: [string, string][] } } | null;

/**
 * Один переход одной созревшей дуэли — своей транзакцией. Созрела: вызов с `lock_at <= now` (молчание → `expired`),
 * партия с `settle_at <= now` (срок нажатия — сервер бросает за непрожавших; конец анимации — расчёт), любая живая на
 * сервере, где игры или экономика выключены (`games-off`, возврат). `SKIP LOCKED`: дуэль, которую прямо сейчас
 * принимают или бросают, ждёт следующего такта.
 */
async function duelStep(now: Date, skip: string[]): Promise<StepOutcome> {
  return withGameMoney(async (m): Promise<StepOutcome> => {
    const [round] = await m.tx
      .select({ row: gameRounds, economyOn: serverEconomy.enabled, gamesOn: serverEconomy.gamesEnabled })
      .from(gameRounds)
      .leftJoin(serverEconomy, eq(serverEconomy.serverId, gameRounds.serverId))
      .where(
        and(
          eq(gameRounds.kind, 'duel'),
          inArray(gameRounds.state, [...LIVE]),
          // ⚠️ Только дуэли, заведённые вызовом (у них всегда есть `lock_at`), — чужие строки `kind='duel'` не трогаем.
          isNotNull(gameRounds.lockAt),
          skip.length > 0 ? sql`${gameRounds.id} NOT IN (${sql.join(skip.map((s) => sql`${s}`), sql`, `)})` : undefined,
          or(
            and(eq(gameRounds.state, 'open'), lte(gameRounds.lockAt, now)),
            and(eq(gameRounds.state, 'locked'), lte(gameRounds.settleAt, now)),
            sql`${serverEconomy.serverId} IS NULL`,
            eq(serverEconomy.enabled, false),
            eq(serverEconomy.gamesEnabled, false),
          ),
        ),
      )
      .orderBy(asc(gameRounds.lockAt))
      .limit(1)
      .for('update', { of: gameRounds, skipLocked: true });
    if (!round) return null;
    const cur = round.row;
    skip.push(cur.id);
    const data = dataOf(cur);
    const reread = async () => (await duelRow(m.tx, cur.serverId, cur.id, false))!;

    if (!round.economyOn || !round.gamesOn) {
      await cancelLiveRounds(m, cur.serverId, [cur.id], 'games-off');
      await m.tx.update(gameRounds).set({ settledAt: now }).where(eq(gameRounds.id, cur.id));
      return { row: await reread() };
    }

    if (cur.state === 'open') {
      // Молчание = отказ: пауза пары, как после «Отказаться» (вызвавшему одинаково «Не принял»).
      const [row] = await m.tx
        .update(gameRounds)
        .set({ state: 'cancelled', settledAt: now, data: sql`${gameRounds.data} || jsonb_build_object('reason', 'expired')` })
        .where(eq(gameRounds.id, cur.id))
        .returning();
      return { row, pause: { ms: DUEL_PAIR_COOLDOWN_MS, pairs: [[data.challengerId, data.targetId]] } };
    }

    if (data.phase === 'playing') {
      // Срок нажатия вышел — сервер бросает за тех, кто не нажал (кости те же, решены при принятии).
      const sides: DuelSide[] = ['challenger', 'target'];
      const seen = data.revealed?.[data.rollNo ?? 0];
      const autoSides = sides.filter((s) => !seen?.[s]);
      const r = duelReveal(data, sides, now);
      // Раскрывать нечего (битые данные без бросков) — сразу к расчёту: он вернёт ставки, а не зациклит такт.
      // Бросок за непрожавших — в счётчик автоходов (этап 4, для званий).
      const next = r.changed ? { ...r, data: withAuto(r.data, autoSides) } : { data: { ...data, phase: 'done' as const }, settleAt: now };
      const [row] = await m.tx
        .update(gameRounds)
        .set({ data: { ...next.data }, settleAt: next.settleAt ?? new Date(now.getTime() + DUEL_ROLL_TURN_MS) })
        .where(eq(gameRounds.id, cur.id))
        .returning();
      return { row };
    }

    if (data.phase === 'moving') {
      // Этап 4: срок хода в игре с выбором. КНБ — сходивший побеждает, никто — возврат; Жадный гусь — автостоп/автобросок
      // за молчащего (ход пишется в `game_moves` с `auto`), `GREEDY_MAX_TIMEOUTS`-я просрочка подряд — поражение.
      let t: { data: DuelRoundData; settleAt: Date };
      if (data.game === 'twentyone' && data.twentyOne) {
        const g = twentyOneTimeout(cur.id, data, now);
        if (g.record) {
          await m.tx.insert(gameMoves).values({
            roundId: cur.id, userId: g.side === 'challenger' ? data.challengerId : data.targetId,
            seq: data.twentyOne.seq, move: { ...g.record }, thinkMs: null,
          }).onConflictDoNothing();
        }
        t = g;
      } else if (data.game === 'greedy' && data.greedy) {
        const g = greedyTimeout(cur.id, data, now);
        if (g.record) {
          await m.tx
            .insert(gameMoves)
            .values({ roundId: cur.id, userId: g.side === 'challenger' ? data.challengerId : data.targetId, seq: data.greedy.seq, move: { ...g.record }, thinkMs: null })
            .onConflictDoNothing();
        }
        t = g;
      } else {
        t = rpsTimeout(data, now);
      }
      const [row] = await m.tx.update(gameRounds).set({ data: { ...t.data }, settleAt: t.settleAt }).where(eq(gameRounds.id, cur.id)).returning();
      return { row };
    }

    // Расчёт. 🔴 Предохранитель: обе ставки на месте и обе не закрыты — иначе банк уже неполный (кто-то удалён или
    // ставка вернулась мимо дуэли): возврат оставшимся и отмена, а не выплата из воздуха.
    const stakes = await m.tx
      .select({ userId: gameStakes.userId, pick: gameStakes.pick, paidAt: gameStakes.paidAt, refundedAt: gameStakes.refundedAt })
      .from(gameStakes)
      .where(eq(gameStakes.roundId, cur.id))
      .orderBy(asc(gameStakes.userId), asc(gameStakes.pick));
    const intact =
      stakes.length === 2 &&
      stakes.every((s) => s.pick === 'duel' && s.paidAt === null && s.refundedAt === null) &&
      new Set(stakes.map((s) => s.userId)).size === 2 &&
      stakes.every((s) => s.userId === data.challengerId || s.userId === data.targetId);
    const open = stakes.filter((s) => s.paidAt === null && s.refundedAt === null);
    await m.lockWallets(cur.serverId, open.map((s) => s.userId));
    if (!intact) {
      for (const s of open) await m.refundStake({ roundId: cur.id, userId: s.userId, pick: s.pick });
      const [row] = await m.tx
        .update(gameRounds)
        .set({ state: 'cancelled', settledAt: now, data: sql`${gameRounds.data} || jsonb_build_object('reason', 'player-deleted')` })
        .where(eq(gameRounds.id, cur.id))
        .returning();
      return { row };
    }
    const plan = duelSettlePlan(data);
    if (plan.winnerId && plan.loserId && plan.payout !== null) {
      // Выплаты — в порядке `user_id` (кошельки уже под замком в том же порядке).
      for (const s of stakes) {
        const win = s.userId === plan.winnerId;
        await m.payStake({
          roundId: cur.id,
          userId: s.userId,
          pick: s.pick,
          payout: win ? plan.payout : 0,
          refUserId: win ? plan.loserId : plan.winnerId,
        });
      }
    } else {
      for (const s of stakes) await m.refundStake({ roundId: cur.id, userId: s.userId, pick: s.pick });
    }
    const settled: DuelRoundData = {
      ...data,
      winnerId: plan.winnerId,
      payout: plan.payout,
      pool: plan.pool,
      fee: plan.fee,
      ...(data.series ? { series: { ...data.series, score: seriesScore(data.series, plan.winnerId ? duelSideOf(data, plan.winnerId) : null) } } : {}),
      // Возврат без своей причины — ничья после лимита; `timeout`/`draw-limit` игр с выбором уже лежат в `data.reason`.
      ...(plan.winnerId || data.reason || data.game === 'twentyone' ? {} : { reason: 'draw-limit' as const }),
    };
    const [row] = await m.tx
      .update(gameRounds)
      .set({ state: 'settled', settledAt: now, data: { ...settled } })
      .where(eq(gameRounds.id, cur.id))
      .returning();
    return {
      row,
      pause: {
        ms: DUEL_REMATCH_PAUSE_MS,
        pairs: [
          [data.challengerId, data.targetId],
          [data.targetId, data.challengerId],
        ],
      },
    };
  });
}

export interface DuelTickReport {
  steps: number;
}

/** Такт: созревшие дуэли по одному переходу, не больше `DUEL_TICK_BATCH`. События — после коммита каждого перехода. */
export async function runDuelTick(now = new Date()): Promise<DuelTickReport> {
  const report: DuelTickReport = { steps: 0 };
  const skip: string[] = [];
  for (let i = 0; i < DUEL_TICK_BATCH; i++) {
    const step = await duelStep(now, skip);
    if (!step) break;
    report.steps += 1;
    if (step.pause) for (const [a, b] of step.pause.pairs) await setPairPause(step.row.serverId, a, b, step.pause.ms);
    await publishDuel(step.row);
  }
  const seriesSkip: string[] = [];
  for (let i = 0; i < DUEL_TICK_BATCH; i++) {
    const changed = await duelSeriesStep(now, seriesSkip);
    if (!changed) break;
    report.steps += 1;
    await publishDuel(changed);
  }
  return report;
}

let started = false;

/**
 * Запустить такт дуэлей (`routes/gameDuel.ts`, `onListen` — тесты на `inject` его не заводят). Первый такт — сразу:
 * созревшее за время перезапуска подбирается без ожидания. Новый такт поверх незавершённого не стартует.
 */
export function startDuelWorker(): void {
  if (started) return;
  started = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runDuelTick()
      .catch((err: unknown) => {
        console.warn(`[duel] такт упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, DUEL_TICK_MS);
  timer.unref();
}
