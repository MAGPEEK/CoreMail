/**
 * Branding (9.3) — global singleton `Branding` row → the public branding object.
 *
 * `getBranding()` reads the row (never throws: database errors and a missing row
 * give the environment defaults), `toPublicBranding()` maps a row to the shape of
 * `GET /api/v1/branding` (docs/plans/branding-9.3.md, "API contract"). Defaults
 * when nothing is stored: BRANDING_NAME / BRANDING_COLOR, else "CoreMail" /
 * #006d77 (10.7: petrol, the built-in accent of the web client). `ServerSettings.orgName` stays
 * the organisation name; the product name is what the UI and system texts show.
 *
 * Validation rules shared by the admin API and the environment defaults live
 * here too (pure functions, no database).
 */
import { prisma } from './prisma/index.js';
import { normalizeDefaultBackground, type DefaultBackground } from './user-background.js';

export const DEFAULT_PRODUCT_NAME = 'CoreMail';
export const DEFAULT_PRIMARY_COLOR = '#006d77';
export const BRANDING_ASSET_SLOTS = ['logoLight', 'logoDark', 'favicon', 'loginBackground'] as const;
export type BrandingAssetSlot = typeof BRANDING_ASSET_SLOTS[number];

export const PRODUCT_NAME_MAX = 40;
export const LOGIN_TEXT_MAX = 280;
export const FOOTER_LINKS_MAX = 5;
export const FOOTER_LABEL_MAX = 40;
export const FOOTER_URL_MAX = 500;

/** Path prefix of branding assets in the object store. */
export const BRANDING_KEY_PREFIX = 'branding/';
/** Public URL prefix of branding assets (served by the api-gateway). */
export const BRANDING_ASSET_URL_PREFIX = '/branding/assets/';
/** `<sha256>.<ext>` — the only file names the asset route serves. */
export const BRANDING_ASSET_FILE_RE = /^[0-9a-f]{64}\.(png|webp|svg|jpg)$/;

export interface BrandingFooterLink { label: string; url: string }

export interface PublicBranding {
  version: number;
  productName: string;
  primaryColor: string | null;
  headerColor: string | null;
  allowUserAccent: boolean;
  showPoweredBy: boolean;
  /** 10.1: webmail background of users without an own choice */
  defaultBackground: DefaultBackground;
  loginText: string;
  footerLinks: BrandingFooterLink[];
  assets: Record<BrandingAssetSlot, string | null>;
}

/** The stored row (subset of the Prisma model the mapping needs). */
export interface BrandingRow {
  version: number;
  productName: string | null;
  primaryColor: string | null;
  headerColor: string | null;
  logoLightKey: string | null;
  logoDarkKey: string | null;
  faviconKey: string | null;
  loginBackgroundKey: string | null;
  loginText: string;
  footerLinks: unknown;
  allowUserAccent: boolean;
  showPoweredBy: boolean;
  /** 10.1 (optional: rows of older callers / fakes) */
  defaultBackground?: string | null;
}

// ── Validation (pure) ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/;

/** Trimmed product name or null when invalid (1–40 characters, no control characters). */
export function normalizeProductName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length < 1 || [...s].length > PRODUCT_NAME_MAX || CONTROL_CHARS.test(s)) return null;
  return s;
}

/** `#rrggbb` (lower case) or null when not a 6-digit hex colour. */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) return null;
  return v.trim().toLowerCase();
}

/** Plain-text login text (≤ 280 characters, newlines allowed, other control characters not). */
export function normalizeLoginText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').trim();
  if ([...s].length > LOGIN_TEXT_MAX || CONTROL_EXCEPT_NEWLINE.test(s)) return null;
  return s;
}

/** Characters never allowed in a footer URL (besides CONTROL_CHARS). */
const URL_FORBIDDEN = /[\s<>"'`\\]/;
const MAILTO_RE = /^mailto:[^@/?#]+@[^@/?#]+\.[^@/?#]+(\?[^#]*)?$/i;

/**
 * https:// or mailto: URL (≤ 500 characters) or null. Same rule as the
 * frontend `validateFooterLink` (web-client / admin-panel lib/branding.ts):
 * no whitespace, control characters, quotes, backticks, angle brackets or
 * backslashes; mailto: needs `local@domain.tld`; https:// needs a host and no
 * user info (`https://user:pw@host`).
 */
export function normalizeFooterUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > FOOTER_URL_MAX || CONTROL_CHARS.test(s) || URL_FORBIDDEN.test(s)) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith('mailto:')) return MAILTO_RE.test(s) ? s : null;
  if (!lower.startsWith('https://')) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return s;
}

/**
 * Footer links → normalised list, or `{ error }` naming the first problem.
 * Max 5 entries, label 1–40 characters, URL https:// or mailto:.
 */
