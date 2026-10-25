import { useEffect, useId, useRef } from 'react';
import {
  centerIndex,
  clampPos,
  DRUM_HEIGHT,
  DRUM_ITEM_HEIGHT,
  DRUM_SNAP_MS,
  drumRowLook,
  easeOutCubic,
  flingTarget,
  snapDuration,
  tapTarget,
  wheelSteps,
} from '../drumMath';

/** Видимых строк: окно 200 / строка 40 (tdesktop `_itemsVisible.count`), для PageUp/PageDown. */
const VISIBLE = Math.ceil(DRUM_HEIGHT / DRUM_ITEM_HEIGHT);
/** Сдвиг пальцем/мышью меньше этого — щелчок, не перетаскивание, px. */
const DRAG_SLOP = 4;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Барабан выбора — одно колесо (19.10, #226; общий компонент, первый потребитель — «Своё время» таймера самоуничтожения,
 * `OnceTimerMenu`). Повторяет tdesktop `ui/widgets/vertical_drum_picker.cpp` + `ui/boxes/time_picker_box.cpp`: окно 200 px,
 * строка 40, крайние строки гаснут и сжимаются, две линии вокруг выбранной; колесо мыши — по строке за щелчок (трекпад — плавно
 * и доводка при затихании), перетаскивание с броском и доводкой к ближайшей строке, щелчок по строке — прыжок к ней, ↑ ↓ ← →
 * по строке, PageUp/PageDown на экран, Home/End, Enter — `onSubmit`. Esc не трогаем — его ловит хозяин (меню/окно).
 * Положение — в строках (дробное), рисуется напрямую в DOM (без перерисовок React на каждый кадр); `onChange` — только при смене
 * строки по центру. Неуправляемый: стартовая строка `initial`.
 */
