/**
 * Branding colours (9.3): WCAG contrast check of the brand / header colour
 * against the light (#ffffff) and dark (rgb 27 30 37) surfaces of the web
 * client, plus a hue-preserving correction suggestion.
 *
 * The contrast formula is a copy of packages/web-client/src/theme/contrast.ts
 * (server code never imports frontend code). The suggestion keeps the OKLCH
 * hue, moves the lightness as little as possible and reduces the chroma only
 * as far as the sRGB gamut requires.
 */

export type Rgb = readonly [number, number, number];

/** Minimum contrast of a control colour against both surfaces (WCAG 1.4.11). */
export const MIN_CONTROL_CONTRAST = 3;
export const LIGHT_SURFACE: Rgb = [255, 255, 255];
export const DARK_SURFACE: Rgb = [27, 30, 37];

// ── Copied from web-client/src/theme/contrast.ts ─────────────────────────────

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

// ── Hex ───────────────────────────────────────────────────────────────────────

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`invalid colour ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** "r g b" channels for CSS variables (`--brand-primary`). */
export function rgbChannels(hex: string): string {
  return hexToRgb(hex).join(' ');
}

// ── OKLCH ─────────────────────────────────────────────────────────────────────

const toLinear = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLinear = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;

interface Oklch { l: number; c: number; h: number }

function rgbToOklch([R, G, B]: Rgb): Oklch {
  const r = toLinear(R), g = toLinear(G), b = toLinear(B);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  return { l: L, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

/** Linear sRGB (unclamped, 0..1 inside the gamut). */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S,
  ];
}

const inGamut = (v: [number, number, number]): boolean => v.every((x) => x >= -1e-6 && x <= 1 + 1e-6);

/** sRGB colour for (l, h) with the largest chroma ≤ `c` that is inside the gamut. */
function fitGamut(l: number, c: number, h: number): Rgb {
  let lo = 0, hi = c;
  if (!inGamut(oklchToLinear({ l, c, h }))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h }))) lo = mid; else hi = mid;
    }
    c = lo;
  }
  return oklchToLinear({ l, c, h }).map((v) => Math.round(fromLinear(Math.max(0, Math.min(1, v))))) as unknown as Rgb;
}

export function meetsControlContrast(rgb: Rgb): boolean {
  return contrastRatio(rgb, LIGHT_SURFACE) >= MIN_CONTROL_CONTRAST && contrastRatio(rgb, DARK_SURFACE) >= MIN_CONTROL_CONTRAST;
}

/**
 * The closest colour (OKLCH lightness, same hue) that reaches 3:1 against both
 * surfaces, as `#rrggbb`. Returns the input when it already does.
 */
export function suggestAccessibleColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (meetsControlContrast(rgb)) return hex.toLowerCase();
  const { l, c, h } = rgbToOklch(rgb);
  const STEP = 0.002;
  for (let d = STEP; d <= 1; d += STEP) {
    for (const cand of [l - d, l + d]) {
      if (cand <= 0 || cand >= 1) continue;
      const out = fitGamut(cand, c, h);
      if (meetsControlContrast(out)) return rgbToHex(out);
    }
  }
  return '#6b6b6b'; // neutral grey reaches 3:1 on both surfaces (fallback, not reached in practice)
}

export interface ColorWarning { field: string; message: string; suggestion: string }

/** Warning for a colour below 3:1 on the light or the dark surface, else null. */
export function colorWarning(field: string, hex: string): ColorWarning | null {
  const rgb = hexToRgb(hex);
  const light = contrastRatio(rgb, LIGHT_SURFACE);
  const dark = contrastRatio(rgb, DARK_SURFACE);
  if (light >= MIN_CONTROL_CONTRAST && dark >= MIN_CONTROL_CONTRAST) return null;
  const low = [
    ...(light < MIN_CONTROL_CONTRAST ? [`${light.toFixed(2)}:1 on the light surface`] : []),
    ...(dark < MIN_CONTROL_CONTRAST ? [`${dark.toFixed(2)}:1 on the dark surface`] : []),
  ].join(' and ');
  return {
    field,
    message: `Contrast below 3:1 for controls (${low}). The colour was saved; consider the suggestion.`,
    suggestion: suggestAccessibleColor(hex),
  };
}
