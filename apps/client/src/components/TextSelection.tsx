/**
 * Выделение текста пальцем в ленте (#211, Telegram 2.02 / 4.34). Пункт «Выделить текст» меню сообщения (телефон) выделяет текст:
 * подсветка, два маркера (тянутся пальцем) и панель «Копировать · Цитировать · Выделить всё». Удержание пальцем — в любом
 * месте пузыря, и по тексту, — выделение сообщения или меню (решение 37, 08.10; решает лента, `MessagePane.startLongPress`).
 * `wordSelAt` (слово под пальцем) оставлено (мог бы пригодиться двойному тапу), сейчас не вызывается.
 *
 * Выделение СВОЁ, не браузерное: строки ленты на телефоне остаются `user-select: none` (иначе системное долгое нажатие
 * WebView выделяло бы текст само и рисовало своё меню поверх нашего). Подсветка — CSS Custom Highlight API
 * (`::highlight(gv-tsel)`, Chromium 105+): DOM-выделения нет, и ни системные маркеры, ни системная панель не появляются;
 * без этого API — полупрозрачные прямоугольники поверх текста. Правила отрезка (слово, порядок концов, «всё ли
 * выделено») — `textSelRules.ts`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushBackHandler } from '../androidBack';
import { orderedRange, selectsAll, snapOffset, wordBounds } from '../textSelRules';

/** Что выделено: тело сообщения (`.message-body`) и отрезок его текста. */
export type TextSel = { body: HTMLElement; start: number; end: number };

/** Не текст сообщения: время и «изм.» внутри тела, нераскрытый спойлер (его текст скрыт). */
const SKIP = '.bub-meta, .ts, .edited, .spoiler:not(.open)';
/** Палец «на тексте» — в пределах 8 px от символа (у Telegram — 8 dp). */
const SLOP = 8;
const HL = 'gv-tsel';

/** Текстовые узлы тела по порядку — кроме времени и скрытого. */
export function textNodes(body: Element): Text[] {
  const out: Text[] = [];
  const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const skip = n.parentElement?.closest(SKIP);
    if (skip && body.contains(skip)) continue;
    if ((n as Text).data) out.push(n as Text);
  }
  return out;
}

const joined = (nodes: readonly Text[]) => nodes.map((n) => n.data).join('');

/** Смещение в склеенном тексте → узел и смещение в нём. */
function locate(nodes: readonly Text[], off: number): [Text, number] {
  let base = 0;
  for (const n of nodes) {
    if (off <= base + n.data.length) return [n, off - base];
    base += n.data.length;
  }
  const last = nodes[nodes.length - 1];
  return [last, last.data.length];
}

function rangeFor(nodes: readonly Text[], start: number, end: number): Range | null {
  if (!nodes.length) return null;
  const r = document.createRange();
  const [a, ao] = locate(nodes, start);
  const [b, bo] = locate(nodes, end);
  r.setStart(a, ao);
  r.setEnd(b, bo);
  return r;
}

/** Ближайший к точке символ: сначала по строке (`dy`), потом вдоль неё (`dx`); `after` — точка правее середины символа. */
function nearest(nodes: readonly Text[], x: number, y: number) {
  let best: { i: number; dx: number; dy: number; after: boolean } | null = null;
  const r = document.createRange();
  let base = 0;
  for (const n of nodes) {
    // Узел целиком дальше лучшего найденного по вертикали — посимвольно не смотрим.
    r.selectNodeContents(n);
    const nb = r.getBoundingClientRect();
    const ndy = Math.max(0, nb.top - y, y - nb.bottom);
    if (!best || ndy <= best.dy) {
      for (let k = 0; k < n.data.length; k++) {
        if (n.data[k] === '\n') continue;
        r.setStart(n, k);
        r.setEnd(n, k + 1);
        const b = r.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        const dx = Math.max(0, b.left - x, x - b.right);
        const dy = Math.max(0, b.top - y, y - b.bottom);
        if (!best || dy < best.dy || (dy === best.dy && dx < best.dx))
          best = { i: base + k, dx, dy, after: x > (b.left + b.right) / 2 };
      }
    }
    base += n.data.length;
  }
  return best;
}

/**
 * Удержание в точке `x, y` тела сообщения: палец на тексте — выделение слова под ним; мимо текста (поля пузыря, время,
 * пустое место строки) — `null`, и лента делает прежнее.
 */
export function wordSelAt(body: HTMLElement, x: number, y: number): TextSel | null {
  const nodes = textNodes(body);
  const hit = nearest(nodes, x, y);
  if (!hit || hit.dx > SLOP || hit.dy > SLOP) return null;
  const text = joined(nodes);
  if (!text.trim()) return null;
  const [start, end] = wordBounds(text, hit.i);
  return { body, start, end };
}

