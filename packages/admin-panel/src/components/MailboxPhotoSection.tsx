/**
 * 9.5: profile photo of a mailbox in the BCP detail panel — the photo (fetched
 * with the Authorization header as a blob: URL) and "Foto entfernen" for
 * admins with write access to the recipients area
 * (DELETE /admin/mailboxes/:id/photo, audited as mailbox.photo.remove).
 * Nothing is shown when the account has no photo.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageOff, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, fetchBlob } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { Can } from './Can.js';

export interface MailboxPhoto { userId: string; version: string; updatedAt: string | null }

export function MailboxPhotoSection({ userId, email, photo }: { userId: string; email: string; photo: MailboxPhoto }) {
  const t = useT();
  const qc = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchBlob(`/admin/mailboxes/${encodeURIComponent(userId)}/photo?v=${encodeURIComponent(photo.version)}`).then((blob) => {
      if (cancelled || blob.type !== 'image/jpeg') return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, () => setUrl(null));
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [userId, photo.version]);

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/mailboxes/${encodeURIComponent(userId)}/photo`),
    onSuccess: () => {
      toast.success(t('mbox_photo_removed'));
      void qc.invalidateQueries({ queryKey: ['admin-mailbox-detail'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section aria-label={t('mbox_photo_title')} className="flex items-center gap-3">
      <div className="w-16 h-16 rounded-full overflow-hidden bg-surface-2 shrink-0 flex items-center justify-center">
        {url
          ? <img src={url} alt={`${t('mbox_photo_title')}: ${email}`} className="w-full h-full object-cover" />
          : <Loader2 size={16} className="animate-spin text-fg-subtle" aria-hidden="true" />}
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium text-fg-subtle">{t('mbox_photo_title')}</h3>
        <Can area="recipients" access="write">
          <button type="button" className="btn-secondary text-xs flex items-center gap-1 text-danger-fg" disabled={remove.isPending}
            onClick={() => { if (confirm(`${t('mbox_photo_remove_confirm')}\n\n${email}`)) remove.mutate(); }}>
            <ImageOff size={12} aria-hidden="true" /> {t('mbox_photo_remove')}
          </button>
        </Can>
      </div>
    </section>
  );
}
