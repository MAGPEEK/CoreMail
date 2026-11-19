// Avatar: the profile photo when there is one (9.5), else initials on a hash-based colour
import { getInitials } from '../lib/initials.js';

// 14 Material-inspired color pairs (background, text) — 700 shades: white initials reach >= 4.99:1 (WCAG 1.4.3)
const COLORS = [
  { bg: 'bg-blue-700',    text: 'text-white' },
  { bg: 'bg-emerald-700', text: 'text-white' },
  { bg: 'bg-amber-700',   text: 'text-white' },
  { bg: 'bg-rose-700',    text: 'text-white' },
  { bg: 'bg-violet-700',  text: 'text-white' },
  { bg: 'bg-cyan-700',    text: 'text-white' },
  { bg: 'bg-pink-700',    text: 'text-white' },
  { bg: 'bg-orange-700',  text: 'text-white' },
  { bg: 'bg-teal-700',    text: 'text-white' },
  { bg: 'bg-indigo-700',  text: 'text-white' },
  { bg: 'bg-fuchsia-700', text: 'text-white' },
  { bg: 'bg-lime-700',    text: 'text-white' },
  { bg: 'bg-sky-700',     text: 'text-white' },
  { bg: 'bg-red-700',     text: 'text-white' },
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Deterministic color for an address */
export function avatarColors(input: string): { bg: string; text: string } {
  const idx = hashString(input.toLowerCase()) % COLORS.length;
  return COLORS[idx]!;
}

export interface AvatarProps {
  /** Email address (or display name when there is none) — picks the colour */
  seed: string;
  /** Display name for the initials (lib/initials.ts); the address in `seed` is the fallback */
  name?: string | null | undefined;
  /** blob: URL of the profile photo; shown instead of the initials */
  photoUrl?: string | null | undefined;
  size?: 'chip' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_MAP = {
  chip: 'w-5 h-5 text-[9px]',
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-24 h-24 text-3xl',
} as const;

/** The photo filling a round avatar frame (decorative: the name is always next to it). */
export function AvatarPhoto({ src }: { src: string }) {
  return <img src={src} alt="" draggable={false} className="w-full h-full rounded-full object-cover" />;
}

export function Avatar({ seed, name, photoUrl, size = 'sm', className = '' }: AvatarProps) {
  const { bg, text } = avatarColors(seed);
  const colours = photoUrl ? 'bg-surface-2' : `${bg} ${text}`;
  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold select-none overflow-hidden ${colours} ${SIZE_MAP[size]} ${className}`}
      aria-hidden
    >
      {photoUrl ? <AvatarPhoto src={photoUrl} /> : getInitials(name, seed)}
    </div>
  );
}
