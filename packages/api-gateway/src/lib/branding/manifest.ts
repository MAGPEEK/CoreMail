/**
 * Web app manifest of the webmail (9.4) — name, colours and icons from the
 * branding, so the installed app carries the organisation's product name.
 * Pure; served as GET /manifest.webmanifest (no cache, follows branding saves).
 *
 * Icons: the branding favicon (square by upload rule) when set, always the
 * built-in vector icon as fallback. Both are declared `sizes: "any"`.
 */
import type { PublicBranding } from '@coremail/storage';
import { EXT_CONTENT_TYPE } from './image.js';

export const BUILTIN_APP_ICON = '/favicon.svg';
const FALLBACK_THEME = '#0078d4';

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

export function webManifest(b: PublicBranding): WebManifest {
  const icons: WebManifestIcon[] = [];
  const favicon = b.assets.favicon;
  if (favicon) {
    const ext = favicon.slice(favicon.lastIndexOf('.') + 1);
    icons.push({ src: favicon, sizes: 'any', type: EXT_CONTENT_TYPE[ext] ?? 'image/png', purpose: 'any' });
  }
  icons.push({ src: BUILTIN_APP_ICON, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });
  return {
    name: b.productName,
    short_name: b.productName.slice(0, 12),
    id: '/',
    start_url: '/mail',
    scope: '/',
    display: 'standalone',
    theme_color: b.headerColor ?? b.primaryColor ?? FALLBACK_THEME,
    background_color: '#ffffff',
    icons,
  };
}
