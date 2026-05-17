// Einheitlicher Schalter für das gesamte Admin-Panel (ECP)
// h-6 w-11  — Track 44 × 24 px
// h-4 w-4   — Knob  16 × 16 px
// Inactive: translate-x-1 (4 px Abstand links)
// Active:   translate-x-6 (24 px = 44 - 16 - 4)

export function Toggle({
  active,
  onToggle,
  disabled = false,
}: {
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
        active ? 'bg-accent' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          active ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
