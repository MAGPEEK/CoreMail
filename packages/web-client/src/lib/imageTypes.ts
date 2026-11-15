/**
 * Pure helpers for loading mail images as blob: URLs (no imports, no DOM),
 * so they can be unit-tested with `node --test`.
 */

/**
 * Image types that may become blob: URLs. SVG (scriptable when opened as a
 * document), HTML and everything else are refused — a blob: URL inherits the
 * app origin, so an active type would run with access to the session.
 */
export const RASTER_IMAGE_TYPES: readonly string[] = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
];

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-bmp': 'image/bmp',
};

/** Normalised raster MIME type, or null if the type is not an allowed raster image. */
export function rasterImageType(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const t = ALIASES[base] ?? base;
  return RASTER_IMAGE_TYPES.includes(t) ? t : null;
}

/** Maximum number of external images loaded through the image proxy per mail. */
export const MAX_PROXIED_IMAGES = 50;
/** Parallel image proxy requests. */
export const PROXY_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep the
 * input order; a rejected call yields null (one broken image must not stop the rest).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array<R | null>(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
