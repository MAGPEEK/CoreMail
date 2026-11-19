/**
 * 10.1: webmail background (Einstellungen → Darstellung → Hintergrund).
 *
 * The roaming preference `appearance.background` is `none`, `custom` (the image
 * the user uploaded, GET /api/v1/user/background) or `builtin:<id>`; null = no
 * own choice → the organisation default of the branding (`defaultBackground`,
 * none or a built-in). The built-in pictures are CoreMail's own SVG drawings in
 * public/backgrounds/<id>-light.svg / <id>-dark.svg (scripts/backgrounds.mjs),
 * one variant per theme. KEEP the id list IN STEP with api-gateway
 * lib/user-preferences.ts and storage user-background.ts (tests check both).
 * KEEP IDENTICAL in web-client and admin-panel (BCP → Branding → Standard-Hintergrund).
 * No imports — unit-tested with `node --test`.
 */

export const BUILTIN_BACKGROUND_IDS = ['lake', 'dawn', 'forest', 'coast', 'dunes', 'waves', 'aurora', 'neutral'] as const;
export type BuiltinBackgroundId = typeof BUILTIN_BACKGROUND_IDS[number];

/** German names of the built-in backgrounds (tiles, the admin picker). */
export const BUILTIN_BACKGROUND_LABELS: Record<BuiltinBackgroundId, string> = {
  lake: 'Bergsee bei Nacht',
  dawn: 'Morgendämmerung',
  forest: 'Wald',
  coast: 'Küste',
  dunes: 'Dünen',
  waves: 'Wellen',
  aurora: 'Polarlicht',
  neutral: 'Neutral',
};

export type BackgroundChoice = 'none' | 'custom' | `builtin:${BuiltinBackgroundId}`;

/** What the app body shows. */
export type ResolvedBackground =
  | { kind: 'none' }
  | { kind: 'builtin'; id: BuiltinBackgroundId }
  | { kind: 'custom' };

export function isBuiltinBackground(id: string): id is BuiltinBackgroundId {
  return (BUILTIN_BACKGROUND_IDS as readonly string[]).includes(id);
}

/** A stored / sent value → a valid choice, or null (no own choice or garbage). */
export function parseBackgroundChoice(v: unknown): BackgroundChoice | null {
  if (v === 'none' || v === 'custom') return v;
  if (typeof v !== 'string' || !v.startsWith('builtin:')) return null;
  const id = v.slice('builtin:'.length);
  return isBuiltinBackground(id) ? `builtin:${id}` : null;
}

/** The organisation default (branding): none or a built-in; anything else → none. */
export function parseDefaultBackground(v: unknown): 'none' | `builtin:${BuiltinBackgroundId}` {
  const c = parseBackgroundChoice(v);
  return c === null || c === 'custom' ? 'none' : c;
}

/**
 * Background to show: the own choice, else the organisation default. `custom`
 * without an uploaded image (removed on another device) shows nothing.
 */
export function resolveBackground(pref: unknown, orgDefault: unknown, hasCustomImage: boolean): ResolvedBackground {
  const choice = parseBackgroundChoice(pref) ?? parseDefaultBackground(orgDefault);
  if (choice === 'none') return { kind: 'none' };
  if (choice === 'custom') return hasCustomImage ? { kind: 'custom' } : { kind: 'none' };
  return { kind: 'builtin', id: choice.slice('builtin:'.length) as BuiltinBackgroundId };
}

/** URL of a built-in picture for the theme (served from the web client's public folder). */
export function builtinBackgroundUrl(id: BuiltinBackgroundId, dark: boolean): string {
  return `/backgrounds/${id}-${dark ? 'dark' : 'light'}.svg`;
}

/** Upload limits of "Eigenes Bild hochladen…" (the server checks again and re-encodes). */
export const BACKGROUND_FILE_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_BACKGROUND_FILE_BYTES = 5 * 1024 * 1024;

/** German message why a picked file cannot be a background, or null. */
export function backgroundFileError(file: { type: string; size: number }): string | null {
  if (!(BACKGROUND_FILE_TYPES as readonly string[]).includes(file.type)) return 'Bitte ein JPEG- oder PNG-Bild wählen.';
  if (file.size > MAX_BACKGROUND_FILE_BYTES) return 'Das Bild darf höchstens 5 MB groß sein.';
  if (file.size === 0) return 'Die Datei ist leer.';
  return null;
}

/**
 * Pane surfaces over a background: the surface at 92 % opacity (with a light
 * blur) — opaque without one. Text contrast on the blended surface is checked
 * against black and white behind it in lib/paneSurface.test.ts.
 */
export const PANE_SURFACE_ALPHA = 0.92;
