import {
  DUEL_MAX_REROLLS,
  DUEL_DICE_WINS,
  duelOutcome,
  DUEL_MOVE_MS,
  DUEL_ROLL_ANIM_MS,
  DUEL_ROLL_TURN_MS,
  GREEDY_MAX_TIMEOUTS,
  GREEDY_TARGET,
  RPS_HANDS,
  RPS_MAX_ROUNDS,
  RPS_WINS,
  greedyHide,
  greedyStep,
  rpsRoundWinner,
  twentyOneStart,
  twentyOneStep,
  twentyOneHide,
  type DuelDto,
  type DuelGame,
  type DuelGreedyDto,
  type DuelReason,
  type DuelSide,
  type RpsHand,
} from '@gusvoice/shared';

/**
 * «Тренировка с капитаном» (ГусКоины 2): дуэль с ботом без ставки — целиком на клиенте. Денег нет — серверу незачем:
 * ни записей в экономику, журнал и таблицу игр, ни событий шлюза другим. Здесь — чистый «движок» хода без React:
 * состояние держит готовый `DuelDto` (сцена `DuelScene` рисует его теми же досками, что настоящую партию) и скрытое
 * (рука капитана, когда ему ходить, когда подводить итог). Время и случай приходят снаружи (`now`, `PracticeRng`),
 * поэтому всё проверяется без таймеров.
 *
 * Правила — как у сервера (`packages/backend/src/gameDuelRules.ts`): кубики — 2d6 каждому до двух побед, ничья — переброс.
 * Бюджет новой партии — 8 бросков, без цели (legacy) — 6; не нажал «Бросить» за `DUEL_ROLL_TURN_MS` — бросает судья. КНБ — до
 * `RPS_WINS` побед, `RPS_MAX_ROUNDS` раундов без решения — ничья, не выбрал руку за `DUEL_MOVE_MS` — поражение.
 * Жадный гусь — `greedyStep` из общих правил, ход `DUEL_MOVE_MS`, просрочка — за игрока ходит судья (копилка есть —
 * «Стоп», нет — бросок), `GREEDY_MAX_TIMEOUTS` подряд — поражение. Я — всегда вызвавший (`challenger`), капитан — цель.
 */

/** Id капитана в тренировочной партии (настоящих пользователей с таким id нет: у них uuid). */
export const PRACTICE_CAPTAIN_ID = 'practice:captain';

/** Источник случая: `unit` — [0, 1), `die` — честная кость 1..6. */
export interface PracticeRng {
  unit(): number;
  die(): number;
}

/** Случай из `crypto.getRandomValues`; кость — без смещения (отбрасывание выше кратного 6). */
export const cryptoRng: PracticeRng = {
  unit() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] / 2 ** 32;
  },
  die() {
    const limit = 2 ** 32 - (2 ** 32 % 6);
    const a = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(a);
      if (a[0] < limit) return (a[0] % 6) + 1;
    }
  },
};

/** Капитан «думает» в КНБ: столько после начала раунда (поверх показа прошлых рук). */
export const PRACTICE_RPS_THINK_MS: readonly [number, number] = [700, 2_600];
/** Показ раскрытых рук КНБ на сцене (`RPS_REVEAL_MS` сцены) — капитан не ходит, пока руки на столе. */
export const PRACTICE_RPS_REVEAL_MS = 2_500;
/** Капитан бросает кубики через столько после начала броска. */
export const PRACTICE_DICE_THINK_MS: readonly [number, number] = [600, 1_800];
/** Жадный гусь: пауза капитана между действиями (сверх анимации кубика). */
export const PRACTICE_GREEDY_THINK_MS: readonly [number, number] = [500, 1_300];
/** Жадный гусь: капитан рискует, пока копилка хода меньше цели из этого отрезка (выбирается заново на каждый ход). */
export const PRACTICE_GREEDY_GOAL: readonly [number, number] = [12, 15];

