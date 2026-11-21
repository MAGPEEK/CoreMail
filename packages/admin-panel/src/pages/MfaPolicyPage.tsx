import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, RefreshCw, Save, Search, ShieldCheck, Smartphone, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Toggle } from '../components/Toggle.js';
import {
  ADMIN_GRACE_MAX_DAYS, MFA_POLICY_FORM_DEFAULTS, REMEMBER_MAX_DAYS, REMEMBER_PRESETS, adminsWithoutMfa, changedFields,
  clampDays, formProblem, overrideLeavesAdminWithoutMfa, rememberChoice,
  type AdminAccount, type AdminRule, type MfaLevel, type MfaPolicyForm, type MfaSource, type OverrideChoice,
} from '../lib/mfaPolicy.js';

/**
 * 10.6: BCP → Authentifizierung → Mehrstufige Anmeldung (MFA).
 * Policy for all users, admin rule (+ admin grace ≤ 14 days), "Gerät merken"
 * durations and per-user exceptions. Server: GET/PUT /admin/settings/mfa-policy
 * (area organisation), /admin/user-mfa (area recipients, scoped). Docs: docs/mfa-policy.md.
 */

interface PolicyResponse {
  policy: MfaPolicyForm;
  admins: Array<AdminAccount & { effective: { level: MfaLevel; source: MfaSource } }>;
}

interface OverrideRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  mfaPolicy: MfaLevel | null;
  enrolled: boolean;
  effective: { level: MfaLevel; source: MfaSource };
}

const LEVEL_KEYS: Record<MfaLevel, { label: TranslationKey; hint: TranslationKey }> = {
  required: { label: 'mfap_level_required', hint: 'mfap_level_required_hint' },
  optional: { label: 'mfap_level_optional', hint: 'mfap_level_optional_hint' },
  off:      { label: 'mfap_level_off',      hint: 'mfap_level_off_hint' },
};

const SOURCE_KEYS: Record<MfaSource, TranslationKey> = {
  user: 'mfap_source_user', admin: 'mfap_source_admin', global: 'mfap_source_global',
};

// ── Module-level building blocks (never defined inside other components) ──────

function Card({ icon: Icon, title, hint, children }: {
  icon: React.ElementType; title: string; hint: string; children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
          <Icon size={16} className="text-accent-fg" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function RadioOption({ name, checked, onSelect, title, desc, disabled }: {
  name: string; checked: boolean; onSelect: () => void; title: string; desc?: string; disabled: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 py-1 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="mt-1" />
      <span>
        <span className="text-sm font-medium text-fg">{title}</span>
        {desc && <span className="block text-xs text-fg-subtle">{desc}</span>}
      </span>
    </label>
  );
}

function DaysInput({ id, value, onChange, min, max, disabled, label }: {
  id: string; value: number; onChange: (v: number) => void; min: number; max: number; disabled: boolean; label: string;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="number" value={value} min={min} max={max} disabled={disabled} aria-label={label}
        onChange={(e) => onChange(clampDays(parseInt(e.target.value, 10), min, max))}
        className="input w-28 disabled:opacity-50" />
      <span className="text-sm text-fg-subtle">{t('unit_days')}</span>
    </div>
  );
}

function RememberSelect({ id, label, value, onChange, max, disabled }: {
  id: string; label: string; value: number; onChange: (v: number) => void; max: number; disabled: boolean;
}) {
  const t = useT();
  const choice = rememberChoice(value);
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={id} className="input w-44" value={choice} disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === 'custom' ? clampDays(value > 0 && !REMEMBER_PRESETS.includes(value) ? value : 14, 1, max) : Number(v));
          }}>
          {REMEMBER_PRESETS.filter((d) => d <= max).map((d) => (
            <option key={d} value={String(d)}>{d === 0 ? t('mfap_remember_off') : `${d} ${t('unit_days')}`}</option>
          ))}
          <option value="custom">{t('mfap_remember_custom')}</option>
        </select>
        {choice === 'custom' && (
          <DaysInput id={`${id}-custom`} value={value} onChange={onChange} min={1} max={max} disabled={disabled} label={label} />
        )}
      </div>
    </div>
  );
}

