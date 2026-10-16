import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { moveStageKey, stageDropIndex } from './stageOrderRules';

/**
 * Перетаскивание плиток сетки сцены (12.10, только ПК-раскладка, только мышь/перо) — как значки на
 * рабочем столе Android-оболочки: удержание поднимает плитку, она ездит за указателем, соседи
 * расступаются, на месте плитки — «гнездо», отпускание сажает её в гнездо.
 *
 * Плитки помечены `data-stage-key`; события ловятся на самой сетке (делегирование), поэтому
 * `StageTile` / `StreamCard` о перетаскивании не знают. Всё, что двигается на каждом кадре, пишется в
 * DOM напрямую (inline `transform` + атрибут `data-drag`), React перерисовывает сетку только при
 * перестановке. Плитки ни один из компонентов не размонтирует: ключи React стабильны, `<video>`
 * переезжает вместе со своим узлом.
 */

/**
 * Удержание до подъёма. 16.10 решение владельца: 0,5 с вместо 2 с (две секунды держать мышь — долго
 * и ненадёжно; порядок долгого нажатия у Telegram и Android — 0,25–0,5 с, `tg-src/codemap/selection-gestures.md`).
 */
export const STAGE_DRAG_HOLD_MS = 500;
/**
 * С этого момента удержания плитка показывает, что сейчас поднимется. 150 мс: обычный клик мышью
 * короче (кнопку держат ~0,1 с), поэтому на простом клике по карточке показа подсказка не мигает,
 * а при удержании поджатие идёт оставшиеся 350 мс до подъёма — видно, что жест «взялся». Прежние
 * 300 мс при удержании 0,5 с оставили бы на поджатие 0,2 с — мигание, а не подсказку. Длительность
 * поджатия в CSS (`[data-drag='pressing']`) = `STAGE_DRAG_HOLD_MS − STAGE_DRAG_HINT_MS`.
 */
export const STAGE_DRAG_HINT_MS = 150;
/**
 * Сдвиг до подъёма больше этого — это не удержание (выделение, прокрутка, промах).
 *
 * 🔴 16.10: было 6 px — и живьём жест не срабатывал ВООБЩЕ. Две секунды (тогдашнее удержание) держать мышь неподвижно с
 * точностью 6 px нельзя: само нажатие кнопки и дрожь руки сдвигают курсор игровой мыши (высокий DPI,
 * масштаб Windows 125–150 %) на 5–15 px. Удержание молча гасло к ~0,7 с, а отпускание на карточке
 * показа срабатывало обычным кликом и ОТКРЫВАЛО показ: сетка «под окно» уходила в режим просмотра,
 * где перетаскивания нет, — «таскать нельзя даже плитки людей». Замерено на стенде (дрожь ±5 px:
 * `pressing` снят на 686 мс, после отпускания `voice-stage watching`). Порог берём с запасом под
 * дрожь, но заметно меньше самой узкой плитки (156 px), чтобы осознанный увод курсора всё ещё
 * отменял удержание.
 */
export const STAGE_DRAG_SLOP_PX = 16;
/** Сколько центр поднятой плитки должен пробыть над чужой ячейкой, чтобы соседи расступились. */
export const STAGE_DRAG_DWELL_MS = 100;
/** Переезд соседей и посадка в гнездо. */
export const STAGE_DRAG_ANIM_MS = 200;
/** Масштаб поднятой плитки. */
export const STAGE_DRAG_LIFT_SCALE = 1.06;
/**
 * Автопрокрутка у края (16.10, решение владельца): поднятую плитку подвели к краю прокручиваемого
 * контейнера (полоса людей в несколько рядов, полоса карточек, сетка с переполнением) — контейнер едет
 * сам, и плитку можно поставить на место, которого не было видно. Зона у края, экранные px; у тесного
 * контейнера — не больше четверти его размера, иначе полоса высотой в одну плитку ехала бы от любого
 * движения.
 */
export const STAGE_DRAG_EDGE_PX = 48;
/** Предельная скорость автопрокрутки, px за кадр: у самого края (и за ним), к границе зоны — к нулю. */
export const STAGE_DRAG_EDGE_SPEED_PX = 12;

