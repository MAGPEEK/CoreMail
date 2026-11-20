// BCP → SMTP & Routing → Sendelimit (10.5): per-account outgoing messages /
// recipients per hour for every submission path (storage submission-rate.ts),
// optional temporary send block. Own API: /admin/smtp-config/send-rate.
import { useEffect, useId, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from './Toggle.js';
import { WriteGuard } from './Can.js';
import { useT } from '../i18n/useT.js';
import { errorMessage } from '../lib/errors.js';
import { sendRateForm, sendRatePayload, SEND_RATE_LIMITS, type SendRateForm, type SendRateView } from '../lib/sendRate.js';

const inputCls = 'w-full border border-line-strong rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg';
const QUERY_KEY = ['admin', 'smtp-config', 'send-rate'];

export function SendRateSection() {
  const t = useT();
  const qc = useQueryClient();
  const ids = { messages: useId(), recipients: useId(), recipientsHint: useId() };
  const { data } = useQuery<SendRateView>({
    queryKey: QUERY_KEY,
    queryFn:  () => api.get<SendRateView>('/admin/smtp-config/send-rate'),
  });
  const [form, setForm] = useState<SendRateForm | null>(null);
  useEffect(() => { if (data) setForm(sendRateForm(data)); }, [data]);

  const save = useMutation({
    mutationFn: (body: SendRateView) => api.put<SendRateView>('/admin/smtp-config/send-rate', body),
    onSuccess: () => {
      toast.success(t('srate_saved'));
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) => toast.error(errorMessage(e, t('srate_save_error'))),
  });

  if (!data || !form) return <div className="text-sm text-fg-subtle">{t('srate_loading')}</div>;
  const set = <K extends keyof SendRateForm>(k: K, v: SendRateForm[K]) => setForm({ ...form, [k]: v });
  const submit = () => {
    const checked = sendRatePayload(form);
    if (!checked.ok) { toast.error(t('srate_invalid')); return; }
    save.mutate(checked.value);
  };

  return (
    <WriteGuard area="servers">
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-fg">{t('srate_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('srate_subtitle')}</p>
          </div>
          <button onClick={submit} disabled={save.isPending} className="btn-primary text-sm disabled:opacity-50">
            {save.isPending ? 'Speichern…' : 'Speichern'}
          </button>
        </div>

        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-fg">{t('srate_enabled')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{t('srate_enabled_hint')}</p>
            </div>
            <Toggle active={form.enabled} label={t('srate_enabled')} onToggle={() => set('enabled', !form.enabled)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={ids.messages} className="block text-xs font-medium text-fg-muted mb-1">{t('srate_messages')}</label>
              <input id={ids.messages} type="number" min={SEND_RATE_LIMITS.messagesPerHour[0]} max={SEND_RATE_LIMITS.messagesPerHour[1]}
                value={form.messagesPerHour} disabled={!form.enabled}
                onChange={(e) => set('messagesPerHour', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor={ids.recipients} className="block text-xs font-medium text-fg-muted mb-1">{t('srate_recipients')}</label>
              <input id={ids.recipients} type="number" min={SEND_RATE_LIMITS.recipientsPerHour[0]} max={SEND_RATE_LIMITS.recipientsPerHour[1]}
                value={form.recipientsPerHour} disabled={!form.enabled} aria-describedby={ids.recipientsHint}
                onChange={(e) => set('recipientsPerHour', e.target.value)} className={inputCls} />
            </div>
            <p id={ids.recipientsHint} className="col-span-2 text-[11px] text-fg-subtle">{t('srate_recipients_hint')}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-fg">{t('srate_block')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{t('srate_block_hint')}</p>
            </div>
            <Toggle active={form.blockOnExceed} label={t('srate_block')} disabled={!form.enabled}
              onToggle={() => set('blockOnExceed', !form.blockOnExceed)} />
          </div>
        </div>

        <div className="bg-info-bg border border-info-line rounded-lg px-4 py-3 text-xs text-info-fg flex items-start gap-2">
          <Info size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('srate_info')}</span>
        </div>
      </div>
    </WriteGuard>
  );
}
