import { useEffect, useState } from 'react';
import { fetchBlob } from '../api/client.js';
import { normalizeCid } from '../lib/mailHtmlCss.js';
import { referencedCids } from '../lib/mailHtml.js';

interface InlineAttachment {
  id: string;
  contentId?: string | null;
}

/**
 * Loads the inline (cid:) images of a mail with the Authorization header and
 * exposes them as blob: URLs — no access token in image URLs.
 * Only attachments that the HTML actually references are fetched.
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
    .map((a) => ({ id: a.id, cid: normalizeCid(a.contentId!) }));
  const key = targets.map((t) => `${t.cid}=${t.id}`).join('|');

  useEffect(() => {
    if (!key) { setMap(new Map()); return; }
    let cancelled = false;
    const created: string[] = [];
    void Promise.all(targets.map(async (t) => {
      try {
        const blob = await fetchBlob(urlFor(t.id));
        if (cancelled) return null;
        const url = URL.createObjectURL(blob);
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
