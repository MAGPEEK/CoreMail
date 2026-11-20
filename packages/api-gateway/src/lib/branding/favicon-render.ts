/**
 * Serves the favicons derived from the light logo (favicon.ts):
 * GET /branding/favicons/<sha256>-<64|180>.png. Kept apart from favicon.ts so the
 * pure part (index.html injection) does not load the object store.
 */
import type { PublicBranding } from '@coremail/storage';
import { loadBrandingAsset } from './app-icons.js';
import { brandingAssetCache } from './asset-cache.js';
import { DERIVED_FAVICON_FILE_RE, deriveFaviconPng, faviconSource } from './favicon.js';
import { PngUnsupportedError } from './png.js';

const inFlight = new Map<string, Promise<Buffer | null>>();
const cacheKey = (file: string) => `favicon:${file}`;

/**
 * The PNG for `<sha>-<64|180>.png`, or null when that is not an icon of the
 * current light logo (or an own favicon replaces the derived one). A logo the
 * codec cannot read is returned unchanged. Throws when the object store fails.
 */
export function renderDerivedFavicon(file: string, b: PublicBranding): Promise<Buffer | null> {
  const m = DERIVED_FAVICON_FILE_RE.exec(file);
  const src = faviconSource(b.assets);
  if (!m || src.kind !== 'logo-derived' || src.sha !== m[1]) return Promise.resolve(null);
  const cached = brandingAssetCache.get(cacheKey(file));
  if (cached) return Promise.resolve(cached);
  let job = inFlight.get(file);
  if (!job) {
    job = (async () => {
      const logo = await loadBrandingAsset(`${m[1]}.png`);
      let icon: Buffer;
      try {
        icon = deriveFaviconPng(logo, Number(m[2]));
      } catch (err) {
        if (!(err instanceof PngUnsupportedError)) throw err;
        icon = logo; // unreadable for the codec: the logo itself, as before the derivation existed
      }
      brandingAssetCache.set(cacheKey(file), icon);
      return icon;
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
  }
  return job;
}
