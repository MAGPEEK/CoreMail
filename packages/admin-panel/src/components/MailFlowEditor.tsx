/**
 * 9.4: editor of the per-mailbox mail flow (user mailbox or Shared Mailbox):
 * address-list visibility, admin forwarding (+ keep a copy), accept-only-from /
 * reject-from lists and the limits that replace the global ones. Send limits
 * only for user mailboxes. Saves the whole form (PUT …/mail-flow, audited).
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Waypoints } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { WriteGuard } from './Can.js';
import { useT } from '../i18n/useT.js';
import { errorMessage } from '../lib/errors.js';
import { formFromView, patchFromForm, type MailFlowForm, type MailFlowKind, type MailFlowView } from '../lib/mailFlow.js';

export function MailFlowEditor({ path, kind }: {
  /** API path, e.g. /admin/mailboxes/<userId>/mail-flow. */
  path: string;
  kind: MailFlowKind;
}) {
  const t = useT();
  const qc = useQueryClient();
  const id = useId();
  const { data: view, isLoading, isError } = useQuery<MailFlowView>({
    queryKey: ['mail-flow', path],
    queryFn: () => api.get<MailFlowView>(path),
  });
  const [form, setForm] = useState<MailFlowForm | null>(null);
  useEffect(() => { if (view) setForm(formFromView(view)); }, [view]);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put<MailFlowView>(path, patch),
    onSuccess: (next) => { qc.setQueryData(['mail-flow', path], next); toast.success(t('mflow_saved')); },
    onError: (e) => toast.error(`${t('mflow_save_error')}: ${errorMessage(e)}`),
  });

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-fg-subtle"><Loader2 size={14} className="animate-spin" /> {t('mflow_title')}</div>;
  }
  if (isError || !view || !form) return <p className="text-xs text-danger-fg">{t('mflow_load_error')}</p>;

  const result = patchFromForm(form, kind);
  const set = (p: Partial<MailFlowForm>) => setForm({ ...form, ...p });
  const field = (name: string) => `${id}-${name}`;

  return (
    <section aria-labelledby={field('h')} className="space-y-3">
      <div className="flex items-center gap-2">
        <Waypoints size={14} className="text-fg-subtle" aria-hidden="true" />
        <h3 id={field('h')} className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{t('mflow_title')}</h3>
      </div>
      <p className="text-xs text-fg-subtle">{t('mflow_hint')}</p>
      <WriteGuard area="recipients" className="space-y-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={form.hiddenFromGal} onChange={(e) => set({ hiddenFromGal: e.target.checked })} className="rounded" />
          {t('mflow_hide_gal')}
        </label>
        <div>
          <label className="field-label" htmlFor={field('fwd')}>{t('mflow_forward')}</label>
          <input id={field('fwd')} className="input w-full" type="email" value={form.forwardTo}
            placeholder={t('mflow_forward_ph')} onChange={(e) => set({ forwardTo: e.target.value })} />
          <label className="mt-1.5 flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={form.forwardKeepCopy} disabled={!form.forwardTo.trim()}
              onChange={(e) => set({ forwardKeepCopy: e.target.checked })} className="rounded" />
            {t('mflow_keep_copy')}
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label" htmlFor={field('acc')}>{t('mflow_accept_from')}</label>
            <textarea id={field('acc')} className="input w-full font-mono text-xs" rows={3} value={form.acceptFrom}
              aria-describedby={field('lh')} onChange={(e) => set({ acceptFrom: e.target.value })} />
          </div>
          <div>
            <label className="field-label" htmlFor={field('rej')}>{t('mflow_reject_from')}</label>
            <textarea id={field('rej')} className="input w-full font-mono text-xs" rows={3} value={form.rejectFrom}
              aria-describedby={field('lh')} onChange={(e) => set({ rejectFrom: e.target.value })} />
          </div>
          <p id={field('lh')} className="col-span-2 text-[11px] text-fg-subtle">{t('mflow_list_hint')}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="field-label" htmlFor={field('mr')}>{t('mflow_max_receive')}</label>
            <input id={field('mr')} className="input w-full" inputMode="numeric" value={form.maxReceiveSizeMb}
              placeholder={t('mflow_limit_ph')} onChange={(e) => set({ maxReceiveSizeMb: e.target.value })} />
          </div>
          {kind === 'user' && (
            <>
              <div>
                <label className="field-label" htmlFor={field('ms')}>{t('mflow_max_send')}</label>
                <input id={field('ms')} className="input w-full" inputMode="numeric" value={form.maxSendSizeMb}
                  placeholder={t('mflow_limit_ph')} onChange={(e) => set({ maxSendSizeMb: e.target.value })} />
              </div>
              <div>
                <label className="field-label" htmlFor={field('mc')}>{t('mflow_max_rcpt')}</label>
                <input id={field('mc')} className="input w-full" inputMode="numeric" value={form.maxRecipients}
                  placeholder={t('mflow_limit_ph')} onChange={(e) => set({ maxRecipients: e.target.value })} />
              </div>
            </>
          )}
        </div>
        {!result.ok && (
          <p className="text-xs text-danger-fg" role="alert">
            {result.field === 'forwardTo' ? t('mflow_invalid_forward') : t('mflow_invalid_limit')}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => result.ok && save.mutate(result.patch)}
            disabled={!result.ok || save.isPending}
            className="btn-primary disabled:opacity-50 flex items-center gap-2"
          >
            {save.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('mflow_save')}
          </button>
        </div>
      </WriteGuard>
    </section>
  );
}
