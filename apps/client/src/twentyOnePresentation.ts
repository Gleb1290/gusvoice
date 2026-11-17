import type { DuelDto, DuelSide } from '@gusvoice/shared';

export const TWENTY_ONE_ROLL_MS = 1500;
export const TWENTY_ONE_DELTA_MS = 550;
export const TWENTY_ONE_ADD_MS = 850;
const SIDES: readonly DuelSide[] = ['challenger', 'target'];
export type TwentyOnePhase = 'rolling' | 'delta' | 'adding';
type BoardInput = Pick<DuelDto, 'id' | 'state' | 'twentyOne'>;
export type TwentyOneSeat = { total: number | null; die: number | null; dice?: number[] };
type Roll = { side: DuelSide; die: number; dice?: number[]; total: number; key: number };
type ActiveRoll = Roll & { startedAt: number; phase: TwentyOnePhase };
export interface TwentyOnePresentation {
  id: string;
  seq: number;
  rollCount: number;
  latest: Record<DuelSide, TwentyOneSeat>;
  shown: Record<DuelSide, TwentyOneSeat>;
  active: ActiveRoll | null;
  queue: Roll[];
}

// Маска применяется до сохранения presentation: скрытая сторона не несёт чисел даже в очереди.
function visibleSeats(d: BoardInput): Record<DuelSide, TwentyOneSeat> {
  const g = d.twentyOne!;
  const seat = (side: DuelSide): TwentyOneSeat => {
    if (g.hidden?.[side]) return { total: null, die: null };
    const rolls = g.rolls.filter(r => r.by === side);
    const die = rolls.at(-1)?.die;
    return { total: g.totals[side], die: die && die >= 1 && die <= 6 ? die : null,
      ...(g.started && rolls.length === 2 ? { dice: rolls.map(r => r.die) } : {}) };
  };
  return { challenger: seat('challenger'), target: seat('target') };
}

/** Открытие сцены/новая партия — сразу серверный счёт, без проигрывания истории. */
export function createTwentyOnePresentation(d: BoardInput): TwentyOnePresentation {
  const latest = visibleSeats(d);
  return { id: d.id, seq: d.twentyOne!.seq, rollCount: d.twentyOne!.rolls.length,
    latest, shown: latest, active: null, queue: [] };
}

function startNext(p: TwentyOnePresentation, now: number): TwentyOnePresentation {
  if (p.active || !p.queue.length) return p;
  const [roll, ...queue] = p.queue;
  return { ...p, queue, active: { ...roll, startedAt: now, phase: 'rolling' },
    shown: { ...p.shown, [roll.side]: { total: roll.total - roll.die,
      die: roll.dice?.at(-1) ?? roll.die, ...(roll.dice ? { dice: roll.dice } : {}) } } };
}

/** Синхронизация DTO не сбрасывает начатый бросок при смене хода/finished/settled. */
export function syncTwentyOnePresentation(
  p: TwentyOnePresentation, d: BoardInput, now: number, reducedMotion = false,
): TwentyOnePresentation {
  if (p.id !== d.id) return createTwentyOnePresentation(d);
  const g = d.twentyOne!;
  if (g.seq < p.seq) return p;
  const latest = visibleSeats(d);
  // После пропуска событий (reconnect) догоняем снимок, не разыгрываем старые доборы.
  const added = g.rolls.slice(p.rollCount);
  const pair = added.length === 2 && added[0].by === added[1].by && !!g.started;
  const contiguous = g.seq === p.seq + 1 && (added.length === 1 || pair);
  let active = p.active && latest[p.active.side].total !== null ? p.active : null;
  let queue = p.queue.filter(r => latest[r.side].total !== null);
  if (contiguous && !reducedMotion) {
    const roll = g.rolls.at(-1)!;
    // Раскрытие прежде скрытой стороны — полученные данные, а не свежий видимый бросок.
    if (p.latest[roll.by].total !== null && latest[roll.by].total !== null && roll.die >= 1 && roll.die <= 6) {
      const dice = pair ? added.map(r => r.die) : undefined;
      if (!dice || dice.every(die => die >= 1 && die <= 6)) queue = [...queue, {
        side: roll.by, die: dice ? dice[0] + dice[1] : roll.die,
        ...(dice ? { dice } : {}), total: g.totals[roll.by], key: g.rolls.length,
      }];
    }
  }
  if (reducedMotion) { active = null; queue = []; }
  const shown = { ...p.shown };
  for (const side of SIDES) {
    if (latest[side].total === null || (active?.side !== side && !queue.some(r => r.side === side))) shown[side] = latest[side];
  }
  return startNext({ ...p, seq: g.seq, rollCount: g.rolls.length, latest, shown, active, queue }, now);
}

/** Один таймер на ближайшую границу фазы. При уходе со сцены таймер снимает компонент. */
export function twentyOneNextAt(p: TwentyOnePresentation): number | null {
  const a = p.active;
  if (!a) return null;
  const offset = a.phase === 'rolling' ? TWENTY_ONE_ROLL_MS
    : a.phase === 'delta' ? TWENTY_ONE_ROLL_MS + TWENTY_ONE_DELTA_MS
    : TWENTY_ONE_ROLL_MS + TWENTY_ONE_DELTA_MS + TWENTY_ONE_ADD_MS;
  return a.startedAt + offset;
}

export function advanceTwentyOnePresentation(
  p: TwentyOnePresentation, now: number, reducedMotion = false,
): TwentyOnePresentation {
  if (reducedMotion) return { ...p, shown: p.latest, active: null, queue: [] };
  const a = p.active;
  if (!a) return p;
  const elapsed = now - a.startedAt;
  if (elapsed < TWENTY_ONE_ROLL_MS) return p;
  if (elapsed < TWENTY_ONE_ROLL_MS + TWENTY_ONE_DELTA_MS) return { ...p, active: { ...a, phase: 'delta' } };
  if (elapsed < TWENTY_ONE_ROLL_MS + TWENTY_ONE_DELTA_MS + TWENTY_ONE_ADD_MS) {
    return { ...p, active: { ...a, phase: 'adding' } };
  }
  const shown = { ...p.shown, [a.side]: { total: a.total, die: a.dice?.at(-1) ?? a.die,
    ...(a.dice ? { dice: a.dice } : {}) } };
  for (const side of SIDES) {
    if (!p.queue.some(r => r.side === side)) shown[side] = p.latest[side];
  }
  return startNext({ ...p, shown, active: null }, now);
}

export function twentyOneCanMove(
  d: BoardInput, mySide: DuelSide | null, busy: boolean, p: TwentyOnePresentation, move: 'roll' | 'stop' = 'roll',
): boolean {
  const g = d.twentyOne!;
  return d.state === 'playing' && !g.finished && !!mySide && g.turn === mySide && !g.standing[mySide]
    && !busy && p.active === null && (move !== 'stop' || g.started?.[mySide] !== false);
}

export function twentyOneRollLabel(d: BoardInput, side: DuelSide | null): string {
  return side && d.twentyOne?.started?.[side] === false ? 'Бросить 2 кубика' : 'Ещё кубик';
}