type Hidden = {
  /** Рука капитана в текущем раунде КНБ (до раскрытия не видна сцене). */
  botHand: RpsHand | null;
  /** Когда капитану действовать; null — не его очередь. */
  botAt: number | null;
  /** Срок хода игрока (кубики — `turnUntil`, игры с выбором — `moveUntil`), мс; null — срока нет. */
  deadline: number | null;
  /** Исход решён — итог показывается в этот миг (после анимации), мс. */
  settleAt: number | null;
  outcome: DuelSide | null;
  reason: DuelReason | null;
  /** Жадный гусь: до какой копилки капитан рискует в этом ходе. */
  botGoal: number;
};

export interface PracticeState {
  /** То, что рисует сцена (`DuelView.duel`). */
  duel: DuelDto;
  /** Своя рука КНБ в текущем раунде (`DuelView.myHand`). */
  myHand: RpsHand | null;
  hidden: Hidden;
}

export type PracticeMove = 'roll' | 'stop' | RpsHand;

const iso = (ms: number) => new Date(ms).toISOString();
const between = (rng: PracticeRng, [a, b]: readonly [number, number]) => a + Math.floor(rng.unit() * (b - a + 1));
const other = (s: DuelSide): DuelSide => (s === 'challenger' ? 'target' : 'challenger');

let practiceNo = 0;

/** Новая тренировочная партия: сразу идёт (вызова и ожидания ответа нет). */
export function practiceStart(game: DuelGame, meId: string, now: number, rng: PracticeRng = cryptoRng): PracticeState {
  practiceNo += 1;
  const duel: DuelDto = {
    id: `practice-${now}-${practiceNo}`,
    serverId: '',
    channelId: '',
    game,
    challengerId: meId,
    targetId: PRACTICE_CAPTAIN_ID,
    amount: 0,
    feePercent: 0,
    state: 'playing',
    inviteUntil: null,
    commit: '',
    rollNo: 0,
    turnUntil: null,
    rolls: [],
    winnerId: null,
    payout: null,
    seed: null,
    reason: null,
    settledAt: null,
    moveUntil: null,
  };
  const hidden: Hidden = { botHand: null, botAt: null, deadline: null, settleAt: null, outcome: null, reason: null, botGoal: PRACTICE_GREEDY_GOAL[0] };
  if (game === 'rps') {
    duel.rps = { rounds: [], ready: { challenger: false, target: false }, wins: { challenger: 0, target: 0 }, seq: 0 };
    hidden.deadline = now + DUEL_MOVE_MS;
    hidden.botAt = now + between(rng, PRACTICE_RPS_THINK_MS);
    duel.moveUntil = iso(hidden.deadline);
  } else if (game === 'twentyone') {
    const first = 'challenger' as const;
    duel.twentyOne = { ...twentyOneStart(first),
      seq: 0, timeouts: { challenger: 0, target: 0 } };
    hidden.deadline = now + DUEL_MOVE_MS;
    duel.moveUntil = iso(hidden.deadline);
    hidden.botAt = null;
  } else if (game === 'greedy') {
    const first: DuelSide = rng.unit() < 0.5 ? 'challenger' : 'target';
    duel.greedy = {
      scores: { challenger: 0, target: 0 },
      turn: first,
      turnPoints: 0,
      lastRoll: null,
      burned: 0,
      timeouts: { challenger: 0, target: 0 },
      seq: 0,
      first,
      rolls: [],
    };
    hidden.deadline = now + DUEL_MOVE_MS;
    duel.moveUntil = iso(hidden.deadline);
    if (first === 'target') {
      hidden.botGoal = between(rng, PRACTICE_GREEDY_GOAL);
      hidden.botAt = now + between(rng, PRACTICE_GREEDY_THINK_MS) + 600;
    }
  } else {
    duel.diceTarget = DUEL_DICE_WINS;
    duel.rolls = [{ challenger: null, target: null }];
    hidden.deadline = now + DUEL_ROLL_TURN_MS;
    hidden.botAt = now + between(rng, PRACTICE_DICE_THINK_MS);
    duel.turnUntil = iso(hidden.deadline);
  }
  return { duel, myHand: null, hidden };
}

