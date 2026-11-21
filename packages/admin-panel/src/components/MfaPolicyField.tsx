import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { MfaLevel, MfaSource, OverrideChoice } from '../lib/mfaPolicy.js';

/**
 * 10.6: the per-user MFA exception of one account in BCP → Postfächer →
 * Bearbeiten (GET/PUT /admin/user-mfa/:id) plus its remembered devices
 * (DELETE /admin/user-mfa/:id/trusted-devices). Saves on change — it is its own
 * setting, not part of the mailbox form.
 */

interface Detail {
  mfaPolicy: MfaLevel | null;
  enrolled: boolean;
  effective: { level: MfaLevel; source: MfaSource };
  inherited: { level: MfaLevel; source: MfaSource };
  trustedDevices: Array<{ id: string; surface: string; userAgent: string; lastUsedAt: string | null; expiresAt: string }>;
  canWeaken: boolean;
  canRevokeDevices: boolean;
  role: string;
}

const LEVEL: Record<MfaLevel, TranslationKey> = {
  required: 'mfap_level_required', optional: 'mfap_level_optional', off: 'mfap_level_off',
};
const SOURCE: Record<MfaSource, TranslationKey> = {
  user: 'mfap_source_user', admin: 'mfap_source_admin', global: 'mfap_source_global',
};
const STRENGTH: Record<MfaLevel, number> = { off: 0, optional: 1, required: 2 };

export function MfaPolicyField({ userId }: { userId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('recipients', 'write');
  const key = ['admin-user-mfa-detail', userId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/admin/user-mfa/${userId}`) });

  const set = useMutation({
    mutationFn: (mfaPolicy: OverrideChoice) => api.put<{ adminWithoutMfaRequirement?: boolean }>(`/admin/user-mfa/${userId}`, { mfaPolicy }),
    onSuccess: (r) => {
      toast.success(t('mfap_override_saved'));
      if (r.adminWithoutMfaRequirement) toast(t('mfap_override_admin_warn'), { icon: '⚠️' });
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['admin-user-mfa'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => api.delete<{ revoked: number }>(`/admin/user-mfa/${userId}/trusted-devices`),
    onSuccess: () => { toast.success(t('mfap_devices_revoked')); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <Loader2 size={14} className="animate-spin text-fg-subtle" aria-hidden="true" />;

  const current: OverrideChoice = data.mfaPolicy ?? 'inherit';
  const isAdmin = data.role !== 'USER';
  // a choice that would weaken an admin account is offered only to organisation management (server checks again)
  const allowed = (c: OverrideChoice): boolean => {
    if (!isAdmin || data.canWeaken) return true;
    const level = c === 'inherit' ? data.inherited.level : c;
    return STRENGTH[level] >= STRENGTH[data.effective.level];
  };
  const leavesAdminWithoutMfa = (c: OverrideChoice): boolean =>
    isAdmin && (c === 'inherit' ? data.inherited.level : c) !== 'required';

  return (
    <div className="space-y-2">
      <label className="field-label flex items-center gap-1" htmlFor={`mfa-policy-${userId}`}>
        <KeyRound size={12} aria-hidden="true" /> {t('mfap_field_label')}
      </label>
      <select id={`mfa-policy-${userId}`} className="input w-full" value={current} disabled={!canWrite || set.isPending}
        onChange={(e) => {
          const next = e.target.value as OverrideChoice;
          if (leavesAdminWithoutMfa(next) && !window.confirm(t('mfap_override_admin_warn'))) return;
          set.mutate(next);
        }}>
        <option value="inherit" disabled={!allowed('inherit')}>
          {t('mfap_inherit')} ({t(LEVEL[data.inherited.level])})
        </option>
        {(['required', 'optional', 'off'] as const).map((l) => (
          <option key={l} value={l} disabled={!allowed(l)}>{t(LEVEL[l])}</option>
        ))}
      </select>
      <p className="text-xs text-fg-subtle">
        {t('mfap_field_hint')} {t('mfap_col_effective')}: {t(LEVEL[data.effective.level])} ({t(SOURCE[data.effective.source])}) ·{' '}
        {t('mfap_col_mfa')}: {data.enrolled ? t('mfap_yes') : t('mfap_no')}
      </p>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-fg-muted">
          {t('mfap_devices')}: {data.trustedDevices.length === 0 ? t('mfap_devices_none') : data.trustedDevices.length}
        </span>
        {data.trustedDevices.length > 0 && data.canRevokeDevices && canWrite && (
          <button type="button" className="btn-secondary text-xs" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {t('mfap_devices_revoke')}
          </button>
        )}
      </div>
    </div>
  );
}
