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

// ── Typen ─────────────────────────────────────────────────────────────────────
interface GlobalSettings {
  id: string;
  // Organisation
  orgName:        string;
  orgDescription: string;
  adminEmail:     string;
  language:       string;
  timezone:       string;
  welcomeMessage: string;
  logoUrl:        string;
  // Mail
  maxMessageSizeMb:    number;
  maxAttachmentSizeMb: number;
  trashRetentionDays:  number;
  // Sicherheit
  minPasswordLength:           number;
  maxLoginAttempts:            number;
  sessionTimeoutMinutes:       number;
  inactivityTimeoutMinutes:    number;
  requireMfaForAdmins:         boolean;
  allowSelfRegistration:       boolean;
  selfServicePasswordReset:    boolean;
  auditLogEnabled:             boolean;
  // Wartung
  maintenanceMode:    boolean;
  maintenanceMessage: string;
  // Server-URLs (read-only)
  publicHostname: string;
  updatedAt: string;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── IANA-Zeitzonen ────────────────────────────────────────────────────────────
// Alle vom Runtime unterstützten IANA-Zonen (~400). Label enthält aktuellen
// UTC-Offset zur Orientierung. Sortiert: UTC oben, dann alphabetisch.
function buildTimezoneOptions(): { value: string; label: string }[] {
  type IntlEx = typeof Intl & { supportedValuesOf?: (k: string) => string[] };
  const intlAny = Intl as IntlEx;
  const raw = (intlAny.supportedValuesOf?.('timeZone') ?? [
    // Fallback für ältere Runtimes — kleine kuratierte Liste
    'UTC', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London',
    'Europe/Madrid', 'Europe/Paris', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Warsaw',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Dubai', 'Asia/Shanghai',
    'Australia/Sydney', 'Pacific/Auckland',
  ]);

  function offsetLabel(tz: string): string {
    try {
      const fmt = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' });
      const parts = fmt.formatToParts(new Date());
      const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      return off || '';
    } catch {
      return '';
    }
  }

  const utcFirst = raw.filter((z) => z === 'UTC');
  const rest = raw.filter((z) => z !== 'UTC').sort((a, b) => a.localeCompare(b));
  return [...utcFirst, ...rest].map((z) => {
    const off = offsetLabel(z);
    return { value: z, label: off ? `${z} (${off})` : z };
  });
}
const TIMEZONE_OPTIONS = buildTimezoneOptions();

// ── Feldkomponenten ───────────────────────────────────────────────────────────
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] gap-4 py-4 border-b border-gray-100 last:border-0">
      <div>
        <label className="text-sm font-medium text-gray-700">{label}</label>
        {hint && <p className="text-xs text-gray-400 mt-0.5 leading-snug">{hint}</p>}
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

function NumberInput({ value, onChange, min, max, unit }: {
  value: number; onChange: (v: number) => void; min: number; max: number; unit?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="number" value={value} onChange={(e) => onChange(parseInt(e.target.value, 10) || min)}
        min={min} max={max} className="input w-28" />
      {unit && <span className="text-sm text-gray-500">{unit}</span>}
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

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`flex items-center gap-2 text-sm transition-colors ${value ? 'text-accent' : 'text-gray-500'}`}>
      {value ? <ToggleRight size={26} className="text-accent" /> : <ToggleLeft size={26} className="text-gray-400" />}
      {label && <span>{label}</span>}
    </button>
  );
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input w-auto">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Sektion-Wrapper ───────────────────────────────────────────────────────────
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
            <Icon size={16} className="text-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{description}</p>
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

