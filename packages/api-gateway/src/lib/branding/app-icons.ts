/**
 * App icons from a custom branding favicon (9.4).
 *
 *   appIconSha(branding)        content hash of the current favicon when the
 *                               gateway can scale it (PNG, 8-bit, non-interlaced,
 *                               square, at least 512 px), else null → the
 *                               manifest keeps the default icons
 *   renderAppIcon(file)         GET /branding/app-icons/<sha>-<192|512>.png —
 *                               only for the CURRENT favicon (no resize work for
 *                               arbitrary stored objects); scaled once, then
 *                               kept in the branding asset LRU (cleared on
 *                               every branding change)
 *
 * Pure JavaScript scaling (png.ts). WebP / SVG favicons keep the defaults —
 * scaling them would need a native image library.
 */
import { BRANDING_KEY_PREFIX, getObjectStore, type PublicBranding } from '@coremail/storage';
import { brandingAssetCache } from './asset-cache.js';
import { APP_ICON_SIZES } from './manifest.js';
import { decodePng, encodePng, isDecodable, readPngHeader, resizeRgba } from './png.js';

export const APP_ICON_FILE_RE = /^([0-9a-f]{64})-(192|512)\.png$/;
const FAVICON_PNG_RE = /\/([0-9a-f]{64})\.png$/;
const MIN_SOURCE_PX = Math.max(...APP_ICON_SIZES);

/** A branding asset by its file name (`<sha256>.<ext>`), through the shared LRU. */
export async function loadBrandingAsset(file: string): Promise<Buffer> {
  const hit = brandingAssetCache.get(file);
  if (hit) return hit;
  const data = await getObjectStore().get(`${BRANDING_KEY_PREFIX}${file}`);
  brandingAssetCache.set(file, data);
  return data;
}

/** Pure: can this favicon become the app icons (checked by decoding it)? */
export function scalableFavicon(buf: Buffer): boolean {
  const h = readPngHeader(buf);
  if (!h || !isDecodable(h) || h.width !== h.height || h.width < MIN_SOURCE_PX) return false;
  try {
    decodePng(buf);
    return true;
  } catch {
    return false; // truncated / corrupt: keep the default icons
  }
}

/** Verdicts per favicon hash (assets are immutable; bounded, a branding change adds one). */
const verdicts = new Map<string, boolean>();
const MAX_VERDICTS = 32;

/** Hash of the current favicon when it can become the app icons, else null. */
export async function appIconSha(b: PublicBranding): Promise<string | null> {
  const sha = FAVICON_PNG_RE.exec(b.assets.favicon ?? '')?.[1];
  if (!sha) return null;
  let ok = verdicts.get(sha);
  if (ok === undefined) {
    try {
      ok = scalableFavicon(await loadBrandingAsset(`${sha}.png`));
    } catch {
      return null; // unreadable object → default icons for now (the asset route reports the error)
    }
    if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
    verdicts.set(sha, ok);
  }
  return ok ? sha : null;
}

const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * The PNG for `<sha>-<size>.png`, or null when that is not an icon of the
 * current favicon. Throws when the object store fails.
 */
export function renderAppIcon(file: string, b: PublicBranding): Promise<Buffer | null> {
  const m = APP_ICON_FILE_RE.exec(file);
  if (!m || FAVICON_PNG_RE.exec(b.assets.favicon ?? '')?.[1] !== m[1]) return Promise.resolve(null);
  const cached = brandingAssetCache.get(file);
  if (cached) return Promise.resolve(cached);
  let job = inFlight.get(file);
  if (!job) {
    job = (async () => {
      const source = await loadBrandingAsset(`${m[1]}.png`);
      if (!scalableFavicon(source)) return null;
      const icon = encodePng(resizeRgba(decodePng(source), Number(m[2])));
      brandingAssetCache.set(file, icon);
      return icon;
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
  }
  return job;
}
