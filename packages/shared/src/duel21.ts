import type { DuelSide } from './duel.js';

export const TWENTY_ONE_TARGET = 21;

export interface TwentyOneState {
  first: DuelSide;
  totals: Record<DuelSide, number>;
  standing: Record<DuelSide, boolean>;
  turn: DuelSide;
  rolls: { by: DuelSide; die: number }[];
  finished: boolean;
  winner: DuelSide | null;
  /** Отсутствует у legacy с автоматической раздачей. */
  started?: Record<DuelSide, boolean>;
}

export interface DuelTwentyOneDto extends TwentyOneState {
  seq: number;
  timeouts: Record<DuelSide, number>;
  hidden?: Partial<Record<DuelSide, boolean>>;
}

const other = (side: DuelSide): DuelSide => side === 'challenger' ? 'target' : 'challenger';
const validDie = (die: number) => Number.isInteger(die) && die >= 1 && die <= 6;

/** Новый старт пуст; явно переданные кости восстанавливают legacy с автоматической раздачей. */
export function twentyOneStart(first: DuelSide, dice?: Record<DuelSide, [number, number]>): TwentyOneState {
  if (!dice) return {
    first, turn: first, totals: { challenger: 0, target: 0 },
    standing: { challenger: false, target: false }, started: { challenger: false, target: false },
    rolls: [], finished: false, winner: null,
  };
  if (![...dice.challenger, ...dice.target].every(validDie)) throw new Error('Invalid initial dice');
  return {
    totals: { challenger: dice.challenger[0] + dice.challenger[1], target: dice.target[0] + dice.target[1] },
    standing: { challenger: false, target: false }, turn: first, first,
    rolls: [...dice.challenger.map(die => ({ by: 'challenger' as const, die })), ...dice.target.map(die => ({ by: 'target' as const, die }))],
    finished: false, winner: null,
  };
}

/** Сравнивать можно только две законченные попытки. Оба перебрали или равны — возврат обоим. */
export function twentyOneWinner(totals: Record<DuelSide, number>): DuelSide | null {
  const a = totals.challenger > TWENTY_ONE_TARGET ? -1 : totals.challenger;
  const b = totals.target > TWENTY_ONE_TARGET ? -1 : totals.target;
  return a === b ? null : a > b ? 'challenger' : 'target';
}

/** Добор по очереди; остановившийся больше не ходит. 21 и перебор останавливают только свою попытку. */
export function twentyOneStep(s: TwentyOneState, move: 'roll' | 'stop', die: number | [number, number] = 0): TwentyOneState | null {
  const opening = s.started?.[s.turn] === false;
  const dice = Array.isArray(die) ? die : [die];
  if (s.finished || s.standing[s.turn] || (move === 'stop' && opening)
    || (move === 'roll' && (dice.length !== (opening ? 2 : 1) || !dice.every(validDie)))) return null;
  const totals = { ...s.totals };
  const standing = { ...s.standing };
  if (move === 'roll') totals[s.turn] += dice.reduce((a, b) => a + b, 0);
  standing[s.turn] = move === 'stop' || totals[s.turn] >= TWENTY_ONE_TARGET;
  const finished = standing.challenger && standing.target;
  return {
    totals, standing, finished, first: s.first,
    turn: standing[other(s.turn)] ? s.turn : other(s.turn),
    rolls: move === 'roll' ? [...s.rolls, ...dice.map(die => ({ by: s.turn, die }))] : s.rolls,
    ...(s.started ? { started: { ...s.started, [s.turn]: true } } : {}),
    winner: finished ? twentyOneWinner(totals) : null,
  };
}

/** Сумма и кости соперника закрыты до конца обеих попыток; готовность видна. */
export function twentyOneHide(s: DuelTwentyOneDto, viewer: DuelSide | null): DuelTwentyOneDto {
  if (s.finished) return s;
  const hidden = { challenger: viewer !== 'challenger', target: viewer !== 'target' };
  return { ...s,
    totals: { challenger: hidden.challenger ? 0 : s.totals.challenger, target: hidden.target ? 0 : s.totals.target },
    rolls: s.rolls.map(r => hidden[r.by] ? { ...r, die: 0 } : r), hidden,
  };
}
