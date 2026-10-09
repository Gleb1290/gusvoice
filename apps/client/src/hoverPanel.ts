import { useEffect, useRef } from 'react';

/**
 * Панель эмодзи и меню скрепки по наведению (G61; Telegram Desktop `TabbedPanel` + `ComposeControls`: пока опция «открывать
 * по клику» (`kOptionTabbedPanelShowOnClick`) выключена — а она выключена по умолчанию, — панель выезжает, когда мышь стоит на
 * кнопке смайлика, и закрывается `kHideTimeoutMs` = 300 мс после того, как мышь ушла и с кнопки, и с панели; клик по кнопке или
 * по самой панели оставляет её открытой, как при открытии кликом). Только мышь: у пальца и пера наведения нет.
 *
 * Панель, открытая наведением: не забирает фокус у поля (`hoverPanelOpened()` — читает `exprAutoFocus`), не закрывает щелчок
 * мимо (подложка на это время прозрачна для мыши, `body.expr-hover`), закрывается уходом мыши.
 */
export const HOVER_OPEN_MS = 200;
export const HOVER_CLOSE_MS = 300;

/** Мышь с наведением (не телефон, не перо): иначе `mouseenter` — эхо касания перед кликом, и панель открылась бы сама. */
export function hoverPanelsAvailable(): boolean {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

let hoverOpened = false;
/** Сейчас открыта панель, открытая наведением (ещё не закреплённая кликом): автофокус поиска в ней отключён. */
export function hoverPanelOpened(): boolean {
  return hoverOpened;
}
function setHoverOpened(on: boolean) {
  hoverOpened = on;
  document.body.classList.toggle('expr-hover', on);
}

export interface HoverPanelOptions {
  /** Панель сейчас открыта (любым способом). */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Селектор самой панели (мышь на ней — не «ушла»). */
  panel: string;
  /** Селектор кнопки-триггера. */
  trigger: string;
  /**
   * Щелчок по кнопке при панели, открытой наведением (G61): `true` — панель закрепили иначе, колонкой (`exprDock.ts`; Telegram Desktop
   * `toggleTabbedSelectorMode`), и всплывающую закрыть. `false`/нет — она остаётся открытой, как была.
   */
  pin?: () => boolean;
}

/**
 * `onMouseEnter` / `onMouseLeave` — на кнопку. Клик по кнопке или щелчок по самой панели закрепляют открытую наведением панель.
 */
export function useHoverPanel(o: HoverPanelOptions) {
  const opts = useRef(o);
  opts.current = o;
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const hovering = useRef(false);
  const unwatch = useRef<(() => void) | null>(null);

  function stop() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = 0;
    unwatch.current?.();
    unwatch.current = null;
    if (hovering.current) {
      hovering.current = false;
      setHoverOpened(false);
    }
  }
  function startClose() {
    if (closeTimer.current) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = 0;
      if (!hovering.current) return;
      stop();
      opts.current.close();
    }, HOVER_CLOSE_MS);
  }
  function watch() {
    const onMove = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(`${opts.current.panel}, ${opts.current.trigger}`)) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = 0;
      } else startClose();
    };
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) startClose();
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(opts.current.panel)) stop();
    };
    // Клик по кнопке, пока панель открыта наведением, закрепляет её: дальше он не идёт — ни в `onClick` кнопки (открыл бы заново),
    // ни в «щелчок мимо» самой панели (меню скрепки закрылось бы, кнопка для него — «мимо»).
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(opts.current.trigger)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
      if (opts.current.pin?.()) opts.current.close();
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseout', onOut);
    window.addEventListener('pointerdown', onDown, true);
    unwatch.current = () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }

  // Закрыли иначе (Esc, выбор, подложка) — наведение больше не при делах.
  useEffect(() => {
    if (!o.isOpen) stop();
  }, [o.isOpen]);
  useEffect(() => stop, []);

  return {
    onMouseEnter() {
      if (opts.current.isOpen || hovering.current || !hoverPanelsAvailable()) return;
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => {
        hovering.current = true;
        setHoverOpened(true);
        watch();
        opts.current.open();
      }, HOVER_OPEN_MS);
    },
    onMouseLeave() {
      window.clearTimeout(openTimer.current);
    },
  };
}
