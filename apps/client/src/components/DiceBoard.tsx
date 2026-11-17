import { useEffect, useRef, useState } from 'react';
import { DUEL_MAX_REROLLS, DUEL_ROLL_ANIM_MS, DUEL_ROLL_TURN_MS, duelOutcome, type DuelDto, type DuelSide } from '@gusvoice/shared';
import judgeUrl from '../assets/duel/judge.png';
import { advanceDicePresentation, createDicePresentation, diceNextAt, diceRoundResult, syncDicePresentation } from '../dicePresentation';
import { duelLeftMs, hasRolled } from '../duelRules';
import { playSound } from '../sounds';
import { useStore } from '../store';
import { CountRing } from './Duel';
import { Die, Duelist } from './DuelArt';

export function DiceBoard({ duel: d, mySide, people, phone, busy, now, skew, stateNote, onRoll }: {
  duel: DuelDto; mySide: DuelSide | null; people: (id: string) => { name: string; avatar: string | null };
  phone: boolean; busy: boolean; now: number; skew: number; stateNote: string; onRoll: () => void;
}) {
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [frame, setFrame] = useState(() => ({ dto: d, reduced, p: createDicePresentation(d) }));
  let current = frame;
  if (frame.dto !== d || frame.reduced !== reduced) {
    current = { dto: d, reduced, p: syncDicePresentation(frame.p, d, Date.now(), reduced) };
    setFrame(current);
  }
  const p = current.p, at = Date.now();
  const deadline = diceNextAt(p, at);
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setTimeout(() => setFrame(f => ({ ...f, p: advanceDicePresentation(f.p, Date.now()) })), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline, p.id]);
  const sound = useRef({ id: p.id, seen: p.seen });
  const soundKey = p.seen.join('|');
  useEffect(() => {
    const fresh = sound.current.id === p.id && p.seen.some(key => !sound.current.seen.includes(key));
    if (fresh && !reduced && !useStore.getState().selfDeafened) playSound('diceRoll');
    sound.current = { id: p.id, seen: p.seen };
  }, [soundKey, p.id]);

  const target = d.diceTarget ?? 1;
  const revealing = !!p.active && at < p.active.at + DUEL_ROLL_ANIM_MS;
  const index = p.active?.index ?? d.rollNo;
  const last = d.rolls.reduce((index, r, i) => r.challenger && r.target ? i : index, -1);
  const result = diceRoundResult(d, p.active?.index ?? last);
  const countForScore = p.active ? p.active.index + (revealing ? 0 : 1) : d.rolls.length;
  const rolls = d.rolls.slice(0, countForScore).flatMap(r => r.challenger && r.target ? [[...r.challenger, ...r.target] as [number, number, number, number]] : []);
  const score = duelOutcome(rolls, target).wins;
  const name = (side: DuelSide) => side === mySide ? 'Ты' : people(side === 'challenger' ? d.challengerId : d.targetId).name;
  const resultTitle = d.state === 'cancelled' && !result ? 'Партия отменена' : !result ? 'Кто наберёт больше — выиграет бросок'
    : revealing ? `Бросок ${result.index + 1} · кубики катятся…`
    : !result.winner ? `Бросок ${result.index + 1} · ничья`
    : `Бросок ${result.index + 1} · ${result.winner === mySide ? 'ты победил' : `победил ${name(result.winner)}`}`;
  const resultDetail = d.state === 'cancelled' ? stateNote : !result ? `Нужно выиграть ${target === 1 ? 'один бросок' : 'два броска'}, чтобы забрать партию`
    : revealing ? 'Сравним суммы после остановки кубиков'
    : `${result.challenger} ${result.winner === 'challenger' ? '>' : result.winner === 'target' ? '<' : '='} ${result.target} · ${result.winner ? '+1 победа' : result.index + 1 >= 2 * target - 1 + DUEL_MAX_REROLLS ? 'без очка · лимит бросков' : 'без очка, бросаем ещё'}`;
  const canRoll = !busy && d.state === 'playing' && !!mySide && !hasRolled(d, mySide) && !p.active
    && !(p.animations[`${d.rollNo}:${mySide}`] > at);
  const status = p.active ? revealing ? 'Показываем бросок…' : d.state === 'settled' ? 'Партия завершена' : 'Следующий бросок через пару секунд'
    : d.state === 'settled' ? d.reason === 'draw-limit' ? 'Лимит бросков · партия без победителя' : 'Партия завершена' : d.state !== 'playing' ? stateNote
    : !mySide ? 'Наблюдаешь за партией' : busy ? 'Отправляем бросок…'
    : hasRolled(d, mySide) ? 'Бросок принят · ждём соперника' : `Бросок ${d.rollNo + 1} · твой ход`;
  const player = (side: DuelSide) => {
    const id = side === 'challenger' ? d.challengerId : d.targetId, who = people(id), mine = side === mySide;
    const pair = d.rolls[index]?.[side] ?? null;
    // У каждой стороны свой срок анимации. Общая фаза сравнения не бросает уже показанные кости повторно.
    const rolling = (p.animations[`${index}:${side}`] ?? 0) > at;
    const roundWon = !!result && !revealing && p.active !== null && result.winner === side;
    const won = d.state === 'settled' && !revealing && d.winnerId === id;
    const lost = d.state === 'settled' && !revealing && !!d.winnerId && !won;
    return <div className={`dc-player dice-player${mine ? ' me' : ''}${won ? ' won' : ''}${lost ? ' lost' : ''}${roundWon ? ' dice-round-won' : ''}`}>
      <Duelist side={side} who={who} phone={phone} mine={mine} won={won} lost={lost} />
      <span className="dc-name" title={who.name}>{who.name}{mine ? ' (ты)' : ''}</span>
      <span className="dice-victories" aria-label={`${who.name}: побед ${score[side]} из ${target}`}>
        <span>Победы</span><span className="dice-win-marks" aria-hidden="true">{Array.from({ length: target }, (_, i) => <i key={i} className={i < score[side] ? 'on' : ''}>★</i>)}</span><b>{score[side]}/{target}</b>
      </span>
      <span className="dc-dice" aria-label={rolling ? 'Кубики крутятся' : pair ? `Кубики: ${pair[0]} и ${pair[1]}` : 'Кубики ещё не брошены'}>
        <Die key={`${index}:a`} v={pair?.[0] ?? null} rolling={rolling} /><Die key={`${index}:b`} v={pair?.[1] ?? null} rolling={rolling} />
      </span>
      <span className="dc-sum">{pair && !rolling ? `Сумма: ${pair[0] + pair[1]}` : 'Сумма: —'}</span>
    </div>;
  };
  return <div className="dc-board dice-board">
    <div className="rps-phase dice-phase"><b>Партия до {target} побед{target === 1 ? 'ы' : ''}</b><span>{p.active ? `Итог броска ${index + 1}` : d.state === 'settled' ? 'Партия завершена' : `Бросок ${d.rollNo + 1} · каждому по два кубика`}</span></div>
    <div className="dc-arena">{player('challenger')}<div className="dc-judge"><img src={judgeUrl} alt="Судья — зелёный попугай" draggable={false} /><span className="rps-score" aria-label="Счёт побед в партии">{score.challenger} : {score.target}</span><span className="dc-vs">ПОБЕДЫ</span></div>{player('target')}</div>
    <div className={`dice-round-result${result && !revealing ? result.winner ? ' decisive' : ' tied' : ''}`} role="status"><b>{resultTitle}</b><span>{resultDetail}</span></div>
    <div className="dc-turn-controls"><p className="dc-move-status">{status}</p><div className="gr-actions"><button type="button" className="ew-btn ew-btn-main dc-roll" disabled={!canRoll} onClick={() => { if (canRoll) onRoll(); }}><CountRing leftMs={d.state === 'playing' ? duelLeftMs(d.turnUntil, skew, now) : 0} totalMs={DUEL_ROLL_TURN_MS} size={24} />Бросить</button></div></div>
  </div>;
}