/**
 * Шаг автопрокрутки по одной оси: `pos` — указатель, `[start, end)` — видимый край контейнера (экранные px).
 * Вне зоны — 0; в зоне скорость растёт линейно к краю до `max`, за краем — `max`; не меньше 1 px, чтобы
 * у самой границы зоны прокрутка не «стояла». Знак — направление (к началу отрицательный).
 */
export function stageEdgeScrollStep(pos: number, start: number, end: number, zone: number, max: number): number {
  const size = end - start;
  const z = Math.min(zone, size / 4);
  if (!(z > 0) || !(max > 0)) return 0;
  const toStart = pos - start;
  const toEnd = end - pos;
  const speed = (d: number) => Math.max(1, Math.round(max * Math.min(1, (z - Math.max(0, d)) / z)));
  if (toStart < z && toStart <= toEnd) return -speed(toStart);
  if (toEnd < z) return speed(toEnd);
  return 0;
}

const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)';

type Phase = 'hold' | 'drag';
type Session = {
  key: string;
  el: HTMLElement;
  pointerId: number;
  phase: Phase;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Сколько экранных px в одном px раскладки (зум корня и т. п.). */
  k: number;
  slot0: { x: number; y: number };
  /** Прокрутка контейнера в момент подъёма: прокрутили под поднятой плиткой — она остаётся под указателем. */
  scroll0: { x: number; y: number };
  grabX: number;
  grabY: number;
  hintTimer: number | null;
  liftTimer: number | null;
  dwellTimer: number | null;
  dwellIndex: number | null;
  raf: number | null;
  /** Кадр автопрокрутки у края (`STAGE_DRAG_EDGE_PX`). */
  edgeRaf: number | null;
  /**
   * Края, в зоне которых указатель был уже в момент подъёма: от них не едем, пока указатель из зоны не
   * выйдет — иначе плитка, взятая за нижнюю подпись в полосе высотой в одну плитку, тут же уезжала бы вниз.
   */
  edgeHeld: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  /**
   * Предел прокрутки, снятый в момент подъёма. 🔴 Живой `scrollHeight` брать нельзя: сдвинутая `transform`
   * поднятая плитка сама расширяет прокручиваемую область, и автопрокрутка уезжала за содержимое без конца
   * (замер на стенде: предел рос 144 → 292 → 700 px за секунду у края).
   */
  scrollMax: { x: number; y: number };
  detach: () => void;
};

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function tilesOf(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-stage-key]'));
}

function keyOf(el: HTMLElement): string {
  return el.dataset.stageKey ?? '';
}

/** Экранных px на px раскладки — по самой сетке (у неё transform нет). */
function scaleOf(grid: HTMLElement): number {
  const w = grid.offsetWidth;
  const k = w > 0 ? grid.getBoundingClientRect().width / w : 1;
  return k > 0 && Number.isFinite(k) ? k : 1;
}

/** Клик сразу после перетаскивания не должен открывать «Смотреть» / что-то ещё. */
function swallowNextClick(untilUp: boolean): void {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, true);
  const remove = () => {
    window.removeEventListener('click', stop, true);
    window.removeEventListener('pointerup', onUp, true);
    window.clearTimeout(fallback);
  };
  // Кнопку ещё держат (отмена по Esc) — снимаем после её отпускания; иначе — после текущего события.
  const onUp = () => window.setTimeout(remove, 0);
  const fallback = window.setTimeout(remove, untilUp ? 10_000 : 0);
  if (untilUp) window.addEventListener('pointerup', onUp, true);
}

