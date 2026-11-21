/**
 * 10.6: Settings → Sicherheit → Wiederherstellungsadresse (docs/password-reset.md).
 * The external address a "Passwort vergessen?" link may go to. Saving sends a
 * confirmation link to the new address (the previous address stays in force
 * until then); every change needs the current password or an MFA code
 * (PasswordPromptDialog) and is announced to the own mailbox and the old address.
 * API: GET/PUT/DELETE /api/v1/user/recovery-email.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MailCheck, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client.js';
import { useT, fmt } from '../../i18n/useT.js';
import { useRegional } from '../../store/preferences.js';
import { formatDateTime } from '../../lib/regionalFormat.js';
import { PasswordPromptDialog, type ReauthKind } from '../PasswordPromptDialog.js';
import { Group } from './controls.js';

interface RecoveryState {
  address: string | null;
  verifiedAt: string | null;
  pendingAddress: string | null;
  pendingExpiresAt: string | null;
  policy: { available: boolean; recoveryEmail: boolean; ownMailbox: boolean };
  account: { eligible: boolean; reason?: 'external_directory' | 'admin_excluded' | 'mfa_unprovable'; ownMailboxUsable: boolean; mfaRequired: boolean };
}

type Pending = { kind: 'save'; address: string } | { kind: 'remove' };

const reauthBody = (secret: string, kind: ReauthKind) => (kind === 'mfa' ? { mfaCode: secret } : { currentPassword: secret });

export function RecoveryEmailPanel() {
  const t = useT();
  const qc = useQueryClient();
  const regional = useRegional();
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['recovery-email'], queryFn: () => api.get<RecoveryState>('/user/recovery-email') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['recovery-email'] });

  const save = useMutation({
    mutationFn: ({ addr, secret, kind }: { addr: string; secret: string; kind: ReauthKind }) =>
      api.put<{ pendingAddress: string }>('/user/recovery-email', { address: addr, ...reauthBody(secret, kind) }),
    onSuccess: (r) => { toast.success(fmt(t('sspr_panel_sent'), { address: r.pendingAddress })); setAddress(''); void refresh(); },
  });
  const remove = useMutation({
    mutationFn: ({ secret, kind }: { secret: string; kind: ReauthKind }) => api.delete('/user/recovery-email', reauthBody(secret, kind)),
    onSuccess: () => { toast.success(t('sspr_panel_removed')); void refresh(); },
  });

  if (isLoading) return <Loader2 size={16} className="animate-spin text-fg-subtle" aria-label="…" />;
  if (!data) return null;

  const notes: string[] = [];
  if (data.account.reason === 'external_directory') notes.push(t('sspr_panel_not_local'));
  else {
    if (!data.policy.available) notes.push(t('sspr_panel_off'));
    else if (!data.policy.recoveryEmail) notes.push(t('sspr_panel_method_off'));
    if (data.account.reason === 'admin_excluded') notes.push(t('sspr_panel_admin_excluded'));
    if (data.account.reason === 'mfa_unprovable') notes.push(t('sspr_panel_mfa_unprovable'));
    if (data.policy.available && data.policy.ownMailbox && !data.account.ownMailboxUsable && !data.address) notes.push(t('sspr_panel_mailbox_skipped'));
    if (data.account.mfaRequired && data.account.reason !== 'mfa_unprovable') notes.push(t('sspr_panel_mfa_note'));
  }
  const local = data.account.reason !== 'external_directory';
  const when = (iso: string | null) => (iso ? formatDateTime(new Date(iso), regional) : '–');

  return (
    <Group title={t('sspr_panel_title')}>
      <p className="text-xs text-fg-subtle">{t('sspr_panel_intro')}</p>

      <div className="text-sm">
        {data.address ? (
          <p className="flex items-center gap-2 text-fg">
            <MailCheck size={14} className="text-success-fg shrink-0" aria-hidden="true" />
            <span>{t('sspr_panel_current')}: <strong className="font-medium">{data.address}</strong></span>
          </p>
        ) : (
          <p className="text-fg-muted">{t('sspr_panel_none')}</p>
        )}
        {data.pendingAddress && (
          <p className="text-xs text-warning-fg mt-1" role="status">
            {fmt(t('sspr_panel_pending'), { address: data.pendingAddress, date: when(data.pendingExpiresAt) })}
          </p>
        )}
      </div>

      {notes.map((n) => <p key={n} className="text-xs text-fg-muted bg-surface-2 rounded px-3 py-2">{n}</p>)}

      {local && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (address.trim()) setPending({ kind: 'save', address: address.trim() }); }}
        >
          <label className="flex-1 min-w-[14rem]">
            <span className="block text-sm text-fg-muted mb-1">{t('sspr_panel_address_label')}</span>
            <input
              type="email" className="input w-full" value={address} autoComplete="email"
              onChange={(e) => setAddress(e.target.value)} maxLength={254}
            />
          </label>
          <button type="submit" className="btn-primary text-xs" disabled={!address.trim() || save.isPending}>
            {t('sspr_panel_save')}
          </button>
          {(data.address || data.pendingAddress) && (
            <button type="button" className="btn-ghost text-xs" disabled={remove.isPending} onClick={() => setPending({ kind: 'remove' })}>
              <Trash2 size={13} aria-hidden="true" /> {t('sspr_panel_remove')}
            </button>
          )}
        </form>
      )}

      {pending && (
        <PasswordPromptDialog
          title={t('sspr_panel_reauth_title')}
          description={t('sspr_panel_reauth_text')}
          confirmLabel={pending.kind === 'save' ? t('sspr_panel_save') : t('sspr_panel_remove')}
          allowMfaCode={data.account.mfaRequired}
          onConfirm={async (secret, kind) => {
            if (pending.kind === 'save') await save.mutateAsync({ addr: pending.address, secret, kind });
            else await remove.mutateAsync({ secret, kind });
          }}
          onClose={() => setPending(null)}
        />
      )}
    </Group>
  );
}
