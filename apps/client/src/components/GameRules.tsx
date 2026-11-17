import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GAME_RULES, type RulesGame } from '../gameRules';

function RuleArt({ icon }: { icon: (typeof GAME_RULES)[RulesGame][number]['icon'] }) {
  const titles = { dice: 'Игральные кости', twentyone: 'Две кости и цель 21', hands: 'Знаки игроков', clock: 'Время хода', coins: 'Монеты и ставка', wheel: 'Пиратское колесо', flag: 'Флаг победы', chest: 'Сундук с сокровищами' };
  return <svg className={`game-rules__art game-rules__art--${icon}`} viewBox="0 0 64 64" role="img" aria-label={titles[icon]}>
    <title>{titles[icon]}</title>
    <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {icon === 'dice' && <><rect x="7" y="19" width="25" height="25" rx="5"/><rect x="32" y="11" width="25" height="25" rx="5"/><circle cx="15" cy="27" r="1.5" fill="currentColor"/><circle cx="24" cy="36" r="1.5" fill="currentColor"/><circle cx="40" cy="19" r="1.5" fill="currentColor"/><circle cx="49" cy="28" r="1.5" fill="currentColor"/></>}
      {icon === 'twentyone' && <><rect x="5" y="25" width="22" height="22" rx="4"/><rect x="30" y="25" width="22" height="22" rx="4"/><circle cx="12" cy="32" r="1.3" fill="currentColor"/><circle cx="20" cy="40" r="1.3" fill="currentColor"/><circle cx="37" cy="32" r="1.3" fill="currentColor"/><circle cx="41" cy="36" r="1.3" fill="currentColor"/><circle cx="45" cy="40" r="1.3" fill="currentColor"/><path d="M22 12c0-6 10-6 10 0 0 3-10 7-10 10h10M39 10l4-3v15m-4 0h8"/></>}
      {icon === 'hands' && <><path d="M9 40l8-14 9 5-7 13zM55 40l-8-14-9 5 7 13zM26 31l6-4 6 4M20 44l8 5h8l8-5"/><path d="M25 36l7 5 7-5"/></>}
      {icon === 'clock' && <><circle cx="32" cy="34" r="19"/><path d="M32 22v13l9 5M26 8h12M32 8v7"/></>}
      {icon === 'coins' && <><circle cx="23" cy="35" r="15"/><circle cx="41" cy="28" r="15"/><path d="M40 20v16m-4-12h7m-7 8h7M17 35h8"/></>}
      {icon === 'wheel' && <><circle cx="32" cy="34" r="21"/><circle cx="32" cy="34" r="4"/><path d="M32 13v17m0 8v17M11 34h17m8 0h17M17 19l12 12m6 6l12 12m0-30L35 31m-6 6L17 49M27 7h10l-5 7z"/></>}
      {icon === 'flag' && <><path d="M16 55V10m0 2c13-8 19 8 32 0v23c-13 8-19-8-32 0M10 55h17"/><path d="M29 20l2 4 5 .5-3.5 3.5 1 5-4.5-2.5-4.5 2.5 1-5-3.5-3.5 5-.5z"/></>}
      {icon === 'chest' && <><path d="M10 29h44v23H10zM10 29a22 17 0 0144 0M10 37h44M27 34h10v10H27zM18 19v10m28-10v10"/></>}
    </g>
  </svg>;
}

export function GameRules({ game, onOpen, children }: { game: RulesGame; onOpen?: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const steps = GAME_RULES[game];
  const gameTitle = { dice: 'Кости', rps: 'Камень, ножницы, бумага', greedy: 'Жадина', wheel: 'Колесо', prediction: 'Прогнозы', twentyone: '21' }[game];

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      } else if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialogRef.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      triggerRef.current?.focus();
    };
  }, [open]);

  return <>
    <button ref={triggerRef} type="button" className="ew-btn game-rules-trigger" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (!open) { setOpen(true); onOpen?.(); } }}>
      Правила игры
    </button>
    {open && createPortal(
      <div className="game-rules-overlay" onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) setOpen(false); }}>
        <div ref={dialogRef} className="game-rules-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <h2 id={titleId}>Правила: {gameTitle}</h2>
          <div className="game-rules-dialog__body">
            {steps.length ? <ol className="game-rules__steps">{steps.map((step) => <li className="game-rules__step" key={step.title}>
              <RuleArt icon={step.icon}/><div className="game-rules__copy"><strong>{step.title}</strong><p>{step.text}</p></div>
            </li>)}</ol> : <p className="game-rules__pending">Правила этой игры готовятся.</p>}
            {children && <section className="game-rules-dialog__extra">{children}</section>}
          </div>
          <button ref={closeRef} type="button" className="ew-btn ew-btn-main game-rules-dialog__close" onClick={() => setOpen(false)}>Понятно</button>
        </div>
      </div>,
      document.body,
    )}
  </>;
}

export default GameRules;