// ── Hauptseite ────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const t = useT();
  const qc = useQueryClient();

  const { data: cfg, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn:  () => api.get<GlobalSettings>('/admin/settings'),
  });

  const [org, setOrg] = useState({
    orgName: '', orgDescription: '', adminEmail: '',
    language: 'de', timezone: 'Europe/Berlin',
    welcomeMessage: '', logoUrl: '',
  });
  const [mail, setMail] = useState({
    maxMessageSizeMb: 25, maxAttachmentSizeMb: 25, trashRetentionDays: 30,
  });
  const [sec, setSec] = useState({
    minPasswordLength: 8, maxLoginAttempts: 5,
    sessionTimeoutMinutes: 480,
    inactivityTimeoutMinutes: 30,
    requireMfaForAdmins: false, allowSelfRegistration: false,
    selfServicePasswordReset: true,
    auditLogEnabled: true,
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
    setOrg({ orgName: cfg.orgName, orgDescription: cfg.orgDescription, adminEmail: cfg.adminEmail,
             language: cfg.language, timezone: cfg.timezone, welcomeMessage: cfg.welcomeMessage, logoUrl: cfg.logoUrl });
    setMail({ maxMessageSizeMb: cfg.maxMessageSizeMb, maxAttachmentSizeMb: cfg.maxAttachmentSizeMb, trashRetentionDays: cfg.trashRetentionDays });
    setSec({ minPasswordLength: cfg.minPasswordLength, maxLoginAttempts: cfg.maxLoginAttempts,
             sessionTimeoutMinutes: cfg.sessionTimeoutMinutes,
             inactivityTimeoutMinutes: cfg.inactivityTimeoutMinutes,
             requireMfaForAdmins: cfg.requireMfaForAdmins, allowSelfRegistration: cfg.allowSelfRegistration,
             selfServicePasswordReset: cfg.selfServicePasswordReset ?? true,
             auditLogEnabled: cfg.auditLogEnabled ?? true });
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
        <div className="flex items-center gap-2 text-gray-400">
          <RefreshCw size={16} className="animate-spin" />
          <span className="text-sm">{t('settings_loading')}</span>
        </div>
      </div>
    );
  }

  // ── Zeiten formatieren ──────────────────────────────────────────────────────
  function fmtTrash(days: number) {
    if (days === 1) return `1 ${t('unit_day')}`;
    if (days <= 7)  return `${days} ${t('unit_days')}`;
    if (days <= 30) return `${days} ${t('unit_days')} (${Math.round(days / 7)} ${t('unit_weeks')})`;
    return `${days} ${t('unit_days')} (ca. ${Math.round(days / 30)} ${t('unit_months')})`;
  }
  function fmtSession(min: number) {
    if (min < 60)   return `${min} ${t('unit_minutes')}`;
    if (min < 1440) return `${Math.round(min / 60 * 10) / 10} ${t('unit_hours')}`;
    return `${Math.round(min / 1440 * 10) / 10} ${t('unit_days')}`;
  }

  return (
    <div className="p-6 space-y-5 max-w-[860px]">

      {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t('settings_page_title')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">
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

      {/* ── Wartungsmodus-Banner ───────────────────────────────────────────── */}
      {maint.maintenanceMode && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-800">
          <AlertTriangle size={16} className="shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-semibold">{t('settings_maint_banner_hd')}</p>
            <p className="text-xs mt-0.5">{t('settings_maint_banner_body')}</p>
          </div>
        </div>
      )}

      {/* ══ SEKTION 1: ORGANISATION ══════════════════════════════════════════ */}
      <Section icon={Building2} title={t('settings_org_title')} description={t('settings_org_desc')}
        saving={orgMut.isPending} dirty={orgDirty} onSave={() => orgMut.mutate()}>

        <FieldGroup label={t('settings_org_name')} hint={t('settings_org_name_hint')}>
          <TextInput value={org.orgName} onChange={(v) => updOrg('orgName', v)} placeholder="z.B. Musterfirma Mail" maxLength={100} />
        </FieldGroup>

        <FieldGroup label={t('settings_org_desc_field')} hint={t('settings_org_desc_hint')}>
          <Textarea value={org.orgDescription} onChange={(v) => updOrg('orgDescription', v)} rows={2} />
        </FieldGroup>

        <FieldGroup label={t('settings_org_admin_email')} hint={t('settings_org_admin_hint')}>
          <TextInput value={org.adminEmail} onChange={(v) => updOrg('adminEmail', v)} type="email" placeholder="admin@example.com" />
        </FieldGroup>

        <FieldGroup label={t('settings_org_logo')} hint={t('settings_org_logo_hint')}>
          <TextInput value={org.logoUrl} onChange={(v) => updOrg('logoUrl', v)} placeholder="https://example.com/logo.png" />
          {org.logoUrl && (
            <img src={org.logoUrl} alt="Logo" className="h-10 mt-1 object-contain border border-gray-100 rounded p-1"
              onError={(e) => { (e.target as HTMLImageElement).hidden = true; }} />
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_org_lang')} hint={t('settings_org_lang_hint')}>
          <Select value={org.language} onChange={(v) => updOrg('language', v)}
            options={[{ value: 'de', label: '🇩🇪 Deutsch' }, { value: 'en', label: '🇬🇧 English' }]} />
        </FieldGroup>

        <FieldGroup label={t('settings_org_tz')} hint={t('settings_org_tz_hint')}>
          <Select value={org.timezone} onChange={(v) => updOrg('timezone', v)}
            options={TIMEZONE_OPTIONS} />
        </FieldGroup>

        <FieldGroup label={t('settings_org_welcome')} hint={t('settings_org_welcome_hint')}>
          <Textarea value={org.welcomeMessage} onChange={(v) => updOrg('welcomeMessage', v)} rows={2} />
        </FieldGroup>
      </Section>

      {/* ══ SEKTION 2: MAIL-EINSTELLUNGEN ════════════════════════════════════ */}
      <Section icon={Mail} title={t('settings_mail_title')} description={t('settings_mail_desc')}
        saving={mailMut.isPending} dirty={mailDirty} onSave={() => mailMut.mutate()}>

        <FieldGroup label={t('settings_mail_max_msg')} hint={t('settings_mail_max_msg_hint')}>
          <NumberInput value={mail.maxMessageSizeMb} onChange={(v) => updMail('maxMessageSizeMb', v)} min={1} max={500} unit={t('unit_mb')} />
        </FieldGroup>

        <FieldGroup label={t('settings_mail_max_att')} hint={t('settings_mail_max_att_hint')}>
          <NumberInput value={mail.maxAttachmentSizeMb} onChange={(v) => updMail('maxAttachmentSizeMb', v)} min={1} max={500} unit={t('unit_mb')} />
        </FieldGroup>

        <FieldGroup label={t('settings_mail_trash')} hint={t('settings_mail_trash_hint')}>
          <NumberInput value={mail.trashRetentionDays} onChange={(v) => updMail('trashRetentionDays', v)} min={1} max={3650} unit={t('unit_days')} />
          <p className="text-xs text-gray-400">{fmtTrash(mail.trashRetentionDays)}</p>
        </FieldGroup>
      </Section>

      {/* ══ SEKTION 3: SICHERHEITSRICHTLINIEN ════════════════════════════════ */}
      <Section icon={Shield} title={t('settings_sec_title')} description={t('settings_sec_desc')}
        saving={secMut.isPending} dirty={secDirty} onSave={() => secMut.mutate()}>

        <FieldGroup label={t('settings_sec_pw_len')} hint={t('settings_sec_pw_len_hint')}>
          <NumberInput value={sec.minPasswordLength} onChange={(v) => updSec('minPasswordLength', v)} min={4} max={64} unit={t('unit_chars')} />
          <div className="flex gap-1 mt-1">
            {[4, 6, 8, 10, 12, 16].map((n) => (
              <button key={n} type="button" onClick={() => updSec('minPasswordLength', n)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${sec.minPasswordLength === n ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {n}
              </button>
            ))}
          </div>
        </FieldGroup>

        <FieldGroup label={t('settings_sec_max_login')} hint={t('settings_sec_max_login_hint')}>
          <NumberInput value={sec.maxLoginAttempts} onChange={(v) => updSec('maxLoginAttempts', v)} min={1} max={100} unit={t('unit_attempts')} />
        </FieldGroup>

        <FieldGroup label={t('settings_sec_session')} hint={t('settings_sec_session_hint')}>
          <NumberInput value={sec.sessionTimeoutMinutes} onChange={(v) => updSec('sessionTimeoutMinutes', v)} min={5} max={10080} unit={t('unit_minutes')} />
          <p className="text-xs text-gray-400 mt-1">{fmtSession(sec.sessionTimeoutMinutes)}</p>
        </FieldGroup>

        <FieldGroup label={t('settings_sec_inactivity')} hint={t('settings_sec_inactivity_hint')}>
          <NumberInput value={sec.inactivityTimeoutMinutes} onChange={(v) => updSec('inactivityTimeoutMinutes', v)} min={0} max={1440} unit={t('unit_minutes')} />
          <div className="flex gap-1 mt-1 flex-wrap">
            {[0, 5, 10, 15, 30, 60, 120].map((n) => (
              <button key={n} type="button" onClick={() => updSec('inactivityTimeoutMinutes', n)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${sec.inactivityTimeoutMinutes === n ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {n === 0 ? t('settings_sec_inactivity_off') : `${n} min`}
              </button>
            ))}
          </div>
          {sec.inactivityTimeoutMinutes === 0 ? (
            <p className="text-xs text-gray-400 mt-1">{t('settings_sec_inactivity_off')} — Benutzer werden nur beim Token-Ablauf abgemeldet</p>
          ) : (
            <p className="text-xs text-gray-400 mt-1">
              Automatischer Logout nach {sec.inactivityTimeoutMinutes} {sec.inactivityTimeoutMinutes === 1 ? 'Minute' : 'Minuten'} Inaktivität
              {sec.inactivityTimeoutMinutes < 5 && (
                <span className="text-amber-500 ml-2">⚠ Sehr kurze Zeit — könnte Benutzer stören</span>
              )}
            </p>
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_sec_mfa')} hint={t('settings_sec_mfa_hint')}>
          <Toggle value={sec.requireMfaForAdmins} onChange={(v) => updSec('requireMfaForAdmins', v)}
            label={sec.requireMfaForAdmins ? t('settings_sec_mfa_on') : t('status_disabled')} />
          {sec.requireMfaForAdmins && (
            <div className="flex items-center gap-2 mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2">
              <AlertTriangle size={12} />
              {t('settings_sec_mfa_warn')}
            </div>
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_sec_selfreg')} hint={t('settings_sec_selfreg_hint')}>
          <Toggle value={sec.allowSelfRegistration} onChange={(v) => updSec('allowSelfRegistration', v)}
            label={sec.allowSelfRegistration ? t('settings_sec_selfreg_on') : t('settings_sec_selfreg_off')} />
          {sec.allowSelfRegistration && (
            <div className="flex items-center gap-2 mt-2 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
              <Info size={12} />
              {t('settings_sec_selfreg_info')}
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
            <div className="flex items-center gap-2 mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2">
              <AlertTriangle size={12} />
              Der „Passwort vergessen?"-Link wird im Login-Formular ausgeblendet.
            </div>
          )}
        </FieldGroup>

        <FieldGroup
          label="Audit-Log"
          hint="Protokolliert alle administrativen Aktionen (Benutzerverwaltung, Domain-Änderungen, Logins). Kritische Aktionen (Einstellungen-Änderung, Audit-Toggle selbst, Rolle/OAuth/Mailbox-/Domain-Löschungen) werden auch bei ausgeschaltetem Audit-Log IMMER protokolliert — Compliance-Anforderung gegen Insider-Threats."
        >
          <Toggle
            value={sec.auditLogEnabled}
            onChange={(v) => updSec('auditLogEnabled', v)}
            label={sec.auditLogEnabled
              ? 'Aktiviert — alle Admin-Aktionen werden protokolliert'
              : 'Deaktiviert — nur kritische Aktionen werden noch protokolliert'}
          />
          {!sec.auditLogEnabled && (
            <div className="flex items-start gap-2 mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <div>
                <strong>Achtung:</strong> Compliance-Anforderungen (DSGVO Art. 32, SOX, HIPAA, TISAX, ISO 27001) verlangen lückenlose Protokollierung administrativer Aktionen.
                Ein Ausschalten kann zu Audit-Findings führen. Diese Aktion selbst wird ungeachtet des Toggle-Werts protokolliert.
              </div>
            </div>
          )}
        </FieldGroup>
      </Section>

      {/* ══ SEKTION 4: WARTUNGSMODUS ══════════════════════════════════════════ */}
      <Section icon={Wrench} title={t('settings_maint_title')} description={t('settings_maint_desc')}
        saving={maintMut.isPending} dirty={maintDirty} onSave={() => maintMut.mutate()}>

        <FieldGroup label={t('settings_maint_field')} hint={t('settings_maint_field_hint')}>
          <Toggle value={maint.maintenanceMode} onChange={(v) => updMaint('maintenanceMode', v)}
            label={maint.maintenanceMode ? t('settings_maint_on') : t('settings_maint_off')} />
          {maint.maintenanceMode && (
            <div className="flex items-center gap-2 mt-2 px-3 py-2 bg-red-50 border border-red-100 rounded text-xs text-red-700">
              <AlertTriangle size={12} className="shrink-0" />
              <strong>Achtung:</strong>&nbsp;{t('settings_maint_warn')}
            </div>
          )}
        </FieldGroup>

        <FieldGroup label={t('settings_maint_msg')} hint={t('settings_maint_msg_hint')}>
          <Textarea value={maint.maintenanceMessage} onChange={(v) => updMaint('maintenanceMessage', v)} rows={3} />
          <p className="text-xs text-gray-400">{t('settings_maint_msg_chars')}</p>
        </FieldGroup>

        {maint.maintenanceMessage && (
          <div className="mt-3 border border-dashed border-amber-200 rounded-lg p-4 bg-amber-50">
            <p className="text-xs font-medium text-amber-700 mb-2 flex items-center gap-1">
              <Eye size={12} /> {t('settings_maint_preview')}
            </p>
            <div className="bg-white rounded p-3 border border-amber-100 text-sm text-gray-700 text-center">
              <Wrench size={28} className="mx-auto mb-2 text-amber-400" />
              <p className="font-semibold text-gray-800 mb-1">{t('settings_maint_preview_hd')}</p>
              <p className="text-gray-600 text-xs">{maint.maintenanceMessage}</p>
            </div>
          </div>
        )}
      </Section>

      {/* ── Info-Box ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-blue-700">
        <Info size={15} className="shrink-0" />
        <p className="text-xs">
          {t('settings_urls_info')}
        </p>
      </div>
    </div>
  );
}
