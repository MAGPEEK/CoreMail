/**
 * Favicon of the webmail and the BCP, derived from the logo when no own
 * favicon is uploaded (one logo upload is enough).
 *
 *   own favicon               served as uploaded (unchanged)
 *   logo SVG                  the (sanitised) SVG itself is the favicon — there
 *                             is no rasteriser in the stack, so no PNG fallback
 *   logo PNG                  /branding/favicons/<sha>-64.png (icon) and
 *                             /branding/favicons/<sha>-180.png (apple-touch-icon):
 *                             the logo scaled into a transparent square, centred
 *   logo WebP                 the WebP itself (no pure-JS WebP decoder)
 *   nothing                   the built-in icon of the bundle stays
 *
 * The derived icons (favicon-render.ts) are rendered only for the CURRENT light logo (no resize
 * work for arbitrary stored objects), once, then kept in the branding asset LRU
 * (cleared on every branding change). A PNG the codec cannot read (16-bit,
 * interlaced, more than 2048² pixels) is served unchanged under the derived URL,
 * so the URL rule stays the same for every PNG logo — the web clients compute
 * it the same way (`faviconHref()` in web-client / admin-panel lib/branding.ts).
 */
import type { PublicBranding } from '@coremail/storage';
import { EXT_CONTENT_TYPE } from './image.js';
import { decodePng, encodePng, scaleRgba, type RgbaImage } from './png.js';

export const DERIVED_FAVICON_URL_PREFIX = '/branding/favicons/';
/** Browser tab icon and the home-screen icon of mobile browsers. */
export const DERIVED_FAVICON_SIZES = { icon: 64, appleTouch: 180 } as const;
export const DERIVED_FAVICON_FILE_RE = /^([0-9a-f]{64})-(64|180)\.png$/;
const ASSET_URL_RE = /^\/branding\/assets\/([0-9a-f]{64})\.(png|webp|svg|jpg)$/;

export type FaviconSource =
  | { kind: 'own'; href: string }
  | { kind: 'logo-derived'; sha: string }
  | { kind: 'logo'; href: string }
  | { kind: 'builtin' };

type Assets = Pick<PublicBranding['assets'], 'favicon' | 'logoLight'>;

/** Pure: where the favicon comes from (own upload → derived from the logo → built-in). */
export function faviconSource(assets: Assets): FaviconSource {
  if (assets.favicon) return { kind: 'own', href: assets.favicon };
  const m = ASSET_URL_RE.exec(assets.logoLight ?? '');
  if (!m) return { kind: 'builtin' };
  if (m[2] === 'png') return { kind: 'logo-derived', sha: m[1]! };
  return { kind: 'logo', href: assets.logoLight! };
}

export const derivedFaviconUrl = (sha: string, size: number): string => `${DERIVED_FAVICON_URL_PREFIX}${sha}-${size}.png`;

export interface FaviconLink { rel: 'icon' | 'apple-touch-icon'; type: string; href: string; sizes?: string }

const typeOf = (href: string): string => EXT_CONTENT_TYPE[href.slice(href.lastIndexOf('.') + 1)] ?? 'image/png';

/** Pure: the `<link>` tags for index.html; empty = keep the built-in icon of the bundle. */
export function faviconLinks(assets: Assets): FaviconLink[] {
  const src = faviconSource(assets);
  switch (src.kind) {
    case 'own':
    case 'logo':
      return [{ rel: 'icon', type: typeOf(src.href), href: src.href }];
    case 'logo-derived': {
      const { icon, appleTouch } = DERIVED_FAVICON_SIZES;
      return [
        { rel: 'icon', type: 'image/png', sizes: `${icon}x${icon}`, href: derivedFaviconUrl(src.sha, icon) },
        { rel: 'apple-touch-icon', type: 'image/png', sizes: `${appleTouch}x${appleTouch}`, href: derivedFaviconUrl(src.sha, appleTouch) },
      ];
    }
    default:
      return [];
  }
}

/** Pure: the image scaled (aspect ratio kept) and centred in a transparent size × size square. */
export function fitIntoSquare(img: RgbaImage, size: number): RgbaImage {
  const scale = size / Math.max(img.width, img.height);
  const w = Math.max(1, Math.min(size, Math.round(img.width * scale)));
  const h = Math.max(1, Math.min(size, Math.round(img.height * scale)));
  const scaled = w === img.width && h === img.height ? img : scaleRgba(img, w, h);
  const out = Buffer.alloc(size * size * 4); // transparent
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) scaled.data.copy(out, ((top + y) * size + left) * 4, y * w * 4, (y + 1) * w * 4);
  return { width: size, height: size, data: out };
}

/** Pure: a square PNG favicon of `size` px from a PNG logo. Throws PngUnsupportedError for PNGs the codec cannot read. */
export function deriveFaviconPng(logo: Buffer, size: number): Buffer {
  return encodePng(fitIntoSquare(decodePng(logo), size));
}
