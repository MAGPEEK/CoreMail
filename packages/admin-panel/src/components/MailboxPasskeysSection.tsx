/**
 * 10.6: mailbox dialog → Passkeys. Lists the user's passkeys / security keys,
 * removes one or all, resets every factor, issues a one-time recovery link
 * (shown once), sets the per-user passkey switch (Erben | An | Aus) and
 * passkey-only sign-in. Server: api-gateway routes/admin/passkeys.ts — writes
 * need recipients write, an MFA-verified session, and for admin accounts
 * ORGANIZATION_MANAGEMENT.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, Fingerprint, KeyRound, Link2, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import { WriteGuard } from './Can.js';
import { Toggle } from './Toggle.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { ApiError, errorMessage } from '../lib/errors.js';
import { passkeyErrorKey, passkeyStorageKey } from '../lib/passkeys.js';

interface Credential {
  id: string; name: string; kind: 'passkey' | 'security_key'; legacy: boolean; backupEligible: boolean | null;
  synced: boolean; provider: string | null; createdAt: string; lastUsedAt: string | null;
}
interface MailboxPasskeys {
  passkeys: Credential[];
  policy: { setting: 'inherit' | 'on' | 'off'; inherited: boolean; effective: boolean } | null;
  allowed: boolean;
  passwordLoginDisabled: boolean;
  passkeyOnlyRefusal: string | null;
  factors: { totp: boolean; backupCodes: number; passkeys: number; securityKeys: number };
  eligible: boolean;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fill = (text: string, vars: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function MailboxPasskeysSection({ userId }: { userId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['admin-mailbox-passkeys', userId];
  const base = `/admin/mailboxes/${userId}`;
  const { data, isLoading, isError, error } = useQuery<MailboxPasskeys>({ queryKey: key, queryFn: () => api.get(`${base}/passkeys`) });
  const [recovery, setRecovery] = useState<{ url: string; expiresAt: string } | null>(null);

  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : undefined;
    toast.error(code ? t(passkeyErrorKey(code) as TranslationKey) : errorMessage(e));
  };
  const reload = () => { void qc.invalidateQueries({ queryKey: key }); };

  const removeOne = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/passkeys/${encodeURIComponent(id)}`),
    onSuccess: () => { toast.success(t('mpk_removed')); reload(); },
    onError: fail,
  });
  const removeAll = useMutation({
    mutationFn: (allMfa: boolean) => (allMfa ? api.post(`${base}/mfa-reset`, {}) : api.delete(`${base}/passkeys`)),
    onSuccess: () => { toast.success(t('mpk_removed')); reload(); },
    onError: fail,
  });
  const policy = useMutation({
    mutationFn: (patch: { passkeys?: 'inherit' | 'on' | 'off'; passwordLoginDisabled?: boolean }) => api.put(`${base}/passkey-policy`, patch),
    onSuccess: () => { toast.success(t('mpk_saved')); reload(); },
    onError: fail,
  });
  const issue = useMutation({
    mutationFn: () => api.post<{ url: string; expiresAt: string }>(`${base}/passkey-recovery`, {}),
    onSuccess: (r) => setRecovery(r),
    onError: fail,
  });

  if (isLoading) return <p className="text-sm text-fg-muted">…</p>;
  if (isError || !data) return <p className="text-sm text-danger-fg" role="alert">{errorMessage(error)}</p>;
  if (!data.eligible) return <p className="text-sm text-fg-muted">{t('mpk_sso')}</p>;

  const inheritValue = data.policy?.inherited ? t('mpk_on') : t('mpk_off');

  return (
    <WriteGuard area="recipients">
      <div className="space-y-5">
        <section aria-labelledby="mpk-list" className="space-y-2">
          <h3 id="mpk-list" className="text-sm font-semibold text-fg">{t('mpk_title')}</h3>
          {data.passkeys.length === 0 ? (
            <p className="text-sm text-fg-subtle">{t('mpk_empty')}</p>
          ) : (
            <ul className="divide-y divide-line border border-line rounded">
              {data.passkeys.map((p) => (
                <li key={p.id} className="flex items-start gap-3 px-3 py-2">
                  {p.kind === 'passkey'
                    ? <Fingerprint size={15} className="mt-0.5 text-fg-subtle shrink-0" aria-hidden="true" />
                    : <KeyRound size={15} className="mt-0.5 text-fg-subtle shrink-0" aria-hidden="true" />}
                  <div className="flex-1 min-w-0 text-sm">
                    <p className="font-medium text-fg truncate">{p.name}</p>
                    <p className="text-xs text-fg-subtle">
                      {t(passkeyStorageKey(p) as TranslationKey)}{p.provider ? ` · ${p.provider}` : ''}
                      {' · '}{t('mpk_created')} {when(p.createdAt)}
                      {' · '}{t('mpk_last_used')} {p.lastUsedAt ? when(p.lastUsedAt) : t('mpk_never')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${t('mpk_remove')}: ${p.name}`} title={t('mpk_remove')}
                    disabled={removeOne.isPending}
                    onClick={() => { if (window.confirm(fill(t('mpk_remove_confirm'), { name: p.name }))) removeOne.mutate(p.id); }}
                    className="p-1.5 rounded text-danger-fg hover:bg-danger-bg shrink-0"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-fg-subtle">
            {fill(t('mpk_factors'), { totp: data.factors.totp ? t('mpk_yes') : t('mpk_no'), codes: data.factors.backupCodes })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={data.passkeys.length === 0 || removeAll.isPending}
              onClick={() => { if (window.confirm(t('mpk_remove_all_confirm'))) removeAll.mutate(false); }}
              className="text-xs px-3 py-1.5 border border-danger-line text-danger-fg rounded hover:bg-danger-bg disabled:opacity-40"
            >
              {t('mpk_remove_all')}
            </button>
            <button
              type="button"
              disabled={removeAll.isPending}
              onClick={() => { if (window.confirm(t('mpk_mfa_reset_confirm'))) removeAll.mutate(true); }}
              className="text-xs px-3 py-1.5 border border-danger-line text-danger-fg rounded hover:bg-danger-bg disabled:opacity-40"
            >
              {t('mpk_mfa_reset')}
            </button>
          </div>
        </section>

        <section aria-labelledby="mpk-policy" className="space-y-3 border-t border-line pt-4">
          <div className="flex items-center justify-between gap-4">
            <label id="mpk-policy" htmlFor="mpk-policy-select" className="text-sm font-semibold text-fg">{t('mpk_policy')}</label>
            <select
              id="mpk-policy-select"
              className="input w-48"
              value={data.policy?.setting ?? 'inherit'}
              disabled={policy.isPending}
              onChange={(e) => policy.mutate({ passkeys: e.target.value as 'inherit' | 'on' | 'off' })}
            >
              <option value="inherit">{fill(t('mpk_policy_inherit'), { value: inheritValue })}</option>
              <option value="on">{t('mpk_on')}</option>
              <option value="off">{t('mpk_off')}</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-fg">{t('mpk_passkey_only')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{t('mpk_passkey_only_hint')}</p>
              {!data.passwordLoginDisabled && data.passkeyOnlyRefusal && (
                <p className="text-xs text-warning-fg mt-0.5">{t(passkeyErrorKey(data.passkeyOnlyRefusal) as TranslationKey)}</p>
              )}
            </div>
            <Toggle
              active={data.passwordLoginDisabled}
              label={t('mpk_passkey_only')}
              disabled={policy.isPending || (!data.passwordLoginDisabled && !!data.passkeyOnlyRefusal)}
              onToggle={() => policy.mutate({ passwordLoginDisabled: !data.passwordLoginDisabled })}
            />
          </div>
        </section>

        <section aria-labelledby="mpk-recovery" className="space-y-2 border-t border-line pt-4">
          <h3 id="mpk-recovery" className="text-sm font-semibold text-fg">{t('mpk_recovery')}</h3>
          <p className="text-xs text-fg-subtle">{t('mpk_recovery_hint')}</p>
          {recovery ? (
            <div className="space-y-1" role="status">
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs bg-surface-2 border border-line rounded px-2 py-1 break-all select-all">{recovery.url}</code>
                <button
                  type="button" aria-label={t('mpk_copy')} title={t('mpk_copy')}
                  onClick={() => { void navigator.clipboard.writeText(recovery.url).then(() => toast.success(t('mpk_copied'))); }}
                  className="p-1.5 text-fg-subtle hover:text-accent-fg"
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
              </div>
              <p className="text-xs text-warning-fg">{fill(t('mpk_recovery_shown_once'), { date: when(recovery.expiresAt) })}</p>
            </div>
          ) : (
            <button
              type="button"
              disabled={!data.allowed || issue.isPending}
              onClick={() => issue.mutate()}
              className="text-xs px-3 py-1.5 border border-line-strong rounded hover:bg-surface-2 inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              <Link2 size={12} aria-hidden="true" />{t('mpk_recovery')}
            </button>
          )}
        </section>
      </div>
    </WriteGuard>
  );
}
