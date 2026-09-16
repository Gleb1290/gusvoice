import { useEffect } from 'react';
import { type Toast, type ToastType, useToasts } from '../toast';
import { Icon, type IconName } from './Icon';

const TYPE_ICON: Record<ToastType, IconName> = {
  success: 'check',
  warn: 'bell',
  info: 'signal',
  error: 'close',
};

const DISMISS_MS = 3800;

function ToastCard({ id, type, title, subtitle, sticky }: Toast) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    if (sticky) return; // sticky toasts persist until the user clicks ✕
    const t = setTimeout(() => dismiss(id), DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, dismiss, sticky]);

  return (
    <div className={`toast ${type}`} role="status">
      <span className="toast-bar" />
      <span className="toast-ic">
        <Icon name={TYPE_ICON[type]} size={16} />
      </span>
      <div className="toast-text">
        <div className="toast-title">{title}</div>
        {subtitle ? <div className="toast-sub">{subtitle}</div> : null}
      </div>
      <button type="button" className="toast-x" title="Закрыть" onClick={() => dismiss(id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Bottom-right toast stack. Mounted once near the app root. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastCard key={t.id} {...t} />
      ))}
    </div>
  );
}
