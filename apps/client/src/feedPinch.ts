/**
 * Щипок по фото прямо в ленте (G43, VA-21 / GA-18, телефон): двумя пальцами по картинке в ленте — копия фото вырастает ПОВЕРХ
 * чата вслед за пальцами, отпустили любой палец — она за 220 мс возвращается на место. Как `PinchToZoomHelper` у Telegram для
 * Android; просмотр (`Lightbox`) не открывается. Правила и цифры — `pinchRules.ts`; здесь только касания и слой.
 *
 * Что увеличивается: картинка вложения `img.att-img` в ленте (`.messages`) с уже загруженным кадром. Стикеры, видео, файлы,
 * голосовые — не `img.att-img`, и жеста у них нет (в списке исключений Telegram те же). Оба пальца должны лечь на ОДНУ картинку.
 * Пока два пальца на фото, браузер их не листает и не масштабирует (`touchmove` не пассивный и гасится), а CSS-правило
 * «Щипок по фото» в `styles.css` отнимает у картинки `pinch-zoom` из `touch-action`.
 */
import { pinchDistance, pinchScale, pinchStarted, pinchTransform, PINCH_FINISH_EASING, PINCH_FINISH_MS } from './pinchRules';

type Pinch = {
  img: HTMLImageElement;
  id1: number;
  id2: number;
  dist: number;
  cx: number;
  cy: number;
  layer: HTMLImageElement | null;
  rect: DOMRect | null;
};

/** Слой запущен — следующий `click` (палец, оставшийся на фото, мог бы открыть просмотр) гасим на короткое время. */
const SWALLOW_CLICK_MS = 400;

/**
 * Повесить жест на ленту. `onStart` — зовётся, когда на фото легли два пальца: долгое нажатие и свайп первого пальца к этому
 * моменту уже не нужны. Возвращает снятие слушателей и слоя.
 */
export function attachFeedPinch(list: HTMLElement, onStart?: () => void): () => void {
  let p: Pinch | null = null;
  let finishing: HTMLImageElement | null = null;
  let finishTimer = 0;

  const photoOf = (t: Touch): HTMLImageElement | null => {
    const el = t.target instanceof Element ? t.target.closest<HTMLImageElement>('img.att-img') : null;
    return el && list.contains(el) && el.complete && el.naturalWidth > 0 ? el : null;
  };

  const dropLayer = (layer: HTMLImageElement | null) => {
    layer?.remove();
    if (finishing === layer) finishing = null;
    window.clearTimeout(finishTimer);
  };

  const makeLayer = (cur: Pinch, a: Touch, b: Touch) => {
    const r = cur.img.getBoundingClientRect();
    const layer = document.createElement('img');
    layer.className = 'gv-pinch-layer';
    layer.src = cur.img.currentSrc || cur.img.src;
    layer.alt = '';
    const cs = getComputedStyle(cur.img);
    let radius = cs.borderRadius;
    // Фото одно во весь пузырь — скругление даёт пузырь (`overflow: hidden`), а не сама картинка.
    const bubble = cur.img.closest<HTMLElement>('.bubble');
    if (bubble && parseFloat(radius) === 0) {
      const br = bubble.getBoundingClientRect();
      if (Math.abs(br.width - r.width) < 2 && Math.abs(br.height - r.height) < 2) radius = getComputedStyle(bubble).borderRadius;
    }
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    Object.assign(layer.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      objectFit: cs.objectFit,
      borderRadius: radius,
      transformOrigin: `${cx - r.left}px ${cy - r.top}px`,
    });
    document.body.appendChild(layer);
    cur.layer = layer;
    cur.rect = r;
    // Расстояние и центр отсчитываются от момента появления слоя: слой начинает с масштаба 1 и без рывка (как у Telegram).
    cur.dist = pinchDistance(a.clientX, a.clientY, b.clientX, b.clientY);
    cur.cx = cx;
    cur.cy = cy;
  };

  const finish = () => {
    const cur = p;
    p = null;
    const layer = cur?.layer;
    if (!layer) return;
    // Палец, оставшийся на фото, при отпускании мог бы «нажать» её и открыть просмотр.
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', stop, true);
    window.setTimeout(() => window.removeEventListener('click', stop, true), SWALLOW_CLICK_MS);
    finishing = layer;
    layer.style.transition = `transform ${PINCH_FINISH_MS}ms ${PINCH_FINISH_EASING}`;
    layer.style.transform = pinchTransform(1, 0, 0);
    layer.addEventListener('transitionend', () => dropLayer(layer), { once: true });
    // Страховка: переход не пришёл (вкладка скрыта) — слой всё равно уходит.
    finishTimer = window.setTimeout(() => dropLayer(layer), PINCH_FINISH_MS + 120);
  };

  const find = (l: TouchList | undefined, id: number): Touch | undefined => (l ? Array.from(l).find((t) => t.identifier === id) : undefined);

  const onTouchStart = (ev: TouchEvent) => {
    if (p || ev.touches?.length !== 2) return;
    const [a, b] = [ev.touches[0], ev.touches[1]];
    const img = photoOf(a);
    if (!img || photoOf(b) !== img) return;
    // Слой прошлого щипка ещё возвращается на место — новый жест его не ждёт.
    if (finishing) dropLayer(finishing);
    onStart?.();
    p = {
      img,
      id1: a.identifier,
      id2: b.identifier,
      dist: pinchDistance(a.clientX, a.clientY, b.clientX, b.clientY),
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
      layer: null,
      rect: null,
    };
  };

  const onTouchMove = (ev: TouchEvent) => {
    const cur = p;
    if (!cur) return;
    const a = find(ev.touches, cur.id1);
    const b = find(ev.touches, cur.id2);
    if (!a || !b) {
      finish();
      return;
    }
    if (ev.cancelable) ev.preventDefault();
    const dist = pinchDistance(a.clientX, a.clientY, b.clientX, b.clientY);
    if (!cur.layer) {
      if (!pinchStarted(dist / cur.dist)) return;
      makeLayer(cur, a, b);
      return;
    }
    const s = pinchScale(dist, cur.dist);
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    cur.layer.style.transform = pinchTransform(s, cx - cur.cx, cy - cur.cy);
  };

  const onTouchEnd = (ev: TouchEvent) => {
    const cur = p;
    if (!cur) return;
    // Лёг ли поверх ещё чей-то палец — жест живёт, пока на экране оба своих.
    if (find(ev.touches, cur.id1) && find(ev.touches, cur.id2)) return;
    finish();
  };

  list.addEventListener('touchstart', onTouchStart, { passive: true });
  list.addEventListener('touchmove', onTouchMove, { passive: false });
  list.addEventListener('touchend', onTouchEnd, { passive: true });
  list.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return () => {
    list.removeEventListener('touchstart', onTouchStart);
    list.removeEventListener('touchmove', onTouchMove);
    list.removeEventListener('touchend', onTouchEnd);
    list.removeEventListener('touchcancel', onTouchEnd);
    p = null;
    dropLayer(finishing);
    document.querySelectorAll('.gv-pinch-layer').forEach((n) => n.remove());
  };
}
