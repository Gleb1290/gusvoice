import { DUEL_ROLL_ANIM_MS, type DuelDto, type DuelSide } from '@gusvoice/shared';

/** После остановки костей даём прочитать победителя, не меняя серверный дедлайн. */
export const DICE_RESULT_MS = 2000;
type Input = Pick<DuelDto, 'id' | 'rolls' | 'rollNo' | 'state'>;
type Reveal = { index: number; at: number };
export interface DicePresentation {
  id: string;
  seen: string[];
  completed: number;
  active: Reveal | null;
  queue: number[];
  animations: Record<string, number>;
}
const sides: DuelSide[] = ['challenger', 'target'];
const keys = (d: Input) => d.rolls.flatMap((r, i) => sides.filter(s => r[s]).map(s => `${i}:${s}`));
const completed = (d: Input) => d.rolls.filter(r => r.challenger && r.target).length;
export function createDicePresentation(d: Input): DicePresentation {
  return { id: d.id, seen: keys(d), completed: completed(d), active: null, queue: [], animations: {} };
}
export function syncDicePresentation(p: DicePresentation, d: Input, now: number, reduced = false): DicePresentation {
  if (p.id !== d.id) return createDicePresentation(d);
  const seen = keys(d), count = completed(d);
  if (count < p.completed) return p;
  // Пропущенные после сна/переподключения броски остаются в истории, без длинного проигрывания задним числом.
  if (reduced || count > p.completed + 1) return createDicePresentation(d);
  const animations = { ...p.animations };
  for (const key of seen) if (!p.seen.includes(key)) animations[key] = now + DUEL_ROLL_ANIM_MS;
  let active = p.active, queue = p.queue;
  if (count > p.completed) {
    const index = d.rolls.reduce((last, r, i) => r.challenger && r.target ? i : last, -1);
    if (active) queue = [...queue, index];
    else active = { index, at: now };
  }
  return { ...p, seen, completed: count, animations, active, queue };
}
export function advanceDicePresentation(p: DicePresentation, now: number): DicePresentation {
  const animations = Object.fromEntries(Object.entries(p.animations).filter(([, until]) => until > now));
  if (!p.active || now < p.active.at + DUEL_ROLL_ANIM_MS + DICE_RESULT_MS) return { ...p, animations };
  const [index, ...queue] = p.queue;
  return { ...p, animations, queue, active: index === undefined ? null : { index, at: now } };
}
export function diceNextAt(p: DicePresentation, now: number): number | null {
  const deadlines = Object.values(p.animations).filter(at => at > now);
  if (p.active) {
    const reveal = p.active.at + DUEL_ROLL_ANIM_MS;
    deadlines.push(now < reveal ? reveal : reveal + DICE_RESULT_MS);
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}
export function diceRoundResult(d: Input, index: number) {
  const r = d.rolls[index];
  if (!r?.challenger || !r.target) return null;
  const challenger = r.challenger[0] + r.challenger[1], target = r.target[0] + r.target[1];
  return { index, challenger, target, winner: challenger === target ? null : challenger > target ? 'challenger' as const : 'target' as const };
}
