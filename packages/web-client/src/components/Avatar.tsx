// Avatar mit hash-basierter Farbe + Initialen — wie Gmail/Outlook.com

// 14 Material-inspirierte Farbpaare (Hintergrund, Text) — kontrastreich
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

/** Extrahiert 1–2 Initialen aus einem Namen oder einer E-Mail-Adresse */
export function getInitials(input: string): string {
  if (!input) return '?';
  // E-Mail-Adresse — nimm den Teil vor @
  const local = input.includes('@') ? input.split('@')[0]! : input;
  // Trenner: Punkt, Leerzeichen, Bindestrich, Unterstrich
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return (parts[0] ?? input).slice(0, 2).toUpperCase();
}

/** Deterministische Farbe für eine Adresse */
export function avatarColors(input: string): { bg: string; text: string } {
  const idx = hashString(input.toLowerCase()) % COLORS.length;
  return COLORS[idx]!;
}

export interface AvatarProps {
  /** E-Mail-Adresse oder Anzeigename (für Hash + Initialen) */
  seed: string;
  /** Override für angezeigte Initialen */
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
