import { createHash } from 'node:crypto';
import {
  DUEL_MAX_REROLLS,
  DUEL_MOVE_MS,
  DUEL_ROLL_ANIM_MS,
  DUEL_ROLL_TURN_MS,
  DUEL_SERIES_LEASE_MS,
  GREEDY_MAX_TIMEOUTS,
  RPS_MAX_ROUNDS,
  RPS_WINS,
  diceFromHash,
  duelCommitInput,
  duelOutcome,
  duelRollInput,
  duelRollIsDraw,
  greedyFirstInput,
  greedyFirstSide,
  greedyHide,
  greedyStart,
  greedyStep,
  isDuelChoiceGame,
  rpsRoundWinner,
  twentyOneStart,
  twentyOneStep,
  twentyOneHide,
  type DuelDto,
  type DuelGame,
  type DuelReason,
  type DuelSeriesDto,
  type DuelTwentyOneDto,
  type DuelSide as SharedDuelSide,
  type GreedyState,
  type RpsHand,
} from '@gusvoice/shared';
import { STAKE_BLOCK_TEXT, splitPot, type StakeBlock } from './gameMoneyRules.js';

/**
 * Гусиная дуэль (ГусКоины 2, этап 3) — чистое поверх общих правил `@gusvoice/shared/duel.ts`: зерно → броски, раскрытие
 * по нажатию «Бросить», план расчёта, DTO и коды отказов. Транзакции и такт — `gameDuel.ts`, маршруты — `routes/gameDuel.ts`.
 *
 * 🔴 Проверяемая честность (как колесо): зерно `randomBytes(32)` берётся при ВЫЗОВЕ, наружу до итога — только `commit`.
 * Все броски решены при принятии (`duelRolls`), кнопка лишь раскрывает свою пару костей текущего броска. DTO собирается
 * здесь из перечисленных полей: `data.seed` и нераскрытые кости наружу не уходят, `data` целиком — никогда.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

export type DuelSide = SharedDuelSide;
export type DuelRoll = [number, number, number, number];

/** Только у первой партии серии. Её строка — постоянный DB-замок координатора.
 * Дочерние партии содержат только публичный series; денежный lifecycle не меняется.
 * Координатор не блокирует дочернюю строку: расчёт/удаление берут раунды раньше кошельков.
 */
export interface DuelSeriesControl {
  currentId: string;
  countedRound: number;
  owners: Partial<Record<DuelSide, string>>;
  leases: Partial<Record<DuelSide, { roundId: string; until: number }>>;
  graceUntil: number;
  /** Приостановленный итог не перечитывается бесконечно тактом; pulse разбудит его. */
  sleeping?: boolean;
  finished?: boolean;
  next?: { id: string; seed: string; commit: string };
}

export const seriesOffered = (id: string): DuelSeriesDto => ({
  id, round: 1, score: { challenger: 0, target: 0, draws: 0 }, status: 'offered', nextAt: null,
});
export const seriesControl = (id: string, now: Date): DuelSeriesControl => ({
  currentId: id, countedRound: 0, owners: {}, leases: {}, graceUntil: now.getTime() + DUEL_SERIES_LEASE_MS,
});

/** Поздний pulse не может незаметно перекрыть разрыв lease, даже если такт задержался. */
export function seriesLeaseExpired(c: DuelSeriesControl, now: Date): boolean {
  return (['challenger', 'target'] as const).some((side) => {
    const lease = c.leases[side];
    return (lease?.roundId === c.currentId ? lease.until : c.graceUntil) <= now.getTime();
  });
}
export function seriesBothReady(c: DuelSeriesControl, now: Date): boolean {
  return (['challenger', 'target'] as const).every((side) => {
    const lease = c.leases[side];
    return !!lease && lease.roundId === c.currentId && lease.until > now.getTime();
  });
}
export function seriesPaused(s: DuelSeriesDto, reason: NonNullable<DuelSeriesDto['pauseReason']>): DuelSeriesDto {
  const { stopReason: _s, nextRoundId: _i, nextCommit: _c, ...rest } = s;
  return { ...rest, status: 'paused', nextAt: null, pauseReason: reason };
}
export function seriesStopped(s: DuelSeriesDto, reason: NonNullable<DuelSeriesDto['stopReason']>): DuelSeriesDto {
  const { pauseReason: _p, nextRoundId: _i, nextCommit: _c, ...rest } = s;
  return { ...rest, status: 'stopped', nextAt: null, stopReason: reason };
}
/** Один settled даёт ровно одно очко/ничью; отмена очка не даёт. */
export function seriesScore(s: DuelSeriesDto, winner: DuelSide | null): DuelSeriesDto['score'] {
  return { ...s.score, ...(winner ? { [winner]: s.score[winner] + 1 } : { draws: s.score.draws + 1 }) };
}

