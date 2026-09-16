/** Honey on/off switch (46×26). Disabled = locked look (e.g. a permission you can't grant). */
export function Toggle({
  checked,
  onChange,
  disabled,
  title,
  label,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
  /** Accessible name when the visible text next to the switch has no id to point at. */
  label?: string;
  /** id of the visible label sitting next to the switch — without it the switch announces as unnamed. */
  labelledBy?: string;
  /** id of a hint that qualifies what the switch does (e.g. «звук самого устройства»). */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      title={title}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''} ${disabled ? 'locked' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}
