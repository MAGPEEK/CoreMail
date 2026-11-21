/**
 * 10.6: BCP → Authentifizierung → Selbstregistrierung (docs/self-registration.md).
 * Server: api-gateway routes/admin/self-registration.ts (area recipients).
 *
 *  - Registration settings (switch, allowed domains, approval mode, invite
 *    requirement) and invite codes: organisation-wide admins only (a scoped
 *    admin gets 403 from the server; the sections are not shown).
 *  - Pending approvals: every admin with read access to recipients sees the
 *    accounts of its scope; approve / reject need write access.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Check, Copy, KeyRound, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import {
  INVITE_DEFAULTS, inviteFormError, sameIds, type InviteStatus, type InviteView, type PendingView,
  type SelfRegistrationMode, type SelfRegistrationView,
} from '../lib/selfRegistration.js';

const fmtDate = (iso: string | null): string =>
  (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function SelfRegistrationPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can, scoped, ready } = usePermissions();
  const canWrite = can('recipients', 'write');
  const orgWide = ready && !scoped;

  const { data: s, refetch: refetchSettings } = useQuery<SelfRegistrationView>({
    queryKey: ['admin-selfreg-settings'],
    queryFn: () => api.get('/admin/self-registration/settings'),
    enabled: orgWide,
  });
  const { data: inviteData, refetch: refetchInvites } = useQuery<{ invites: InviteView[] }>({
    queryKey: ['admin-selfreg-invites'],
    queryFn: () => api.get('/admin/self-registration/invites'),
    enabled: orgWide,
  });
  const { data: pendingData, refetch: refetchPending } = useQuery<{ pending: PendingView[] }>({
    queryKey: ['admin-selfreg-pending'],
    queryFn: () => api.get('/admin/self-registration/pending'),
    refetchInterval: 60_000,
  });

  // Local draft of the settings form
  const [enabled, setEnabled] = useState(false);
  const [domainIds, setDomainIds] = useState<string[]>([]);
  const [mode, setMode] = useState<SelfRegistrationMode>('approval');
  const [inviteOnly, setInviteOnly] = useState(false);
  useEffect(() => {
    if (!s) return;
    setEnabled(s.enabled); setDomainIds(s.domainIds); setMode(s.mode); setInviteOnly(s.inviteOnly);
  }, [s]);
  const dirty = !!s && (enabled !== s.enabled || mode !== s.mode || inviteOnly !== s.inviteOnly || !sameIds(domainIds, s.domainIds));

  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number>(INVITE_DEFAULTS.days);
  const [uses, setUses] = useState<number>(INVITE_DEFAULTS.uses);
  const [created, setCreated] = useState<string | null>(null);
  const inviteError = inviteFormError(days, uses);

  const saveSettings = useMutation({
    mutationFn: () => api.put<SelfRegistrationView>('/admin/self-registration/settings', { enabled, domainIds, mode, inviteOnly }),
    onSuccess: (v) => { toast.success(t('sr_saved')); qc.setQueryData(['admin-selfreg-settings'], v); },
    onError: (e: Error) => toast.error(e.message),
  });
  const createInvite = useMutation({
    mutationFn: () => api.post<{ code: string }>('/admin/self-registration/invites', {
      ...(label.trim() ? { label: label.trim() } : {}), expiresInDays: days, maxUses: uses,
    }),
    onSuccess: (r) => { setCreated(r.code); setLabel(''); void qc.invalidateQueries({ queryKey: ['admin-selfreg-invites'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/self-registration/invites/${encodeURIComponent(id)}`),
    onSuccess: () => { toast.success(t('sr_invite_revoked')); void qc.invalidateQueries({ queryKey: ['admin-selfreg-invites'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      api.post(`/admin/self-registration/pending/${encodeURIComponent(id)}/${action}`, {}),
    onSuccess: (_r, v) => {
      toast.success(t(v.action === 'approve' ? 'sr_approved' : 'sr_rejected'));
      void qc.invalidateQueries({ queryKey: ['admin-selfreg-pending'] });
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusLabel = (st: InviteStatus) => t(`sr_status_${st}` as const);
  const pending = pendingData?.pending ?? [];
  const invites = inviteData?.invites ?? [];
  const toggleDomain = (id: string) =>
    setDomainIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('nav_self_registration')}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('sr_page_intro')}</p>
        </div>
        <button
          type="button" aria-label={t('action_refresh')} title={t('action_refresh')}
          onClick={() => { if (orgWide) { void refetchSettings(); void refetchInvites(); } void refetchPending(); }}
          className="p-2 text-fg-subtle border border-line-strong rounded hover:bg-surface-2"
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>

      {ready && scoped && <p className="text-xs text-fg-subtle">{t('sr_org_only_hint')}</p>}

      {/* Settings */}
      {orgWide && s && (
        <section className="bg-surface border border-line rounded p-5 space-y-5" aria-labelledby="sr-settings">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="sr-settings" className="text-sm font-semibold text-fg">{t('sr_settings_title')}</h2>
              <p className="text-xs text-fg-subtle mt-0.5">{t('sr_switch_hint')}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={`text-xs px-2 py-0.5 rounded-full ${s.enabled ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
                {s.enabled ? t('sr_status_on') : t('sr_status_off')}
              </span>
              <Toggle active={enabled} disabled={!canWrite} label={t('sr_switch_label')} onToggle={() => setEnabled((v) => !v)} />
            </div>
          </div>

          {enabled && domainIds.length === 0 && (
            <p role="status" className="bg-warning-bg border border-warning-line rounded px-3 py-2 text-xs text-warning-fg">{t('sr_warn_no_domain')}</p>
          )}

          <fieldset>
            <legend className="text-sm font-medium text-fg">{t('sr_domains')}</legend>
            <p className="text-xs text-fg-subtle mb-2">{t('sr_domains_hint')}</p>
            {s.domains.length === 0 ? (
              <p className="text-xs text-fg-subtle">{t('sr_no_domains')}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {s.domains.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm text-fg-muted">
                    <input type="checkbox" checked={domainIds.includes(d.id)} disabled={!canWrite} onChange={() => toggleDomain(d.id)} />
                    <span>{d.name}</span>
                    {!d.active && <span className="text-xs text-fg-subtle">({t('sr_domain_inactive')})</span>}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-fg mb-2">{t('sr_mode')}</legend>
            <div className="space-y-2">
              {(['approval', 'immediate'] as const).map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm text-fg-muted">
                  <input type="radio" name="sr-mode" className="mt-1" checked={mode === m} disabled={!canWrite} onChange={() => setMode(m)} />
                  <span>
                    <span className="text-fg">{t(m === 'approval' ? 'sr_mode_approval' : 'sr_mode_immediate')}</span>
                    <span className="block text-xs text-fg-subtle">{t(m === 'approval' ? 'sr_mode_approval_hint' : 'sr_mode_immediate_hint')}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p id="sr-invite-only" className="text-sm font-medium text-fg">{t('sr_invite_only')}</p>
              <p className="text-xs text-fg-subtle">{t('sr_invite_only_hint')}</p>
            </div>
            <Toggle active={inviteOnly} disabled={!canWrite} label={t('sr_invite_only')} onToggle={() => setInviteOnly((v) => !v)} />
          </div>

          {canWrite && (
            <div className="flex justify-end">
              <button type="button" className="btn-primary" disabled={!dirty || saveSettings.isPending} onClick={() => saveSettings.mutate()}>
                {t('action_save')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Invite codes */}
      {orgWide && (
        <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="sr-invites">
          <h2 id="sr-invites" className="text-sm font-semibold text-fg flex items-center gap-2">
            <KeyRound size={14} aria-hidden="true" /> {t('sr_invites_title')}
          </h2>

          {created && (
            <div role="status" className="bg-success-bg border border-success-line rounded p-3 space-y-2">
              <p className="text-xs text-success-fg">{t('sr_invite_created')}</p>
              <div className="flex items-center gap-2">
                <code className="font-mono text-sm text-fg bg-surface px-2 py-1 rounded select-all">{created}</code>
                <button
                  type="button" aria-label={t('sr_invite_copy')} title={t('sr_invite_copy')}
                  onClick={() => { void navigator.clipboard.writeText(created).then(() => toast.success(t('sr_invite_copied'))); }}
                  className="p-1.5 text-fg-subtle hover:text-accent-fg"
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
                <button type="button" className="ml-auto text-xs text-fg-subtle hover:text-fg" onClick={() => setCreated(null)}>
                  {t('sr_invite_dismiss')}
                </button>
              </div>
            </div>
          )}

          {canWrite && (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => { e.preventDefault(); if (!inviteError) createInvite.mutate(); }}
            >
              <label className="text-xs text-fg-muted flex flex-col gap-1 flex-1 min-w-[10rem]">
                {t('sr_invite_label')}
                <input className="input" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="text-xs text-fg-muted flex flex-col gap-1 w-28">
                {t('sr_invite_days')}
                <input className="input" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              </label>
              <label className="text-xs text-fg-muted flex flex-col gap-1 w-28">
                {t('sr_invite_uses')}
                <input className="input" type="number" min={1} max={1000} value={uses} onChange={(e) => setUses(Number(e.target.value))} />
              </label>
              <button type="submit" className="btn-primary" disabled={!!inviteError || createInvite.isPending}>{t('sr_invite_create')}</button>
            </form>
          )}

          {invites.length === 0 ? (
            <p className="text-xs text-fg-subtle">{t('sr_invite_none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-subtle border-b border-line">
                    <th scope="col" className="py-2 pr-3 font-medium">{t('sr_invite_col_code')}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t('sr_invite_col_label')}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t('sr_invite_col_uses')}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t('sr_invite_col_expires')}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t('sr_invite_col_status')}</th>
                    <th scope="col" className="py-2"><span className="sr-only">{t('sr_invite_revoke')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-3 font-mono text-fg-muted">…{inv.codeHint}</td>
                      <td className="py-2 pr-3 text-fg">{inv.label || '—'}</td>
                      <td className="py-2 pr-3 text-fg-muted">{inv.uses} / {inv.maxUses}</td>
                      <td className="py-2 pr-3 text-fg-muted">{fmtDate(inv.expiresAt)}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${inv.status === 'active' ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
                          {statusLabel(inv.status)}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {canWrite && inv.status === 'active' && (
                          <button
                            type="button" aria-label={`${t('sr_invite_revoke')} …${inv.codeHint}`} title={t('sr_invite_revoke')}
                            onClick={() => { if (confirm(t('sr_invite_revoke_confirm'))) revokeInvite.mutate(inv.id); }}
                            className="p-1.5 text-fg-subtle hover:text-danger-fg"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Pending approvals */}
      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="sr-pending">
        <h2 id="sr-pending" className="text-sm font-semibold text-fg">
          {t('sr_pending_title')}{pending.length > 0 ? ` (${pending.length})` : ''}
        </h2>
        {pending.length === 0 ? (
          <p className="text-xs text-fg-subtle">{t('sr_pending_none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-fg-subtle border-b border-line">
                  <th scope="col" className="py-2 pr-3 font-medium">{t('sr_pending_col_name')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t('sr_pending_col_address')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t('sr_pending_col_created')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t('sr_pending_col_ip')}</th>
                  <th scope="col" className="py-2"><span className="sr-only">{t('sr_approve')} / {t('sr_reject')}</span></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3 text-fg">{p.displayName}</td>
                    <td className="py-2 pr-3 text-fg-muted">
                      {p.email}
                      {p.viaInvite && <span className="block text-xs text-fg-subtle">{t('sr_pending_invite')}</span>}
                    </td>
                    <td className="py-2 pr-3 text-fg-muted">{fmtDate(p.createdAt)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-fg-muted">{p.ipAddress || '—'}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {canWrite && (
                        <>
                          <button
                            type="button" disabled={decide.isPending}
                            onClick={() => decide.mutate({ id: p.id, action: 'approve' })}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-line-strong text-success-fg hover:bg-surface-2"
                            aria-label={`${t('sr_approve')}: ${p.email}`}
                          >
                            <Check size={12} aria-hidden="true" /> {t('sr_approve')}
                          </button>
                          <button
                            type="button" disabled={decide.isPending}
                            onClick={() => { if (confirm(t('sr_reject_confirm'))) decide.mutate({ id: p.id, action: 'reject' }); }}
                            className="ml-2 inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-line-strong text-danger-fg hover:bg-surface-2"
                            aria-label={`${t('sr_reject')}: ${p.email}`}
                          >
                            <X size={12} aria-hidden="true" /> {t('sr_reject')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