/** КНБ в `game_rounds.data` (этап 4). Только раскрытое и флаги «готов»: сами руки лежат в `game_moves`. */
export interface DuelRpsData {
  rounds: { challenger: RpsHand; target: RpsHand; winner: DuelSide | null }[];
  ready: { challenger: boolean; target: boolean };
  wins: { challenger: number; target: number };
}

/** Жадный гусь в `game_rounds.data` (этап 4): состояние `greedyStep` + просрочки подряд, номер действия, первый, броски. */
export interface DuelGreedyData extends GreedyState {
  timeouts: { challenger: number; target: number };
  /** Номер следующего действия партии — `game_moves.seq`. */
  seq: number;
  first: DuelSide;
  rolls: number[];
}

/** Что лежит в `game_rounds.data` дуэли. `seed`, `rolls` и нераскрытое в `revealed` — СЕКРЕТ до раскрытия/итога. */
export interface DuelRoundData {
  series?: DuelSeriesDto;
  seriesControl?: DuelSeriesControl;
  /** Только принятые ручные действия этой партии; heartbeat не является действием. */
  manual?: Partial<Record<SharedDuelSide, boolean>>;
  channelId: string;
  challengerId: string;
  targetId: string;
  game: DuelGame;
  amount: number;
  /** Комиссия банка — заморожена в момент вызова. */
  feePercent: number;
  commit: string;
  seed: string;
  /**
   * С принятия: `playing` — идут броски кубиков, `moving` — ход в игре с выбором (`settle_at` = срок хода), `done` — исход
   * решён, итог после анимации (`settle_at`).
   */
  phase?: 'playing' | 'moving' | 'done';
  /** Игры с выбором: решённый исход (`null` — возврат обоим). Кубики считают исход по `rolls`. */
  outcome?: DuelSide | null;
  /** Начало текущего хода (ISO) — для `game_moves.think_ms`. */
  moveFrom?: string;
  rps?: DuelRpsData;
  greedy?: DuelGreedyData;
  twentyOne?: DuelTwentyOneDto;
  /** Сколько раз за сторону сходил сервер по сроку (все игры; `withAuto`). */
  auto?: { challenger: number; target: number };
  /** Кубики: мс от начала броска до нажатия «Бросить», по сторонам (`withThink`); у игр с выбором — `game_moves.think_ms`. */
  think?: { challenger: number[]; target: number[] };
  /** Все броски [a1, a2, b1, b2] до замороженной цели или лимита — считаются при принятии. */
  rolls?: DuelRoll[];
  /** Цель заморожена при вызове; отсутствие — прежние кубики до одной победы. */
  diceTarget?: 1 | 2;
  rollNo?: number;
  /** Кто уже раскрыл свою пару костей в броске i (нажатием или сервер за него по сроку). */
  revealed?: { challenger: boolean; target: boolean }[];
  /** Итог (`settled`). */
  winnerId?: string | null;
  payout?: number | null;
  pool?: number;
  fee?: number;
  reason?: DuelReason;
}

/** `commit` дуэли — sha256 hex строки `duelCommitInput`. */
export function duelCommit(roundId: string, seedHex: string): string {
  return sha256(duelCommitInput(roundId, seedHex)).toString('hex');
}

/** Броски из зерна до первой не-ничьей или исчерпания (1 + `DUEL_MAX_REROLLS`) — тем же кодом, что проверит браузер. */
export function duelRolls(roundId: string, seedHex: string): DuelRoll[] {
  const rolls: DuelRoll[] = [];
  for (let n = 0; n <= DUEL_MAX_REROLLS; n++) {
    const roll = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n))));
    rolls.push(roll);
    if (!duelRollIsDraw(roll)) break;
  }
  return rolls;
}

/** Новая партия: те же SHA256-входы, остановка только после второй победы или бюджета перебросов. */
export function duelDiceRolls(roundId: string, seedHex: string, target: 1 | 2): DuelRoll[] {
  if (target === 1) return duelRolls(roundId, seedHex);
  const rolls: DuelRoll[] = [];
  for (let n = 0; n < 2 * target - 1 + DUEL_MAX_REROLLS; n++) {
    rolls.push(diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n)))));
    if (duelOutcome(rolls, target).winner) break;
  }
  return rolls;
}

/** Сторона игрока в дуэли; не игрок — null. */
export function duelSideOf(data: Pick<DuelRoundData, 'challengerId' | 'targetId'>, userId: string): DuelSide | null {
  if (data.challengerId === userId) return 'challenger';
  if (data.targetId === userId) return 'target';
  return null;
}

