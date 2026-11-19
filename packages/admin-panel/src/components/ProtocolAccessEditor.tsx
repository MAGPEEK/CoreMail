/**
 * 9.4: editor of the per-protocol access switches of one level (server,
 * domain or mailbox). Domain and mailbox: Erben | An | Aus — the "inherit"
 * option shows what it resolves to; the server level is An | Aus. The last
 * column shows the effective value and the level that decides it (w2b:
 * "aus (Domain)", "an (serverweit)"). Saving sends only the changed switches.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Network } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { WriteGuard } from './Can.js';
import { useReportDirty } from './EditPanel.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import type { AdminArea } from '../lib/adminAreas.js';
import { errorMessage } from '../lib/errors.js';
import {
  changedSettings, effectiveOf, effectiveReason, locksOutWebmail, settingsForLevel,
  type EffectiveReason, type Protocol, type ProtocolLevelView, type ProtocolSetting, type ProtocolSettings,
} from '../lib/protocolAccess.js';

const LABEL_KEYS: Record<Protocol, TranslationKey> = {
  imap: 'proto_label_imap', pop3: 'proto_label_pop3', smtp: 'proto_label_smtp', activesync: 'proto_label_activesync',
  jmap: 'proto_label_jmap', dav: 'proto_label_dav', webmail: 'proto_label_webmail', mapi: 'proto_label_mapi',
};
const REASON_KEYS: Record<EffectiveReason, TranslationKey> = {
  server: 'proto_reason_server', domain: 'proto_reason_domain', user: 'proto_reason_user',
};
const HINT_KEYS: Record<ProtocolLevelView['level'], TranslationKey> = {
  global: 'proto_hint_global', domain: 'proto_hint_domain', user: 'proto_hint_user',
};

export function ProtocolAccessEditor({ path, area }: {
  /** API path of the level, e.g. /admin/protocol-access/domains/<id>. */
  path: string;
  /** Area whose write access the level needs (servers, recipients). */
  area: AdminArea;
}) {
  const t = useT();
  const qc = useQueryClient();
  const headingId = useId();
  const { data: view, isLoading, isError } = useQuery<ProtocolLevelView>({
    queryKey: ['protocol-access', path],
    queryFn: () => api.get<ProtocolLevelView>(path),
  });
  const [draft, setDraft] = useState<ProtocolSettings | null>(null);
  useEffect(() => { if (view) setDraft(view.settings); }, [view]);

  const save = useMutation({
    mutationFn: (patch: Partial<ProtocolSettings>) => api.put<ProtocolLevelView>(path, patch),
    onSuccess: (next) => {
      qc.setQueryData(['protocol-access', path], next);
      toast.success(`${t('proto_saved')} — ${t('proto_saved_users')}: ${next.changedUsers ?? 0}`);
    },
    onError: (e) => toast.error(`${t('proto_save_error')}: ${errorMessage(e)}`),
  });

  const dirty = view !== undefined && draft !== null && Object.keys(changedSettings(view.settings, draft)).length > 0;
  useReportDirty(dirty);

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-fg-subtle"><Loader2 size={14} className="animate-spin" /> {t('proto_title')}</div>;
  }
  if (isError || !view || !draft) return <p className="text-xs text-danger-fg">{t('proto_load_error')}</p>;

  const patch = changedSettings(view.settings, draft);
  const options = settingsForLevel(view.level);
  const state = (on: boolean) => (on ? t('proto_state_on') : t('proto_state_off'));
  /** "aus (Domain)", "an (serverweit)" — the effective value and the level that decides it. */
  const effectiveLabel = (on: boolean, reason: EffectiveReason | null): string =>
    reason ? `${state(on)} (${t(REASON_KEYS[reason])})` : state(on);
  const optionLabel = (s: ProtocolSetting, p: Protocol): string =>
    s === 'inherit' ? `${t('proto_setting_inherit')} (${state(view.inherited[p])})` : s === 'on' ? t('proto_setting_on') : t('proto_setting_off');

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center gap-2">
        <Network size={14} className="text-fg-subtle" aria-hidden="true" />
        <h3 id={headingId} className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{t('proto_title')}</h3>
      </div>
      <p className="text-xs text-fg-subtle">{t(HINT_KEYS[view.level])}</p>
      <WriteGuard area={area}>
        <table className="w-full text-sm border border-line rounded">
          <thead>
            <tr className="bg-surface-2 border-b border-line">
              <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-fg-subtle">{t('proto_col_protocol')}</th>
              <th scope="col" className="text-left px-3 py-1.5 text-xs font-medium text-fg-subtle">{t('proto_col_setting')}</th>
              <th scope="col" className="text-right px-3 py-1.5 text-xs font-medium text-fg-subtle">{t('proto_col_effective')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {view.protocols.map((p) => {
              const on = effectiveOf(draft[p], view.inherited[p]);
              return (
                <tr key={p}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-fg">{t(LABEL_KEYS[p])}</th>
                  <td className="px-3 py-1.5">
                    <select
                      aria-label={`${t(LABEL_KEYS[p])}: ${t('proto_col_setting')}`}
                      value={draft[p]}
                      onChange={(e) => setDraft({ ...draft, [p]: e.target.value as ProtocolSetting })}
                      className="input w-auto py-1"
                    >
                      {options.map((s) => <option key={s} value={s}>{optionLabel(s, p)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${on ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
                      {effectiveLabel(on, effectiveReason(view, p, draft[p]))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-fg-subtle">{t('proto_mapi_note')}</p>
        {locksOutWebmail(view, draft) && <p className="mt-2 text-xs text-warning-fg">{t('proto_webmail_warning')}</p>}
        <div className="flex justify-end mt-3">
          <button
            type="button"
            onClick={() => save.mutate(patch)}
            disabled={!dirty || save.isPending}
            className="btn-primary disabled:opacity-50 flex items-center gap-2"
          >
            {save.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('proto_save')}
          </button>
        </div>
      </WriteGuard>
    </section>
  );
}