function OverridesTable({ form }: { form: Pick<MfaPolicyForm, 'users' | 'admins'> }) {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('recipients', 'write');
  const [q, setQ] = useState('');
  const [onlyOverrides, setOnlyOverrides] = useState(true);
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(h); }, [q]);

  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (onlyOverrides && !debounced) params.set('overrides', '1');
  const { data, isLoading } = useQuery({
    queryKey: ['admin-user-mfa', debounced, onlyOverrides],
    queryFn: () => api.get<{ items: OverrideRow[] }>(`/admin/user-mfa?${params.toString()}`),
  });

  const mut = useMutation({
    mutationFn: (v: { id: string; mfaPolicy: OverrideChoice }) => api.put<{ adminWithoutMfaRequirement?: boolean }>(`/admin/user-mfa/${v.id}`, { mfaPolicy: v.mfaPolicy }),
    onSuccess: (r) => {
      toast.success(t('mfap_override_saved'));
      if (r.adminWithoutMfaRequirement) toast(t('mfap_override_admin_warn'), { icon: '⚠️' });
      void qc.invalidateQueries({ queryKey: ['admin-user-mfa'] });
      void qc.invalidateQueries({ queryKey: ['admin-mfa-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input className="input w-full pl-8" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t('mfap_search')} aria-label={t('mfap_search')} />
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer">
          <input type="checkbox" checked={onlyOverrides} onChange={(e) => setOnlyOverrides(e.target.checked)} />
          {t('mfap_only_overrides')}
        </label>
      </div>
      <div className="overflow-x-auto border border-line rounded">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-fg-muted">
            <tr>
              <th className="text-left px-3 py-2 font-medium">{t('mfap_col_user')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('mfap_col_setting')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('mfap_col_effective')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('mfap_col_mfa')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-fg-subtle"><RefreshCw size={14} className="inline animate-spin" /></td></tr>
            )}
            {!isLoading && items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-fg-subtle">{t('mfap_none')}</td></tr>
            )}
            {items.map((u) => {
              const value: OverrideChoice = u.mfaPolicy ?? 'inherit';
              return (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <div className="text-fg">{u.displayName || u.email}</div>
                    <div className="text-xs text-fg-subtle">{u.email}{u.role !== 'USER' ? ` · ${u.role}` : ''}</div>
                  </td>
                  <td className="px-3 py-2">
                    <select className="input w-36" value={value} disabled={!canWrite || mut.isPending}
                      aria-label={`${t('mfap_col_setting')} ${u.email}`}
                      onChange={(e) => {
                        const next = e.target.value as OverrideChoice;
                        if (overrideLeavesAdminWithoutMfa(form, u.role, next) && !window.confirm(t('mfap_override_admin_warn'))) return;
                        mut.mutate({ id: u.id, mfaPolicy: next });
                      }}>
                      <option value="inherit">{t('mfap_inherit')}</option>
                      <option value="required">{t('mfap_level_required')}</option>
                      <option value="optional">{t('mfap_level_optional')}</option>
                      <option value="off">{t('mfap_level_off')}</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">
                    {t(LEVEL_KEYS[u.effective.level].label)}
                    <span className="block text-xs text-fg-subtle">{t(SOURCE_KEYS[u.effective.source])}</span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{u.enrolled ? t('mfap_yes') : t('mfap_no')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MfaPolicyPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('organisation', 'write');
  const showOverrides = can('recipients');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-mfa-policy'],
    queryFn: () => api.get<PolicyResponse>('/admin/settings/mfa-policy'),
  });
  const saved = data?.policy ?? MFA_POLICY_FORM_DEFAULTS;
  const [form, setForm] = useState<MfaPolicyForm>(MFA_POLICY_FORM_DEFAULTS);
  useEffect(() => { if (data) setForm({ ...MFA_POLICY_FORM_DEFAULTS, ...data.policy }); }, [data]);
  const upd = <K extends keyof MfaPolicyForm>(k: K, v: MfaPolicyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const changes = useMemo(() => changedFields(saved, form), [saved, form]);
  const dirty = Object.keys(changes).length > 0;
  const problem = formProblem(form);
  const exposed = useMemo(() => adminsWithoutMfa(form, data?.admins ?? []), [form, data]);

  const save = useMutation({
    mutationFn: () => api.put<PolicyResponse>('/admin/settings/mfa-policy', changes),
    onSuccess: () => {
      toast.success(t('mfap_saved'));
      void qc.invalidateQueries({ queryKey: ['admin-mfa-policy'] });
      void qc.invalidateQueries({ queryKey: ['admin-user-mfa'] });
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-fg-subtle">
        <RefreshCw size={16} className="animate-spin" />
      </div>
    );
  }

  const disabled = !canWrite;
  return (
    <div className="p-6 space-y-5 max-w-[900px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('mfap_title')}</h1>
          <p className="text-xs text-fg-subtle mt-0.5">{t('mfap_desc')}</p>
        </div>
        {canWrite && (
          <button type="button" onClick={() => save.mutate()} disabled={!dirty || problem !== null || save.isPending}
            className="btn-primary text-xs disabled:opacity-40 shrink-0">
            {save.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            {save.isPending ? t('action_saving') : t('action_save')}
          </button>
        )}
      </div>

      {/* ── Policy for all users ── */}
      <Card icon={Users} title={t('mfap_users_title')} hint={t('mfap_users_hint')}>
        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="sr-only">{t('mfap_users_title')}</legend>
          {(['required', 'optional', 'off'] as const).map((l) => (
            <RadioOption key={l} name="mfa-users" checked={form.users === l} onSelect={() => upd('users', l)} disabled={disabled}
              title={t(LEVEL_KEYS[l].label)} desc={t(LEVEL_KEYS[l].hint)} />
          ))}
        </fieldset>
        {form.users === 'required' && (
          <div className="mt-3 ml-6 space-y-3 border-l-2 border-line pl-4">
            <div>
              <label className="field-label" htmlFor="mfa-grace">{t('settings_sec_mfa_all_grace')}</label>
              <DaysInput id="mfa-grace" value={form.graceDays} onChange={(v) => upd('graceDays', v)} min={0} max={90}
                disabled={disabled} label={t('settings_sec_mfa_all_grace')} />
              <p className="text-xs text-fg-subtle mt-1">{t('settings_sec_mfa_all_grace_hint')}</p>
            </div>
            <div>
              <div className="flex items-center gap-3">
                <Toggle active={form.blocksPrimaryPassword} onToggle={() => upd('blocksPrimaryPassword', !form.blocksPrimaryPassword)}
                  disabled={disabled} label={t('settings_sec_mfa_all_block_pw')} />
                <span className="text-sm text-fg-muted">{t('settings_sec_mfa_all_block_pw')}</span>
              </div>
              <p className="text-xs text-fg-subtle mt-1">{t('settings_sec_mfa_all_block_pw_hint')}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
              <AlertTriangle size={12} className="shrink-0" />
              {t('settings_sec_mfa_all_warn')}
            </div>
          </div>
        )}
      </Card>

      {/* ── Administrators ── */}
      <Card icon={ShieldCheck} title={t('mfap_admins_title')} hint={t('mfap_admins_hint')}>
        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="sr-only">{t('mfap_admins_title')}</legend>
          {(['required', 'as_users'] as const satisfies readonly AdminRule[]).map((r) => (
            <RadioOption key={r} name="mfa-admins" checked={form.admins === r} onSelect={() => upd('admins', r)} disabled={disabled}
              title={t(r === 'required' ? 'mfap_admin_required' : 'mfap_admin_as_users')}
              {...(r === 'required' ? { desc: t('mfap_admin_required_hint') } : {})} />
          ))}
        </fieldset>
        {form.admins === 'required' && (
          <div className="mt-3 ml-6 border-l-2 border-line pl-4">
            <label className="field-label" htmlFor="mfa-admin-grace">{t('mfap_admin_grace')}</label>
            <DaysInput id="mfa-admin-grace" value={form.adminGraceDays} onChange={(v) => upd('adminGraceDays', v)} min={0}
              max={ADMIN_GRACE_MAX_DAYS} disabled={disabled} label={t('mfap_admin_grace')} />
            <p className="text-xs text-fg-subtle mt-1">{t('mfap_admin_grace_hint')}</p>
          </div>
        )}
        {exposed.length > 0 && (
          <div role="alert" className="mt-3 flex items-start gap-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <div>
              {t('mfap_admin_warn')}
              <ul className="mt-1 list-disc pl-4">
                {exposed.slice(0, 10).map((a) => <li key={a.id}>{a.email} ({a.role})</li>)}
                {exposed.length > 10 && <li>… +{exposed.length - 10}</li>}
              </ul>
            </div>
          </div>
        )}
      </Card>

      {/* ── Remember device ── */}
      <Card icon={Smartphone} title={t('mfap_remember_title')} hint={t('mfap_remember_hint')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <RememberSelect id="mfa-remember-users" label={t('mfap_remember_users')} value={form.rememberDays}
            max={REMEMBER_MAX_DAYS} disabled={disabled}
            onChange={(v) => setForm((f) => ({ ...f, rememberDays: v, rememberDaysAdmins: Math.min(f.rememberDaysAdmins, v) }))} />
          <div>
            <RememberSelect id="mfa-remember-admins" label={t('mfap_remember_admins')} value={form.rememberDaysAdmins}
              max={form.rememberDays} disabled={disabled} onChange={(v) => upd('rememberDaysAdmins', v)} />
            <p className="text-xs text-fg-subtle mt-1">{t('mfap_remember_admins_hint')}</p>
          </div>
        </div>
        {problem === 'remember_admins' && <p className="text-xs text-danger-fg mt-2" role="alert">{t('mfap_remember_admins_hint')}</p>}
      </Card>

      {/* ── Per-user exceptions ── */}
      {showOverrides && (
        <Card icon={KeyRound} title={t('mfap_overrides_title')} hint={t('mfap_overrides_hint')}>
          <OverridesTable form={saved} />
        </Card>
      )}
    </div>
  );
}