/**
 * Данные партии при принятии. Кубики: все броски, первый бросок, ничего не раскрыто. КНБ: первый раунд, никто не готов.
 * Жадный гусь: первый ход из зерна (`greedyFirstSide`), пустые копилки. Игры с выбором — фаза `moving`.
 */
export function duelStartData(roundId: string, data: DuelRoundData, now = new Date()): DuelRoundData {
  if (data.game === 'twentyone') {
    const first = greedyFirstSide(new Uint8Array(sha256(greedyFirstInput(roundId, data.seed))));
    return { ...data, phase: 'moving', moveFrom: now.toISOString(), twentyOne: {
      ...twentyOneStart(first),
      seq: 0, timeouts: { challenger: 0, target: 0 },
    } };
  }
  if (data.game === 'rps') {
    return {
      ...data,
      phase: 'moving',
      moveFrom: now.toISOString(),
      rps: { rounds: [], ready: { challenger: false, target: false }, wins: { challenger: 0, target: 0 } },
    };
  }
  if (data.game === 'greedy') {
    const first = greedyFirstSide(new Uint8Array(sha256(greedyFirstInput(roundId, data.seed))));
    return {
      ...data,
      phase: 'moving',
      moveFrom: now.toISOString(),
      greedy: { ...greedyStart(first), timeouts: { challenger: 0, target: 0 }, seq: 0, first, rolls: [] },
    };
  }
  const rolls = duelDiceRolls(roundId, data.seed, data.diceTarget ?? 1);
  return { ...data, phase: 'playing', rolls, rollNo: 0, revealed: [{ challenger: false, target: false }] };
}

/** Срок первого хода после принятия: кубики — нажатие «Бросить», игры с выбором — `DUEL_MOVE_MS`. */
export function duelTurnMs(game: DuelGame | undefined): number {
  return game && isDuelChoiceGame(game) ? DUEL_MOVE_MS : DUEL_ROLL_TURN_MS;
}

/** Жадный гусь: бросок номер `n` партии — первая кость окна `diceFromHash(sha256(duelRollInput(n)))`. */
export function greedyDie(roundId: string, seedHex: string, n: number): number {
  return diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, seedHex, n))))[0];
}

/** Переход партии с выбором: новые данные и новый `settle_at` (срок хода или конец анимации перед итогом). */
export interface DuelMoveResult {
  data: DuelRoundData;
  settleAt: Date;
}

/** Исход решён: `done`, итог — после анимации. `reason` — `timeout`/`draw-limit` (у обычной победы пусто). */
function decided(data: DuelRoundData, outcome: DuelSide | null, now: Date, reason?: DuelReason, delayMs = DUEL_ROLL_ANIM_MS): DuelMoveResult {
  return { data: { ...data, phase: 'done', outcome, ...(reason ? { reason } : {}) }, settleAt: new Date(now.getTime() + delayMs) };
}

/** Следующий ход: срок `DUEL_MOVE_MS` с этого момента. */
function nextMove(data: DuelRoundData, now: Date): DuelMoveResult {
  return { data: { ...data, phase: 'moving', moveFrom: now.toISOString() }, settleAt: new Date(now.getTime() + DUEL_MOVE_MS) };
}

/** КНБ: игрок сходил в текущем раунде (рука уже в `game_moves`) — отметка «готов». */
export function rpsMarkReady(data: DuelRoundData, side: DuelSide): DuelRoundData {
  const rps = data.rps!;
  return { ...data, rps: { ...rps, ready: { ...rps.ready, [side]: true } } };
}

/**
 * КНБ: обе руки текущего раунда есть — раскрыть разом. Победа в раунде — очко; `RPS_WINS` очков — партия; ничья —
 * раунд переигрывается; `RPS_MAX_ROUNDS` раундов без решения — возврат обоим (`draw-limit`).
 */
export function rpsResolve(data: DuelRoundData, hands: { challenger: RpsHand; target: RpsHand }, now: Date): DuelMoveResult {
  const rps = data.rps!;
  const winner = rpsRoundWinner(hands.challenger, hands.target);
  const wins = { ...rps.wins };
  if (winner) wins[winner] += 1;
  const rounds = [...rps.rounds, { challenger: hands.challenger, target: hands.target, winner }];
  const next: DuelRoundData = { ...data, rps: { rounds, ready: { challenger: false, target: false }, wins } };
  if (wins.challenger >= RPS_WINS) return decided(next, 'challenger', now);
  if (wins.target >= RPS_WINS) return decided(next, 'target', now);
  if (rounds.length >= RPS_MAX_ROUNDS) return decided(next, null, now, 'draw-limit');
  return nextMove(next, now);
}

