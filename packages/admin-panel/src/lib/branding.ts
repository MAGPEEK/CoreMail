/**
 * Branding (9.3) — pure client logic shared by webmail and BCP.
 * KEEP IDENTICAL in web-client and admin-panel (branding.test.ts enforces it).
 *
 * Source of truth is the public API contract (docs/plans/branding-9.3.md):
 *   GET /api/v1/branding → { version, productName, primaryColor, headerColor,
 *     allowUserAccent, showPoweredBy, loginText, footerLinks, assets }
 * and the same JSON injected by the gateway as
 *   <script id="cm-branding" type="application/json">…</script>
 *
 * Accent rule (webmail):
 *   - The brand primary colour is the default accent for everyone.
 *   - allowUserAccent = false → any personal choice is ignored (picker disabled).
 *   - allowUserAccent = true  → an explicit personal choice wins; `null` means
 *     "never chose" and follows the brand colour.
 *   - Migration of the persisted theme store (version 0 → 1): the old default
 *     "0 120 212" (Microsoft blue) was stored for everyone, so it is read as
 *     "never chose" (null); any other stored preset stays an explicit choice.
 * The BCP always uses the brand primary colour.
 *
 * Solid accent fills carry white text (`bg-accent text-white`), so the fill is
 * darkened (towards black, same hue direction) until white reaches 4.5:1; the
 * accent text colour (--color-accent-fg) is derived per theme by contrast.ts.
 * The webmail top bar uses headerColor (or the primary colour) unchanged with
 * white text when that reaches 4.5:1, otherwise black text (always >= 4.5:1).
 */
import { accentFgChannels, contrastRatio, parseRgbChannels, type Rgb } from '../theme/contrast.ts';

export interface FooterLink { label: string; url: string }

export interface BrandingAssets {
  logoLight: string | null;
  logoDark: string | null;
  favicon: string | null;
  loginBackground: string | null;
}

export interface Branding {
  version: number;
  productName: string;
  /** #rrggbb lower-case */
  primaryColor: string;
  /** #rrggbb lower-case, null = primary colour */
  headerColor: string | null;
  allowUserAccent: boolean;
  showPoweredBy: boolean;
  /** 10.1: webmail background of users without an own choice: none or builtin:<id> (lib/backgroundPrefs.ts resolves it) */
  defaultBackground: string;
  loginText: string;
  footerLinks: FooterLink[];
  assets: BrandingAssets;
}

export type AssetSlot = keyof BrandingAssets;
export const ASSET_SLOTS: readonly AssetSlot[] = ['logoLight', 'logoDark', 'favicon', 'loginBackground'];

export const DEFAULT_PRODUCT_NAME = 'CoreMail';
export const DEFAULT_PRIMARY_COLOR = '#0078d4';
/** Accent channels of the old per-user default (Microsoft blue). */
export const DEFAULT_ACCENT_RGB = '0 120 212';
/** Built-in favicon (web-client/public/favicon.svg, served at the site root). */
export const BUILTIN_FAVICON = '/favicon.svg';

export const PRODUCT_NAME_MAX = 40;
export const LOGIN_TEXT_MAX = 280;
export const FOOTER_LINKS_MAX = 5;
export const FOOTER_LABEL_MAX = 40;

export const DEFAULT_BRANDING: Branding = Object.freeze({
  version: 0,
  productName: DEFAULT_PRODUCT_NAME,
  primaryColor: DEFAULT_PRIMARY_COLOR,
  headerColor: null,
  allowUserAccent: true,
  showPoweredBy: true,
  defaultBackground: 'none',
  loginText: '',
  footerLinks: [],
  assets: Object.freeze({ logoLight: null, logoDark: null, favicon: null, loginBackground: null }),
}) as Branding;

// ── Colours ───────────────────────────────────────────────────────────────────

