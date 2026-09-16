import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

/**
 * Shared mobile bottom-sheet (design-step8 §G). A scrim-backed panel that rises from the bottom with a
 * grab-handle; tapping the scrim (or Esc) closes it. Portalled to <body> so it overlays everything. Use
 * SheetRow for the ≥56dp icon+text action rows; put a destructive action last with `danger`.
 *
 * This is the mobile replacement for tiny popovers — the "⋯ More" server menu, message long-press
 * actions, the per-user profile actions, etc. Desktop keeps its own popovers/menus.
 */
export function BottomSheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        {title != null && (
          <div className="sheet-head">
            <div className="sheet-title">{title}</div>
            {subtitle != null && <div className="sheet-sub">{subtitle}</div>}
          </div>
        )}
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