/**
 * Весь текст тела сообщения — выделение по пункту меню «Выделить текст» (решение 37 владельца 08.10: удержание выделяет
 * сообщение, как Telegram Android, а текст — из меню). `null` — текста нет (одни вложения).
 */
export function allTextSel(body: HTMLElement): TextSel | null {
  const text = joined(textNodes(body));
  return text.trim() ? { body, start: 0, end: text.length } : null;
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Прямоугольники строк выделения (без пустых). */
function lineRects(range: Range): Box[] {
  return [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
}

type Props = {
  sel: TextSel;
  onChange: (sel: TextSel) => void;
  onClose: () => void;
  onCopy: (text: string) => void;
  /**
   * «Цитировать» (G55, `quote1`; Telegram Android — панель «Копировать · Цитировать · Перевести · Выделить всё»): выделенный
   * текст и его начало в тексте пузыря. Нет — кнопки нет.
   */
  onQuote?: (text: string, start: number) => void;
};

/**
 * Подсветка, маркеры и панель выделенного текста. Живёт порталом в `body`, следит за прокруткой ленты. Тап мимо (в ленте)
 * снимает выделение и до строки не доходит — ни меню, ни свайпа, ни быстрой реакции; прокрутка выделение не снимает.
 * Касание вне ленты (шапка, поле ввода) снимает выделение и делает своё.
 */
export function TextSelLayer({ sel, onChange, onClose, onCopy, onQuote }: Props) {
  const [, setTick] = useState(0);
  const cb = useRef({ onChange, onClose });
  cb.current = { onChange, onClose };
  const selRef = useRef(sel);
  selRef.current = sel;
  const barRef = useRef<HTMLDivElement>(null);
  const nodes = textNodes(sel.body);
  const text = joined(nodes);
  const range = rangeFor(nodes, sel.start, sel.end);
  const rects = range ? lineRects(range) : [];
  const hasApi = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  useLayoutEffect(() => {
    if (!hasApi || !range) return;
    CSS.highlights.set(HL, new Highlight(range));
    return () => {
      CSS.highlights.delete(HL);
    };
  }, [sel.body, sel.start, sel.end, text, hasApi]); // eslint-disable-line react-hooks/exhaustive-deps

  // Прокрутка, поворот, клавиатура: перерисовать по новому месту текста; строку убрали (удалили, сменили беседу) — снять.
  useEffect(() => {
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!selRef.current.body.isConnected) cb.current.onClose();
        else setTick((t) => t + 1);
      });
    };
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
      window.visualViewport?.removeEventListener('resize', on);
    };
  }, []);

  // «Назад» Android снимает выделение, а не уводит из беседы.
  useEffect(
    () =>
      pushBackHandler(() => {
        cb.current.onClose();
        return true;
      }),
    [],
  );

  // Тап мимо снимает выделение. Касание, которое выделение открыло, ещё не кончилось — его `touchend` без нашего
  // `touchstart` и не считается.
  useEffect(() => {
    let down: { x: number; y: number; moved: boolean } | null = null;
    const mine = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tsel-bar, .tsel-handle');
    const start = (e: TouchEvent) => {
      if (mine(e.target)) return;
      const inFeed = e.target instanceof Element && !!e.target.closest('.messages');
      if (!inFeed || e.touches.length > 1) {
        down = null;
        cb.current.onClose();
        return;
      }
      // До строки касание не доходит: ни долгого нажатия, ни свайпа, ни двойного тапа. Прокрутка — своя, браузерная.
      e.stopPropagation();
      down = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
    };
    const move = (e: TouchEvent) => {
      if (!down || !e.touches[0]) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - down.x) > 10 || Math.abs(t.clientY - down.y) > 10) down.moved = true;
    };
    const end = (e: TouchEvent) => {
      if (!down) return;
      const tap = !down.moved && e.type === 'touchend';
      down = null;
      if (!tap) return;
      // Тап — не клик по строке: браузер не синтезирует `click`, а запасной глоток ловит, если всё же синтезирует.
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const eat = (c: Event) => {
        c.preventDefault();
        c.stopPropagation();
      };
      window.addEventListener('click', eat, true);
      window.setTimeout(() => window.removeEventListener('click', eat, true), 500);
      cb.current.onClose();
    };
    const mouse = (e: MouseEvent) => {
      if (!mine(e.target)) cb.current.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current.onClose();
    };
    window.addEventListener('touchstart', start, { capture: true, passive: true });
    window.addEventListener('touchmove', move, { capture: true, passive: true });
    window.addEventListener('touchend', end, { capture: true, passive: false });
    window.addEventListener('touchcancel', end, true);
    window.addEventListener('mousedown', mouse, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('touchstart', start, true);
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', end, true);
      window.removeEventListener('touchcancel', end, true);
      window.removeEventListener('mousedown', mouse, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  /* Маркер тянут пальцем: конец выделения — символ под точкой на строке над маркером (смещение пальца от строки
     запоминаем на касании). Перетянули за другой маркер — роли меняются. */
  function grab(which: 'start' | 'end', e: React.TouchEvent) {
    e.stopPropagation();
    const t0 = e.touches[0];
    if (!t0) return;
    const box = which === 'start' ? rects[0] : rects[rects.length - 1];
    const dy = box ? t0.clientY - (box.top + box.bottom) / 2 : 0;
    let side = which;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    const apply = () => {
      raf = 0;
      if (!last) return;
      const cur = selRef.current;
      const ns = textNodes(cur.body);
      const all = joined(ns);
      const hit = nearest(ns, last.x, last.y - dy);
      if (!hit) return;
      const caret = snapOffset(all, hit.after ? hit.i + 1 : hit.i, hit.after);
      const fixed = side === 'start' ? cur.end : cur.start;
      if (side === 'start' && caret > fixed) side = 'end';
      else if (side === 'end' && caret < fixed) side = 'start';
      const [s, en] = orderedRange(caret, fixed, all.length);
      if (s !== cur.start || en !== cur.end) cb.current.onChange({ body: cur.body, start: s, end: en });
    };
    const move = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      if (ev.cancelable) ev.preventDefault();
      last = { x: t.clientX, y: t.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = (ev: TouchEvent) => {
      if (ev.cancelable) ev.preventDefault();
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', up, true);
      window.removeEventListener('touchcancel', up, true);
      if (raf) cancelAnimationFrame(raf);
      apply();
    };
    window.addEventListener('touchmove', move, { capture: true, passive: false });
    window.addEventListener('touchend', up, { capture: true, passive: false });
    window.addEventListener('touchcancel', up, true);
  }

  // Панель — над первой строкой выделения; не помещается под шапкой ленты — под последней (ниже маркеров). По ширине —
  // по середине выделения, в пределах экрана.
  const feed = sel.body.closest('.messages')?.getBoundingClientRect();
  const top = feed?.top ?? 0;
  const bottom = feed?.bottom ?? window.innerHeight;
  const first = rects[0];
  const lastBox = rects[rects.length - 1];
  const visible = (b: Box | undefined) => !!b && b.bottom > top && b.top < bottom;
  const anyVisible = rects.some(visible);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !rects.length) return;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const left = Math.min(...rects.map((b) => b.left));
    const right = Math.max(...rects.map((b) => b.right));
    const x = Math.max(8, Math.min((left + right) / 2 - w / 2, window.innerWidth - w - 8));
    let y = first.top - h - 10;
    if (y < top + 4) y = lastBox.bottom + 30;
    y = Math.max(top + 4, Math.min(y, bottom - h - 4));
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(y)}px`;
  });

  const all = selectsAll(sel.start, sel.end, text);
  return createPortal(
    <>
      {!hasApi &&
        rects.filter(visible).map((b, i) => (
          <div
            key={i}
            className="tsel-mark"
            style={{ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }}
          />
        ))}
      {visible(first) && (
        <div
          className="tsel-handle start"
          style={{ left: first.left, top: first.bottom }}
          onTouchStart={(e) => grab('start', e)}
          aria-hidden="true"
        />
      )}
      {visible(lastBox) && (
        <div
          className="tsel-handle end"
          style={{ left: lastBox.right, top: lastBox.bottom }}
          onTouchStart={(e) => grab('end', e)}
          aria-hidden="true"
        />
      )}
      {anyVisible && (
        <div className="tsel-bar" role="toolbar" aria-label="Выделенный текст" ref={barRef}>
          <button
            type="button"
            className="tsel-btn"
            onClick={() => {
              onCopy(text.slice(sel.start, sel.end));
              onClose();
            }}
          >
            Копировать
          </button>
          {onQuote && (
            <button
              type="button"
              className="tsel-btn"
              onClick={() => {
                onQuote(text.slice(sel.start, sel.end), sel.start);
                onClose();
              }}
            >
              Цитировать
            </button>
          )}
          {!all && (
            <button
              type="button"
              className="tsel-btn"
              onClick={() => {
                const s = text.length - text.trimStart().length;
                onChange({ body: sel.body, start: s, end: text.trimEnd().length });
              }}
            >
              Выделить всё
            </button>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