/** Исход решён: партия ещё «идёт» (доигрывает анимация), итог — в `settleAt`. Сроков и хода капитана больше нет. */
function decide(s: PracticeState, outcome: DuelSide | null, now: number, reason: DuelReason | null, delayMs = DUEL_ROLL_ANIM_MS): PracticeState {
  return {
    ...s,
    duel: { ...s.duel, turnUntil: null, moveUntil: null },
    hidden: { ...s.hidden, botAt: null, deadline: null, settleAt: now + delayMs, outcome, reason },
  };
}

function settle(s: PracticeState, now: number): PracticeState {
  const d = s.duel;
  const winnerId = s.hidden.outcome === 'challenger' ? d.challengerId : s.hidden.outcome === 'target' ? d.targetId : null;
  return {
    ...s,
    myHand: null,
    duel: { ...d, state: 'settled', winnerId, payout: null, reason: s.hidden.reason, settledAt: iso(now), turnUntil: null, moveUntil: null },
    hidden: { ...s.hidden, botAt: null, deadline: null, settleAt: null },
  };
}

// ——— Кубики ———

function diceReveal(s: PracticeState, sides: DuelSide[], now: number, rng: PracticeRng): PracticeState {
  const d = s.duel;
  const rolls = d.rolls.map((r) => ({ ...r }));
  const cur = rolls[d.rollNo];
  if (!cur) return s;
  let changed = false;
  for (const side of sides) {
    if (!cur[side]) {
      cur[side] = [rng.die(), rng.die()];
      changed = true;
    }
  }
  if (!changed) return s;
  const botAt = cur.target ? null : s.hidden.botAt;
  if (!cur.challenger || !cur.target) return { ...s, duel: { ...d, rolls }, hidden: { ...s.hidden, botAt } };
  const target = d.diceTarget ?? 1;
  const complete = rolls.map((r): [number, number, number, number] => [
    r.challenger![0], r.challenger![1], r.target![0], r.target![1],
  ]);
  const outcome = duelOutcome(complete, target).winner;
  if (!outcome && rolls.length < 2 * target - 1 + DUEL_MAX_REROLLS) {
    // Цель ещё не достигнута — следующий бросок с новым сроком; капитан ждёт анимацию.
    const deadline = now + DUEL_ROLL_TURN_MS;
    rolls.push({ challenger: null, target: null });
    return {
      ...s,
      duel: { ...d, rolls, rollNo: d.rollNo + 1, turnUntil: iso(deadline) },
      hidden: { ...s.hidden, deadline, botAt: now + DUEL_ROLL_ANIM_MS + between(rng, PRACTICE_DICE_THINK_MS) },
    };
  }
  return decide({ ...s, duel: { ...d, rolls } }, outcome, now, outcome ? null : 'draw-limit');
}

// ——— Камень-ножницы-бумага ———

function rpsResolve(s: PracticeState, mine: RpsHand, now: number, rng: PracticeRng): PracticeState {
  const d = s.duel;
  const rps = d.rps!;
  const bot = s.hidden.botHand!;
  const winner = rpsRoundWinner(mine, bot);
  const wins = { ...rps.wins };
  if (winner) wins[winner] += 1;
  const rounds = [...rps.rounds, { challenger: mine, target: bot, winner }];
  const next: PracticeState = {
    ...s,
    myHand: null,
    duel: { ...d, rps: { rounds, ready: { challenger: false, target: false }, wins, seq: rounds.length } },
    hidden: { ...s.hidden, botHand: null },
  };
  if (wins.challenger >= RPS_WINS) return decide(next, 'challenger', now, null);
  if (wins.target >= RPS_WINS) return decide(next, 'target', now, null);
  if (rounds.length >= RPS_MAX_ROUNDS) return decide(next, null, now, 'draw-limit');
  const deadline = now + DUEL_MOVE_MS;
  return {
    ...next,
    duel: { ...next.duel, moveUntil: iso(deadline) },
    hidden: { ...next.hidden, deadline, botAt: now + PRACTICE_RPS_REVEAL_MS + between(rng, PRACTICE_RPS_THINK_MS) },
  };
}