/** КНБ: срок хода вышел. Сходил один — он побеждает партию (`timeout`); не сходил никто — возврат обоим (`timeout`). */
export function rpsTimeout(data: DuelRoundData, now: Date): DuelMoveResult {
  const ready = data.rps?.ready ?? { challenger: false, target: false };
  if (ready.challenger && !ready.target) return decided(data, 'challenger', now, 'timeout', 0);
  if (ready.target && !ready.challenger) return decided(data, 'target', now, 'timeout', 0);
  // Оба сходили, а раунд не раскрыт, быть не должно (раскрытие — в той же транзакции, что второй ход); и это — возврат.
  return decided(data, null, now, 'timeout', 0);
}

/** Жадный гусь: действий в партии не больше (страховка от бесконечной партии; честная игра столько не тянется). */
export const GREEDY_MAX_MOVES = 400;

/** Что записать в `game_moves.move` о действии Жадного гуся. */
export type GreedyMoveRecord =
  | { kind: 'roll'; n: number; die: number; burned?: number; auto?: true }
  | { kind: 'stop'; bank: number; auto?: true };

/**
 * Жадный гусь: действие стороны, чей ход (`auto` — за неё по сроку: просрочка +1, иначе просрочки обнуляются). Бросок
 * берётся из зерна по сквозному номеру. «Стоп» с пустой копилкой и действие после итога — `null`. Набрал цель — итог;
 * `GREEDY_MAX_MOVES` действий — возврат обоим (`draw-limit`).
 */
export function greedyAct(
  roundId: string,
  data: DuelRoundData,
  move: 'roll' | 'stop',
  now: Date,
  auto = false,
): (DuelMoveResult & { record: GreedyMoveRecord }) | null {
  const g = data.greedy;
  if (!g || data.phase !== 'moving') return null;
  const side = g.turn;
  const die = move === 'roll' ? greedyDie(roundId, data.seed, g.n) : 0;
  const stepped = greedyStep(g, move, die);
  if (!stepped) return null;
  const record: GreedyMoveRecord =
    move === 'roll'
      ? { kind: 'roll', n: g.n, die, ...(die === 1 && g.turnPoints > 0 ? { burned: g.turnPoints } : {}), ...(auto ? { auto: true as const } : {}) }
      : { kind: 'stop', bank: g.turnPoints, ...(auto ? { auto: true as const } : {}) };
  const greedy: DuelGreedyData = {
    ...g,
    ...stepped,
    timeouts: { ...g.timeouts, [side]: auto ? g.timeouts[side] + 1 : 0 },
    seq: g.seq + 1,
    rolls: move === 'roll' ? [...g.rolls, die] : g.rolls,
  };
  const next: DuelRoundData = auto ? withAuto({ ...data, greedy }, [side]) : { ...data, greedy };
  if (stepped.winner) return { ...decided(next, stepped.winner, now), record };
  if (greedy.seq >= GREEDY_MAX_MOVES) return { ...decided(next, null, now, 'draw-limit'), record };
  return { ...nextMove(next, now), record };
}

/**
 * Жадный гусь: срок хода вышел. `GREEDY_MAX_TIMEOUTS`-я просрочка подряд — поражение (`timeout`). Иначе за молчащего ходит
 * сервер: копилка не пуста — «Стоп», пуста — бросок (с пустой копилкой «Стоп» нельзя, иначе пасовать можно вечно).
 */
export function greedyTimeout(
  roundId: string,
  data: DuelRoundData,
  now: Date,
): (DuelMoveResult & { record: GreedyMoveRecord | null; side: DuelSide }) {
  const g = data.greedy;
  if (!g) return { ...decided(data, null, now, 'timeout', 0), record: null, side: 'challenger' };
  const side = g.turn;
  if (g.timeouts[side] + 1 >= GREEDY_MAX_TIMEOUTS) {
    const lost: DuelRoundData = { ...data, greedy: { ...g, timeouts: { ...g.timeouts, [side]: g.timeouts[side] + 1 } } };
    return { ...decided(lost, side === 'challenger' ? 'target' : 'challenger', now, 'timeout', 0), record: null, side };
  }
  const acted = greedyAct(roundId, data, g.turnPoints > 0 ? 'stop' : 'roll', now, true);
  if (!acted) return { ...decided(data, null, now, 'timeout', 0), record: null, side };
  return { ...acted, side };
}

export type TwentyOneMoveRecord =
  | { kind: 'roll'; n: number; die: number; dice?: [number, number]; auto?: true }
  | { kind: 'stop'; total: number; auto?: true };

/** «21»: initial hash gives four dice; hits use hashes n >= 4. One is an ordinary die.
 * Either attempt may stand/bust first; ONLY the shared rule, after BOTH stand, determines winner.
 */
