import { useEffect, useRef } from 'react';
import { backLeavesPane, setBackGestureSink, TOP_LAYERS } from './androidBack';
import {
  PREDICTIVE_BACK_CANCEL_MS,
  PREDICTIVE_BACK_COMMIT_MS,
  PREDICTIVE_BACK_EASE,
  PREDICTIVE_BACK_OVERSHOOT_PX,
  predictiveBackOriginX,
  predictiveBackScale,
  swipeBackCommit,
  swipeBackIntent,
  swipeBackOffset,
} from './swipeBack';

/** Где жест не начинаем: поля ввода, ползунки, окна и меню поверх, просмотр фото, всё, что отметило себя само. */
const BLOCK = `input, textarea, select, [contenteditable="true"], [role="slider"], [data-no-swipe-back], ${TOP_LAYERS}`;
/** Время ухода и возврата слоя, мс (Android `animateBackEndAnimation`: 200). */
const ANIM_MS = 200;

/** Вид под пальцем (или его предок до слоя), который можно крутить горизонтально ВЛЕВО — жест ему, а не «назад». */
function scrollsLeft(from: Element | null, stop: Element): boolean {
  for (let el: Element | null = from; el && el !== stop.parentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ox = getComputedStyle(el).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && el.scrollLeft > 0) return true;
  }
  return false;
}

/**
 * Телефон, экран беседы: свайп вправо по любому месту слоя `.content` уводит его за пальцем и по отпусканию вызывает `onBack`
 * (то же, что стрелка «назад»). Правила — `swipeBack.ts`. Слушатели на `document` (касания внутри ленты не трогаем, ленте
 * ничего не подменяем); `touchmove` — не пассивный, чтобы ведомый жест не прокручивал страницу.
 * Здесь же — приёмник системного жеста «назад» Android 14+ (`setBackGestureSink`): тот же слой сжимается за ходом жеста
 * и уходит вправо по отпусканию (правила Telegram — `swipeBack.ts`), шаг «назад» после ухода делает `androidBack`.
 */