export function useStageDrag({
  enabled,
  gridRef,
  order,
  onCommit,
}: {
  enabled: boolean;
  gridRef: RefObject<HTMLDivElement | null>;
  /** Порядок, который сейчас показан (с учётом `preview`) — чтобы знать, жива ли поднятая плитка. */
  order: readonly string[];
  /** Отпустили поднятую плитку: показанный порядок целиком. */
  onCommit: (order: string[]) => void;
}) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const session = useRef<Session | null>(null);
  const nestRef = useRef<HTMLDivElement>(null);
  const flipFirst = useRef<Map<string, DOMRect> | null>(null);
  const flipToken = useRef(new WeakMap<HTMLElement, number>());
  const settling = useRef(new Set<HTMLElement>());
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const snapshotRects = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const map = new Map<string, DOMRect>();
    for (const el of tilesOf(grid)) map.set(keyOf(el), el.getBoundingClientRect());
    flipFirst.current = map;
  }, [gridRef]);

  /** Поставить поднятую плитку под указатель и гнездо — на её ячейку. */
  const placeLifted = useCallback(() => {
    const s = session.current;
    const grid = gridRef.current;
    if (!s || s.phase !== 'drag' || !grid) return;
    const el = s.el;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let cx = s.slot0.x + (s.lastX - s.grabX) / s.k + (grid.scrollLeft - s.scroll0.x) + w / 2;
    let cy = s.slot0.y + (s.lastY - s.grabY) / s.k + (grid.scrollTop - s.scroll0.y) + h / 2;
    // Держим поднятую плитку в видимой области контейнера: у него `overflow`, край её срезал бы.
    // Полоса людей в режиме просмотра ровно в одну плитку высотой (16.10) — увеличенная туда не
    // влезает, и тогда держим в пределах хотя бы обычного размера: плитка идёт вдоль ряда, а не
    // уезжает вверх-вниз под срез.
    const clamp = (c: number, half: number, full: number, start: number, size: number) => {
      const lim = size > 2 * half ? half : size >= full ? full / 2 : null;
      return lim === null ? c : Math.min(Math.max(c, start + lim), start + size - lim);
    };
    cx = clamp(cx, (w * STAGE_DRAG_LIFT_SCALE) / 2, w, grid.scrollLeft, grid.clientWidth);
    cy = clamp(cy, (h * STAGE_DRAG_LIFT_SCALE) / 2, h, grid.scrollTop, grid.clientHeight);
    const dx = cx - w / 2 - el.offsetLeft;
    const dy = cy - h / 2 - el.offsetTop;
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${STAGE_DRAG_LIFT_SCALE})`;
    const nest = nestRef.current;
    if (nest) {
      nest.style.left = `${el.offsetLeft}px`;
      nest.style.top = `${el.offsetTop}px`;
      nest.style.width = `${w}px`;
      nest.style.height = `${h}px`;
      nest.style.borderRadius = getComputedStyle(el).borderRadius;
    }
    return { cx, cy };
  }, [gridRef]);

  const clearTimers = (s: Session) => {
    if (s.hintTimer !== null) window.clearTimeout(s.hintTimer);
    if (s.liftTimer !== null) window.clearTimeout(s.liftTimer);
    if (s.dwellTimer !== null) window.clearTimeout(s.dwellTimer);
    if (s.raf !== null) window.cancelAnimationFrame(s.raf);
    if (s.edgeRaf !== null) window.cancelAnimationFrame(s.edgeRaf);
    s.hintTimer = s.liftTimer = s.dwellTimer = s.raf = s.edgeRaf = null;
  };

  /** Закончить сессию: снять слушатели, таймеры и пометки сетки. Плитку не трогает. */
  const endSession = useCallback(() => {
    const s = session.current;
    if (!s) return;
    clearTimers(s);
    s.detach();
    session.current = null;
    const grid = gridRef.current;
    if (grid) delete grid.dataset.dragging;
  }, [gridRef]);

  /** Удержание оборвалось до подъёма: плитка возвращается как была, клик остаётся обычным. */
  const abortHold = useCallback(() => {
    const s = session.current;
    if (!s || s.phase !== 'hold') return;
    if (s.el.dataset.drag === 'pressing') delete s.el.dataset.drag;
    endSession();
  }, [endSession]);

  /** Отпустили или отменили поднятую плитку: перестановка (или откат) + посадка в гнездо. */
  const finish = useCallback(
    (commit: boolean, buttonStillDown: boolean) => {
      const s = session.current;
      const grid = gridRef.current;
      if (!s || s.phase !== 'drag') return;
      const el = s.el;
      const finalOrder = grid ? tilesOf(grid).map(keyOf) : [];
      snapshotRects();
      endSession();
      el.dataset.drag = 'settling';
      settling.current.add(el);
      swallowNextClick(buttonStillDown);
      setDragging(false);
      setPreview(null);
      if (commit && finalOrder.length > 0) commitRef.current(finalOrder);
    },
    [endSession, gridRef, snapshotRects],
  );

  const lift = useCallback(() => {
    const s = session.current;
    const grid = gridRef.current;
    if (!s || s.phase !== 'hold' || !grid) return;
    const el = s.el;
    el.style.transition = 'none';
    delete el.dataset.drag;
    el.style.transform = '';
    void el.offsetWidth;
    s.k = scaleOf(grid);
    s.slot0 = { x: el.offsetLeft, y: el.offsetTop };
    s.scroll0 = { x: grid.scrollLeft, y: grid.scrollTop };
    s.scrollMax = { x: Math.max(0, grid.scrollWidth - grid.clientWidth), y: Math.max(0, grid.scrollHeight - grid.clientHeight) };
    {
      const r = grid.getBoundingClientRect();
      const held = (pos: number, a: number, b: number) =>
        Math.sign(stageEdgeScrollStep(pos, a, b, STAGE_DRAG_EDGE_PX, STAGE_DRAG_EDGE_SPEED_PX)) as -1 | 0 | 1;
      s.edgeHeld = { x: held(s.lastX, r.left, r.right), y: held(s.lastY, r.top, r.bottom) };
    }
    s.grabX = s.lastX;
    s.grabY = s.lastY;
    s.phase = 'drag';
    el.dataset.drag = 'lifted';
    grid.dataset.dragging = '1';
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* выделения нет — и ладно */
    }
    if (!reducedMotion()) {
      // Короткий «подскок» при подъёме, дальше плитка идёт за указателем без запаздывания.
      el.style.transition = `transform ${STAGE_DRAG_ANIM_MS}ms ${EASE_OUT}, box-shadow ${STAGE_DRAG_ANIM_MS}ms ${EASE_OUT}`;
      window.setTimeout(() => {
        if (session.current?.el === el && session.current.phase === 'drag') el.style.transition = 'none';
      }, STAGE_DRAG_ANIM_MS);
    }
    placeLifted();
    setDragging(true);
  }, [gridRef, placeLifted]);

  /** Центр поднятой плитки над другой ячейкой — после задержки переставляем. */
  const trackTarget = useCallback(
    (center: { cx: number; cy: number }) => {
      const s = session.current;
      const grid = gridRef.current;
      if (!s || !grid) return;
      const els = tilesOf(grid);
      const slots = els.map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
      const idx = stageDropIndex({ x: center.cx, y: center.cy }, slots);
      const current = els.indexOf(s.el);
      if (idx === null || idx === current) {
        if (s.dwellTimer !== null) window.clearTimeout(s.dwellTimer);
        s.dwellTimer = null;
        s.dwellIndex = null;
        return;
      }
      if (s.dwellIndex === idx) return;
      if (s.dwellTimer !== null) window.clearTimeout(s.dwellTimer);
      s.dwellIndex = idx;
      s.dwellTimer = window.setTimeout(() => {
        const now = session.current;
        const g = gridRef.current;
        if (!now || now.phase !== 'drag' || !g) return;
        now.dwellTimer = null;
        now.dwellIndex = null;
        const keys = tilesOf(g).map(keyOf);
        const next = moveStageKey(keys, now.key, idx);
        snapshotRects();
        setPreview(next);
      }, STAGE_DRAG_DWELL_MS);
    },
    [gridRef, snapshotRects],
  );

  /** Скорость автопрокрутки по осям, где у контейнера есть куда ехать (с учётом «удержанных» краёв). */
  const edgeVelocity = useCallback(
    (s: Session, grid: HTMLElement) => {
      const r = grid.getBoundingClientRect();
      const axis = (pos: number, a: number, b: number, scroll: number, max: number, held: -1 | 0 | 1) => {
        if (max <= 0) return { v: 0, held: 0 as const };
        const raw = stageEdgeScrollStep(pos, a, b, STAGE_DRAG_EDGE_PX, STAGE_DRAG_EDGE_SPEED_PX);
        const dir = Math.sign(raw) as -1 | 0 | 1;
        // Вышли из зоны удержанного края — он снова работает.
        const nextHeld = dir === held ? held : 0;
        if (dir === 0 || dir === nextHeld) return { v: 0, held: nextHeld };
        // Упёрлись — ехать некуда.
        if ((dir < 0 && scroll <= 0) || (dir > 0 && scroll >= max)) return { v: 0, held: nextHeld };
        return { v: raw, held: nextHeld };
      };
      const x = axis(s.lastX, r.left, r.right, grid.scrollLeft, s.scrollMax.x, s.edgeHeld.x);
      const y = axis(s.lastY, r.top, r.bottom, grid.scrollTop, s.scrollMax.y, s.edgeHeld.y);
      s.edgeHeld = { x: x.held, y: y.held };
      return { vx: x.v, vy: y.v };
    },
    [],
  );

  /** Запустить автопрокрутку, если указатель у края; кадр сам гаснет, когда ехать перестало. */
  const edgeScroll = useCallback(() => {
    const s = session.current;
    const grid = gridRef.current;
    if (!s || s.phase !== 'drag' || !grid || s.edgeRaf !== null) return;
    const { vx, vy } = edgeVelocity(s, grid);
    if (vx === 0 && vy === 0) return;
    const step = () => {
      const now = session.current;
      const g = gridRef.current;
      if (!now || now !== s || now.phase !== 'drag' || !g) return;
      now.edgeRaf = null;
      const v = edgeVelocity(now, g);
      if (v.vx === 0 && v.vy === 0) return;
      if (v.vx !== 0) g.scrollLeft = Math.min(Math.max(g.scrollLeft + v.vx, 0), now.scrollMax.x);
      if (v.vy !== 0) g.scrollTop = Math.min(Math.max(g.scrollTop + v.vy, 0), now.scrollMax.y);
      // Плитку и цель — сразу в этом кадре (событие `scroll` придёт позже и ничего не испортит).
      const c = placeLifted();
      if (c) trackTarget(c);
      now.edgeRaf = window.requestAnimationFrame(step);
    };
    s.edgeRaf = window.requestAnimationFrame(step);
  }, [gridRef, edgeVelocity, placeLifted, trackTarget]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const grid = gridRef.current;
      if (!enabled || !grid || session.current) return;
      // Во весь экран (показ развёрнут) переставлять нечего — и поднимать полноэкранный узел нельзя.
      if (grid.ownerDocument.fullscreenElement) return;
      if (e.button !== 0 || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
      const target = e.target as Element;
      const el = target.closest<HTMLElement>('[data-stage-key]');
      if (!el || el.parentElement !== grid) return;
      // Кнопки внутри плитки («Развернуть камеру» и т. п.) остаются кнопками.
      const control = target.closest('button, a, input, textarea, select, [role="slider"]');
      if (control && control !== el) return;
      const onMove = (ev: PointerEvent) => {
        const s = session.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        s.lastX = ev.clientX;
        s.lastY = ev.clientY;
        const outside = ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
        if (s.phase === 'hold') {
          if (outside || Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) > STAGE_DRAG_SLOP_PX) abortHold();
          return;
        }
        if (outside) {
          finish(false, true);
          return;
        }
        edgeScroll();
        if (s.raf !== null) return;
        s.raf = window.requestAnimationFrame(() => {
          const now = session.current;
          if (!now) return;
          now.raf = null;
          const c = placeLifted();
          if (c) trackTarget(c);
        });
      };
      const onUp = (ev: PointerEvent) => {
        const s = session.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        if (s.phase === 'hold') abortHold();
        else finish(true, false);
      };
      const onCancel = (ev: PointerEvent) => {
        const s = session.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        if (s.phase === 'hold') abortHold();
        else finish(false, false);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        const s = session.current;
        if (!s) return;
        if (s.phase === 'hold') {
          abortHold();
          return;
        }
        // Esc тратится на отмену перетаскивания — меню/окна под ним закрываться не должны.
        ev.preventDefault();
        ev.stopPropagation();
        finish(false, true);
      };
      const onBlur = () => {
        const s = session.current;
        if (!s) return;
        if (s.phase === 'hold') abortHold();
        else finish(false, true);
      };
      // Картинка аватарки и текст не должны уехать родным перетаскиванием / выделением браузера.
      const block = (ev: Event) => ev.preventDefault();
      // Колесо под поднятой плиткой прокручивает полосу — плитку переставить под указатель.
      const onScroll = () => {
        const s = session.current;
        if (!s || s.phase !== 'drag' || s.raf !== null) return;
        s.raf = window.requestAnimationFrame(() => {
          const now = session.current;
          if (!now) return;
          now.raf = null;
          const c = placeLifted();
          if (c) trackTarget(c);
        });
      };
      grid.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onBlur);
      window.addEventListener('dragstart', block, true);
      window.addEventListener('selectstart', block, true);
      const s: Session = {
        key: keyOf(el),
        el,
        pointerId: e.pointerId,
        phase: 'hold',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        k: 1,
        slot0: { x: 0, y: 0 },
        scroll0: { x: 0, y: 0 },
        grabX: e.clientX,
        grabY: e.clientY,
        hintTimer: null,
        liftTimer: null,
        dwellTimer: null,
        dwellIndex: null,
        raf: null,
        edgeRaf: null,
        edgeHeld: { x: 0, y: 0 },
        scrollMax: { x: 0, y: 0 },
        detach: () => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onCancel, true);
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('blur', onBlur);
          window.removeEventListener('dragstart', block, true);
          window.removeEventListener('selectstart', block, true);
          grid.removeEventListener('scroll', onScroll);
        },
      };
      session.current = s;
      s.hintTimer = window.setTimeout(() => {
        if (session.current === s && s.phase === 'hold') {
          s.el.style.transition = '';
          s.el.dataset.drag = 'pressing';
        }
      }, STAGE_DRAG_HINT_MS);
      s.liftTimer = window.setTimeout(() => {
        if (session.current === s) lift();
      }, STAGE_DRAG_HOLD_MS);
    },
    [enabled, gridRef, abortHold, finish, lift, placeLifted, trackTarget, edgeScroll],
  );

  // FLIP: после перестановки соседи едут со старых мест на новые; посадка поднятой — тем же путём.
  useLayoutEffect(() => {
    const first = flipFirst.current;
    const grid = gridRef.current;
    flipFirst.current = null;
    const s = session.current;
    if (s?.phase === 'drag') placeLifted();
    if (!first || !grid) return;
    const els = tilesOf(grid).filter((el) => !(s?.phase === 'drag' && el === s.el));
    const motion = !reducedMotion();
    const k = scaleOf(grid);
    for (const el of els) {
      el.style.transition = 'none';
      el.style.transform = '';
    }
    const moved: HTMLElement[] = [];
    if (motion) {
      const lasts = els.map((el) => el.getBoundingClientRect());
      els.forEach((el, i) => {
        const f = first.get(keyOf(el));
        const l = lasts[i];
        if (!f || l.width <= 0) return;
        const dx = (f.left + f.width / 2 - (l.left + l.width / 2)) / k;
        const dy = (f.top + f.height / 2 - (l.top + l.height / 2)) / k;
        const sc = f.width / l.width;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sc - 1) < 0.005) return;
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${sc})`;
        moved.push(el);
      });
      void grid.offsetWidth;
    }
    for (const el of moved) {
      el.style.transition = `transform ${STAGE_DRAG_ANIM_MS}ms ${EASE_OUT}, box-shadow ${STAGE_DRAG_ANIM_MS}ms ${EASE_OUT}`;
      el.style.transform = '';
    }
    const done = new Set(els.filter((el) => !moved.includes(el)));
    for (const el of moved) {
      const token = (flipToken.current.get(el) ?? 0) + 1;
      flipToken.current.set(el, token);
      window.setTimeout(() => {
        if (flipToken.current.get(el) !== token) return;
        el.style.transition = '';
        if (settling.current.delete(el) && el.dataset.drag === 'settling') delete el.dataset.drag;
      }, STAGE_DRAG_ANIM_MS + 40);
    }
    for (const el of done) {
      el.style.transition = '';
      if (settling.current.delete(el) && el.dataset.drag === 'settling') delete el.dataset.drag;
    }
  });

  // Поднятая плитка ушла из канала / сетка выключилась (чаевые, просмотр) — отмена без сохранения.
  const orderKey = order.join('\n');
  useEffect(() => {
    const s = session.current;
    if (!s) return;
    if (!enabled || !order.includes(s.key) || !s.el.isConnected) {
      if (s.phase === 'hold') abortHold();
      else finish(false, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, orderKey]);

  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      clearTimers(s);
      s.detach();
      session.current = null;
    },
    [],
  );

  return { preview, dragging, nestRef, onPointerDown };
}
