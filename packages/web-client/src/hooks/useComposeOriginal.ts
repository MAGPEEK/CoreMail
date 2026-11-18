/**
 * Original message of a reply / forward: its Message-ID for threading, its
 * header and body for the quote (when the compose context carries none, e.g.
 * the list context menu), and — forward — its attachments, fetched with the
 * Authorization header and attached again as files (the user can remove them).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, fetchBlob } from '../api/client.js';
import type { Message } from '../api/types.js';
import { mailApiBase, type MailboxRef } from '../lib/mailboxContext.js';
import { isReplyMode, type ComposeMode } from '../lib/composeQuote.js';
import { fmt, translate } from '../i18n/useT.js';

export function useComposeOriginal(o: { mode: ComposeMode; id: string | undefined; mailbox: MailboxRef }) {
  const originalId = isReplyMode(o.mode) || o.mode === 'forward' ? o.id : undefined;
  const query = useQuery({
    queryKey: ['message', originalId],
    queryFn: () => api.get<Message>(`${mailApiBase(o.mailbox)}/messages/${originalId}?markRead=false`),
    enabled: !!originalId,
    retry: false,
  });
  return { originalId, original: query.data, loading: !!originalId && query.isLoading };
}

/** Forward: the original's attachments as files, once (`enabled` false for a restored mail). */
export function useForwardAttachments(o: {
  enabled: boolean;
  original: Message | undefined;
  add: (files: File[]) => void;
}): boolean {
  const [loading, setLoading] = useState(false);
  const attached = useRef(false);
  const add = useRef(o.add);
  add.current = o.add;
  useEffect(() => {
    if (!o.enabled || !o.original || attached.current) return;
    attached.current = true;
    const list = o.original.attachments ?? [];
    if (list.length === 0) return;
    let cancelled = false;
    let done = false;
    setLoading(true);
    void Promise.all(list.map(async (a) => {
      try {
        const blob = await fetchBlob(`/mail/attachments/${a.id}`);
        return new File([blob], a.filename || 'attachment', { type: a.mimeType || blob.type || 'application/octet-stream' });
      } catch {
        return null;
      }
    })).then((files) => {
      if (cancelled) return;
      done = true;
      const ok = files.filter((f): f is File => f !== null);
      if (ok.length < list.length) toast.error(fmt(translate('compose_forward_attach_failed'), { n: list.length - ok.length }));
      add.current(ok);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      if (done) return;
      // Unmounted / re-run before the files arrived → allow a fresh attempt
      cancelled = true;
      attached.current = false;
      setLoading(false);
    };
  }, [o.enabled, o.original]);
  return loading;
}
