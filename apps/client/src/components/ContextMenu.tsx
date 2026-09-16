import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useImageViewerOpen } from '../imageViewer';
import { placeByPoint, toLayoutPoint } from '../popover';
import type { DotStatus } from '../status';
import { Icon, type IconName } from './Icon';
import { StatusDot } from './StatusDot';

export type MenuPos = { x: number; y: number };

/** True on a phone-width viewport — context menus become bottom-sheets there (round-7 P7). */
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 620px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/**
 * Shared right-click menu: a portalled popover anchored at a screen point, clamped to the
 * viewport, dismissed on outside-click / Esc / scroll / resize. Used for the user menu now and
 * channel/category/message menus later (the design-step3 shell). Compose rows with the
 * MenuItem / MenuDivider / MenuSection / MenuHeader primitives below.
 */
export function ContextMenu({
  pos,
  onClose,
  children,
  width = 224,
  bare = false,
}: {
  pos: MenuPos;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Edge-to-edge content (no padding, clipped corners) — for the banner profile card. */
  bare?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (isMobile) return;
    const el = ref.current;
    if (!el) return;
    // Размер берём из offsetWidth/Height, а не из getBoundingClientRect: первый в вёрсточных
    // единицах, второй — в экранных, и при масштабе интерфейса ≠ 100% они расходятся на zoom.
    // `pos` пришёл из clientX/clientY события, то есть тоже экранный — переводим.
    // Меню раскрывается в свободный квадрант от курсора; ползти вдоль кромки, накрывая точку
    // клика, — крайний случай, когда не влез ни один. Влезть вообще ему помогает `max-height`
    // у `.ctx-menu`: без него высокое меню участника не помещалось ни в какую позицию.
    const p = toLayoutPoint(pos.x, pos.y);
    setPlace(placeByPoint(p.x, p.y, el.offsetWidth, el.offsetHeight));
  }, [pos.x, pos.y, isMobile]);

  /**
   * Просмотрщик картинки открыт (аватар из карточки профиля) — меню замирает.
   *
   * Картинка рисуется НАД меню и порталом в `body`, то есть любой клик по ней формально «мимо
   * меню», а её Esc — тот же Esc, что закрывает меню. Без этой уступки карточка схлопывалась бы от
   * первого же клика по картинке, которую сама и открыла.
   */
  const viewerOpen = useImageViewerOpen();

  useEffect(() => {
    if (viewerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    // A mobile sheet shouldn't dismiss on scroll/resize (the soft keyboard fires those).
    if (!isMobile) {
      window.addEventListener('resize', onClose);
      window.addEventListener('blur', onClose);
    }
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, isMobile, viewerOpen]);

  // Phone: a bottom-sheet sliding up over a scrim (taps outside close it).
  if (isMobile) {
    return createPortal(
      <div className="ctx-sheet-backdrop" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
        <div
          ref={ref}
          className={`ctx-menu sheet${bare ? ' bare' : ''}`}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!bare && <div className="ctx-grabber" />}
          {children}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={ref}
      className={`ctx-menu${bare ? ' bare' : ''}`}
      role="menu"
      style={{ left: place?.left ?? pos.x, top: place?.top ?? pos.y, width, visibility: place ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  label,
  sub,
  onClick,
  danger,
  disabled,
  submenu,
  active,
  shortcut,
}: {
  icon?: IconName;
  label: ReactNode;
  /** Optional dim second line under the label (e.g. "только для вас"). */
  sub?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  submenu?: boolean;
  active?: boolean;
  /** Optional keyboard hint shown mono/dim on the right (e.g. "R", "Del"). */
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ctx-item ${danger ? 'danger' : ''} ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <span className="ctx-ico">
          <Icon name={icon} size={16} />
        </span>
      ) : (
        <span className="ctx-ico" />
      )}
      <span className={`ctx-label ${sub ? 'has-sub' : ''}`}>
        <span className="ctx-label-main">{label}</span>
        {sub ? <span className="ctx-sublabel">{sub}</span> : null}
      </span>
      {shortcut ? (
        <span className="ctx-shortcut">{shortcut}</span>
      ) : submenu ? (
        <span className="ctx-arrow">
          <Icon name="chevron-right" size={14} />
        </span>
      ) : null}
    </button>
  );
}

export const MenuDivider = () => <div className="ctx-divider" />;

export function MenuSection({ children }: { children: ReactNode }) {
  return <div className="ctx-section">{children}</div>;
}

/** Non-clickable identity block at the top of a menu: avatar (+ optional status dot) + name + subtitle. */
export function MenuHeader({
  avatar,
  name,
  sub,
  online,
  status,
}: {
  avatar?: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
  /** When provided, overlays a green/grey presence dot on the avatar. */
  online?: boolean;
  /** A 4-state presence dot — takes precedence over `online` when set. */
  status?: DotStatus;
}) {
  return (
    <div className="ctx-header">
      {avatar ? (
        status !== undefined ? (
          <span className="ctx-ava-wrap">
            {avatar}
            <span className="ctx-ava-dot-wrap">
              <StatusDot status={status} size={12} ringColor="var(--bg-2)" />
            </span>
          </span>
        ) : online === undefined ? (
          avatar
        ) : (
          <span className="ctx-ava-wrap">
            {avatar}
            <span className={`ctx-ava-dot ${online ? 'on' : 'off'}`} />
          </span>
        )
      ) : null}
      <div className="ctx-header-text">
        <div className="ctx-header-name">{name}</div>
        {sub ? <div className="ctx-header-sub">{sub}</div> : null}
      </div>
    </div>
  );
}
