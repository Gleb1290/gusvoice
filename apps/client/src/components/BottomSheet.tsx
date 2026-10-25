import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

/**
 * Shared mobile bottom-sheet (design-step8 §G). A scrim-backed panel that rises from the bottom with a
 * grab-handle. Dragging the handle down, tapping the scrim, or Esc closes it. Portalled to <body>
 * so it overlays everything. Use SheetRow for the ≥56dp icon+text action rows; put a destructive
 * action last with `danger`.
 *
 * This is the mobile replacement for tiny popovers — the "⋯ More" server menu, message long-press
 * actions, the per-user profile actions, etc. Desktop keeps its own popovers/menus.
 */
export function BottomSheet({
  title,
  subtitle,
  onClose,
  onBack,
  page = false,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** Стрелка «Назад» слева в шапке (шаги мастера, например «Новая группа», шаг 2): закрывает не лист, а шаг. */
  onBack?: () => void;
  /**
   * Экран на всю высоту вместо листа снизу (#218, «Новое сообщение» как `ContactsActivity` Telegram Android: фрагмент поверх
   * списка, полоса 56 со стрелкой «назад» и заголовком). Без ручки и жеста вниз; Esc и системная «Назад» — как у листа.
   */
  page?: boolean;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y0: number; dy: number; t0: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* Esc и системная «Назад» (`stepBack` шлёт Esc) на листе с шагами — шаг назад, как стрелка в шапке (#218, решение
         владельца): на первом шаге — закрыть лист. */
      if (e.key === 'Escape') (onBack ?? onClose)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onBack]);

  /* Ручка и шапка тянутся пальцем вниз: лист едет следом и закрывается, если утянуть его на треть
     высоты или бросить рывком. Жест живёт ТОЛЬКО на ручке — тело листа прокручивается, и на нём
     оба жеста дрались бы за один и тот же палец. Ручка рисовалась с самого начала, но ничего не
     делала: обещание, которого интерфейс не держал. */
  const followFinger = (dy: number) => {
    const el = sheetRef.current;
    if (!el) return;
    // Въездная анимация (sheetUp) бьёт inline-стиль по каскаду: схватив ручку в первые 0.24 с,
    // человек тянул бы лист, который не двигается. Гасим её на время жеста.
    el.style.animation = 'none';
    el.style.transition = 'none';
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };

  const snapBack = () => {
    drag.current = null;
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = 'transform var(--t-base) cubic-bezier(0.2, 0.8, 0.2, 1)';
    el.style.transform = '';
  };

  const onGrabDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t0: performance.now() };
    // Захват указателя — удобство (палец может уехать за край ручки), а не условие работы жеста:
    // на неактивном указателе браузер бросает InvalidPointerId, и без защиты жест умирал бы целиком.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* пусто: без захвата жест всё равно доведётся обработчиками на самой ручке */
    }
  };

  const onGrabMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    followFinger(d.dy);
  };

  const onGrabUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const height = sheetRef.current?.offsetHeight ?? 0;
    const speed = d.dy / Math.max(1, performance.now() - d.t0); // пикселей за миллисекунду
    drag.current = null;
    // Утянул на треть (но не больше 140 px — у высоких листов треть недостижима) ИЛИ бросил рывком.
    if (d.dy > Math.min(140, height * 0.33) || (speed > 0.6 && d.dy > 24)) {
      onClose();
      return;
    }
    snapBack();
  };

  if (page)
    return createPortal(
      <div className="sheet-scrim page">
        <div className="sheet page" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
          <div className="sheet-page-bar">
            <button type="button" className="sheet-back" aria-label="Назад" title="Назад" onClick={onBack ?? onClose}>
              <Icon name="chevron-left" size={24} />
            </button>
            {title != null && <div className="sheet-page-title">{title}</div>}
          </div>
          <div className="sheet-body">{children}</div>
        </div>
      </div>,
      document.body,
    );

  return createPortal(
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {onBack && (
          // Вне зоны жеста `.sheet-drag`: захват указателя ручкой перехватил бы нажатие. Сторож нулевой высоты липнет к верху листа.
          <div className="sheet-back-dock">
            <button type="button" className="sheet-back" aria-label="Назад" title="Назад" onClick={onBack}>
              <Icon name="chevron-left" size={24} />
            </button>
          </div>
        )}
        <div
          className="sheet-drag"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={snapBack}
        >
          <div className="sheet-grab" />
          {title != null && (
            <div className={onBack ? 'sheet-head with-back' : 'sheet-head'}>
              <div className="sheet-title">{title}</div>
              {subtitle != null && <div className="sheet-sub">{subtitle}</div>}
            </div>
          )}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** One ≥56dp action row inside a BottomSheet. `meta` renders trailing (e.g. a count); `danger` = red. */
export function SheetRow({
  icon,
  label,
  meta,
  danger,
  onClick,
}: {
  icon: IconName;
  label: React.ReactNode;
  meta?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`sheet-row${danger ? ' danger' : ''}`} onClick={onClick}>
      <Icon name={icon} size={22} />
      <span className="sr-label">{label}</span>
      {meta != null && <span className="sr-meta">{meta}</span>}
    </button>
  );
}