/** "#rgb" / "#rrggbb" / "rrggbb" (any case, trimmed) → "#rrggbb" lower-case; null if not a hex colour. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? hex.replace(/./g, (c) => c + c) : hex;
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toLowerCase()}` : null;
}

/** "#rrggbb" → "r g b" (CSS variable channels); null if invalid. */
export function hexToChannels(hex: string | null | undefined): string | null {
  const n = normalizeHex(hex);
  if (!n) return null;
  return [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16)).join(' ');
}

/** "r g b" → "#rrggbb"; null if invalid. */
export function channelsToHex(channels: string | null | undefined): string | null {
  if (!isValidChannels(channels)) return null;
  return `#${parseRgbChannels(channels).map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** "r g b" with three integers 0..255. */
export function isValidChannels(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3} \d{1,3} \d{1,3}$/.test(value.trim())) return false;
  return value.trim().split(' ').every((n) => Number(n) <= 255);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * Solid accent fill for `bg-accent text-white`: the colour itself when white
 * text reaches `min` (4.5:1), otherwise mixed towards black in small steps.
 */
export function accentFillChannels(channels: string, min = 4.5): string {
  const c = parseRgbChannels(channels);
  for (let step = 0; step <= 40; step++) {
    const t = step / 40;
    const m = c.map((v) => Math.round(v * (1 - t))) as unknown as Rgb;
    if (contrastRatio(WHITE, m) >= min) return m.join(' ');
  }
  return BLACK.join(' ');
}

export interface HeaderColors {
  /** background channels */ bg: string;
  /** text / icon channels: white when it reaches 4.5:1, else black (then always >= 4.6:1) */ fg: string;
  /** hover / selected overlay: the opposite of fg, so overlays only raise contrast */ overlay: string;
}

/** Top-bar colours for a background hex colour (invalid → default primary). */
export function headerColors(hex: string | null | undefined): HeaderColors {
  const bgCh = hexToChannels(hex) ?? hexToChannels(DEFAULT_PRIMARY_COLOR)!;
  const bg = parseRgbChannels(bgCh);
  // White is preferred (the classic look); below 4.5:1 black is used, which then reaches >= 4.6:1.
  const dark = contrastRatio(WHITE, bg) < 4.5;
  return { bg: bgCh, fg: dark ? '0 0 0' : '255 255 255', overlay: dark ? '255 255 255' : '0 0 0' };
}

/** Effective top-bar colour: headerColor, else primaryColor. */
export function headerHex(b: Pick<Branding, 'headerColor' | 'primaryColor'>): string {
  return normalizeHex(b.headerColor) ?? normalizeHex(b.primaryColor) ?? DEFAULT_PRIMARY_COLOR;
}

/**
 * Accent channels ("r g b") before contrast adjustment — see the accent rule
 * at the top. `userAccentRgb` null = the user never chose.
 */
export function resolveAccentChannels(
  b: Pick<Branding, 'primaryColor' | 'allowUserAccent'>,
  userAccentRgb: string | null | undefined,
): string {
  if (b.allowUserAccent && isValidChannels(userAccentRgb)) return userAccentRgb.trim();
  return hexToChannels(b.primaryColor) ?? DEFAULT_ACCENT_RGB;
}

/** CSS variables for the accent + top bar (applied to :root, or to a preview container). */
export function brandCssVars(accentChannels: string, headerHexColor: string, dark: boolean): Record<string, string> {
  const accent = isValidChannels(accentChannels) ? accentChannels.trim() : DEFAULT_ACCENT_RGB;
  const h = headerColors(headerHexColor);
  return {
    '--color-accent': accentFillChannels(accent),
    '--color-accent-fg': accentFgChannels(accent, dark),
    '--header': h.bg,
    '--header-fg': h.fg,
    '--header-overlay': h.overlay,
  };
}

/** Persisted webmail theme store (zustand persist `migrate`), version 0 → 1. */
export function migrateThemeState(persisted: unknown, version: number): Record<string, unknown> {
  const s = (persisted && typeof persisted === 'object' ? { ...(persisted as Record<string, unknown>) } : {});
  if (version < 1) {
    const raw = s['accentRgb'];
    s['accentRgb'] = isValidChannels(raw) && raw.trim() !== DEFAULT_ACCENT_RGB ? raw.trim() : null;
  } else if (s['accentRgb'] !== null && !isValidChannels(s['accentRgb'])) {
    s['accentRgb'] = null;
  }
  return s;
}

// ── Footer links ──────────────────────────────────────────────────────────────

export type FooterLinkError = 'LABEL_EMPTY' | 'LABEL_TOO_LONG' | 'URL_EMPTY' | 'URL_SCHEME' | 'URL_INVALID';

/** Validates one footer link (contract: label 1..40 chars, https:// or mailto: only). */
export function validateFooterLink(link: { label?: unknown; url?: unknown }): FooterLinkError | null {
  const label = typeof link.label === 'string' ? link.label.trim() : '';
  const url = typeof link.url === 'string' ? link.url.trim() : '';
  if (!label) return 'LABEL_EMPTY';
  if ([...label].length > FOOTER_LABEL_MAX) return 'LABEL_TOO_LONG';
  if (!url) return 'URL_EMPTY';
  if (/[\s\u0000-\u001f\u007f<>"'`\\]/.test(url)) return 'URL_INVALID';
  const lower = url.toLowerCase();
  if (lower.startsWith('mailto:')) {
    return /^mailto:[^@/?#]+@[^@/?#]+\.[^@/?#]+(\?[^#]*)?$/i.test(url) ? null : 'URL_INVALID';
  }
  if (!lower.startsWith('https://')) return 'URL_SCHEME';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return 'URL_INVALID';
  } catch {
    return 'URL_INVALID';
  }
  return null;
}