function rpsBotPick(s: PracticeState, now: number, rng: PracticeRng): PracticeState {
  const rps = s.duel.rps!;
  const hand = RPS_HANDS[Math.min(RPS_HANDS.length - 1, Math.floor(rng.unit() * RPS_HANDS.length))];
  const next: PracticeState = {
    ...s,
    duel: { ...s.duel, rps: { ...rps, ready: { ...rps.ready, target: true } } },
    hidden: { ...s.hidden, botHand: hand, botAt: null },
  };
  return rps.ready.challenger && s.myHand ? rpsResolve(next, s.myHand, now, rng) : next;
}

// ——— Жадный гусь ———

/**
 * Решение капитана в свой ход: копилка пуста — бросать (пустой «Стоп» нельзя); иначе рискует, пока копилка меньше
 * `goal` (бросок до цели игры закончит партию сам). Соперник близко к цели (≥ 15) — рискует до победы: ждать нечего.
 */
export function botGreedyWants(g: Pick<DuelGreedyDto, 'scores' | 'turnPoints'>, goal: number): 'roll' | 'stop' {
  if (g.turnPoints <= 0) return 'roll';
  const mine = g.scores.target;
  const rival = g.scores.challenger;
  if (rival >= GREEDY_TARGET - 5) return 'roll';
  return g.turnPoints < Math.min(goal, GREEDY_TARGET - mine) ? 'roll' : 'stop';
}

function greedyAct(s: PracticeState, move: 'roll' | 'stop', now: number, rng: PracticeRng, auto = false): PracticeState | null {
  const d = s.duel;
  const g = d.greedy!;
  const side = g.turn;
  const die = move === 'roll' ? rng.die() : 0;
  const stepped = greedyStep({ scores: g.scores, turn: g.turn, turnPoints: g.turnPoints, n: g.rolls.length, lastRoll: g.lastRoll, burned: g.burned, winner: null }, move, die);
  if (!stepped) return null;
  const greedy: DuelGreedyDto = {
    ...g,
    scores: stepped.scores,
    turn: stepped.turn,
    turnPoints: stepped.turnPoints,
    lastRoll: stepped.lastRoll,
    burned: stepped.burned,
    timeouts: { ...g.timeouts, [side]: auto ? g.timeouts[side] + 1 : 0 },
    seq: g.seq + 1,
    rolls: move === 'roll' ? [...g.rolls, die] : g.rolls,
  };
  const next: PracticeState = { ...s, duel: { ...d, greedy } };
  if (stepped.winner) return decide(next, stepped.winner, now, null);
  const deadline = now + DUEL_MOVE_MS;
  // Ход капитана: подождать, пока кубик докатится (после броска), и «подумать».
  const botTurn = greedy.turn === 'target';
  const turnChanged = greedy.turn !== side;
  const botGoal = botTurn && turnChanged ? between(rng, PRACTICE_GREEDY_GOAL) : s.hidden.botGoal;
  const botAt = botTurn ? now + (move === 'roll' ? DUEL_ROLL_ANIM_MS : 0) + between(rng, PRACTICE_GREEDY_THINK_MS) : null;
  return { ...next, duel: { ...next.duel, moveUntil: iso(deadline) }, hidden: { ...next.hidden, deadline, botAt, botGoal } };
}

