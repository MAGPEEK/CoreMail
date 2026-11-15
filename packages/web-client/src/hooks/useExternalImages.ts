import { useEffect, useState } from 'react';
import { fetchBlob } from '../api/client.js';
import {
  rasterImageType, mapLimit, MAX_PROXIED_IMAGES, PROXY_CONCURRENCY,
} from '../lib/imageTypes.js';

/** API path of the server-side image proxy (Authorization header required). */
export function imageProxyPath(url: string): string {
  return `/mail/image-proxy?url=${encodeURIComponent(url)}`;
}

/**
 * "Show images": loads the external images of a mail through the server-side
 * image proxy (the CSP img-src does not allow arbitrary hosts, and the proxy
 * hides the reader's IP address) and exposes them as blob: URLs.
 *
 * - only while `enabled` (the user clicked "show images")
 * - at most MAX_PROXIED_IMAGES images, PROXY_CONCURRENCY requests in parallel
 * - only raster images; the blob is re-wrapped with the normalised raster type
 * - object URLs are revoked when the inputs change or on unmount
 */
export function useExternalImages(urls: readonly string[], enabled: boolean): ReadonlyMap<string, string> {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = enabled ? [...new Set(urls)].slice(0, MAX_PROXIED_IMAGES) : [];
  const key = wanted.join('\n');

  useEffect(() => {
    if (!key) { setMap(new Map()); return; }
    let cancelled = false;
    const created: string[] = [];
    void mapLimit(wanted, PROXY_CONCURRENCY, async (url) => {
      if (cancelled) return null;
      const blob = await fetchBlob(imageProxyPath(url));
      if (cancelled) return null;
      const type = rasterImageType(blob.type);
      if (!type) return null;
      const objectUrl = URL.createObjectURL(new Blob([blob], { type }));
      created.push(objectUrl);
      return [url, objectUrl] as const;
    }).then((entries) => {
      if (cancelled) return;
      setMap(new Map(entries.filter((e): e is readonly [string, string] => e !== null)));
    });
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // `wanted` is derived from `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}
