import { useEffect, useRef, useState } from 'react';
import { Goose } from './Goose';
import {
  closeWindow,
  maxButtonSpot,
  minimizeWindow,
  nextMaxHover,
  onMaxHover,
  reportMaxSpot,
  titleBarPointerDown,
  toggleMaximizeWindow,
  watchWindowState,
} from '../titleBar';

/**
 * Своя полоса главного окна десктопа (#219) вместо системной, как у Discord и Telegram Desktop: гусь и
 * название слева, справа три системные кнопки 46 × 32 (свернуть / развернуть-восстановить / закрыть).
 * Цвета — рельса (`--rail`), как полоса Discord над списком серверов; наведение — `--row-hover`, закрыть —
 * `--danger`. Монтируется отдельным корнем вне `App` (`main.tsx`): упадёт приложение — полоса и крестик
 * останутся.
 *
 * Над кнопкой «Развернуть» лежит прозрачное нативное окно (`titlebar.rs`): мышь там у него, поэтому
 * подсветку и щелчок для неё присылает оно (`onMaxHover`), а свой `onClick` у кнопки — запасной путь
 * (окно ещё не встало на место, не Windows).
 */
export function WindowTitleBar() {
  const maxRef = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [maxHover, setMaxHover] = useState({ hover: false, pressed: false });

  useEffect(() => watchWindowState(setMaximized, setFocused), []);
  useEffect(() => onMaxHover((ev) => setMaxHover((p) => nextMaxHover(p, ev))), []);

  // Место кнопки «Развернуть» — нативной стороне: при смене размера кнопки (масштаб интерфейса), окна,
  // плотности пикселей (переезд на монитор с другим DPI) и при полноэкранном элементе (тогда спрятать).
  useEffect(() => {
    const el = maxRef.current;
    if (!el) return;
    let mq: MediaQueryList | null = null;
    const report = () => {
      const r = document.fullscreenElement ? null : el.getBoundingClientRect();
      reportMaxSpot(maxButtonSpot(r, window.innerWidth, window.devicePixelRatio));
    };
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    const onDpr = () => {
      watchDpr();
      report();
    };
    watchDpr();
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    document.addEventListener('fullscreenchange', report);
    return () => {
      ro.disconnect();
      mq?.removeEventListener('change', onDpr);
      window.removeEventListener('resize', report);
      document.removeEventListener('fullscreenchange', report);
      reportMaxSpot(null);
    };
  }, []);

  const maxCls =
    'gv-titlebar-btn' + (maxHover.hover ? ' is-hover' : '') + (maxHover.pressed ? ' is-pressed' : '');
  return (
    <div className={'gv-titlebar' + (focused ? '' : ' is-blurred')} onMouseDown={(e) => titleBarPointerDown(e)}>
      <div className="gv-titlebar-title">
        <Goose pose="head" size={18} className="gv-titlebar-goose" />
        <span>GusVoice</span>
      </div>
      <div className="gv-titlebar-btns" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="gv-titlebar-btn" aria-label="Свернуть" title="Свернуть" onClick={minimizeWindow}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5 H10" />
          </svg>
        </button>
        <button
          ref={maxRef}
          type="button"
          className={maxCls}
          aria-label={maximized ? 'Восстановить' : 'Развернуть'}
          title={maximized ? 'Восстановить' : 'Развернуть'}
          onClick={toggleMaximizeWindow}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 2.5 H7.5 V9.5 H0.5 Z M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="gv-titlebar-btn gv-titlebar-close"
          aria-label="Закрыть"
          title="Закрыть"
          onClick={closeWindow}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0 L10 10 M10 0 L0 10" />
          </svg>
        </button>
      </div>
    </div>
  );
}
