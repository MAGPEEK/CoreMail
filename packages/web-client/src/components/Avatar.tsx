// Avatar with hash-based color + initials — like Gmail/Outlook.com

// 14 Material-inspired color pairs (background, text) — high contrast
const COLORS = [
  { bg: 'bg-blue-500',    text: 'text-white' },
  { bg: 'bg-emerald-500', text: 'text-white' },
  { bg: 'bg-amber-500',   text: 'text-white' },
  { bg: 'bg-rose-500',    text: 'text-white' },
  { bg: 'bg-violet-500',  text: 'text-white' },
  { bg: 'bg-cyan-500',    text: 'text-white' },
  { bg: 'bg-pink-500',    text: 'text-white' },
  { bg: 'bg-orange-500',  text: 'text-white' },
  { bg: 'bg-teal-500',    text: 'text-white' },
  { bg: 'bg-indigo-500',  text: 'text-white' },
  { bg: 'bg-fuchsia-500', text: 'text-white' },
  { bg: 'bg-lime-600',    text: 'text-white' },
  { bg: 'bg-sky-500',     text: 'text-white' },
  { bg: 'bg-red-500',     text: 'text-white' },
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Extracts 1–2 initials from a name or an email address */
export function getInitials(input: string): string {
  if (!input) return '?';
  // Email address — take the part before @
  const local = input.includes('@') ? input.split('@')[0]! : input;
  // Separators: dot, space, hyphen, underscore
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return (parts[0] ?? input).slice(0, 2).toUpperCase();
}

/** Deterministic color for an address */
export function avatarColors(input: string): { bg: string; text: string } {
  const idx = hashString(input.toLowerCase()) % COLORS.length;
  return COLORS[idx]!;
}

export interface AvatarProps {
  /** Email address or display name (for hash + initials) */
  seed: string;
  /** Override for displayed initials */
  initials?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_MAP = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-base',
} as const;

export function Avatar({ seed, initials, size = 'sm', className = '' }: AvatarProps) {
  const { bg, text } = avatarColors(seed);
  const label = initials ?? getInitials(seed);
  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold select-none ${bg} ${text} ${SIZE_MAP[size]} ${className}`}
      aria-hidden
    >
      {label}
    </div>
  );
}