export function normalizeFooterLinks(v: unknown): BrandingFooterLink[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'footerLinks must be an array' };
  if (v.length > FOOTER_LINKS_MAX) return { error: `at most ${FOOTER_LINKS_MAX} footer links` };
  const out: BrandingFooterLink[] = [];
  for (const [i, item] of v.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `footerLinks[${i}] must be { label, url }` };
    const o = item as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => k !== 'label' && k !== 'url');
    if (extra.length) return { error: `footerLinks[${i}]: unknown field ${extra[0]}` };
    const label = typeof o['label'] === 'string' ? o['label'].trim() : '';
    if (!label || [...label].length > FOOTER_LABEL_MAX || CONTROL_CHARS.test(label)) {
      return { error: `footerLinks[${i}].label must be 1–${FOOTER_LABEL_MAX} characters` };
    }
    const url = normalizeFooterUrl(o['url']);
    if (!url) return { error: `footerLinks[${i}].url must be an https:// or mailto: URL` };
    out.push({ label, url });
  }
  return out;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export interface BrandingDefaults { productName: string; primaryColor: string }

/** BRANDING_NAME / BRANDING_COLOR when valid, else "CoreMail" / #006d77. */
export function brandingDefaults(env: Record<string, string | undefined> = process.env): BrandingDefaults {
  return {
    productName: normalizeProductName(env['BRANDING_NAME']) ?? DEFAULT_PRODUCT_NAME,
    primaryColor: normalizeHexColor(env['BRANDING_COLOR']) ?? DEFAULT_PRIMARY_COLOR,
  };
}

// ── Mapping ───────────────────────────────────────────────────────────────────

/** `branding/<sha256>.<ext>` → `/branding/assets/<sha256>.<ext>` (null for anything else). */
export function brandingAssetUrl(key: string | null | undefined): string | null {
  if (!key || !key.startsWith(BRANDING_KEY_PREFIX)) return null;
  const file = key.slice(BRANDING_KEY_PREFIX.length);
  return BRANDING_ASSET_FILE_RE.test(file) ? `${BRANDING_ASSET_URL_PREFIX}${file}` : null;
}

/** Stored links: entries that do not (or no longer) pass the rules are dropped one by one. */
function storedFooterLinks(v: unknown): BrandingFooterLink[] {
  if (!Array.isArray(v)) return [];
  const out: BrandingFooterLink[] = [];
  for (const item of v.slice(0, FOOTER_LINKS_MAX)) {
    const r = normalizeFooterLinks([item]);
    if (Array.isArray(r) && r[0]) out.push(r[0]);
  }
  return out;
}

/** Row (or null = nothing stored) → public branding object. */
export function toPublicBranding(row: BrandingRow | null, env: Record<string, string | undefined> = process.env): PublicBranding {
  const d = brandingDefaults(env);
  return {
    version: row?.version ?? 0,
    productName: normalizeProductName(row?.productName) ?? d.productName,
    primaryColor: normalizeHexColor(row?.primaryColor) ?? d.primaryColor,
    headerColor: normalizeHexColor(row?.headerColor),
    allowUserAccent: row?.allowUserAccent ?? true,
    showPoweredBy: row?.showPoweredBy ?? true,
    defaultBackground: normalizeDefaultBackground(row?.defaultBackground) ?? 'none',
    loginText: row?.loginText ?? '',
    footerLinks: storedFooterLinks(row?.footerLinks ?? []),
    assets: {
      logoLight: brandingAssetUrl(row?.logoLightKey),
      logoDark: brandingAssetUrl(row?.logoDarkKey),
      favicon: brandingAssetUrl(row?.faviconKey),
      loginBackground: brandingAssetUrl(row?.loginBackgroundKey),
    },
  };
}

/** The stored row or null. Throws on database errors (callers that must not fail use getBranding()). */
export async function loadBrandingRow(): Promise<BrandingRow | null> {
  return (await prisma.branding.findUnique({ where: { id: 'singleton' } })) as BrandingRow | null;
}

/** Public branding; environment defaults when no row exists or the database is unavailable. */
export async function getBranding(): Promise<PublicBranding> {
  try {
    return toPublicBranding(await loadBrandingRow());
  } catch {
    return toPublicBranding(null);
  }
}

/** Product name for system texts (notifications, mails, profiles). Never throws. */
export async function getProductName(): Promise<string> {
  return (await getBranding()).productName;
}

/**
 * Name shown as the provider / account label in client profiles (Apple
 * profile, Thunderbird autoconfig): the product name once it is branded,
 * otherwise the organisation name (as before 9.3), falling back to the product name.
 */
export function brandDisplayName(productName: string, orgName: string | null | undefined): string {
  if (productName !== DEFAULT_PRODUCT_NAME) return productName;
  return orgName?.trim() || productName;
}