export function DrumPicker({
  items,
  initial,
  onChange,
  onSubmit,
  label,
  autoFocus = false,
}: {
  items: readonly string[];
  initial: number;
  onChange?: (index: number) => void;
  onSubmit?: () => void;
  label: string;
  /** Фокус на барабан при показе — клавиши и Enter работают сразу. */
  autoFocus?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const n = items.length;
  const pos = useRef(clampPos(initial, n));
  /** Куда идёт барабан: серия шагов колеса/клавиш считается от цели, а не от середины пути. */
  const goal = useRef(pos.current);
  const anim = useRef(0);
  const last = useRef(centerIndex(pos.current, n));
  const cb = useRef({ onChange, onSubmit });
  cb.current = { onChange, onSubmit };
  const id = useId();

  const paint = () => {
    const p = pos.current;
    const c = centerIndex(p, n);
    for (let i = 0; i < n; i++) {
      const el = rows.current[i];
      if (!el) continue;
      const look = drumRowLook(i, p);
      if (look.opacity <= 0.001) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.opacity = String(look.opacity);
      el.style.transform = `translateY(${(look.offset + (DRUM_HEIGHT - DRUM_ITEM_HEIGHT) / 2).toFixed(2)}px) scaleY(${look.scale.toFixed(3)})`;
      el.setAttribute('aria-selected', i === c ? 'true' : 'false');
    }
    if (c !== last.current) {
      last.current = c;
      cb.current.onChange?.(c);
    }
    root.current?.setAttribute('aria-activedescendant', `${id}-${c}`);
  };

  const stop = () => {
    if (anim.current) cancelAnimationFrame(anim.current);
    anim.current = 0;
  };
  const animateTo = (to: number, ms?: number) => {
    stop();
    const target = clampPos(to, n);
    const from = pos.current;
    if (reducedMotion() || from === target) {
      pos.current = target;
      paint();
      return;
    }
    const dur = ms ?? snapDuration(from, target);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      pos.current = from + (target - from) * easeOutCubic(t);
      paint();
      anim.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    anim.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    paint();
    if (autoFocus) root.current?.focus({ preventScroll: true });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let acc = 0;
    let idle = 0;
    // Колесо — слушателем без `passive`: страницу под барабаном (и меню) крутить не даём.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dy = e.deltaMode === 1 ? e.deltaY * DRUM_ITEM_HEIGHT : e.deltaMode === 2 ? e.deltaY * DRUM_HEIGHT : e.deltaY;
      // Мышь: щелчки по 100 → строка за щелчок. Трекпад: мелкие дельты ведут барабан плавно, при затишье — доводка к строке.
      if (Math.abs(dy) >= 50 || e.deltaMode !== 0) {
        acc += dy;
        const { steps, rest } = wheelSteps(acc);
        acc = rest;
        if (steps !== 0) {
          goal.current = clampPos(Math.round(goal.current) + steps, n);
          animateTo(goal.current);
        }
      } else {
        stop();
        pos.current = clampPos(pos.current + dy / DRUM_ITEM_HEIGHT, n);
        goal.current = pos.current;
        paint();
        window.clearTimeout(idle);
        idle = window.setTimeout(() => {
          goal.current = Math.round(pos.current);
          animateTo(goal.current, DRUM_SNAP_MS);
        }, 120);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  const drag = useRef<{ id: number; y: number; lastY: number; moved: boolean; samples: { t: number; p: number }[] } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    stop();
    goal.current = pos.current;
    drag.current = { id: e.pointerId, y: e.clientY, lastY: e.clientY, moved: false, samples: [{ t: e.timeStamp, p: pos.current }] };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < DRAG_SLOP) return;
    d.moved = true;
    // Вниз по экрану — к меньшим номерам: содержимое идёт за пальцем (tdesktop `handleMouseEvent`).
    pos.current = clampPos(pos.current - (e.clientY - d.lastY) / DRUM_ITEM_HEIGHT, n);
    d.lastY = e.clientY;
    d.samples.push({ t: e.timeStamp, p: pos.current });
    if (d.samples.length > 6) d.samples.shift();
    goal.current = pos.current;
    paint();
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) {
      if (cancelled) return;
      const r = e.currentTarget.getBoundingClientRect();
      goal.current = tapTarget(pos.current, e.clientY - r.top, DRUM_ITEM_HEIGHT, DRUM_HEIGHT, n);
      animateTo(goal.current);
      return;
    }
    const a = d.samples[0]!;
    const b = d.samples[d.samples.length - 1]!;
    const dt = b.t - a.t;
    // Бросок — только если палец двигался прямо перед отпусканием; иначе просто доводка к ближайшей строке.
    const v = !cancelled && e.timeStamp - b.t < 80 && dt > 0 ? ((b.p - a.p) / dt) * 1000 : 0;
    goal.current = flingTarget(pos.current, v, n);
    animateTo(goal.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const move = (by: number) => {
      e.preventDefault();
      goal.current = clampPos(Math.round(goal.current) + by, n);
      animateTo(goal.current);
    };
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(1);
    else if (e.key === 'PageUp') move(-VISIBLE);
    else if (e.key === 'PageDown') move(VISIBLE);
    else if (e.key === 'Home') move(-n);
    else if (e.key === 'End') move(n);
    else if (e.key === 'Enter') {
      e.preventDefault();
      cb.current.onSubmit?.();
    }
  };

  return (
    <div
      ref={root}
      className="drum"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      style={{ height: DRUM_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onKeyDown={onKeyDown}
    >
      <span className="drum-line top" aria-hidden="true" />
      <span className="drum-line bottom" aria-hidden="true" />
      {items.map((t, i) => (
        <div
          key={i}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === centerIndex(pos.current, n)}
          className="drum-row"
          ref={(el) => {
            rows.current[i] = el;
          }}
          style={{ height: DRUM_ITEM_HEIGHT }}
        >
          {t}
        </div>
      ))}
    </div>
  );
}