export function twentyOneAct(
  roundId: string, data: DuelRoundData, move: 'roll' | 'stop', now: Date, auto = false,
): (DuelMoveResult & { record: TwentyOneMoveRecord }) | null {
  const g = data.twentyOne;
  if (!g || data.game !== 'twentyone' || data.phase !== 'moving') return null;
  const side = g.turn;
  const opening = g.started?.[side] === false;
  const n = g.started ? 4 + g.rolls.length - 2 * Number(g.started.challenger) - 2 * Number(g.started.target) : g.rolls.length;
  let dice: [number, number] | undefined;
  if (opening && move === 'roll') {
    const initial = diceFromHash(new Uint8Array(sha256(duelRollInput(roundId, data.seed, 0))));
    dice = side === 'challenger' ? [initial[0], initial[1]] : [initial[2], initial[3]];
  }
  const die = move === 'roll' ? dice?.[0] ?? greedyDie(roundId, data.seed, n) : 0;
  const stepped = twentyOneStep(g, move, dice ?? die);
  if (!stepped) return null;
  const record: TwentyOneMoveRecord = move === 'roll'
    ? { kind: 'roll', n: opening ? (side === 'challenger' ? 0 : 2) : n, die, ...(dice ? { dice } : {}), ...(auto ? { auto: true as const } : {}) }
    : { kind: 'stop', total: g.totals[side], ...(auto ? { auto: true as const } : {}) };
  const twentyOne: DuelTwentyOneDto = {
    ...stepped, seq: g.seq + 1,
    timeouts: { ...g.timeouts, [side]: g.timeouts[side] + (auto ? 1 : 0) },
  };
  const next = auto ? withAuto({ ...data, twentyOne }, [side]) : { ...data, twentyOne };
  if (stepped.finished) {
    const timedOut = twentyOne.timeouts.challenger > 0 || twentyOne.timeouts.target > 0;
    return { ...decided(next, stepped.winner, now, timedOut ? 'timeout' : undefined), record };
  }
  return { ...nextMove(next, now), record };
}

/** До старта просрочка бросает пару; затем останавливает только текущую попытку. */
export function twentyOneTimeout(
  roundId: string, data: DuelRoundData, now: Date,
): DuelMoveResult & { record: TwentyOneMoveRecord | null; side: DuelSide } {
  const side = data.twentyOne?.turn ?? 'challenger';
  const acted = twentyOneAct(roundId, data, data.twentyOne?.started?.[side] === false ? 'roll' : 'stop', now, true);
  return acted ? { ...acted, side } : { ...decided(data, null, now, 'timeout', 0), record: null, side };
}

/** `game_moves.think_ms`: сколько прошло с начала хода (`moveFrom`); нет отметки — null. */
export function thinkMsOf(data: DuelRoundData, now: Date): number | null {
  const from = data.moveFrom ? Date.parse(data.moveFrom) : NaN;
  if (!Number.isFinite(from)) return null;
  return Math.max(0, Math.min(now.getTime() - from, 2_147_483_647));
}

export interface DuelRevealResult {
  data: DuelRoundData;
  /** Новый `settle_at`: дедлайн нажатия следующего броска или конец анимации перед итогом; null — без изменений. */
  settleAt: Date | null;
  changed: boolean;
}

/**
 * Раскрыть стороны текущего броска (нажатие «Бросить» — одна сторона; срок вышел — все нераскрытые). Повтор — без
 * изменений. Раскрыты обе и цель ещё не достигнута — следующий заранее рассчитанный бросок с новым дедлайном;
 * иначе `done` и итог через
 * `DUEL_ROLL_ANIM_MS` (клиент доигрывает анимацию).
 */
export function duelReveal(data: DuelRoundData, sides: DuelSide[], now: Date): DuelRevealResult {
  if (data.phase !== 'playing' || !data.rolls || data.rolls.length === 0) return { data, settleAt: null, changed: false };
  const rollNo = Math.min(data.rollNo ?? 0, data.rolls.length - 1);
  const revealed = (data.revealed ?? []).map((r) => ({ ...r }));
  while (revealed.length <= rollNo) revealed.push({ challenger: false, target: false });
  const cur = revealed[rollNo];
  let changed = false;
  for (const side of sides) {
    if (!cur[side]) {
      cur[side] = true;
      changed = true;
    }
  }
  if (!changed) return { data, settleAt: null, changed: false };
  if (!cur.challenger || !cur.target) return { data: { ...data, rollNo, revealed }, settleAt: null, changed: true };
  if (rollNo < data.rolls.length - 1) {
    revealed.push({ challenger: false, target: false });
    return {
      data: { ...data, rollNo: rollNo + 1, revealed },
      settleAt: new Date(now.getTime() + DUEL_ROLL_TURN_MS),
      changed: true,
    };
  }
  return { data: { ...data, rollNo, revealed, phase: 'done' }, settleAt: new Date(now.getTime() + DUEL_ROLL_ANIM_MS), changed: true };
}