/** Срок хода в Жадном гусе вышел (у ходящего): `GREEDY_MAX_TIMEOUTS`-я просрочка — поражение, иначе ход за него. */
function greedyTimeout(s: PracticeState, now: number, rng: PracticeRng): PracticeState {
  const g = s.duel.greedy!;
  const side = g.turn;
  if (g.timeouts[side] + 1 >= GREEDY_MAX_TIMEOUTS) {
    const lost: PracticeState = { ...s, duel: { ...s.duel, greedy: { ...g, timeouts: { ...g.timeouts, [side]: g.timeouts[side] + 1 } } } };
    return decide(lost, other(side), now, 'timeout', 0);
  }
  return greedyAct(s, g.turnPoints > 0 ? 'stop' : 'roll', now, rng, true) ?? decide(s, null, now, 'timeout', 0);
}

// ——— Вход ———

function twentyOneAct(s: PracticeState, move: 'roll' | 'stop', now: number, rng: PracticeRng, auto = false): PracticeState | null {
  const g = s.duel.twentyOne!;
  const dice = move === 'roll' ? (g.started?.[g.turn] === false ? [rng.die(), rng.die()] as [number, number] : rng.die()) : 0;
  const next = twentyOneStep(g, move, dice);
  if (!next) return null;
  const timeouts = { ...g.timeouts, [g.turn]: g.timeouts[g.turn] + Number(auto) };
  const duel = { ...s.duel, twentyOne: { ...next, seq: g.seq + 1, timeouts } };
  if (next.finished) return decide({ ...s, duel }, next.winner, now,
    timeouts.challenger || timeouts.target ? 'timeout' : null, move === 'roll' ? DUEL_ROLL_ANIM_MS : 0);
  const deadline = now + DUEL_MOVE_MS;
  return { ...s, duel: { ...duel, moveUntil: iso(deadline) }, hidden: { ...s.hidden, deadline,
    botAt: next.turn === 'target' ? now + (move === 'roll' ? DUEL_ROLL_ANIM_MS : 0) + between(rng, PRACTICE_GREEDY_THINK_MS) : null } };
}

/** Идёт ли тренировка (итог ещё не подведён). */
export function practiceLive(s: PracticeState): boolean {
  return s.duel.state === 'playing';
}

/**
 * Ход игрока: «Бросить» (кубики и гусь), «Стоп» (гусь) или рука (КНБ). Нельзя (не мой ход, рука уже выбрана, исход
 * решён, пустой «Стоп») — `null`.
 */
export function practiceMove(s: PracticeState, move: PracticeMove, now: number, rng: PracticeRng = cryptoRng): PracticeState | null {
  const d = s.duel;
  if (d.state !== 'playing' || s.hidden.settleAt !== null) return null;
  if (d.game === 'dice') {
    if (move !== 'roll' || d.rolls[d.rollNo]?.challenger) return null;
    return diceReveal(s, ['challenger'], now, rng);
  }
  if (d.game === 'rps') {
    if (move === 'roll' || move === 'stop' || !d.rps || d.rps.ready.challenger) return null;
    const next: PracticeState = { ...s, myHand: move, duel: { ...d, rps: { ...d.rps, ready: { ...d.rps.ready, challenger: true } } } };
    return d.rps.ready.target ? rpsResolve(next, move, now, rng) : next;
  }
  if (d.game === 'greedy') {
    if ((move !== 'roll' && move !== 'stop') || !d.greedy || d.greedy.turn !== 'challenger') return null;
    return greedyAct(s, move, now, rng);
  }
  if (d.game === 'twentyone') {
    if ((move !== 'roll' && move !== 'stop') || !d.twentyOne || d.twentyOne.turn !== 'challenger') return null;
    return twentyOneAct(s, move, now, rng);
  }
  return null;
}

/**
 * Что видит игрок (29.10, решение владельца): в Жадном гусе счёт, копилка и броски капитана скрыты, пока идут ходы, — та
 * же маска `greedyHide`, что у сервера (я — `challenger`). Решённая партия (`moveUntil` снят) — целиком: так раскрывается
 * итог. Движок и `botGreedyWants` работают с полным `s.duel`; маска — только для показа.
 */