export function useSwipeBack(enabled: boolean, onBack: () => void): void {
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    let layer: HTMLElement | null = null;
    let sx = 0;
    let sy = 0;
    let state: 'idle' | 'wait' | 'track' | 'other' = 'idle';
    let samples: Array<{ t: number; x: number }> = [];
    let busy = false;
    // Предиктивная «назад» Android 14+ (G16): системный жест от края ведёт этот же слой (`swipeBack.ts`, правила Telegram).
    let pred = false;
    // Стрелка «назад» шапки живёт рядом со слоем (`.app > .mobile-back`), а не в нём — при жесте её ведём вместе со слоем.
    let back: HTMLElement | null = null;
    let scale = 1;
    let commit: { timer: number; done?: () => void } | null = null;

    const reset = () => {
      state = 'idle';
      samples = [];
    };
    const clear = () => {
      if (back) {
        back.style.transform = '';
        back.style.transition = '';
        back.style.transformOrigin = '';
        back = null;
      }
      if (!layer) return;
      layer.style.transform = '';
      layer.style.transition = '';
      layer.style.boxShadow = '';
      layer.style.transformOrigin = '';
      layer = null;
    };
    const onStart = (e: TouchEvent) => {
      reset();
      if (busy || pred || e.touches.length !== 1) return;
      const target = e.target instanceof Element ? e.target : null;
      const host = target?.closest<HTMLElement>('.app > .content');
      if (!target || !host || target.closest(BLOCK) || scrollsLeft(target, host)) return;
      layer = host;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      state = 'wait';
      samples = [{ t: e.timeStamp, x: sx }];
    };
    const onMove = (e: TouchEvent) => {
      if (pred || state === 'idle' || state === 'other' || !layer) return;
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (state === 'wait') {
        const intent = swipeBackIntent(dx, dy);
        if (intent === 'other') {
          state = 'other';
          layer = null;
          return;
        }
        if (intent === 'track') {
          state = 'track';
          // Клавиатура уходит, как у Android (`hideKeyboard` в `onBeginSlide`).
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          layer.style.transition = 'none';
          layer.style.boxShadow = '-8px 0 24px rgba(0, 0, 0, 0.25)';
        }
      }
      if (state === 'track') {
        if (e.cancelable) e.preventDefault();
        layer.style.transform = `translateX(${swipeBackOffset(dx, window.innerWidth)}px)`;
        samples.push({ t: e.timeStamp, x: t.clientX });
        if (samples.length > 6) samples.shift();
      }
    };
    const onEnd = (e: TouchEvent) => {
      const was = state;
      const host = layer;
      if (was !== 'track' || !host) {
        reset();
        // Системный жест от края забирает касание у страницы (`touchcancel`/`touchend`) — его слой не трогаем.
        if (!pred) layer = null;
        return;
      }
      const x = e.changedTouches[0]?.clientX ?? sx;
      const dx = x - sx;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const velocity = first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
      reset();
      busy = true;
      const done = swipeBackCommit(dx, velocity, window.innerWidth);
      host.style.transition = `transform ${ANIM_MS}ms ease-out`;
      host.style.transform = `translateX(${done ? window.innerWidth : 0}px)`;
      window.setTimeout(() => {
        // Слой убран (или вернулся): стили снимаем и только потом идём назад — экран списка сам займёт место.
        clear();
        busy = false;
        if (done) backRef.current();
      }, ANIM_MS);
    };
    const onCancel = () => {
      if (state === 'track' && layer) {
        const host = layer;
        host.style.transition = `transform ${ANIM_MS}ms ease-out`;
        host.style.transform = 'translateX(0px)';
        window.setTimeout(() => {
          if (layer === host) clear();
        }, ANIM_MS);
      } else if (!pred) layer = null;
      reset();
    };

    /** Слой и стрелка — одним преобразованием (у каждого своя опора, сведённая к одной точке экрана). */
    const paint = (transform: string, transition?: string) => {
      for (const el of [layer, back]) {
        if (!el) continue;
        if (transition !== undefined) el.style.transition = transition;
        el.style.transform = transform;
      }
    };
    const offSink = setBackGestureSink((phase, progress, edge, y, done) => {
      if (phase === 'start') {
        pred = false;
        // Жест ведём, только если «назад» сейчас = уход из беседы; меню, листы, правка закрываются без анимации (как у Telegram).
        if (busy || state === 'track' || !backLeavesPane()) return false;
        const host = document.querySelector<HTMLElement>('.app > .content');
        if (!host) return false;
        reset(); // касание, начатое у края, страница уже не ведёт — жест системный
        layer = host;
        pred = true;
        scale = 1;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const ox = predictiveBackOriginX(edge, window.innerWidth);
        const oy = y > 0 ? y : window.innerHeight / 2;
        host.style.transition = 'none';
        host.style.boxShadow = '-8px 0 24px rgba(0, 0, 0, 0.25)';
        host.style.transformOrigin = `${ox}px ${oy}px`;
        back = document.querySelector<HTMLElement>('.app > .mobile-back');
        if (back) {
          const r = back.getBoundingClientRect();
          back.style.transition = 'none';
          back.style.transformOrigin = `${ox - r.left}px ${oy - r.top}px`;
        }
        paint('scale(1)', 'none');
        return false;
      }
      if (!pred || !layer) return false;
      const host = layer;
      if (phase === 'progress') {
        scale = predictiveBackScale(progress);
        paint(`scale(${scale})`);
        return false;
      }
      pred = false;
      busy = true;
      if (phase === 'cancel') {
        paint('scale(1)', `transform ${PREDICTIVE_BACK_CANCEL_MS}ms ${PREDICTIVE_BACK_EASE}`);
        window.setTimeout(() => {
          if (layer === host) clear();
          busy = false;
        }, PREDICTIVE_BACK_CANCEL_MS);
        return false;
      }
      // invoked: экран уходит за правый край, потом — тот же шаг «назад», что у кнопки (`done` → `stepBack`).
      paint(
        `translateX(${window.innerWidth + PREDICTIVE_BACK_OVERSHOOT_PX}px) scale(${scale})`,
        `transform ${PREDICTIVE_BACK_COMMIT_MS}ms ${PREDICTIVE_BACK_EASE}`,
      );
      const timer = window.setTimeout(() => {
        commit = null;
        clear();
        busy = false;
        done?.();
      }, PREDICTIVE_BACK_COMMIT_MS);
      commit = { timer, done };
      return true;
    });

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      offSink();
      // Ушли раньше конца ухода — шаг «назад» всё равно делаем (иначе `androidBack` ждал бы его вечно).
      const pending = commit;
      commit = null;
      if (pending) window.clearTimeout(pending.timer);
      clear();
      pending?.done?.();
    };
  }, [enabled]);
}