export interface DuelSettlePlan {
  winnerId: string | null;
  loserId: string | null;
  /** Выплата победителю (банк минус комиссия, дробь вниз); null — ничья после лимита, возврат обоим. */
  payout: number | null;
  pool: number;
  fee: number;
}

/**
 * Расчёт итога по решённым броскам (кубики) или решённому исходу (`outcome`, игры с выбором) и замороженной комиссии
 * (`splitPot` этапа 1).
 */
export function duelSettlePlan(data: DuelRoundData): DuelSettlePlan {
  const winner = data.game && isDuelChoiceGame(data.game) ? (data.outcome ?? null) : duelOutcome(data.rolls ?? [], data.diceTarget ?? 1).winner;
  const pool = data.amount * 2;
  if (!winner) return { winnerId: null, loserId: null, payout: null, pool, fee: 0 };
  const winnerId = winner === 'challenger' ? data.challengerId : data.targetId;
  const loserId = winner === 'challenger' ? data.targetId : data.challengerId;
  const split = splitPot(
    [
      { key: winnerId, amount: data.amount, winner: true },
      { key: loserId, amount: data.amount, winner: false },
    ],
    data.feePercent,
  );
  return { winnerId, loserId, payout: split.payouts.get(winnerId) ?? 0, pool, fee: split.fee };
}

type DuelRow = { id: string; serverId: string; state: string; lockAt: Date | null; settleAt: Date | null; settledAt: Date | null; data: Record<string, unknown> };

/** Состояние строки → состояние DTO. `locked` с фазой `done` до расчёта — всё ещё `playing` (клиент доигрывает анимацию). */
function dtoState(state: string): DuelDto['state'] | null {
  if (state === 'open') return 'invited';
  if (state === 'locked') return 'playing';
  if (state === 'settled') return 'settled';
  if (state === 'cancelled') return 'cancelled';
  return null;
}

/** Только раскрытые кости, по броску 0..rollNo. */
function revealedRolls(data: Partial<DuelRoundData>, all: boolean): DuelDto['rolls'] {
  const rolls = Array.isArray(data.rolls) ? data.rolls : [];
  const upto = all ? rolls.length - 1 : Math.min(data.rollNo ?? 0, rolls.length - 1);
  const out: DuelDto['rolls'] = [];
  for (let i = 0; i <= upto; i++) {
    const r = rolls[i];
    const seen = all ? { challenger: true, target: true } : (data.revealed?.[i] ?? { challenger: false, target: false });
    out.push({
      challenger: seen.challenger ? [r[0], r[1]] : null,
      target: seen.target ? [r[2], r[3]] : null,
    });
  }
  return out;
}

/** КНБ наружу: раскрытые раунды, «готов», счёт. 🔴 Рук текущего раунда здесь нет и быть не может — их нет в `data`. */
function rpsDto(rps: DuelRpsData): NonNullable<DuelDto['rps']> {
  return {
    rounds: rps.rounds.map((r) => ({ challenger: r.challenger, target: r.target, winner: r.winner })),
    ready: { challenger: rps.ready.challenger === true, target: rps.ready.target === true },
    wins: { challenger: rps.wins.challenger, target: rps.wins.target },
    seq: rps.rounds.length,
  };
}

function greedyDto(g: DuelGreedyData): NonNullable<DuelDto['greedy']> {
  return {
    scores: { challenger: g.scores.challenger, target: g.scores.target },
    turn: g.turn,
    turnPoints: g.turnPoints,
    lastRoll: g.lastRoll ? { by: g.lastRoll.by, die: g.lastRoll.die } : null,
    burned: g.burned,
    timeouts: { challenger: g.timeouts.challenger, target: g.timeouts.target },
    seq: g.seq,
    first: g.first,
    rolls: [...g.rolls],
  };
}

function twentyOneDto(g: DuelTwentyOneDto): DuelTwentyOneDto {
  return {
    totals: { ...g.totals }, standing: { ...g.standing }, turn: g.turn, first: g.first,
    rolls: g.rolls.map((r) => ({ by: r.by, die: r.die })),
    finished: g.finished, winner: g.winner, seq: g.seq, timeouts: { ...g.timeouts },
    ...(g.started ? { started: { ...g.started } } : {}),
  };
}