export function practiceShownDuel(s: PracticeState): DuelDto {
  const d = s.duel;
  if (d.game === 'twentyone' && d.twentyOne && d.state === 'playing' && d.moveUntil) return { ...d, twentyOne: twentyOneHide(d.twentyOne, 'challenger') };
  if (d.game !== 'greedy' || !d.greedy || d.state !== 'playing' || !d.moveUntil) return d;
  return { ...d, greedy: greedyHide(d.greedy, 'challenger') };
}

/** Ближайший миг, когда партии есть что делать само (ход капитана, срок, итог); null — ждать нечего. */
export function practiceNextAt(s: PracticeState): number | null {
  if (s.duel.state !== 'playing') return null;
  if (s.hidden.settleAt !== null) return s.hidden.settleAt;
  const t = [s.hidden.botAt, s.hidden.deadline].filter((x): x is number => x !== null);
  return t.length ? Math.min(...t) : null;
}

/**
 * Время пошло: применить всё, что наступило к `now`, по порядку (ход капитана, просрочку, итог). Вкладка спала — партия
 * догоняет, как сервер с часами: просроченные ходы засчитываются. Ничего не наступило — тот же объект.
 */
export function practiceTick(s: PracticeState, now: number, rng: PracticeRng = cryptoRng): PracticeState {
  let cur = s;
  for (let i = 0; i < 1_000; i++) {
    const at = practiceNextAt(cur);
    if (at === null || at > now) break;
    cur = step(cur, at, rng);
  }
  return cur;
}

function step(s: PracticeState, at: number, rng: PracticeRng): PracticeState {
  const h = s.hidden;
  if (h.settleAt !== null) return settle(s, at);
  const d = s.duel;
  const botFirst = h.botAt !== null && (h.deadline === null || h.botAt <= h.deadline);
  if (d.game === 'dice') {
    if (botFirst) return diceReveal(s, ['target'], at, rng);
    // Срок нажатия вышел — судья бросает за всех, кто не нажал.
    return diceReveal({ ...s, hidden: { ...h, deadline: null } }, ['challenger', 'target'], at, rng);
  }
  if (d.game === 'rps') {
    if (botFirst) return rpsBotPick(s, at, rng);
    const ready = d.rps!.ready;
    const outcome: DuelSide | null = ready.target && !ready.challenger ? 'target' : ready.challenger && !ready.target ? 'challenger' : null;
    return decide(s, outcome, at, 'timeout', 0);
  }
  if (d.game === 'greedy') {
    if (botFirst && d.greedy!.turn === 'target') {
      const want = botGreedyWants(d.greedy!, h.botGoal);
      return greedyAct(s, want, at, rng) ?? greedyTimeout(s, at, rng);
    }
    return greedyTimeout({ ...s, hidden: { ...h, botAt: null } }, at, rng);
  }
  if (d.game === 'twentyone' && d.twentyOne) {
    const g = d.twentyOne;
    if (botFirst && g.turn === 'target') return twentyOneAct(s, g.totals.target < 17 ? 'roll' : 'stop', at, rng) ?? s;
    return twentyOneAct(s, g.started?.[g.turn] === false ? 'roll' : 'stop', at, rng, true) ?? decide(s, null, at, 'timeout', 0);
  }
  return decide(s, null, at, null, 0);
}

/** Итог для меня: победа / поражение / ничья; партия идёт — null. */
export function practiceResult(d: Pick<DuelDto, 'state' | 'winnerId' | 'challengerId'>): 'win' | 'loss' | 'draw' | null {
  if (d.state !== 'settled') return null;
  if (!d.winnerId) return 'draw';
  return d.winnerId === d.challengerId ? 'win' : 'loss';
}

/** Строка итога тренировки. */
export function practiceResultText(d: Pick<DuelDto, 'state' | 'winnerId' | 'challengerId'>): string | null {
  const r = practiceResult(d);
  return r === 'win' ? 'Тренировка: ты выиграл' : r === 'loss' ? 'Тренировка: ты проиграл' : r === 'draw' ? 'Тренировка: ничья' : null;
}
