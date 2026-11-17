import { useEffect, useId, useRef, useState } from 'react';
import type { DuelDto, DuelSide } from '@gusvoice/shared';
import judgeUrl from '../assets/duel/judge.png';
import { playSound } from '../sounds';
import { useStore } from '../store';
import {
  advanceTwentyOnePresentation, createTwentyOnePresentation, syncTwentyOnePresentation,
  twentyOneCanMove, twentyOneNextAt, twentyOneRollLabel,
} from '../twentyOnePresentation';
import { Die, Duelist } from './DuelArt';

export interface TwentyOneBoardProps {
  duel: DuelDto;
  mySide: DuelSide | null;
  people: (id: string) => { name: string; avatar: string | null };
  phone: boolean;
  busy: boolean;
  onMove: (move: 'roll' | 'stop') => void;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function TwentyOneBoard({ duel: d, mySide, people, phone, busy, onMove }: TwentyOneBoardProps) {
  const g = d.twentyOne!;
  const reduced = useReducedMotion();
  const statusId = useId();
  const [frame, setFrame] = useState(() => ({
    dto: g, id: d.id, state: d.state, reduced, presentation: createTwentyOnePresentation(d),
  }));
  // Согласуем до вывода JSX: ни одного кадра с новым authoritative-счётом до анимации,
  // либо с прежними числами после установки маски/смены id.
  let current = frame;
  if (frame.dto !== g || frame.id !== d.id || frame.state !== d.state || frame.reduced !== reduced) {
    current = { dto: g, id: d.id, state: d.state, reduced,
      presentation: syncTwentyOnePresentation(frame.presentation, d, Date.now(), reduced) };
    setFrame(current);
  }
  const p = current.presentation;
  const pending = useRef<string | null>(null);
  const moveKey = `${d.id}:${g.seq}`;
  if (pending.current !== moveKey) pending.current = null;
  const deadline = twentyOneNextAt(p);
  useEffect(() => {
    if (deadline === null) return;
    let timer: number;
    const tick = () => {
      const now = Date.now();
      // Раннее пробуждение таймера/коррекция часов не оставляют фазу без следующего тика.
      if (now < deadline) { timer = window.setTimeout(tick, deadline - now); return; }
      setFrame(f => ({ ...f, presentation: advanceTwentyOnePresentation(f.presentation, now, f.reduced) }));
    };
    timer = window.setTimeout(tick, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline, p.id]);
  const sounded = useRef<string | null>(null);
  const soundKey = p.active ? `${p.id}:${p.active.key}` : null;
  useEffect(() => {
    if (!soundKey || sounded.current === soundKey || reduced || document.hidden) return;
    sounded.current = soundKey;
    if (!useStore.getState().selfDeafened) playSound('diceRoll');
  }, [soundKey, reduced]);

  const animating = p.active !== null;
  const playing = d.state === 'playing' && !g.finished;
  const canMove = twentyOneCanMove(d, mySide, busy, p);
  const canStop = twentyOneCanMove(d, mySide, busy, p, 'stop');
  const send = (move: 'roll' | 'stop') => {
    if (document.hidden || pending.current === moveKey || !twentyOneCanMove(d, mySide, busy, p, move)) return;
    pending.current = moveKey;
    try { onMove(move); } finally { void Promise.resolve().then(() => { if (pending.current === moveKey) pending.current = null; }); }
  };
  const status = animating ? 'Показываем бросок…'
    : d.state === 'settled' || g.finished ? 'Обе попытки завершены'
    : !playing ? 'Ожидаем начала партии'
    : !mySide ? 'Ты наблюдаешь за партией'
    : busy ? 'Отправляем ход…'
    : g.standing[mySide] ? 'Твоя попытка завершена · ждём соперника'
    : g.turn !== mySide ? 'Ход соперника'
    : g.started?.[mySide] === false ? 'Твой ход · брось 2 стартовых кубика' : 'Твой ход · ещё кубик или стоп';

  const player = (side: DuelSide) => {
    const id = side === 'challenger' ? d.challengerId : d.targetId;
    const who = people(id);
    // Проверяем и текущий DTO: даже до синхронизации состояния маска не отдаёт числа в DOM/aria.
    const hidden = !!g.hidden?.[side];
    const shown = p.shown[side];
    const total = hidden ? null : shown.total;
    const a = !hidden && p.active?.side === side ? p.active : null;
    const won = d.state === 'settled' && !animating && d.winnerId === id;
    const lost = d.state === 'settled' && !animating && !!d.winnerId && !won;
    const wait = hidden ? (g.standing[side] ? 'Стоп · очки скрыты' : 'Очки скрыты до итога')
      : a ? (a.phase === 'rolling' ? (a.dice ? 'Бросает 2 кубика…' : 'Бросает кубик…') : 'Прибавляем очки…')
      : total !== null && total > 21 ? 'Перебор'
      : total === 21 ? 'Ровно 21!'
      : g.standing[side] ? 'Стоп'
      : playing && g.turn === side ? 'Принимает решение' : 'Ждёт хода';
    return <div className={`dc-player twentyone-player${side === mySide ? ' me' : ''}${won ? ' won' : ''}${lost ? ' lost' : ''}${hidden ? ' secret' : ''}${total !== null && total > 21 ? ' bust' : ''}`}>
      <Duelist side={side} who={who} phone={phone} mine={side === mySide} won={won} lost={lost} />
      <span className="dc-name" title={who.name}>{who.name}{side === mySide ? ' (ты)' : ''}</span>
      <strong className="twentyone-total">
        <span className="twentyone-score-number">{total ?? '?'}</span>
        <small> / 21</small>
        <span className="twentyone-score-delta-slot" aria-hidden="true">
          <span className={`twentyone-score-delta${a && a.phase !== 'rolling' ? ` twentyone-delta-${a.phase}` : ''}`}>
            {a && a.phase !== 'rolling' ? `+${a.die}` : ''}
          </span>
        </span>
      </strong>
      <span className="dc-wait">{wait}</span>
      <span className="dc-dice twentyone-dice" aria-label={hidden ? 'Кубики скрыты' : shown.die === null ? 'Кубики ещё не брошены'
        : a?.phase === 'rolling' ? 'Кубики крутятся' : shown.dice ? `Стартовые кубики: ${shown.dice.join(' и ')}` : `Последний кубик: ${shown.die}`}>
        {[0, 1].map(i => {
          const dice = shown.dice ?? [shown.die];
          const visible = hidden || shown.die === null || i < dice.length;
          return <span key={i} className={`twentyone-die-slot${visible ? '' : ' empty'}`} aria-hidden={!visible}>
            <Die v={hidden ? null : dice[i] ?? null} rolling={visible && a?.phase === 'rolling' && !reduced} />
          </span>;
        })}
      </span>
    </div>;
  };
  return <div className="dc-board twentyone-board">
    <div className="rps-phase"><b>{d.state === 'settled' ? 'Партия завершена' : '21 без перебора'}</b><span>{g.finished ? 'Обе попытки завершены' : 'Добор по очереди · ближе к 21 без перебора'}</span></div>
    <div className="dc-arena">
      {player('challenger')}
      <div className="dc-judge">
        <img src={judgeUrl} alt="Судья — зелёный попугай" draggable={false} />
        <span className="dc-vs">до 21 без перебора</span>
      </div>
      {player('target')}
    </div>
    <div className="dc-turn-controls">
      <p id={statusId} className="dc-move-status" role="status">{status}</p>
      <div className="gr-actions twentyone-actions">
        <button type="button" className="ew-btn ew-btn-main" disabled={!canMove} aria-disabled={!canMove}
          aria-describedby={statusId} onClick={() => send('roll')}>{twentyOneRollLabel(d, mySide)}</button>
        <button type="button" className="ew-btn" disabled={!canStop} aria-disabled={!canStop}
          aria-describedby={statusId} onClick={() => send('stop')}>Стоп</button>
      </div>
    </div>
  </div>;
}

export default TwentyOneBoard;
