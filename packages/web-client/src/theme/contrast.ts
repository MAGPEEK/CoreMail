/**
 * WCAG 2.x contrast helpers + accent-foreground derivation.
 * KEEP IDENTICAL in web-client and admin-panel (theme.test.ts enforces it).
 */
export type Rgb = readonly [number, number, number];

export function parseRgbChannels(value: string): Rgb {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    throw new Error(`invalid RGB channels: ${value}`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

/**
 * Accent colour usable as text / icon / focus ring on the given surfaces:
 * the accent itself when it already reaches `min` (4.5:1) against every
 * background, otherwise the accent mixed towards black (light theme) or
 * white (dark theme) in small steps until it does.
 */
export function accentForeground(accent: Rgb, backgrounds: readonly Rgb[], dark: boolean, min = 4.5): Rgb {
  const target: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
  for (let step = 0; step <= 40; step++) {
    const c = mix(accent, target, step / 40);
    if (backgrounds.every((bg) => contrastRatio(c, bg) >= min)) return c;
  }
  return target;
}

/** Backgrounds the accent foreground must stay legible on (canvas, surface, surface-2, surface-3). */
export const LIGHT_BACKGROUNDS: readonly Rgb[] = [[243, 244, 246], [255, 255, 255], [246, 247, 249], [232, 234, 238]];
export const DARK_BACKGROUNDS: readonly Rgb[] = [[17, 19, 24], [27, 30, 37], [34, 38, 46], [44, 49, 59]];

/** Value for the --color-accent-fg CSS variable ("r g b"). */
export function accentFgChannels(accentChannels: string, dark: boolean): string {
  const fg = accentForeground(parseRgbChannels(accentChannels), dark ? DARK_BACKGROUNDS : LIGHT_BACKGROUNDS, dark);
  return fg.join(' ');
}
