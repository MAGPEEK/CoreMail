import { useEffect, useState } from 'react';
import { fetchBlob } from '../api/client.js';
import { normalizeCid } from '../lib/mailHtmlCss.js';
import { referencedCids } from '../lib/mailHtml.js';
import { rasterImageType } from '../lib/imageTypes.js';

interface InlineAttachment {
  id: string;
  contentId?: string | null;
  mimeType?: string | null;
}

/**
 * Loads the inline (cid:) images of a mail with the Authorization header and
 * exposes them as blob: URLs — no access token in image URLs.
 * Only attachments that the HTML actually references are fetched, and only
 * raster images (png/jpeg/gif/webp/bmp/avif): the blob is re-wrapped with the
 * normalised raster type, so an SVG/HTML part declared by the sender can never
 * become an app-origin blob: document.
 * Object URLs are revoked when the message changes or the component unmounts.
 */
export function useInlineImages(
  html: string | undefined,
  attachments: InlineAttachment[] | undefined,
  urlFor: (attachmentId: string) => string = (id) => `/mail/attachments/${id}`,
): ReadonlyMap<string, string> {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(new Map());

  // Stable key so the effect only re-runs when the relevant inputs change
  const wanted = html ? new Set(referencedCids(html)) : new Set<string>();
  const targets = (attachments ?? [])
    .filter((a) => a.contentId && wanted.has(normalizeCid(a.contentId)))
    .filter((a) => a.mimeType == null || rasterImageType(a.mimeType) !== null)
    .map((a) => ({ id: a.id, cid: normalizeCid(a.contentId!), mimeType: a.mimeType ?? null }));
  const key = targets.map((t) => `${t.cid}=${t.id}`).join('|');

  useEffect(() => {
    if (!key) { setMap(new Map()); return; }
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(targets.map(async (t) => {
      try {
        const blob = await fetchBlob(urlFor(t.id));
        if (cancelled) return null;
        const type = rasterImageType(blob.type) ?? rasterImageType(t.mimeType);
        if (!type) return null; // not a raster image → stays a placeholder
        const url = URL.createObjectURL(new Blob([blob], { type }));
        created.push(url);
        return [t.cid, url] as const;
      } catch {
        return null; // stays a placeholder
      }
    })).then((entries) => {
      if (cancelled) return;
      setMap(new Map(entries.filter((e): e is readonly [string, string] => e !== null)));
    });
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // targets/urlFor are derived from `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}