/**
 * Дуэль наружу. 🔴 Зерно — только у `settled`; кости — только раскрытые (у `settled` — все); рука КНБ — только раскрытая
 * (`rpsDto`). `null` — битая строка.
 */
export function duelDto(row: DuelRow): DuelDto | null {
  const data = row.data as Partial<DuelRoundData>;
  const state = dtoState(row.state);
  if (!state || typeof data.channelId !== 'string' || typeof data.challengerId !== 'string' || typeof data.targetId !== 'string') return null;
  const settled = state === 'settled';
  const playing = state === 'playing' && data.phase === 'playing';
  return {
    id: row.id,
    serverId: row.serverId,
    channelId: data.channelId,
    game: data.game ?? 'dice',
    challengerId: data.challengerId,
    targetId: data.targetId,
    amount: typeof data.amount === 'number' ? data.amount : 0,
    feePercent: typeof data.feePercent === 'number' ? data.feePercent : 0,
    state,
    inviteUntil: state === 'invited' && row.lockAt ? row.lockAt.toISOString() : null,
    commit: typeof data.commit === 'string' ? data.commit : '',
    rollNo: data.rollNo ?? 0,
    turnUntil: playing && row.settleAt ? row.settleAt.toISOString() : null,
    rolls: revealedRolls(data, settled),
    winnerId: settled ? (data.winnerId ?? null) : null,
    payout: settled ? (data.payout ?? null) : null,
    seed: settled && typeof data.seed === 'string' ? data.seed : null,
    reason: data.reason ?? null,
    settledAt: (settled || state === 'cancelled') && row.settledAt ? row.settledAt.toISOString() : null,
    ...(data.game === 'rps' && data.rps ? { rps: rpsDto(data.rps) } : {}),
    ...(data.game === 'greedy' && data.greedy ? { greedy: greedyDto(data.greedy) } : {}),
    ...(data.game === 'twentyone' && data.twentyOne ? { twentyOne: twentyOneDto(data.twentyOne) } : {}),
    moveUntil: state === 'playing' && data.phase === 'moving' && row.settleAt ? row.settleAt.toISOString() : null,
    ...((data.game ?? 'dice') === 'dice' && data.diceTarget ? { diceTarget: data.diceTarget } : {}),
    ...(data.series ? { series: data.series } : {}),
  };
}

/**
 * Дуэль наружу для конкретного смотрящего (29.10): Жадный гусь в ходу (`locked` + `moving`) — под маской `greedyHide`
 * (игрок видит свою сторону, зритель — `viewerId` не игрок или null — ни одной). Решённая и итоговая партия — целиком.
 * 🔴 Всё, что уходит наружу (снимок, ответы маршрутов, `duel.state`), — только через неё; `duelDto` — полный вид.
 */
export function duelDtoFor(row: DuelRow, viewerId: string | null): DuelDto | null {
  const dto = duelDto(row);
  if (!dto?.greedy && !dto?.twentyOne) return dto;
  const data = row.data as Partial<DuelRoundData>;
  const side = viewerId && typeof data.challengerId === 'string' && typeof data.targetId === 'string'
    ? duelSideOf({ challengerId: data.challengerId, targetId: data.targetId }, viewerId)
    : null;
  if (dto.twentyOne) return { ...dto, twentyOne: twentyOneHide(dto.twentyOne, side) };
  if (row.state !== 'locked' || data.phase !== 'moving') return dto;
  return { ...dto, greedy: greedyHide(dto.greedy!, side) };
}

/**
 * Коды отказа дуэли (клиент переводит в текст; `message` — запасной текст для старых клиентов). ⚠️ `target_unavailable`
 * — любой отказ «со стороны соперника» (нет денег, предел, игры выключены у него, вышел из голоса): чужую причину не
 * раскрываем.
 */
export type DuelRefusal =
  | 'games-off'
  | 'not_in_voice'
  | 'not_voice_channel'
  | 'target_unavailable'
  | 'self'
  | 'busy'
  | 'in_duel'
  | 'channel_busy'
  | 'cooldown'
  | 'expired'
  | 'not_found'
  | 'not_player'
  | 'not_playing'
  | 'pair_limit'
  | 'not_your_turn'
  | 'stale_seq'
  | 'bad_move'
  | StakeBlock;

