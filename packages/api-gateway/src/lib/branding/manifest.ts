/**
 * Web app manifest of the webmail (9.4) — name, colours and icons from the
 * branding, so the installed app carries the organisation's product name.
 * Pure; served as GET /manifest.webmanifest (no cache, follows branding saves).
 *
 * Icons: PNG 192×192 and 512×512.
 *  - Default: rendered from the default logo when the web client is built
 *    (web-client scripts/app-icons.mjs → /icons/), "any" and "maskable".
 *  - A custom branding favicon replaces them when the gateway can scale it
 *    (lib/branding/app-icons.ts: PNG, square, at least 512 px) — served under
 *    /branding/app-icons/, purpose "any" only (a logo of unknown shape cannot
 *    be declared maskable). Any other favicon keeps the defaults.
 */
import type { PublicBranding } from '@coremail/storage';

const FALLBACK_THEME = '#006d77';
export const APP_ICON_SIZES = [192, 512] as const;
export const APP_ICON_URL_PREFIX = '/branding/app-icons/';

export interface WebManifestIcon { src: string; sizes: string; type: string; purpose: string }

export interface WebManifest {
  name: string;
  short_name: string;
  id: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  theme_color: string;
  background_color: string;
  icons: WebManifestIcon[];
}

const png = (src: string, size: number, purpose: string): WebManifestIcon =>
  ({ src, sizes: `${size}x${size}`, type: 'image/png', purpose });

/** Built-in icons (files written by the web client build). */
export const DEFAULT_APP_ICONS: readonly WebManifestIcon[] = [
  ...APP_ICON_SIZES.map((s) => png(`/icons/app-${s}.png`, s, 'any')),
  ...APP_ICON_SIZES.map((s) => png(`/icons/app-maskable-${s}.png`, s, 'maskable')),
];

/** Icons scaled from the custom favicon with content hash `sha`. */
export function customAppIcons(sha: string): WebManifestIcon[] {
  return APP_ICON_SIZES.map((s) => png(`${APP_ICON_URL_PREFIX}${sha}-${s}.png`, s, 'any'));
}

/** The first `max` characters, never splitting a surrogate pair. */
function clipName(name: string, max: number): string {
  return Array.from(name).slice(0, max).join('').trimEnd();
}

/** `customIconSha`: hash of a favicon the gateway scales (null = default icons). */
export function webManifest(b: PublicBranding, customIconSha: string | null = null): WebManifest {
  return {
    name: b.productName,
    short_name: clipName(b.productName, 12),
    id: '/',
    start_url: '/mail',
    scope: '/',
    display: 'standalone',
    theme_color: b.headerColor ?? b.primaryColor ?? FALLBACK_THEME,
    background_color: '#ffffff',
    icons: customIconSha ? customAppIcons(customIconSha) : [...DEFAULT_APP_ICONS],
  };
}