export const FOOTER_LINK_ERROR_TEXT: Record<FooterLinkError, string> = {
  LABEL_EMPTY: 'Bitte eine Bezeichnung eingeben.',
  LABEL_TOO_LONG: `Höchstens ${FOOTER_LABEL_MAX} Zeichen.`,
  URL_EMPTY: 'Bitte eine Adresse eingeben.',
  URL_SCHEME: 'Nur https:// oder mailto: erlaubt.',
  URL_INVALID: 'Keine gültige https://- oder mailto:-Adresse.',
};

/** Per-link errors (same order) plus TOO_MANY when more than 5 links are given. */
export function validateFooterLinks(links: readonly { label?: unknown; url?: unknown }[]): {
  errors: (FooterLinkError | null)[]; tooMany: boolean; ok: boolean;
} {
  const errors = links.map(validateFooterLink);
  const tooMany = links.length > FOOTER_LINKS_MAX;
  return { errors, tooMany, ok: !tooMany && errors.every((e) => e === null) };
}

// ── Assets ────────────────────────────────────────────────────────────────────

/**
 * Only same-origin, root-relative asset paths are used ("/branding/assets/…"):
 * no scheme, no protocol-relative "//host", no quotes or spaces (the value
 * ends up in <img src> and a CSS url()).
 */
export function safeAssetUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^\/(?!\/)[A-Za-z0-9/._~%-]+(\?[A-Za-z0-9=&._-]*)?$/.test(value) && !value.includes('..') ? value : null;
}

/** Favicon: own favicon → light logo → built-in. */
export function faviconHref(assets: BrandingAssets): string {
  return safeAssetUrl(assets.favicon) ?? safeAssetUrl(assets.logoLight) ?? BUILTIN_FAVICON;
}

/** Logo for the theme (dark logo only in dark mode and when set); null = built-in icon. */
export function logoFor(assets: BrandingAssets, dark: boolean): string | null {
  const light = safeAssetUrl(assets.logoLight);
  const darkLogo = safeAssetUrl(assets.logoDark);
  return dark && darkLogo ? darkLogo : light;
}

/** Browser title per app. */
export function documentTitle(productName: string, app: 'mwa' | 'bcp'): string {
  return app === 'bcp' ? `${productName} BCP` : productName;
}

