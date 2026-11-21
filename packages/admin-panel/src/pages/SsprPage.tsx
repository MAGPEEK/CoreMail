/**
 * 10.6: BCP → Authentifizierung → Passwort-Zurücksetzung. Self-service password
 * reset: the switch, the two delivery methods (confirmed external recovery
 * address; own mailbox — skipped automatically while others can read it), the
 * admin exclusion, and how many accounts have a confirmed recovery address.
 * Server: api-gateway GET/PUT /admin/settings/password-reset (area organisation),
 * docs/password-reset.md. Each switch saves at once (audited server-side).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';

interface SsprView {
  enabled: boolean;
  recoveryEmail: boolean;
  ownMailbox: boolean;
  allowAdmins: boolean;
  available: boolean;
  stats: { usersWithRecoveryEmail: number | null; localUsers: number | null; adminAccounts: number | null };
}

type SsprPatch = Partial<Pick<SsprView, 'enabled' | 'recoveryEmail' | 'ownMailbox' | 'allowAdmins'>>;

function SwitchRow({ id, title, hint, active, disabled, onToggle }: {
  id: string; title: string; hint: string; active: boolean; disabled: boolean; onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p id={id} className="text-sm font-medium text-fg">{title}</p>
        <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>
      </div>
      <Toggle active={active} disabled={disabled} label={title} onToggle={onToggle} />
    </div>
  );
}

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(n));

export function SsprPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('organisation', 'write');

  const { data: s, refetch, isError } = useQuery<SsprView>({
    queryKey: ['admin-sspr'],
    queryFn: () => api.get('/admin/settings/password-reset'),
  });

  const save = useMutation({
    mutationFn: (patch: SsprPatch) => api.put<SsprView>('/admin/settings/password-reset', patch),
    onSuccess: (r) => { qc.setQueryData(['admin-sspr'], r); toast.success(t('sspr_saved')); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isError) return <div className="p-6 text-sm text-danger-fg">{t('sspr_load_failed')}</div>;
  if (!s) return <div className="p-6 text-sm text-fg-subtle">…</div>;

  const busy = !canWrite || save.isPending;
  const noMethod = s.enabled && !s.recoveryEmail && !s.ownMailbox;

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('sspr_title')}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('sspr_intro')}</p>
        </div>
        <button
          type="button" aria-label={t('action_refresh')} title={t('action_refresh')}
          onClick={() => { void refetch(); }}
          className="p-2 text-fg-subtle border border-line-strong rounded hover:bg-surface-2"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Master switch */}
      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="sspr-switch">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="sspr-switch" className="text-sm font-semibold text-fg">{t('sspr_switch_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('sspr_switch_hint')}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`text-xs px-2 py-0.5 rounded-full ${s.available ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
              {s.available ? t('sspr_status_on') : t('sspr_status_off')}
            </span>
            <Toggle active={s.enabled} disabled={busy} label={t('sspr_switch_title')} onToggle={() => save.mutate({ enabled: !s.enabled })} />
          </div>
        </div>
        {noMethod && (
          <div role="status" className="flex items-center gap-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
            <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
            {t('sspr_no_method_warn')}
          </div>
        )}
      </section>

      {/* Methods */}
      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="sspr-methods">
        <h2 id="sspr-methods" className="text-sm font-semibold text-fg">{t('sspr_methods_title')}</h2>
        <SwitchRow
          id="sspr-recovery" title={t('sspr_method_recovery')} hint={t('sspr_method_recovery_hint')}
          active={s.recoveryEmail} disabled={busy} onToggle={() => save.mutate({ recoveryEmail: !s.recoveryEmail })}
        />
        <SwitchRow
          id="sspr-mailbox" title={t('sspr_method_mailbox')} hint={t('sspr_method_mailbox_hint')}
          active={s.ownMailbox} disabled={busy} onToggle={() => save.mutate({ ownMailbox: !s.ownMailbox })}
        />
      </section>

      {/* Admin accounts */}
      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="sspr-admins">
        <h2 id="sspr-admins" className="text-sm font-semibold text-fg">{t('sspr_admins_title')}</h2>
        <SwitchRow
          id="sspr-admins-switch" title={t('sspr_admins_switch')} hint={t('sspr_admins_hint')}
          active={s.allowAdmins} disabled={busy} onToggle={() => save.mutate({ allowAdmins: !s.allowAdmins })}
        />
        {s.allowAdmins && (
          <div role="status" className="flex items-center gap-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
            <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
            {t('sspr_admins_warn')}
          </div>
        )}
      </section>

      {/* Figures */}
      <section className="bg-surface border border-line rounded p-5" aria-labelledby="sspr-stats">
        <h2 id="sspr-stats" className="text-sm font-semibold text-fg mb-3">{t('sspr_stats_title')}</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="bg-surface-2 rounded px-3 py-2">
            <dt className="text-xs text-fg-subtle">{t('sspr_stats_recovery')}</dt>
            <dd className="text-lg font-semibold text-fg">{num(s.stats.usersWithRecoveryEmail)}</dd>
          </div>
          <div className="bg-surface-2 rounded px-3 py-2">
            <dt className="text-xs text-fg-subtle">{t('sspr_stats_local')}</dt>
            <dd className="text-lg font-semibold text-fg">{num(s.stats.localUsers)}</dd>
          </div>
          <div className="bg-surface-2 rounded px-3 py-2">
            <dt className="text-xs text-fg-subtle">{s.allowAdmins ? t('sspr_stats_admins_included') : t('sspr_stats_admins_excluded')}</dt>
            <dd className="text-lg font-semibold text-fg">{num(s.stats.adminAccounts)}</dd>
          </div>
        </dl>
      </section>

      {/* Notes */}
      <section className="bg-surface border border-line rounded p-5" aria-labelledby="sspr-notes">
        <h2 id="sspr-notes" className="flex items-center gap-2 text-sm font-semibold text-fg mb-2">
          <Info size={14} aria-hidden="true" /> {t('sspr_notes_title')}
        </h2>
        <ul className="list-disc pl-5 space-y-1 text-xs text-fg-muted">
          <li>{t('sspr_note_mfa')}</li>
          <li>{t('sspr_note_directory')}</li>
          <li>{t('sspr_note_link')}</li>
          <li>{t('sspr_note_notify')}</li>
          <li>{t('sspr_note_users')}</li>
        </ul>
      </section>
    </div>
  );
}
