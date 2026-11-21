/**
 * 10.5: BCP → Schutz → Angriffsschutz. Currently locked IPs and accounts of all
 * protocols (unlock), the permanent IP block list, the exceptions ("nie
 * sperren"), events per protocol (24 h), admin notifications and the
 * repeat-offender escalation. Server: api-gateway
 * routes/admin/security-protection.ts, docs/attack-protection.md.
 *
 * Area hygiene: write access (HYGIENE_MANAGEMENT / Organization Management)
 * may change things, VIEW_ONLY_ORG reads; organisation-wide admins only.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, RefreshCw, Trash2, Unlock } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { ApiError } from '../lib/errors.js';
import {
  AUTO_REFRESH_MS, EXPIRY_CHOICES, eventsView, formatRemaining, lastRefreshedAt, looksLikeCidr, protocolLabel,
  type ActiveLockView, type IpRuleView, type LocksView, type ProtectionSettingsView, type RulesView,
} from '../lib/attackProtection.js';

type T = ReturnType<typeof useT>;

interface AttackSummary { byProtocol?: Array<{ protocol: string; count: number }>; total24h?: number }

const fmt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// ── Locked IPs / accounts ────────────────────────────────────────────────────

function LockTable({ title, locks, scope, canWrite, busy, onUnlock, t }: {
  title: string; locks: ActiveLockView[]; scope: 'ip' | 'account'; canWrite: boolean; busy: boolean;
  onUnlock: (lock: ActiveLockView) => void; t: T;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title} ({locks.length})</h3>
      {locks.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('ap_none_locked')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle border-b border-line">
                <th className="py-2 pr-3 font-medium">{scope === 'ip' ? t('ap_col_ip') : t('ap_col_account')}</th>
                <th className="py-2 pr-3 font-medium">{t('ap_col_reason')}</th>
                <th className="py-2 pr-3 font-medium">{t('ap_col_strikes')}</th>
                {scope === 'ip' && <th className="py-2 pr-3 font-medium">{t('ap_col_locks7d')}</th>}
                <th className="py-2 pr-3 font-medium">{t('ap_col_remaining')}</th>
                <th className="py-2" aria-label={t('ap_unlock')} />
              </tr>
            </thead>
            <tbody>
              {locks.map((l) => {
                const name = scope === 'ip' ? l.id : (l.account ?? t('ap_unknown_account'));
                return (
                  <tr key={`${l.scope}:${l.id}`} className="border-b border-line last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-mono text-fg break-all">{name}</div>
                      {scope === 'account' && l.ip && <div className="text-xs text-fg-subtle font-mono">{l.ip}</div>}
                    </td>
                    <td className="py-2 pr-3 text-fg-muted">
                      {l.failures !== null ? `${l.failures} ${t('ap_failures')}` : '—'} · {protocolLabel(l.protocol)}
                      {scope === 'ip' && l.account && <div className="text-xs text-fg-subtle break-all">{t('ap_last_login_tried')}: {l.account}</div>}
                    </td>
                    <td className="py-2 pr-3 text-fg-muted tabular-nums">{l.strikes}</td>
                    {scope === 'ip' && <td className="py-2 pr-3 text-fg-muted tabular-nums">{l.locksInWindow ?? '—'}</td>}
                    <td className="py-2 pr-3 text-fg-muted whitespace-nowrap tabular-nums">{formatRemaining(l.remainingSec)}</td>
                    <td className="py-2 text-right">
                      {canWrite && (
                        <button
                          type="button" disabled={busy}
                          aria-label={`${t('ap_unlock')}: ${name}`}
                          onClick={() => onUnlock(l)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-line-strong rounded text-fg hover:bg-surface-2 disabled:opacity-40"
                        >
                          <Unlock size={12} /> {t('ap_unlock')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Block list / exceptions ──────────────────────────────────────────────────

function RuleSection({ kind, rules, callerIp, canWrite, onAdd, onRemove, adding, removing, t }: {
  kind: 'BLOCK' | 'ALLOW'; rules: IpRuleView[]; callerIp: string; canWrite: boolean;
  onAdd: (input: { cidr: string; note: string; expiresInDays: number | null }) => void;
  onRemove: (rule: IpRuleView) => void; adding: boolean; removing: boolean; t: T;
}) {
  const [cidr, setCidr] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const titleKey = kind === 'BLOCK' ? 'ap_block_title' : 'ap_allow_title';
  const hintKey = kind === 'BLOCK' ? 'ap_block_hint' : 'ap_allow_hint';
  const id = kind === 'BLOCK' ? 'ap-block' : 'ap-allow';
  const valid = looksLikeCidr(cidr);
  return (
    <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby={id}>
      <div>
        <h2 id={id} className="text-sm font-semibold text-fg">{t(titleKey)}</h2>
        <p className="text-xs text-fg-subtle mt-0.5">{t(hintKey)}</p>
      </div>
      {canWrite && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onAdd({ cidr: cidr.trim(), note: note.trim(), expiresInDays: days });
            setCidr(''); setNote('');
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('ap_cidr')}
            <input
              value={cidr} onChange={(e) => setCidr(e.target.value)} maxLength={64} aria-label={t('ap_cidr')}
              placeholder={kind === 'BLOCK' ? '203.0.113.0/24' : callerIp || '192.0.2.10'}
              className="w-56 font-mono text-sm bg-surface-2 border border-line-strong rounded px-3 py-1.5 text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('ap_note')}
            <input
              value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} aria-label={t('ap_note')}
              className="w-56 text-sm bg-surface-2 border border-line-strong rounded px-3 py-1.5 text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('ap_expiry')}
            <select
              value={days === null ? '' : String(days)} aria-label={t('ap_expiry')}
              onChange={(e) => setDays(e.target.value === '' ? null : Number(e.target.value))}
              className="text-sm bg-surface-2 border border-line-strong rounded px-2 py-1.5 text-fg"
            >
              {EXPIRY_CHOICES.map((d) => (
                <option key={d ?? 'permanent'} value={d === null ? '' : String(d)}>{d === null ? t('ap_expiry_permanent') : `${d} ${t('ap_days')}`}</option>
              ))}
            </select>
          </label>
          <button
            type="submit" disabled={!valid || adding}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
          >
            <Plus size={14} /> {t('ap_add')}
          </button>
          {cidr !== '' && !valid && <span className="text-xs text-danger-fg">{t('ap_cidr_invalid')}</span>}
        </form>
      )}
      {rules.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('ap_no_entries')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle border-b border-line">
                <th className="py-2 pr-3 font-medium">{t('ap_col_cidr')}</th>
                <th className="py-2 pr-3 font-medium">{t('ap_note')}</th>
                <th className="py-2 pr-3 font-medium">{t('ap_col_created')}</th>
                <th className="py-2 pr-3 font-medium">{t('ap_col_expires')}</th>
                <th className="py-2" aria-label={t('ap_remove')} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 align-top">
                  <td className="py-2 pr-3">
                    <code className="font-mono text-fg">{r.cidr}</code>
                    {r.auto && <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-warning-bg text-warning-fg">{t('ap_auto_badge')}</span>}
                  </td>
                  <td className="py-2 pr-3 text-fg-muted break-words">{r.note || '—'}</td>
                  <td className="py-2 pr-3 text-fg-muted whitespace-nowrap">
                    {fmt(r.createdAt)}
                    <span className="block text-xs text-fg-subtle">{r.createdBy ?? t('ap_created_by_system')}</span>
                  </td>
                  <td className="py-2 pr-3 text-fg-muted whitespace-nowrap">{r.expiresAt ? fmt(r.expiresAt) : t('ap_expiry_permanent')}</td>
                  <td className="py-2 text-right">
                    {canWrite && (
                      <button
                        type="button" disabled={removing}
                        aria-label={`${t('ap_remove')}: ${r.cidr}`} title={t('ap_remove')}
                        onClick={() => { if (confirm(t('ap_remove_confirm'))) onRemove(r); }}
                        className="p-1.5 text-fg-subtle hover:text-danger-fg disabled:opacity-40"
                      >
                        <Trash2 size={13} />
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
  );
}

// ── Notifications + repeat offenders ─────────────────────────────────────────

function NumberField({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <input
        type="number" value={value} min={min} max={max} disabled={disabled} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 text-sm bg-surface-2 border border-line-strong rounded px-3 py-1.5 text-fg disabled:opacity-60"
      />
    </label>
  );
}

function SettingsSections({ s, canWrite, saving, onSave, t }: {
  s: ProtectionSettingsView; canWrite: boolean; saving: boolean;
  onSave: (patch: Partial<ProtectionSettingsView>) => void; t: T;
}) {
  const [recipient, setRecipient] = useState(s.notifyRecipient);
  const [threshold, setThreshold] = useState(s.failureAlertThreshold);
  const [autoThreshold, setAutoThreshold] = useState(s.autoBlockThreshold);
  const [autoDays, setAutoDays] = useState(s.autoBlockDays);
  useEffect(() => {
    setRecipient(s.notifyRecipient); setThreshold(s.failureAlertThreshold);
    setAutoThreshold(s.autoBlockThreshold); setAutoDays(s.autoBlockDays);
  }, [s]);
  const L = s.limits;
  const inRange = (v: number, r: { min: number; max: number }) => Number.isInteger(v) && v >= r.min && v <= r.max;
  const notifyChanged = recipient.trim() !== s.notifyRecipient || threshold !== s.failureAlertThreshold;
  const autoChanged = autoThreshold !== s.autoBlockThreshold || autoDays !== s.autoBlockDays;
  return (
    <>
      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="ap-notify">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="ap-notify" className="text-sm font-semibold text-fg">{t('ap_notify_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('ap_notify_hint')}</p>
          </div>
          <Toggle
            active={s.notifyEnabled} disabled={!canWrite || saving} label={t('ap_notify_switch')}
            onToggle={() => onSave({ notifyEnabled: !s.notifyEnabled })}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('ap_notify_recipient')}
            <input
              type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} disabled={!canWrite}
              placeholder={t('ap_notify_recipient_hint')} aria-label={t('ap_notify_recipient')}
              className="w-72 text-sm bg-surface-2 border border-line-strong rounded px-3 py-1.5 text-fg disabled:opacity-60"
            />
          </label>
          <NumberField
            label={t('ap_threshold')} value={threshold} min={L.failureAlertThreshold.min} max={L.failureAlertThreshold.max}
            disabled={!canWrite} onChange={setThreshold}
          />
          {canWrite && (
            <button
              type="button"
              disabled={!notifyChanged || saving || !inRange(threshold, L.failureAlertThreshold)}
              onClick={() => onSave({ notifyRecipient: recipient.trim(), failureAlertThreshold: threshold })}
              className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
            >
              {t('action_save')}
            </button>
          )}
        </div>
        <p className="text-xs text-fg-subtle">
          {t('ap_notify_effective')}: {s.effectiveRecipients.length ? s.effectiveRecipients.join(', ') : t('ap_notify_none')}
        </p>
      </section>

      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="ap-auto">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="ap-auto" className="text-sm font-semibold text-fg">{t('ap_auto_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('ap_auto_hint')}</p>
          </div>
          <Toggle
            active={s.autoBlockEnabled} disabled={!canWrite || saving} label={t('ap_auto_switch')}
            onToggle={() => onSave({ autoBlockEnabled: !s.autoBlockEnabled })}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label={t('ap_auto_threshold')} value={autoThreshold} min={L.autoBlockThreshold.min} max={L.autoBlockThreshold.max}
            disabled={!canWrite} onChange={setAutoThreshold}
          />
          <NumberField
            label={t('ap_auto_days')} value={autoDays} min={L.autoBlockDays.min} max={L.autoBlockDays.max}
            disabled={!canWrite} onChange={setAutoDays}
          />
          {canWrite && (
            <button
              type="button"
              disabled={!autoChanged || saving || !inRange(autoThreshold, L.autoBlockThreshold) || !inRange(autoDays, L.autoBlockDays)}
              onClick={() => onSave({ autoBlockThreshold: autoThreshold, autoBlockDays: autoDays })}
              className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
            >
              {t('action_save')}
            </button>
          )}
        </div>
      </section>
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AttackProtectionPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('hygiene', 'write');
  const [resetStrikes, setResetStrikes] = useState(false);

  // 10.6: every part of the page refreshes every 30 s; the button refreshes all of them at once
  const locks = useQuery<LocksView>({ queryKey: ['ap-locks'], queryFn: () => api.get('/admin/security/protection/locks'), refetchInterval: AUTO_REFRESH_MS });
  const rules = useQuery<RulesView>({ queryKey: ['ap-rules'], queryFn: () => api.get('/admin/security/protection/rules'), refetchInterval: AUTO_REFRESH_MS });
  const settings = useQuery<ProtectionSettingsView>({ queryKey: ['ap-settings'], queryFn: () => api.get('/admin/security/protection/settings'), refetchInterval: AUTO_REFRESH_MS });
  const summary = useQuery<AttackSummary>({ queryKey: ['attack-summary'], queryFn: () => api.get('/admin/security/attacks/summary'), refetchInterval: AUTO_REFRESH_MS });
  const queries = [locks, rules, settings, summary];
  const fetching = queries.some((q) => q.isFetching);
  const refreshedAt = lastRefreshedAt(queries.map((q) => q.dataUpdatedAt));
  const refreshAll = () => { for (const q of queries) void q.refetch(); };

  const unlock = useMutation({
    mutationFn: (l: ActiveLockView) => api.post('/admin/security/protection/locks/release', { scope: l.scope, id: l.id, resetStrikes }),
    onSuccess: () => {
      toast.success(t('ap_unlocked'));
      void qc.invalidateQueries({ queryKey: ['ap-locks'] });
      void qc.invalidateQueries({ queryKey: ['attack-summary'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addRule = useMutation({
    mutationFn: (input: { kind: 'BLOCK' | 'ALLOW'; cidr: string; note: string; expiresInDays: number | null; confirmOwnIp?: boolean }) =>
      api.post('/admin/security/protection/rules', input),
    onSuccess: () => { toast.success(t('ap_added')); void qc.invalidateQueries({ queryKey: ['ap-rules'] }); },
    onError: (e: Error, input) => {
      if (e instanceof ApiError && e.code === 'BLOCKS_OWN_IP') {
        if (confirm(`${e.message}\n\n${t('ap_own_ip_confirm')}`)) addRule.mutate({ ...input, confirmOwnIp: true });
        return;
      }
      toast.error(e.message);
    },
  });
  const removeRule = useMutation({
    mutationFn: (r: IpRuleView) => api.delete(`/admin/security/protection/rules/${encodeURIComponent(r.id)}`),
    onSuccess: () => { toast.success(t('ap_removed')); void qc.invalidateQueries({ queryKey: ['ap-rules'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const saveSettings = useMutation({
    mutationFn: (patch: Partial<ProtectionSettingsView>) => api.put<ProtectionSettingsView>('/admin/security/protection/settings', patch),
    onSuccess: (s) => { toast.success(t('ap_saved')); qc.setQueryData(['ap-settings'], s); },
    onError: (e: Error) => toast.error(e.message),
  });

  const byProtocol = summary.data?.byProtocol ?? [];
  const events = eventsView(summary.data, summary.isError);
  const r = rules.data;

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('nav_attack_protection')}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('ap_page_intro')}</p>
          <p className="text-xs text-fg-subtle mt-1">
            {t('ap_last_refresh')} {refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : '—'} · {t('ap_auto_refresh')}
          </p>
        </div>
        <button
          type="button" aria-label={t('action_refresh')} title={t('action_refresh')} aria-busy={fetching}
          onClick={refreshAll}
          className="p-2 text-fg-subtle border border-line-strong rounded hover:bg-surface-2"
        >
          <RefreshCw size={13} className={fetching ? 'animate-spin' : undefined} />
        </button>
      </div>

      {/* Currently locked */}
      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="ap-locked">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="ap-locked" className="text-sm font-semibold text-fg">{t('ap_locked_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('ap_locked_hint')}</p>
          </div>
          {canWrite && (
            <label className="flex items-center gap-2 text-xs text-fg-muted shrink-0">
              <input type="checkbox" checked={resetStrikes} onChange={(e) => setResetStrikes(e.target.checked)} aria-label={t('ap_reset_strikes')} />
              {t('ap_reset_strikes')}
            </label>
          )}
        </div>
        {locks.isError ? (
          <p className="text-sm text-danger-fg">{(locks.error as Error).message}</p>
        ) : !locks.data ? (
          <p className="text-sm text-fg-subtle">…</p>
        ) : (
          <>
            <LockTable title={t('ap_locked_ips')} locks={locks.data.ips} scope="ip" canWrite={canWrite} busy={unlock.isPending} onUnlock={(l) => unlock.mutate(l)} t={t} />
            <LockTable title={t('ap_locked_accounts')} locks={locks.data.accounts} scope="account" canWrite={canWrite} busy={unlock.isPending} onUnlock={(l) => unlock.mutate(l)} t={t} />
            {locks.data.truncated && <p className="text-xs text-fg-subtle">{t('ap_locks_truncated')}</p>}
          </>
        )}
      </section>

      {/* Events per protocol (24 h) */}
      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="ap-protocols">
        <h2 id="ap-protocols" className="text-sm font-semibold text-fg">{t('ap_protocols_title')}</h2>
        {events === 'error' ? (
          <p className="text-sm text-danger-fg">{(summary.error as Error).message}</p>
        ) : events === 'loading' ? (
          <p className="text-sm text-fg-subtle">…</p>
        ) : events === 'empty' ? (
          <p className="text-sm text-fg-subtle">{t('ap_protocols_none')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {byProtocol.map((p) => (
              <span key={p.protocol} className="text-xs px-2 py-1 rounded bg-surface-2 text-fg-muted">
                {protocolLabel(p.protocol)} <span className="font-semibold text-fg tabular-nums">{p.count}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      {r && (
        <>
          <p className="text-xs text-fg-subtle">
            {t('ap_own_ip')}: <code className="font-mono">{r.callerIp || '—'}</code>
            {r.envExempt.length > 0 && <> · {t('ap_env_exempt')}: <code className="font-mono">{r.envExempt.join(', ')}</code></>}
          </p>
          <RuleSection
            kind="BLOCK" rules={r.block} callerIp={r.callerIp} canWrite={canWrite} t={t}
            adding={addRule.isPending} removing={removeRule.isPending}
            onAdd={(input) => addRule.mutate({ kind: 'BLOCK', ...input })} onRemove={(rule) => removeRule.mutate(rule)}
          />
          <RuleSection
            kind="ALLOW" rules={r.allow} callerIp={r.callerIp} canWrite={canWrite} t={t}
            adding={addRule.isPending} removing={removeRule.isPending}
            onAdd={(input) => addRule.mutate({ kind: 'ALLOW', ...input })} onRemove={(rule) => removeRule.mutate(rule)}
          />
        </>
      )}

      {settings.data && (
        <SettingsSections s={settings.data} canWrite={canWrite} saving={saveSettings.isPending} onSave={(p) => saveSettings.mutate(p)} t={t} />
      )}
    </div>
  );
}