export const DUEL_REFUSAL_TEXT: Record<DuelRefusal, string> = {
  ...STAKE_BLOCK_TEXT,
  'round-closed': 'Вызов уже не действует',
  not_in_voice: 'Дуэль — только сидя в этом голосовом канале',
  not_voice_channel: 'Дуэль бывает только в голосовом канале',
  target_unavailable: 'Соперник сейчас не может играть',
  self: 'Себя на дуэль не вызвать',
  busy: 'Уже отправляется',
  in_duel: 'Кто-то из вас уже в дуэли',
  channel_busy: 'В этом канале уже идёт дуэль',
  cooldown: 'Слишком часто — подожди немного',
  expired: 'Вызов уже не действует',
  not_found: 'Дуэль не найдена',
  not_player: 'Это не твоя дуэль',
  not_playing: 'Сейчас бросать нечего',
  pair_limit: 'Вы двое на сегодня уже выиграли друг у друга предел в играх с выбором',
  not_your_turn: 'Сейчас ход соперника',
  stale_seq: 'Ход уже сменился — обнови партию',
  bad_move: 'Так сходить нельзя',
};

/** HTTP-код: неверный ввод — 400, «нельзя тебе/здесь» — 403, нет такого — 404, состояние — 409, гонка/частота — 429. */
export function duelRefusalStatus(code: DuelRefusal): number {
  if (code === 'bad-amount' || code === 'bad-pick' || code === 'self' || code === 'not_voice_channel' || code === 'bad_move') return 400;
  if (code === 'games-off' || code === 'not_in_voice' || code === 'bot' || code === 'opted-out' || code === 'games-opted-out' || code === 'not_player') return 403;
  if (code === 'not_found') return 404;
  if (code === 'busy' || code === 'cooldown') return 429;
  return 409;
}

/**
 * Отказ проверки ставки (этап 1) → код дуэли. Своя причина называется как есть, причина соперника — обезличенно.
 * `duplicate`/`round-closed` при принятии значат «вызов уже принят/закрыт».
 */
export function duelRefusalOf(block: StakeBlock, mine: boolean): DuelRefusal {
  if (block === 'round-closed' || block === 'duplicate') return 'expired';
  if (block === 'over-bet-max' || block === 'bad-amount' || block === 'games-off') return block;
  return mine ? block : 'target_unavailable';
}

/** Ключ паузы между вызовами одной пары (Redis): после отказа/молчания — 60 с, после итога — `DUEL_REMATCH_PAUSE_MS`. */
export const duelPairKey = (serverId: string, challengerId: string, targetId: string) => `duel:pair:${serverId}:${challengerId}:${targetId}`;
/** Пауза повторного вызова того же человека после отказа или молчания. */
export const DUEL_PAIR_COOLDOWN_MS = 60_000;
/** Сколько после конца партии снимок канала ещё отдаёт её итог (опоздавший зритель видит результат, а не пустоту). */
export const DUEL_RESULT_SHOW_MS = 30_000;

/**
 * Чистый перевод победителю от соперника при ставке `amount` и комиссии `feePercent` (выплата минус своя ставка) — то же,
 * что `payStake` запишет в `data.net` строки `duel.win`.
 */
export function duelWinNet(amount: number, feePercent: number): number {
  const split = splitPot(
    [
      { key: 'w', amount, winner: true },
      { key: 'l', amount, winner: false },
    ],
    feePercent,
  );
  return (split.payouts.get('w') ?? 0) - amount;
}

/**
 * Предел пары в играх с выбором (этап 4): `flow` — чистый поток пары за сутки МСК (выигрыши одного у другого минус обратные),
 * `net` — чистый перевод новой партии. Худший случай — выиграет тот, кто уже впереди: `|flow| + net` не выше `max`.
 * `max` 0 — без предела. Ставка 0 (`net` 0) предел не трогает.
 */
export function pairBlocked(flow: number, net: number, max: number): boolean {
  if (!(max > 0)) return false;
  return Math.abs(flow) + Math.max(0, net) > max;
}

/**
 * Автоходы по сторонам (этап 4, для званий этапа 6): сколько раз за игрока сходил сервер по сроку — во ВСЕХ играх дуэли
 * (кубики — бросок за непрожавшего, КНБ — нет, там просрочка = поражение и счётчик не растёт, Жадный гусь — автостоп/автобросок).
 */
export function withAuto(data: DuelRoundData, sides: DuelSide[]): DuelRoundData {
  if (sides.length === 0) return data;
  const auto = { challenger: data.auto?.challenger ?? 0, target: data.auto?.target ?? 0 };
  for (const side of sides) auto[side] += 1;
  return { ...data, auto };
}

/** Кубики: сколько думал над нажатием «Бросить» (мс от начала броска) — в `data.think` по сторонам (у кубиков нет `game_moves`). */
export function withThink(data: DuelRoundData, side: DuelSide, ms: number | null): DuelRoundData {
  if (ms === null) return data;
  const think = { challenger: [...(data.think?.challenger ?? [])], target: [...(data.think?.target ?? [])] };
  think[side].push(ms);
  return { ...data, think };
}
