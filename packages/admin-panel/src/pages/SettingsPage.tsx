import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Mail, Shield, Wrench,
  Save, AlertTriangle, Info,
  Eye, RefreshCw, Globe,
  ToggleLeft, ToggleRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { API_RATE_LIMIT_FORM_DEFAULTS, rateLimitForm, rateLimitEnvNote, rateLimitLocked } from '../lib/apiRateLimit.js';

// ── Types ─────────────────────────────────────────────────────────────────────
interface GlobalSettings {
  id: string;
  // Organisation
  orgName:        string;
  adminEmail:     string;
  // Mail
  maxMessageSizeMb:    number;
  // Security
  minPasswordLength:           number;
  inactivityTimeoutMinutes:    number;
  requireMfaForAdmins:         boolean;
  selfServicePasswordReset:    boolean;
  auditLogEnabled:             boolean;
  apiRateLimitEnabled:         boolean;
  apiRateLimitWindowMin:       number;
  apiRateLimitPerIp:           number;
  apiRateLimitPerUser:         number;
  /** Rate-limit fields an API_RATE_LIMIT_* environment variable overrides (read-only). */
  apiRateLimitEnvOverrides?:   string[];
  // Maintenance
  maintenanceMode:    boolean;
  maintenanceMessage: string;
  // Server-URLs (read-only)
  publicHostname: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Field components ──────────────────────────────────────────────────────────
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] gap-4 py-4 border-b border-line last:border-0">
      <div>
        <label className="text-sm font-medium text-fg-muted">{label}</label>
        {hint && <p className="text-xs text-fg-subtle mt-0.5 leading-snug">{hint}</p>}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder = '', type = 'text', maxLength }: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; maxLength?: number;
}) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} maxLength={maxLength} className="input" />
  );
}

function NumberInput({ value, onChange, min, max, unit, disabled = false, label }: {
  value: number; onChange: (v: number) => void; min: number; max: number; unit?: string; disabled?: boolean; label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="number" value={value} onChange={(e) => onChange(parseInt(e.target.value, 10) || min)}
        min={min} max={max} disabled={disabled} aria-label={label} className="input w-28 disabled:opacity-50" />
      {unit && <span className="text-sm text-fg-subtle">{unit}</span>}
    </div>
  );
}

function Textarea({ value, onChange, placeholder = '', rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number;
}) {
  return (
    <textarea value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} rows={rows} className="input resize-none" />
  );
}

