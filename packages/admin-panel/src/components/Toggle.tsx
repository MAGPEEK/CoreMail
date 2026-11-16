// Unified toggle switch for the entire admin panel (BCP)
// h-6 w-11  — Track 44 × 24 px, 2 px border (line-strong when off: >= 3:1 boundary)
// h-4 w-4   — Knob  16 × 16 px
// Inactive: translate-x-0.5   (4 px from the outer left edge)
// Active:   translate-x-[22px] (4 px from the outer right edge)

export function Toggle({
  active,
  onToggle,
  disabled = false,
  label,
}: {
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Accessible name when no visible <label> points at the switch */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      {...(label ? { 'aria-label': label } : {})}
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 disabled:cursor-not-allowed ${
        active ? 'bg-accent border-transparent' : 'bg-surface-2 border-line-strong'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
          active ? 'translate-x-[22px] bg-surface' : 'translate-x-0.5 bg-fg-subtle'
        }`}
      />
    </button>
  );
}