// ── Parsing (API answer, injected JSON) ───────────────────────────────────────

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

/** Validates an API/injected branding object; every invalid field falls back to its default. */
export function parseBranding(raw: unknown): Branding {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const a = (o['assets'] && typeof o['assets'] === 'object' ? o['assets'] : {}) as Record<string, unknown>;
  const name = str(o['productName'], '').trim().slice(0, 80);
  const version = typeof o['version'] === 'number' && Number.isFinite(o['version']) ? o['version'] : 0;
  const links = Array.isArray(o['footerLinks']) ? o['footerLinks'] : [];
  return {
    version,
    productName: name || DEFAULT_PRODUCT_NAME,
    primaryColor: normalizeHex(o['primaryColor']) ?? DEFAULT_PRIMARY_COLOR,
    headerColor: normalizeHex(o['headerColor']),
    allowUserAccent: typeof o['allowUserAccent'] === 'boolean' ? o['allowUserAccent'] : true,
    showPoweredBy: typeof o['showPoweredBy'] === 'boolean' ? o['showPoweredBy'] : true,
    defaultBackground: typeof o['defaultBackground'] === 'string' && /^(none|builtin:[a-z]{1,20})$/.test(o['defaultBackground']) ? o['defaultBackground'] : 'none',
    loginText: str(o['loginText'], '').slice(0, 1000),
    footerLinks: links
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .map((l) => ({ label: str(l['label'], '').trim(), url: str(l['url'], '').trim() }))
      .filter((l) => validateFooterLink(l) === null)
      .slice(0, FOOTER_LINKS_MAX),
    assets: {
      logoLight: safeAssetUrl(a['logoLight']),
      logoDark: safeAssetUrl(a['logoDark']),
      favicon: safeAssetUrl(a['favicon']),
      loginBackground: safeAssetUrl(a['loginBackground']),
    },
  };
}

/** Text content of <script id="cm-branding">; null when absent, empty or not valid JSON. */
export function parseInjectedBrandingText(text: string | null | undefined): Branding | null {
  if (!text || !text.trim()) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return parseBranding(raw);
  } catch {
    return null;
  }
}

/** Two brandings are equal for rendering purposes. */
export function sameBranding(a: Branding, b: Branding): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Upload checks (client side, mirror of the API limits) ─────────────────────

export type AssetErrorCode = 'TYPE' | 'SIZE' | 'DIMENSIONS' | 'SVG_UNSAFE';

export const ASSET_TYPES: Record<AssetSlot, readonly string[]> = {
  logoLight: ['image/png', 'image/webp', 'image/svg+xml'],
  logoDark: ['image/png', 'image/webp', 'image/svg+xml'],
  favicon: ['image/png', 'image/webp', 'image/svg+xml'],
  loginBackground: ['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg'],
};

export const ASSET_MAX_BYTES: Record<AssetSlot, number> = {
  logoLight: 512 * 1024,
  logoDark: 512 * 1024,
  favicon: 512 * 1024,
  loginBackground: 2 * 1024 * 1024,
};

/** Pre-check before the upload (the server checks again, incl. magic bytes). */
export function checkAssetFile(slot: AssetSlot, file: { type: string; size: number }): AssetErrorCode | null {
  if (!ASSET_TYPES[slot].includes(file.type)) return 'TYPE';
  if (file.size <= 0 || file.size > ASSET_MAX_BYTES[slot]) return 'SIZE';
  return null;
}

export const ASSET_ERROR_TEXT: Record<AssetErrorCode, string> = {
  TYPE: 'Dateityp nicht erlaubt.',
  SIZE: 'Datei ist zu groß.',
  DIMENSIONS: 'Bildmaße außerhalb der erlaubten Grenzen.',
  SVG_UNSAFE: 'Die SVG-Datei enthält unsichere Inhalte (Skripte, Event-Handler, externe Verweise) und wurde abgelehnt.',
};