function Toggle({ value, onChange, label, disabled = false }: {
  value: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={() => onChange(!value)} disabled={disabled}
      className={`flex items-center gap-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${value ? 'text-accent-fg' : 'text-fg-subtle'}`}>
      {value ? <ToggleRight size={26} className="text-accent-fg" /> : <ToggleLeft size={26} className="text-fg-subtle" />}
      {label && <span>{label}</span>}
    </button>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ icon: Icon, title, description, children, saving, onSave, dirty }: {
  icon: React.ElementType; title: string; description: string;
  children: React.ReactNode; saving?: boolean; onSave?: () => void; dirty?: boolean;
}) {
  const t = useT();
  return (
    <div className="card">
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
            <Icon size={16} className="text-accent-fg" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-fg">{title}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{description}</p>
          </div>
        </div>
        {onSave && (
          <button type="button" onClick={onSave} disabled={saving || !dirty}
            className={`btn-primary text-xs disabled:opacity-40 ml-4 shrink-0 ${dirty ? '' : 'opacity-40'}`}>
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? t('action_saving') : t('action_save')}
          </button>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const t = useT();
  const qc = useQueryClient();

  const { data: cfg, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn:  () => api.get<GlobalSettings>('/admin/settings'),
  });

  // Only settings the server actually applies are offered (v9.1 review: the former
  // description/logo/language/time zone/welcome text, attachment size, trash days,
  // lockout count, token lifetime and self-registration fields were saved but never read).
  const [org, setOrg] = useState({ orgName: '', adminEmail: '' });
  const [mail, setMail] = useState({ maxMessageSizeMb: 25 });
  const [sec, setSec] = useState({
    minPasswordLength: 8,
    inactivityTimeoutMinutes: 30,
    requireMfaForAdmins: false,
    selfServicePasswordReset: true,
    auditLogEnabled: true,
    ...API_RATE_LIMIT_FORM_DEFAULTS,
  });
  const [maint, setMaint] = useState({
    maintenanceMode: false,
    maintenanceMessage: '',
  });

  const [orgDirty,   setOrgDirty]   = useState(false);
  const [mailDirty,  setMailDirty]  = useState(false);
  const [secDirty,   setSecDirty]   = useState(false);
  const [maintDirty, setMaintDirty] = useState(false);

  useEffect(() => {
    if (!cfg) return;
    setOrg({ orgName: cfg.orgName, adminEmail: cfg.adminEmail });
    setMail({ maxMessageSizeMb: cfg.maxMessageSizeMb });
    setSec({ minPasswordLength: cfg.minPasswordLength,
             inactivityTimeoutMinutes: cfg.inactivityTimeoutMinutes,
             requireMfaForAdmins: cfg.requireMfaForAdmins,
             selfServicePasswordReset: cfg.selfServicePasswordReset ?? true,
             auditLogEnabled: cfg.auditLogEnabled ?? true,
             ...rateLimitForm(cfg) });
    setMaint({ maintenanceMode: cfg.maintenanceMode, maintenanceMessage: cfg.maintenanceMessage });
    setOrgDirty(false); setMailDirty(false); setSecDirty(false); setMaintDirty(false);
  }, [cfg]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-settings'] });

  const orgMut = useMutation({
    mutationFn: () => api.put<GlobalSettings>('/admin/settings/org', org),
    onSuccess: () => { toast.success(t('settings_org_saved')); setOrgDirty(false); void invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mailMut = useMutation({
    mutationFn: () => api.put<GlobalSettings>('/admin/settings/mail', mail),
    onSuccess: () => { toast.success(t('settings_mail_saved')); setMailDirty(false); void invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const secMut = useMutation({
    mutationFn: () => api.put<GlobalSettings>('/admin/settings/security', sec),
    onSuccess: () => { toast.success(t('settings_sec_saved')); setSecDirty(false); void invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const maintMut = useMutation({
    mutationFn: () => api.put<GlobalSettings>('/admin/settings/maintenance', maint),
    onSuccess: () => { toast.success(t('settings_maint_saved')); setMaintDirty(false); void invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  function updOrg<K extends keyof typeof org>(k: K, v: typeof org[K])   { setOrg(p => ({ ...p, [k]: v })); setOrgDirty(true); }
  function updMail<K extends keyof typeof mail>(k: K, v: typeof mail[K]) { setMail(p => ({ ...p, [k]: v })); setMailDirty(true); }
  function updSec<K extends keyof typeof sec>(k: K, v: typeof sec[K])   { setSec(p => ({ ...p, [k]: v })); setSecDirty(true); }
  function updMaint<K extends keyof typeof maint>(k: K, v: typeof maint[K]) { setMaint(p => ({ ...p, [k]: v })); setMaintDirty(true); }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-2 text-fg-subtle">
          <RefreshCw size={16} className="animate-spin" />
          <span className="text-sm">{t('settings_loading')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-[860px]">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('settings_page_title')}</h1>
          <p className="text-xs text-fg-subtle mt-0.5">
            {t('settings_page_saved')} {cfg ? fmtDate(cfg.updatedAt) : '—'}
            {cfg?.publicHostname && (
              <span className="ml-3 inline-flex items-center gap-1">
                <Globe size={11} />
                {cfg.publicHostname}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ── Maintenance mode banner ────────────────────────────────────────── */}
      {maint.maintenanceMode && (
        <div className="flex items-center gap-3 bg-warning-bg border border-warning-line rounded-lg px-4 py-3 text-warning-fg">
          <AlertTriangle size={16} className="shrink-0 text-warning-fg" />
          <div>
            <p className="text-sm font-semibold">{t('settings_maint_banner_hd')}</p>
            <p className="text-xs mt-0.5">{t('settings_maint_banner_body')}</p>
          </div>
        </div>
      )}

      {/* ══ SECTION 1: ORGANIZATION ══════════════════════════════════════════ */}
      <Section icon={Building2} title={t('settings_org_title')} description={t('settings_org_desc')}
        saving={orgMut.isPending} dirty={orgDirty} onSave={() => orgMut.mutate()}>

        <FieldGroup label={t('settings_org_name')} hint={t('settings_org_name_hint')}>
          <TextInput value={org.orgName} onChange={(v) => updOrg('orgName', v)} placeholder="z.B. Musterfirma Mail" maxLength={100} />
        </FieldGroup>

        <FieldGroup label={t('settings_org_admin_email')} hint={t('settings_org_admin_hint')}>
          <TextInput value={org.adminEmail} onChange={(v) => updOrg('adminEmail', v)} type="email" placeholder="admin@example.com" />
        </FieldGroup>

      </Section>

      {/* ══ SECTION 2: MAIL SETTINGS ═════════════════════════════════════════ */}
      <Section icon={Mail} title={t('settings_mail_title')} description={t('settings_mail_desc')}
        saving={mailMut.isPending} dirty={mailDirty} onSave={() => mailMut.mutate()}>

        <FieldGroup label={t('settings_mail_max_msg')} hint={t('settings_mail_max_msg_hint')}>
          <NumberInput value={mail.maxMessageSizeMb} onChange={(v) => updMail('maxMessageSizeMb', v)} min={1} max={500} unit={t('unit_mb')} />
        </FieldGroup>

      </Section>

      {/* ══ SECTION 3: SECURITY POLICIES ═════════════════════════════════════ */}
      <Section icon={Shield} title={t('settings_sec_title')} description={t('settings_sec_desc')}
        saving={secMut.isPending} dirty={secDirty} onSave={() => secMut.mutate()}>

        <FieldGroup label={t('settings_sec_pw_len')} hint={t('settings_sec_pw_len_hint')}>
          <NumberInput value={sec.minPasswordLength} onChange={(v) => updSec('minPasswordLength', v)} min={8} max={64} unit={t('unit_chars')} />
          <div className="flex gap-1 mt-1">
            {[8, 10, 12, 14, 16].map((n) => (
              <button key={n} type="button" onClick={() => updSec('minPasswordLength', n)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${sec.minPasswordLength === n ? 'border-accent bg-accent/10 text-accent-fg' : 'border-line text-fg-subtle hover:border-line-strong'}`}>
                {n}
              </button>
            ))}
          </div>
        </FieldGroup>

        <FieldGroup label={t('settings_sec_inactivity')} hint={t('settings_sec_inactivity_hint')}>
          <NumberInput value={sec.inactivityTimeoutMinutes} onChange={(v) => updSec('inactivityTimeoutMinutes', v)} min={0} max={1440} unit={t('unit_minutes')} />
          <div className="flex gap-1 mt-1 flex-wrap">
            {[0, 5, 10, 15, 30, 60, 120].map((n) => (
              <button key={n} type="button" onClick={() => updSec('inactivityTimeoutMinutes', n)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${sec.inactivityTimeoutMinutes === n ? 'border-accent bg-accent/10 text-accent-fg' : 'border-line text-fg-subtle hover:border-line-strong'}`}>
                {n === 0 ? t('settings_sec_inactivity_off') : `${n} min`}
              </button>
            ))}
          </div>
          {sec.inactivityTimeoutMinutes === 0 ? (
            <p className="text-xs text-fg-subtle mt-1">{t('settings_sec_inactivity_off')} — Benutzer werden nur beim Token-Ablauf abgemeldet</p>
          ) : (
            <p className="text-xs text-fg-subtle mt-1">
              Automatischer Logout nach {sec.inactivityTimeoutMinutes} {sec.inactivityTimeoutMinutes === 1 ? 'Minute' : 'Minuten'} Inaktivität
              {sec.inactivityTimeoutMinutes < 5 && (
                <span className="text-warning-fg ml-2">⚠ Sehr kurze Zeit — könnte Benutzer stören</span>
              )}
            </p>
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_sec_mfa')} hint={t('settings_sec_mfa_hint')}>
          <Toggle value={sec.requireMfaForAdmins} onChange={(v) => updSec('requireMfaForAdmins', v)}
            label={sec.requireMfaForAdmins ? t('settings_sec_mfa_on') : t('status_disabled')} />
          {sec.requireMfaForAdmins && (
            <div className="flex items-center gap-2 mt-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
              <AlertTriangle size={12} />
              {t('settings_sec_mfa_warn')}
            </div>
          )}
        </FieldGroup>

        <FieldGroup
          label="Passwort-Selbstzurücksetzung"
          hint="Erlaubt Benutzern, ihr Passwort eigenständig per E-Mail-Link zurückzusetzen (Vergessen-Funktion im Login)."
        >
          <Toggle
            value={sec.selfServicePasswordReset}
            onChange={(v) => updSec('selfServicePasswordReset', v)}
            label={sec.selfServicePasswordReset ? 'Aktiviert — Benutzer können Passwort selbst zurücksetzen' : 'Deaktiviert — nur Administratoren können Passwörter zurücksetzen'}
          />
          {!sec.selfServicePasswordReset && (
            <div className="flex items-center gap-2 mt-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-3 py-2">
              <AlertTriangle size={12} />
              Der „Passwort vergessen?"-Link wird im Login-Formular ausgeblendet.
            </div>
          )}
        </FieldGroup>

        <FieldGroup
          label="Audit-Log"
          hint="Protokolliert alle ändernden Admin-Aktionen sowie Exporte und Backup-Downloads. Kritische Aktionen (Einstellungen, der Audit-Schalter selbst, Audit-Log-Exporte, Postfach- und Domain-Löschungen) werden auch bei ausgeschaltetem Audit-Log IMMER protokolliert — Compliance-Anforderung gegen Insider-Threats."
        >
          <Toggle
            value={sec.auditLogEnabled}
            onChange={(v) => updSec('auditLogEnabled', v)}
            label={sec.auditLogEnabled
              ? 'Aktiviert — alle Admin-Aktionen werden protokolliert'
              : 'Deaktiviert — nur kritische Aktionen werden noch protokolliert'}
          />
          {!sec.auditLogEnabled && (
            <div className="flex items-start gap-2 mt-2 text-xs text-danger-fg bg-danger-bg border border-danger-line rounded px-3 py-2">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <div>
                <strong>Achtung:</strong> Compliance-Anforderungen (DSGVO Art. 32, SOX, HIPAA, TISAX, ISO 27001) verlangen lückenlose Protokollierung administrativer Aktionen.
                Ein Ausschalten kann zu Audit-Findings führen. Diese Aktion selbst wird ungeachtet des Toggle-Werts protokolliert.
              </div>
            </div>
          )}
        </FieldGroup>

        <FieldGroup
          label="API-Ratenbegrenzung"
          hint="Begrenzt die Anfragen je Zeitfenster. Angemeldete Webmail- und Verwaltungssitzungen zählen je Benutzer, alle übrigen Anfragen – auch Mailprogramme über ActiveSync, CalDAV/CardDAV oder JMAP – je IP-Adresse. Statische Dateien und der Live-Ereignisstrom zählen nicht."
        >
          <Toggle value={sec.apiRateLimitEnabled} onChange={(v) => updSec('apiRateLimitEnabled', v)}
            disabled={rateLimitLocked(cfg?.apiRateLimitEnvOverrides, 'apiRateLimitEnabled')}
            label={sec.apiRateLimitEnabled ? 'Aktiviert' : 'Deaktiviert — keine globale Begrenzung (der Anmeldeschutz bleibt aktiv)'} />
          {sec.apiRateLimitEnabled && (
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 mt-2 text-sm text-fg-muted">
              <span>Zeitfenster</span>
              <NumberInput value={sec.apiRateLimitWindowMin} onChange={(v) => updSec('apiRateLimitWindowMin', v)} min={1} max={1440} unit={t('unit_minutes')}
                label="Zeitfenster" disabled={rateLimitLocked(cfg?.apiRateLimitEnvOverrides, 'apiRateLimitWindowMin')} />
              <span>Je Benutzer</span>
              <NumberInput value={sec.apiRateLimitPerUser} onChange={(v) => updSec('apiRateLimitPerUser', v)} min={10} max={1000000} unit="Anfragen"
                label="Anfragen je Benutzer" disabled={rateLimitLocked(cfg?.apiRateLimitEnvOverrides, 'apiRateLimitPerUser')} />
              <span>Je IP-Adresse (übrige Anfragen)</span>
              <NumberInput value={sec.apiRateLimitPerIp} onChange={(v) => updSec('apiRateLimitPerIp', v)} min={10} max={1000000} unit="Anfragen"
                label="Anfragen je IP-Adresse" disabled={rateLimitLocked(cfg?.apiRateLimitEnvOverrides, 'apiRateLimitPerIp')} />
            </div>
          )}
          {rateLimitEnvNote(cfg?.apiRateLimitEnvOverrides) && (
            <div role="note" className="flex items-start gap-2 mt-2 text-xs text-fg-muted bg-surface-2 border border-line rounded px-3 py-2">
              <Info size={12} className="shrink-0 mt-0.5" />
              {rateLimitEnvNote(cfg?.apiRateLimitEnvOverrides)}
            </div>
          )}
        </FieldGroup>
      </Section>

      {/* ══ SECTION 4: MAINTENANCE MODE ═══════════════════════════════════════ */}
      <Section icon={Wrench} title={t('settings_maint_title')} description={t('settings_maint_desc')}
        saving={maintMut.isPending} dirty={maintDirty} onSave={() => maintMut.mutate()}>

        <FieldGroup label={t('settings_maint_field')} hint={t('settings_maint_field_hint')}>
          <Toggle value={maint.maintenanceMode} onChange={(v) => updMaint('maintenanceMode', v)}
            label={maint.maintenanceMode ? t('settings_maint_on') : t('settings_maint_off')} />
          {maint.maintenanceMode && (
            <div className="flex items-center gap-2 mt-2 px-3 py-2 bg-danger-bg border border-danger-line rounded text-xs text-danger-fg">
              <AlertTriangle size={12} className="shrink-0" />
              <strong>Achtung:</strong>&nbsp;{t('settings_maint_warn')}
            </div>
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_maint_msg')} hint={t('settings_maint_msg_hint')}>
          <Textarea value={maint.maintenanceMessage} onChange={(v) => updMaint('maintenanceMessage', v)} rows={3} />
          <p className="text-xs text-fg-subtle">{t('settings_maint_msg_chars')}</p>
        </FieldGroup>

        {maint.maintenanceMessage && (
          <div className="mt-3 border border-dashed border-warning-line rounded-lg p-4 bg-warning-bg">
            <p className="text-xs font-medium text-warning-fg mb-2 flex items-center gap-1">
              <Eye size={12} /> {t('settings_maint_preview')}
            </p>
            <div className="bg-surface rounded p-3 border border-warning-line text-sm text-fg-muted text-center">
              <Wrench size={28} className="mx-auto mb-2 text-warning-fg" />
              <p className="font-semibold text-fg mb-1">{t('settings_maint_preview_hd')}</p>
              <p className="text-fg-muted text-xs">{maint.maintenanceMessage}</p>
            </div>
          </div>
        )}
      </Section>

      {/* ── Info-Box ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-info-bg border border-info-line rounded-lg px-4 py-3 text-info-fg">
        <Info size={15} className="shrink-0" />
        <p className="text-xs">
          {t('settings_urls_info')}
        </p>
      </div>
    </div>
  );
}
