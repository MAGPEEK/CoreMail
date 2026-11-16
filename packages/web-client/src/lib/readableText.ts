import { contrastRatio, type Rgb } from '../theme/contrast.ts';

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** Parses #rgb / #rrggbb (with or without #); null when it is not a hex colour. */
export function parseHexColor(value: string | null | undefined): Rgb | null {
  const hex = (value ?? '').trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * Text colour (black or white) for text on a user-chosen background colour
 * (calendar colours, task chips): whichever has the higher WCAG contrast, which
 * is always >= 4.5:1. Unknown formats fall back to white.
 */
export function readableTextOn(background: string | null | undefined): '#000000' | '#ffffff' {
  const bg = parseHexColor(background);
  if (!bg) return '#ffffff';
  return contrastRatio(BLACK, bg) >= contrastRatio(WHITE, bg) ? '#000000' : '#ffffff';
}
