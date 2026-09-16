import type { DotStatus } from '../status';

/**
 * The presence dot: green (online), red-with-dash (dnd), honey (away), hollow ring (invisible),
 * muted (offline). `ringColor` draws a contrasting outline when the dot overlays an avatar.
 */
export function StatusDot({ status, size = 10, ringColor }: { status: DotStatus; size?: number; ringColor?: string }) {
  return (
    <span
      className={`stdot stdot-${status}`}
      style={{ width: size, height: size, ...(ringColor ? { boxShadow: `0 0 0 2px ${ringColor}` } : {}) }}
      aria-hidden
    >
      {status === 'dnd' && (
        <span className="stdot-dash" style={{ width: Math.round(size * 0.5), height: Math.max(2, Math.round(size * 0.2)) }} />
      )}
    </span>
  );
}
