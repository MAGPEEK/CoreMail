import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, Link } from 'react-router-dom';
import {
  User, PenLine, BellOff, Shield, Key, HardDrive, Trash2,
  ChevronDown, Loader2, Lock, Palette, Sun, Moon, Monitor, Check,
  ShieldCheck, ShieldOff, Copy, RefreshCw, AlertTriangle, Globe, CalendarDays,
  Tag, Star, Plus, Pencil, X as XIcon, Smartphone, AlertCircle,
  Layout, PanelRight, PanelBottom, EyeOff, Rows3, Clock, ListFilter,
  Cable, Mail as MailIcon, BookUser, Info, ExternalLink, RotateCcw, Bell, FileText,
} from 'lucide-react';
import { RulesSection } from '../components/RulesSection.js';
import { RecoverDeletedItemsPanel } from '../components/RecoverDeletedItems.js';
import { MailboxAccessLog } from '../components/MailboxAccessLog.js';
import { QuotaIndicator } from '../components/QuotaIndicator.js';
import { quotaColor, type QuotaLevel } from '../lib/quota.js';
import { SignatureSettings } from '../components/settings/SignatureSettings.js';
import { PANE_CARD_CLASS } from '../lib/paneLayout.js';
import { BackgroundSettings } from '../components/settings/BackgroundSettings.js';
import { TemplateSettings } from '../components/settings/TemplateSettings.js';
import { ProfilePhotoSettings } from '../components/settings/ProfilePhotoSettings.js';
import { ReadingSettings } from '../components/settings/ReadingSettings.js';
import { ComposeSettings } from '../components/settings/ComposeSettings.js';
import { RegionalSettings } from '../components/settings/RegionalSettings.js';
import { CalendarSettings } from '../components/settings/CalendarSettings.js';
import { MailSortSettings } from '../components/settings/MailSortSettings.js';
import { SessionsPanel, DevicesPanel, SmimeSettingsPanel, TrustedDevicesPanel } from '../components/settings/SecurityPanels.js';
import { useMfaEnforcement } from '../hooks/useMfaEnforcement.js';
import { NotificationsSection } from '../components/NotificationsSection.js';
import { ViewKeyboardSettings } from '../components/ViewKeyboardSettings.js';
import { format as fmtDate } from 'date-fns';
import { api, apiFetch, fetchBlob, saveBlob } from '../api/client.js';
import {
  APPLE_PROFILE_TICKET_PATH, appleProfileFileName, appleProfilePath, isAppleMobileDevice, openAppleProfileTicket,
  type AppleProfileKind,
} from '../lib/appleProfile.js';
import { externalClientSections, type ClientProtocols } from '../lib/externalClients.js';
import { PasswordPromptDialog, type ReauthKind } from '../components/PasswordPromptDialog.js';
import { apiErrorFromBody } from '../lib/errors.js';
import { settingsNavClass, settingsNavIconSize } from '../lib/settingsNav.js';
import { webauthnRegister, webauthnErrorMessage, webauthnSupported } from '../lib/webauthn.js';
import { useThemeStore, ACCENT_COLORS, useUiPrefs, type ThemeMode, type Density, type ReadingPane } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import { useLanguageStore } from '../store/language.js';
import { LANGS } from '../i18n/translations.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { useBranding } from '../hooks/useBranding.js';
import { accentFillChannels, hexToChannels, DEFAULT_ACCENT_RGB } from '../lib/branding.js';
import { copyToClipboard } from '../api/clipboard.js';
import toast from 'react-hot-toast';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { isSettingsSectionVisible } from '../lib/webmailFeatures.js';

// ── Types ─────────────────────────────────────────────────────────────────────
type Section = 'profile' | 'oof' | 'signature' | 'templates' | 'storage' | 'recover' | 'security' | 'password' | 'theme' | 'language' | 'calendar' | 'categories' | 'appPasswords' | 'inactivity' | 'view' | 'retention' | 'rules' | 'externalClients' | 'reading' | 'compose' | 'regional' | 'notifications';

interface RetentionTagDto {
  id: string;
  name: string;
  description: string;
  retentionDays: number;
  action: 'MOVE_TO_ARCHIVE' | 'DELETE_AND_ALLOW_RECOVERY' | 'PERMANENTLY_DELETE' | 'MARK_AS_PAST_RETENTION_LIMIT';
  isSystem: boolean;
}

interface AppPassword {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface Category {
  id: string;
  name: string;
  color: string;
  isFavorite?: boolean;
  sortOrder?: number;
}

// 14 predefined pastel colors
const CATEGORY_PALETTE = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308',
  '#84CC16', '#22C55E', '#10B981', '#14B8A6',
  '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1',
  '#8B5CF6', '#EC4899',
];

interface OofData {
  enabled: boolean;
  internalMessage: string;
  externalMessage: string;
  externalEnabled: boolean;
  externalOnlyContacts: boolean;
  useTimeRange: boolean;
  startDate: string | null;
  endDate: string | null;
}

// SigData is now defined in SignatureSection.tsx

interface StorageFolder { id: string; name: string; displayName: string; sizeBytes: number; messageCount: number }
interface StorageData {
  quotaBytes: number; usedBytes: number; folders: StorageFolder[];
  // v8.1: quota levels (bytes, 0 = unlimited)
  limits?: { warningBytes: number; prohibitSendBytes: number; prohibitSendReceiveBytes: number };
  level?: QuotaLevel;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function today()    { return new Date().toISOString().split('T')[0]!; }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]!; }

// Password strength ───────────────────────────────────────────────────────────
function getPasswordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string; colorClass: string } {
  if (!pw) return { score: 0, label: '', colorClass: '' };
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  const s = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  const labels      = ['', 'Schwach', 'Mittel', 'Gut', 'Stark'];
  const colorClasses = ['', 'bg-red-500', 'bg-orange-400', 'bg-yellow-400', 'bg-green-500'];
  return { score: s, label: labels[s] ?? '', colorClass: colorClasses[s] ?? '' };
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg ${
          checked ? 'bg-accent' : 'bg-line-strong'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`} />
      </button>
      <span className="text-sm text-fg">{label}</span>
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['user-profile'],
    queryFn: () => api.get<{ displayName: string; email: string; quotaBytes: number; usedBytes: number }>('/user/profile'),
  });
  const [name, setName] = useState('');
  useEffect(() => { if (data?.displayName) setName(data.displayName); }, [data?.displayName]);

  const mutation = useMutation({
    mutationFn: () => api.put('/user/profile', { displayName: name }),
    onSuccess: () => { toast.success('Profil gespeichert'); void qc.invalidateQueries({ queryKey: ['user-profile'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-fg">E-Mail-Konto</h2>
        <p className="text-sm text-fg-subtle mt-0.5">Kontoinformationen und Anzeigename</p>
      </div>
      <ProfilePhotoSettings />
      <div className="space-y-4 max-w-md">
        <div>
          <label className="block text-sm font-medium text-fg-muted mb-1">E-Mail-Adresse</label>
          <input className="input bg-surface-2 text-fg-subtle cursor-not-allowed" value={data?.email ?? ''} disabled />
        </div>
        <div>
          <label className="block text-sm font-medium text-fg-muted mb-1">Anzeigename</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Ihr Name" />
        </div>
        <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Speichern…</> : 'Speichern'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE PASSWORD
// ═══════════════════════════════════════════════════════════════════════════════
function PasswordSection() {
  const [currentPw,  setCurrentPw]  = useState('');
  const [newPw,      setNewPw]      = useState('');
  const [confirmPw,  setConfirmPw]  = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew,     setShowNew]     = useState(false);

  const strength = getPasswordStrength(newPw);
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;

  const mutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/user/change-password', { currentPassword: currentPw, newPassword: newPw }),
    onSuccess: () => {
      toast.success('Passwort erfolgreich geändert');
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canSubmit = currentPw.length > 0 && newPw.length >= 8 && newPw === confirmPw && !mutation.isPending;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-fg">Passwort ändern</h2>
        <p className="text-sm text-fg-subtle mt-0.5">Legen Sie ein neues Passwort für Ihr Konto fest</p>
      </div>

      <div className="space-y-4 max-w-md">
        {/* Current password */}
        <div>
          <label className="block text-sm font-medium text-fg-muted mb-1">Aktuelles Passwort</label>
          <div className="relative">
            <input
              type={showCurrent ? 'text' : 'password'}
              className="input pr-10"
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              placeholder="Aktuelles Passwort eingeben"
              autoComplete="current-password"
            />
            <button aria-label={showCurrent ? 'Passwort verbergen' : 'Passwort anzeigen'}
              type="button"
              onClick={() => setShowCurrent(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-muted"
            >
              {showCurrent ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        {/* New password */}
        <div>
          <label className="block text-sm font-medium text-fg-muted mb-1">Neues Passwort</label>
          <div className="relative">
            <input
              type={showNew ? 'text' : 'password'}
              className="input pr-10"
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="Mindestens 8 Zeichen"
              autoComplete="new-password"
            />
            <button aria-label={showNew ? 'Passwort verbergen' : 'Passwort anzeigen'}
              type="button"
              onClick={() => setShowNew(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-muted"
            >
              {showNew ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {/* Strength meter */}
          {newPw.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-colors ${
                      i <= strength.score ? strength.colorClass : 'bg-surface-3'
                    }`}
                  />
                ))}
              </div>
              {strength.label && (
                <p className={`text-xs font-medium ${
                  strength.score <= 1 ? 'text-danger-fg'
                  : strength.score === 2 ? 'text-warning-fg'
                  : strength.score === 3 ? 'text-warning-fg'
                  : 'text-success-fg'
                }`}>
                  Stärke: {strength.label}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Confirm password */}
        <div>
          <label className="block text-sm font-medium text-fg-muted mb-1">Passwort bestätigen</label>
          <input
            type="password"
            className={`input ${mismatch ? 'border-danger-line focus:border-danger-line focus:ring-danger-line' : ''}`}
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            placeholder="Neues Passwort wiederholen"
            autoComplete="new-password"
          />
          {mismatch && (
            <p className="text-xs text-danger-fg mt-1">Die Passwörter stimmen nicht überein</p>
          )}
        </div>

        <button
          onClick={() => mutation.mutate()}
          className="btn-primary"
          disabled={!canSubmit}
        >
          {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Passwort ändern…</> : 'Passwort ändern'}
        </button>
      </div>
    </div>
  );
}

// Minimal SVG icons for password visibility ──────────────────────────────────
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DESIGN (THEME)
// ═══════════════════════════════════════════════════════════════════════════════
const THEME_OPTIONS: { id: ThemeMode; label: string; desc: string; icon: React.ElementType }[] = [
  { id: 'light',  label: 'Hell',     desc: 'Immer helles Design',                          icon: Sun     },
  { id: 'dark',   label: 'Dunkel',   desc: 'Immer dunkles Design',                         icon: Moon    },
  { id: 'system', label: 'System',   desc: 'Folgt den Systemeinstellungen automatisch',    icon: Monitor },
];

// The previews deliberately show the fixed light and dark look, independent of the active theme.
const THEME_PREVIEW = {
  // theme-guard-ignore: theme picker preview shows the light look in every theme
  light: { frame: 'bg-white border-gray-200', bar: 'bg-gray-100', dot: 'bg-gray-300', line: 'bg-gray-200', side: 'bg-gray-100', pane: 'bg-white border-gray-200' },
  // theme-guard-ignore: theme picker preview shows the dark look in every theme
  dark: { frame: 'bg-gray-800 border-gray-600', bar: 'bg-gray-700', dot: 'bg-gray-500', line: 'bg-gray-500', side: 'bg-gray-700', pane: 'bg-gray-800 border-gray-600' },
};

function ThemeSection() {
  const { theme, accentRgb, setTheme, setAccent } = useThemeStore();
  const { allowUserAccent, primaryColor } = useBranding();
  // 9.3: the brand colour is the default; a personal choice counts only while the
  // organisation allows it (lib/branding.ts resolveAccentChannels).
  const brandFill = accentFillChannels(hexToChannels(primaryColor) ?? DEFAULT_ACCENT_RGB);
  const followsBrand = !allowUserAccent || accentRgb === null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">Darstellung</h2>
        <p className="text-sm text-fg-subtle mt-0.5">Farbschema, Akzentfarbe und Hintergrund des Webclients</p>
      </div>

      {/* Color scheme */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-fg-muted">Farbschema</p>
        <div className="grid grid-cols-3 gap-3 max-w-lg">
          {THEME_OPTIONS.map(({ id, label, desc, icon: Icon }) => {
            const active = theme === id;
            const pv = id === 'dark' ? THEME_PREVIEW.dark : THEME_PREVIEW.light;
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-left ${
                  active
                    ? 'border-accent bg-accent/5'
                    : 'border-line hover:border-line-strong bg-surface'
                }`}
              >
                {active && (
                  <span className="absolute top-2 right-2 w-5 h-5 bg-accent rounded-full flex items-center justify-center">
                    <Check size={11} className="text-white" strokeWidth={3} />
                  </span>
                )}
                {/* Preview box */}
                <div className={`w-full h-14 rounded-lg overflow-hidden border ${pv.frame}`}>
                  <div className={`h-4 ${pv.bar} flex items-center gap-1 px-2`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${pv.dot}`} />
                    <span className={`w-8 h-1 rounded ${pv.line}`} />
                  </div>
                  <div className="flex gap-1 p-1.5">
                    <span className={`w-8 h-6 rounded ${pv.side}`} />
                    <span className={`flex-1 h-6 rounded ${pv.pane} border`} />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 w-full">
                  <Icon size={13} className={active ? 'text-accent-fg' : 'text-fg-subtle'} />
                  <span className={`text-xs font-semibold ${active ? 'text-accent-fg' : 'text-fg-muted'}`}>{label}</span>
                </div>
                <p className="text-[10px] text-fg-subtle leading-tight w-full">{desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent color — 9.3: brand default, personal choice only when allowed */}
      <fieldset className="space-y-3 min-w-0 border-0 p-0 m-0" disabled={!allowUserAccent} aria-describedby="accent-color-hint">
        <legend className="text-sm font-medium text-fg-muted mb-3">Akzentfarbe</legend>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            title="Standard der Organisation"
            aria-label="Standard der Organisation"
            aria-pressed={followsBrand}
            onClick={() => setAccent(null)}
            className={`w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-60 ${
              followsBrand ? 'border-line-strong scale-110 shadow-md' : 'border-transparent hover:scale-105'
            }`}
            style={{ backgroundColor: `rgb(${brandFill})` }}
          >
            {followsBrand && <Check size={14} className="text-white" strokeWidth={3} aria-hidden="true" />}
          </button>
          {ACCENT_COLORS.map(({ name, hex, rgb }) => {
            const active = !followsBrand && accentRgb === rgb;
            return (
              <button
                key={rgb}
                type="button"
                title={name}
                aria-label={name}
                aria-pressed={active}
                onClick={() => setAccent(rgb)}
                className={`w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-60 ${
                  active ? 'border-line-strong scale-110 shadow-md' : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: hex }}
              >
                {active && <Check size={14} className="text-white" strokeWidth={3} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <p id="accent-color-hint" className="text-xs text-fg-subtle">
          {allowUserAccent
            ? 'Die Akzentfarbe wird für Schaltflächen, Links und Markierungen verwendet. Die erste Farbe ist der Standard Ihrer Organisation.'
            : 'Die Akzentfarbe wird von Ihrer Organisation vorgegeben und kann nicht geändert werden.'}
        </p>
      </fieldset>

      {/* 10.1: background picture behind the panes */}
      <BackgroundSettings />
    </div>
  );
}

// SIGNATURES — component now in components/SignatureSection.tsx
// (extracted for richer features: images, links, fonts, font sizes)

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATIC REPLIES (OOF)
// ═══════════════════════════════════════════════════════════════════════════════
function OofSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['user-oof'],
    queryFn: () => api.get<OofData>('/user/oof'),
  });

  const [enabled,              setEnabled]              = useState(false);
  const [useTimeRange,         setUseTimeRange]         = useState(false);
  const [startDate,            setStartDate]            = useState(today());
  const [startTime,            setStartTime]            = useState('08:00');
  const [endDate,              setEndDate]              = useState(tomorrow());
  const [endTime,              setEndTime]              = useState('18:00');
  const [internalMsg,          setInternalMsg]          = useState('');
  const [externalEnabled,      setExternalEnabled]      = useState(true);
  const [externalOnlyContacts, setExternalOnlyContacts] = useState(false);
  const [externalMsg,          setExternalMsg]          = useState('');

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setUseTimeRange(data.useTimeRange);
    setInternalMsg(data.internalMessage);
    setExternalEnabled(data.externalEnabled);
    setExternalOnlyContacts(data.externalOnlyContacts);
    setExternalMsg(data.externalMessage);
    if (data.startDate) {
      const d = new Date(data.startDate);
      setStartDate(d.toISOString().split('T')[0]!);
      setStartTime(d.toTimeString().slice(0, 5));
    }
    if (data.endDate) {
      const d = new Date(data.endDate);
      setEndDate(d.toISOString().split('T')[0]!);
      setEndTime(d.toTimeString().slice(0, 5));
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => api.put('/user/oof', {
      enabled,
      internalMessage: internalMsg,
      externalMessage: externalMsg,
      externalEnabled,
      externalOnlyContacts,
      useTimeRange,
      ...(useTimeRange ? {
        startDate: `${startDate}T${startTime}:00`,
        endDate:   `${endDate}T${endTime}:00`,
      } : {}),
    }),
    onSuccess: () => { toast.success('Automatische Antworten gespeichert'); void qc.invalidateQueries({ queryKey: ['user-oof'] }); },
    onError: () => toast.error('Fehler beim Speichern'),
  });

  const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);

  if (isLoading) return <div className="flex justify-center py-12 text-fg-subtle"><Loader2 size={18} className="animate-spin" /></div>;

  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-fg">Automatische Antworten</h2>
        <p className="text-sm text-fg-subtle mt-0.5 leading-relaxed">
          Verwenden Sie automatische Antworten, um anderen mitzuteilen, dass Sie im Urlaub sind oder Ihre E-Mails zurzeit nicht beantworten können.
          Sie können festlegen, dass Ihre Antworten an einem bestimmten Zeitpunkt beginnen und enden. Andernfalls bleiben sie aktiviert, bis Sie sie deaktivieren.
        </p>
        <p className="text-xs text-fg-subtle mt-1">
          Jeder Absender erhält pro Abwesenheitszeitraum genau eine automatische Antwort. Mailinglisten, automatisch erzeugte Nachrichten und „noreply"-Absender erhalten keine Antwort.
        </p>
      </div>

      {/* Main toggle */}
      <Toggle checked={enabled} onChange={setEnabled} label="Automatische Antworten aktivieren" />

      {/* Options when enabled */}
      {enabled && (
        <div className="space-y-5 pl-1">

          {/* Time range */}
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={useTimeRange} onChange={e => setUseTimeRange(e.target.checked)}
                className="w-4 h-4 accent-accent rounded" />
              <span className="text-sm text-fg-muted">Antworten nur in einem bestimmten Zeitraum senden</span>
            </label>

            <div className={`space-y-2 pl-6 ${!useTimeRange ? 'opacity-40 pointer-events-none' : ''}`}>
              {/* Start time */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-fg-muted w-16">Startzeit</span>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="input text-sm w-36" />
                <div className="relative">
                  <select value={startTime} onChange={e => setStartTime(e.target.value)}
                    className="input text-sm pr-8 appearance-none w-28">
                    {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                </div>
              </div>
              {/* End time */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-fg-muted w-16">Endzeit</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                  className="input text-sm w-36" />
                <div className="relative">
                  <select value={endTime} onChange={e => setEndTime(e.target.value)}
                    className="input text-sm pr-8 appearance-none w-28">
                    {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
                </div>
              </div>
              {useTimeRange && (
                <p className="text-xs text-accent-fg pl-0">
                  Der Zeitraum wird als Abwesenheitstermin in Ihrem Kalender eingetragen.
                </p>
              )}
            </div>
          </div>

          {/* Internal reply */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-fg-muted">Antwort an Personen innerhalb Ihrer Organisation</label>
            <textarea
              value={internalMsg} onChange={e => setInternalMsg(e.target.value)}
              rows={4} className="input resize-none text-sm"
              placeholder="Ich bin momentan nicht erreichbar und antworte Ihrer Nachricht so schnell wie möglich." />
          </div>

          {/* External reply */}
          <div className="space-y-3 pt-1">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={externalEnabled} onChange={e => setExternalEnabled(e.target.checked)}
                className="w-4 h-4 accent-accent rounded" />
              <span className="text-sm text-fg-muted">Antworten an Personen außerhalb Ihrer Organisation senden</span>
            </label>

            <div className={`pl-6 space-y-3 ${!externalEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={externalOnlyContacts} onChange={e => setExternalOnlyContacts(e.target.checked)}
                  className="w-4 h-4 accent-accent rounded" />
                <span className="text-sm text-fg-muted">Antworten nur an Kontakte senden</span>
              </label>
              <textarea
                value={externalMsg} onChange={e => setExternalMsg(e.target.value)}
                rows={4} className="input resize-none text-sm"
                placeholder="Ich bin momentan im Urlaub und nicht erreichbar." />
            </div>
          </div>
        </div>
      )}

      <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Speichern…</> : 'Speichern'}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

const FOLDER_COLORS: Record<string, string> = {
  INBOX:   '#3b82f6',
  Sent:    '#f59e0b',
  Trash:   '#6b7280',
  Junk:    '#eab308',
  Drafts:  '#8b5cf6',
  Archive: '#10b981',
};
const FALLBACK_COLORS = ['#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#a78bfa'];

const FOLDER_ICON_MAP: Record<string, React.ElementType> = {
  INBOX: () => <span className="text-fg-subtle">📥</span>,
  Trash: Trash2,
  Junk:  () => <span className="text-fg-subtle">⚠️</span>,
};

// v8.1: Recover deleted items
function RecoverSection() {
  const t = useT();
  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="text-lg font-semibold text-fg">{t('recover_title')}</h2>
      <RecoverDeletedItemsPanel />
    </div>
  );
}

// 9.1: quotas of the shared mailboxes the user can read (one bar each; hidden when none
// or when a mailbox has no quota). Module level (never define components inline).
function SharedMailboxQuotas() {
  const t = useT();
  const { data = [] } = useQuery<Array<{ id: string; email: string; displayName: string; permissions: string[] }>>({
    queryKey: ['user-shared-mailboxes'],
    queryFn: () => api.get('/user/shared-mailboxes'),
    staleTime: 60_000,
  });
  const readable = data.filter((m) => m.permissions.includes('FULL_ACCESS') || m.permissions.includes('READ_ONLY'));
  if (readable.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-fg mb-1">{t('quota_shared_mailboxes')}</h3>
      <div className="space-y-1">
        {readable.map((m) => (
          <QuotaIndicator key={m.id} sharedMailboxId={m.id} label={m.displayName ? `${m.displayName} (${m.email})` : m.email} className="py-1" />
        ))}
      </div>
    </div>
  );
}

function StorageSection() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<StorageData>({
    queryKey: ['user-storage'],
    queryFn:  () => api.get<StorageData>('/user/storage'),
  });

  const emptyMut = useMutation({
    mutationFn: (folderId: string) => api.delete(`/user/folders/${folderId}/empty`),
    onSuccess: () => {
      toast.success('Ordner geleert');
      setConfirming(null);
      void refetch();
      void qc.invalidateQueries({ queryKey: ['folders'] });
    },
    onError: () => toast.error('Fehler beim Leeren'),
  });

  if (isLoading) return <div className="flex justify-center py-12 text-fg-subtle"><Loader2 size={18} className="animate-spin" /></div>;

  const quota = data?.quotaBytes ?? 0;
  const used  = data?.usedBytes  ?? 0;
  const pct   = quota > 0 ? Math.min((used / quota) * 100, 100) : 0;
  const folders = data?.folders ?? [];

  // Color per folder
  const colorFor = (name: string, idx: number) =>
    FOLDER_COLORS[name] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]!;

  const FOLDER_DISPLAY: Record<string, string> = {
    INBOX:   'Posteingang',
    Drafts:  'Entwürfe',
    Sent:    'Gesendete Elemente',
    Trash:   'Gelöschte Elemente',
    Junk:    'Junk-E-Mail',
    Archive: 'Archiv',
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-fg">Speicher</h2>
        <p className="text-sm text-fg-subtle mt-0.5">
          Sie haben {fmtBytes(quota)} E-Mail-Speicher mit diesem Konto, das Anlagen und Nachrichten in allen Ordnern umfasst.
        </p>
      </div>

      {/* Usage display */}
      <div className="space-y-2">
        <p className={`text-sm ${data?.level && data.level !== 'ok' ? quotaColor(data.level).text : 'text-fg-muted'}`}>
          <span className="font-medium">{fmtBytes(used)}</span> von <span className="font-medium">{fmtBytes(quota)}</span>{' '}
          (<span className="font-medium">{pct.toFixed(1)}%</span>) verwendet
        </p>
        {/* v8.1: quota levels */}
        {data?.limits && (
          <ul className="text-xs text-fg-subtle space-y-0.5">
            {data.limits.warningBytes > 0 && <li>Warnung ab {fmtBytes(data.limits.warningBytes)}</li>}
            {data.limits.prohibitSendBytes > 0 && <li>Senden gesperrt ab {fmtBytes(data.limits.prohibitSendBytes)}</li>}
            {data.limits.prohibitSendReceiveBytes > 0 && <li>Senden und Empfangen gesperrt ab {fmtBytes(data.limits.prohibitSendReceiveBytes)}</li>}
          </ul>
        )}
        {data?.level && data.level !== 'ok' && (
          <p className={`text-sm font-medium ${quotaColor(data.level).text}`}>
            {data.level === 'warning' ? 'Ihr Postfach ist fast voll.'
              : data.level === 'prohibitSend' ? 'Postfach voll – Senden ist gesperrt.'
                : 'Postfach voll – Senden und Empfangen sind gesperrt.'}
          </p>
        )}

        {/* Stacked bar */}
        <div className="h-4 w-full bg-surface-2 rounded-full overflow-hidden flex">
          {folders.map((f, i) => {
            const w = quota > 0 ? (f.sizeBytes / quota) * 100 : 0;
            if (w < 0.5) return null;
            return (
              <div key={f.id} title={`${FOLDER_DISPLAY[f.name] ?? f.displayName}: ${fmtBytes(f.sizeBytes)}`}
                style={{ width: `${w}%`, backgroundColor: colorFor(f.name, i) }}
                className="h-full transition-all" />
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          {folders.filter(f => f.sizeBytes > 0).map((f, i) => (
            <div key={f.id} className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: colorFor(f.name, i) }} />
              {FOLDER_DISPLAY[f.name] ?? f.displayName}
            </div>
          ))}
        </div>
      </div>

      <SharedMailboxQuotas />

      {/* Table */}
      <div>
        <h3 className="text-sm font-semibold text-fg mb-1">Speicher verwalten</h3>
        <p className="text-xs text-fg-subtle mb-3">
          Wenn Sie Inhalte aus einem Ordner leeren, können Sie Speicherplatz freigeben. Geleerte Elemente lassen sich eine Zeit lang unter „Gelöschte Elemente wiederherstellen" zurückholen.
        </p>

        {folders.length === 0 ? (
          <p className="text-sm text-fg-subtle py-4">Keine Daten verfügbar.</p>
        ) : (
          <div role="region" aria-label="Ordner und Speicher (scrollbar)" tabIndex={0} className="border border-line rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 border-b border-line">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-subtle uppercase">Ordner</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-subtle uppercase">Größe</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-subtle uppercase">Nachrichten</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-fg-subtle uppercase">Verwalten</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {folders.map((f, i) => {
                  const FIcon = FOLDER_ICON_MAP[f.name] ?? Trash2;
                  const isConfirming = confirming === f.id;
                  const displayName = FOLDER_DISPLAY[f.name] ?? f.displayName;
                  return (
                    <tr key={f.id} className="hover:bg-surface-2">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span style={{ color: colorFor(f.name, i) }}>
                            <FIcon size={14} />
                          </span>
                          <span className="text-fg">{displayName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-fg-muted">{fmtBytes(f.sizeBytes)}</td>
                      <td className="px-4 py-3 text-fg-muted">{f.messageCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        {isConfirming ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-fg-subtle">Sicher?</span>
                            <button onClick={() => emptyMut.mutate(f.id)} disabled={emptyMut.isPending}
                              className="px-2 py-1 text-xs font-medium text-white bg-danger rounded hover:bg-danger/90 transition-colors">
                              {emptyMut.isPending ? '…' : 'Ja, leeren'}
                            </button>
                            <button onClick={() => setConfirming(null)}
                              className="px-2 py-1 text-xs text-fg-muted hover:text-fg">
                              Abbrechen
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirming(f.id)}
                            className="flex items-center gap-1.5 ml-auto px-3 py-1.5 text-xs font-medium text-fg-muted border border-line-strong rounded hover:bg-surface-2 hover:text-danger-fg hover:border-danger-line transition-colors">
                            <Trash2 size={12} />
                            Leeren
                            <ChevronDown size={11} className="text-fg-subtle" />
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
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════════
// ── TOTP setup wizard (integrated) ────────────────────────────────────────────
type TotpStep = 'idle' | 'setup' | 'confirm' | 'done';

interface MfaStatus {
  totpEnabled: boolean;
  webauthnCount: number;
  backupCodesCount: number;
}

interface TotpSetupData {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

// Auth fetch helper for /auth/* routes (outside /api/v1/) — Bearer header + token refresh
async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isGet = !init.method || init.method === 'GET';
  const res = await apiFetch(path, init, isGet ? null : 'application/json');
  if (!res.ok) {
    // REAUTH_REQUIRED / REAUTH_FAILED / REAUTH_LOCKED / TOTP_ALREADY_ENABLED → readable text
    const body = await res.json().catch(() => ({ error: res.statusText })) as unknown;
    throw apiErrorFromBody(body, res.status);
  }
  return res.json() as Promise<T>;
}

/** JSON body helper for re-authenticated MFA changes (`currentPassword`). */
function withPassword(currentPassword: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, currentPassword });
}

interface ReauthRequest {
  title: string;
  confirmLabel: string;
  run: (currentPassword: string) => Promise<void>;
}

/**
 * Settings → Sicherheit. 10.5: `enrolmentOnly` = the mandatory enrolment page
 * (pages/MfaEnrolmentPage.tsx): only the TOTP and security-key cards — the
 * other panels call APIs that answer MFA_ENROLMENT_REQUIRED until a factor is set up.
 */
export function SecuritySection({ enrolmentOnly = false }: { enrolmentOnly?: boolean } = {}) {
  const qc = useQueryClient();
  const email = useAuthStore((s) => s.email);
  const [totpStep, setTotpStep] = useState<TotpStep>('idle');
  const [setupData, setSetupData] = useState<TotpSetupData | null>(null);
  const [confirmDigits, setConfirmDigits] = useState(['', '', '', '', '', '']);
  const [confirmError, setConfirmError] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [regenCodes, setRegenCodes] = useState<string[] | null>(null);
  const [reauth, setReauth] = useState<ReauthRequest | null>(null);
  const [keyName, setKeyName] = useState('Sicherheitsschlüssel');
  const [keyBusy, setKeyBusy] = useState(false);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Password entered when starting the TOTP wizard — reused for the backup codes
  // generated right after the confirmation (no second prompt).
  const setupPasswordRef = useRef<string>('');

  // 10.6: policy "off" → no new factor is offered (enrolled ones stay and can be removed)
  const t = useT();
  const { data: enforcement } = useMfaEnforcement();
  const enrolmentOffered = enforcement?.enrolmentOffered !== false;
  const { data: mfaStatus, isLoading: statusLoading } = useQuery<MfaStatus>({
    queryKey: ['mfa-status'],
    queryFn: () => authFetch<MfaStatus>('/auth/mfa/status'),
    staleTime: 0,
  });

  const { data: profile } = useQuery({
    queryKey: ['user', 'profile'],
    queryFn: () => api.get<{ email: string }>('/user/profile'),
    enabled: !email,
  });

  const invalidateStatus = () => {
    void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    void qc.invalidateQueries({ queryKey: ['mfa-enforcement'] }); // 10.5: grace banner of the app frame
  };

  const startTotpSetup = () => setReauth({
    title: '2FA einrichten',
    confirmLabel: 'Weiter',
    run: async (currentPassword) => {
      const data = await authFetch<TotpSetupData>('/auth/mfa/totp/setup', {
        method: 'POST', body: withPassword(currentPassword, { accountName: email ?? profile?.email }),
      });
      setupPasswordRef.current = currentPassword;
      setSetupData(data);
      setTotpStep('setup');
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (code: string) =>
      authFetch<{ ok: boolean }>('/auth/mfa/totp/confirm', {
        method: 'POST',
        body: withPassword(setupPasswordRef.current, { code }),
      }),
    onSuccess: async () => {
      try {
        const data = await authFetch<{ codes: string[] }>('/auth/mfa/backup-codes/generate', {
          method: 'POST', body: withPassword(setupPasswordRef.current),
        });
        setBackupCodes(data.codes);
      } catch (err) {
        toast.error(`2FA aktiv, Backup-Codes konnten nicht erzeugt werden: ${(err as Error).message}`);
        setBackupCodes([]);
      } finally {
        setupPasswordRef.current = '';
      }
      setTotpStep('done');
      invalidateStatus();
    },
    onError: (e: Error) => {
      setConfirmError(e.message);
      setConfirmDigits(['', '', '', '', '', '']);
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    },
  });

  const disableTotp = () => setReauth({
    title: '2FA deaktivieren',
    confirmLabel: '2FA deaktivieren',
    run: async (currentPassword) => {
      await authFetch<{ ok: boolean }>('/auth/mfa/totp', { method: 'DELETE', body: withPassword(currentPassword) });
      toast.success('2FA wurde deaktiviert');
      setTotpStep('idle');
      setSetupData(null);
      setBackupCodes(null);
      setRegenCodes(null);
      invalidateStatus();
    },
  });

  const regenerateBackupCodes = () => setReauth({
    title: 'Backup-Codes neu generieren',
    confirmLabel: 'Neu generieren',
    run: async (currentPassword) => {
      const data = await authFetch<{ codes: string[] }>('/auth/mfa/backup-codes/generate', {
        method: 'POST', body: withPassword(currentPassword),
      });
      setRegenCodes(data.codes);
      toast.success('Neue Backup-Codes generiert');
      invalidateStatus();
    },
  });

  // WebAuthn: register a security key / passkey
  const registerSecurityKey = () => setReauth({
    title: 'Sicherheitsschlüssel hinzufügen',
    confirmLabel: 'Weiter',
    run: async (currentPassword) => {
      setKeyBusy(true);
      try {
        const accountEmail = email ?? profile?.email ?? '';
        const options = await authFetch<unknown>('/auth/mfa/webauthn/register/start', {
          method: 'POST', body: withPassword(currentPassword, { email: accountEmail }),
        });
        let response: Record<string, unknown>;
        try {
          response = await webauthnRegister(options);
        } catch (err) {
          throw new Error(webauthnErrorMessage(err));
        }
        await authFetch<{ ok: boolean }>('/auth/mfa/webauthn/register/finish', {
          method: 'POST', body: withPassword(currentPassword, { response, name: keyName.trim() || 'Sicherheitsschlüssel' }),
        });
        toast.success('Sicherheitsschlüssel registriert');
        invalidateStatus();
      } finally {
        setKeyBusy(false);
      }
    },
  });

  // OTP digit helpers
  const handleDigitChange = (i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...confirmDigits];
    next[i] = digit;
    setConfirmDigits(next);
    if (digit && i < 5) digitRefs.current[i + 1]?.focus();
  };
  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !confirmDigits[i] && i > 0) digitRefs.current[i - 1]?.focus();
  };
  const handleDigitPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) { e.preventDefault(); setConfirmDigits(pasted.split('')); digitRefs.current[5]?.focus(); }
  };

  const copySecret = () => {
    if (setupData?.secret) {
      copyToClipboard(setupData.secret)
        .then(() => toast.success('Secret kopiert'))
        .catch(() => toast.error('Kopieren fehlgeschlagen'));
    }
  };
  const copyBackupCodes = () => {
    if (backupCodes) {
      copyToClipboard(backupCodes.join('\n'))
        .then(() => toast.success('Backup-Codes kopiert'))
        .catch(() => toast.error('Kopieren fehlgeschlagen'));
    }
  };

  return (
    <div className="space-y-5 max-w-lg">
      {!enrolmentOnly && (
      <div>
        <h2 className="text-lg font-semibold text-fg">Sicherheit</h2>
        <p className="text-sm text-fg-subtle mt-0.5">App-Passwörter und Zwei-Faktor-Authentifizierung</p>
      </div>
      )}

      {/* App passwords (link stays) */}
      {!enrolmentOnly && (
      <div className="bg-surface-2 border border-line rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <Key size={15} className="text-fg-subtle" />
          <span className="text-sm font-medium">App-Passwörter</span>
        </div>
        <p className="text-xs text-fg-subtle mb-3">Für externe E-Mail-Clients ohne Hauptpasswort verbinden.</p>
        {/* In-app section (the old link opened the raw /auth/app-passwords JSON API, which needs a header token) */}
        <Link to="/settings#appPasswords" className="btn-secondary text-xs">
          App-Passwörter verwalten
        </Link>
      </div>
      )}

      {/* ── 2FA card ── */}
      <div className="bg-surface-2 border border-line rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={15} className="text-fg-subtle" />
            <span className="text-sm font-medium">Zwei-Faktor-Authentifizierung (TOTP)</span>
          </div>
          {statusLoading ? (
            <Loader2 size={14} className="animate-spin text-fg-subtle" />
          ) : mfaStatus?.totpEnabled ? (
            <span className="flex items-center gap-1 text-xs font-medium text-success-fg bg-success-bg px-2 py-0.5 rounded-full">
              <ShieldCheck size={12} /> Aktiv
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs font-medium text-fg-subtle bg-surface-3 px-2 py-0.5 rounded-full">
              <ShieldOff size={12} /> Inaktiv
            </span>
          )}
        </div>

        {/* 10.6: policy "off" — no setup offered */}
        {!enrolmentOffered && !mfaStatus?.totpEnabled && totpStep === 'idle' && (
          <p className="text-xs text-fg-subtle">{t('mfa_not_offered')}</p>
        )}

        {/* ── Status: inactive → start setup ── */}
        {enrolmentOffered && !mfaStatus?.totpEnabled && totpStep === 'idle' && (
          <>
            <p className="text-xs text-fg-subtle">
              Schützen Sie Ihr Konto mit einer Authenticator-App (z.B. eine TOTP-App wie Aegis, FreeOTP oder Authy).
            </p>
            <button
              onClick={startTotpSetup}
              className="btn-primary text-xs flex items-center gap-1.5"
            >
              <ShieldCheck size={13} />
              2FA einrichten
            </button>
          </>
        )}

        {/* ── Step 1: Show QR code ── */}
        {totpStep === 'setup' && setupData && (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted font-medium">
              1. Scannen Sie den QR-Code mit Ihrer Authenticator-App:
            </p>
            <div className="flex justify-center">
              <img src={setupData.qrCodeDataUrl} alt="TOTP QR Code" className="w-40 h-40 border border-line rounded" />
            </div>
            <div>
              <p className="text-xs text-fg-subtle mb-1">Oder geben Sie den Secret-Schlüssel manuell ein:</p>
              <div className="flex items-center gap-2 bg-surface border border-line rounded px-3 py-1.5">
                <code className="text-xs font-mono text-fg-muted flex-1 select-all break-all">{setupData.secret}</code>
                <button aria-label="Geheimnis kopieren" onClick={copySecret} className="text-fg-subtle hover:text-fg-muted shrink-0">
                  <Copy size={13} />
                </button>
              </div>
            </div>
            <button
              onClick={() => { setTotpStep('confirm'); setTimeout(() => digitRefs.current[0]?.focus(), 50); }}
              className="btn-primary text-xs"
            >
              Weiter → Code eingeben
            </button>
          </div>
        )}

        {/* ── Step 2: Confirm code ── */}
        {totpStep === 'confirm' && (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted font-medium">
              2. Geben Sie den 6-stelligen Code aus Ihrer App ein:
            </p>
            <div className="flex gap-2" onPaste={handleDigitPaste}>
              {confirmDigits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => { digitRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(i, e)}
                  className="w-9 h-11 text-center text-lg font-bold border-2 border-line-strong rounded-lg focus:outline-none focus:border-accent-fg focus-visible:ring-2 focus-visible:ring-accent-fg transition-colors"
                  style={{ borderColor: d ? 'var(--color-accent)' : undefined }}
                />
              ))}
            </div>
            {confirmError && (
              <p className="text-xs text-danger-fg flex items-center gap-1">
                <AlertTriangle size={12} /> {confirmError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => confirmMutation.mutate(confirmDigits.join(''))}
                disabled={confirmMutation.isPending || confirmDigits.join('').length < 6}
                className="btn-primary text-xs flex items-center gap-1.5"
              >
                {confirmMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Bestätigen
              </button>
              <button onClick={() => { setTotpStep('setup'); setConfirmError(''); setConfirmDigits(['', '', '', '', '', '']); }}
                className="btn-secondary text-xs">
                Zurück
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Success + backup codes ── */}
        {totpStep === 'done' && backupCodes && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success-fg text-sm font-medium">
              <ShieldCheck size={16} /> 2FA erfolgreich aktiviert!
            </div>
            <div>
              <p className="text-xs text-fg-muted font-medium mb-1">Backup-Codes (je einmalig verwendbar):</p>
              <p className="text-xs text-fg-subtle mb-2">Speichern Sie diese Codes sicher. Sie können damit bei verlorenem Gerät einloggen.</p>
              <div className="grid grid-cols-2 gap-1 bg-surface border border-line rounded p-3 font-mono text-xs">
                {backupCodes.map((c, i) => <span key={i} className="text-fg-muted">{c}</span>)}
              </div>
              <button onClick={copyBackupCodes} className="mt-2 flex items-center gap-1 text-xs text-fg-subtle hover:text-fg-muted">
                <Copy size={11} /> Alle kopieren
              </button>
            </div>
            <button onClick={() => setTotpStep('idle')} className="btn-secondary text-xs">Fertig</button>
          </div>
        )}

        {/* ── Active: management ── */}
        {mfaStatus?.totpEnabled && totpStep === 'idle' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs text-fg-muted">
              <div className="bg-surface border border-line rounded p-2 text-center">
                <p className="font-semibold text-base text-fg">{mfaStatus.backupCodesCount}</p>
                <p>Backup-Codes verbleibend</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={regenerateBackupCodes}
                className="btn-secondary text-xs flex items-center gap-1.5"
              >
                <RefreshCw size={12} />
                Backup-Codes neu generieren
              </button>
              <button
                onClick={disableTotp}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 border border-danger-line text-danger-fg rounded hover:bg-danger-bg disabled:opacity-50"
              >
                <ShieldOff size={12} />
                2FA deaktivieren
              </button>
            </div>
            {regenCodes && (
              <div>
                <p className="text-xs text-fg-muted font-medium mb-1">Neue Backup-Codes:</p>
                <div className="grid grid-cols-2 gap-1 bg-surface border border-line rounded p-3 font-mono text-xs">
                  {regenCodes.map((c, i) => <span key={i} className="text-fg-muted">{c}</span>)}
                </div>
                <button
                  onClick={() => {
                    copyToClipboard(regenCodes.join('\n'))
                      .then(() => toast.success('Kopiert'))
                      .catch(() => toast.error('Kopieren fehlgeschlagen'));
                  }}
                  className="mt-1 flex items-center gap-1 text-xs text-fg-subtle hover:text-fg-muted"
                >
                  <Copy size={11} /> Alle kopieren
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Security keys (WebAuthn / passkeys) ── */}
      <div className="bg-surface-2 border border-line rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key size={15} className="text-fg-subtle" />
            <span className="text-sm font-medium">Sicherheitsschlüssel (WebAuthn)</span>
          </div>
          {!statusLoading && (
            <span className="text-xs font-medium text-fg-muted bg-surface-3 px-2 py-0.5 rounded-full">
              {mfaStatus?.webauthnCount ?? 0} registriert
            </span>
          )}
        </div>
        <p className="text-xs text-fg-subtle">
          Melden Sie sich mit einem Hardware-Schlüssel (z. B. YubiKey) oder einem Passkey Ihres Geräts an.
          Ein registrierter Schlüssel wird beim Login als zweiter Faktor abgefragt.
        </p>
        {!enrolmentOffered ? (
          <p className="text-xs text-fg-subtle">{t('mfa_not_offered')}</p>
        ) : webauthnSupported() ? (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value.slice(0, 60))}
              aria-label="Name des Sicherheitsschlüssels"
              className="input text-xs flex-1 min-w-[160px]"
              placeholder="Name, z. B. YubiKey Büro"
            />
            <button
              onClick={registerSecurityKey}
              disabled={keyBusy}
              className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50"
            >
              {keyBusy ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />}
              Schlüssel hinzufügen
            </button>
          </div>
        ) : (
          <p className="text-xs text-warning-fg">Dieser Browser unterstützt kein WebAuthn (oder die Seite läuft nicht über HTTPS).</p>
        )}
      </div>

      {/* 9.4: sessions, mobile devices, S/MIME */}
      {!enrolmentOnly && (
      <>
      <div className="space-y-8 border-t border-line pt-6">
        <SessionsPanel />
        {/* 10.6: remembered MFA devices ("Gerät merken") */}
        <TrustedDevicesPanel />
        <DevicesPanel />
        <SmimeSettingsPanel />
      </div>
      {/* 9.4: who accessed my mailbox (delegates) */}
      <MailboxAccessLog />
      </>
      )}

      {reauth && (
        <PasswordPromptDialog
          title={reauth.title}
          confirmLabel={reauth.confirmLabel}
          onConfirm={reauth.run}
          onClose={() => setReauth(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP PASSWORDS SECTION (uses authFetch from SecuritySection)
// ═══════════════════════════════════════════════════════════════════════════════
function AppPasswordsSection() {
  const t = useT();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createdPw, setCreatedPw] = useState<{ name: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: list = [], isLoading } = useQuery({
    queryKey: ['app-passwords'],
    queryFn: () => authFetch<AppPassword[]>('/auth/app-passwords'),
  });

  // v8.1: creating an app password needs re-authentication (current password or
  // an authenticator/backup code); the dialog shows server errors and stays open.
  const [reauthFor, setReauthFor] = useState<string | null>(null);
  const createWithReauth = async (secret: string, kind: ReauthKind) => {
    const name = reauthFor ?? '';
    const data = await authFetch<{ id: string; password: string }>('/auth/app-passwords', {
      method: 'POST',
      body: JSON.stringify(kind === 'mfa' ? { name, mfaCode: secret } : { name, currentPassword: secret }),
    });
    qc.invalidateQueries({ queryKey: ['app-passwords'] });
    setCreatedPw({ name, password: data.password });
    setCreating(false);
    setNewName('');
  };
  const startCreate = () => { if (newName.trim()) setReauthFor(newName.trim()); };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => authFetch(`/auth/app-passwords/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-passwords'] });
      toast.success('App-Passwort widerrufen');
    },
    onError: (e: Error) => toast.error(e.message || 'Fehler beim Widerrufen'),
  });

  const copyPw = async () => {
    if (!createdPw) return;
    try {
      await copyToClipboard(createdPw.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast.error('Kopieren fehlgeschlagen — bitte manuell markieren');
    }
  };

  return (
    <section>
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-xl font-semibold text-fg">{t('app_passwords')}</h2>
        {!createdPw && (
          <button onClick={() => setCreating(true)} className="btn-primary text-sm">
            <Plus size={14} /> {t('app_password_create')}
          </button>
        )}
      </div>
      <p className="text-sm text-fg-muted mb-6 max-w-lg">{t('app_passwords_help')}</p>

      {/* "Here is your new password" — shown once */}
      {createdPw && (
        <div className="mb-6 border-2 border-accent rounded-md p-4 bg-accent/5 animate-fly-in">
          <div className="flex items-start gap-2 mb-3">
            <AlertCircle size={18} className="text-accent-fg shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-fg">„{createdPw.name}"</p>
              <p className="text-xs text-fg-muted mt-0.5">{t('app_password_show_once')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-surface border border-line rounded p-3">
            <code className="flex-1 font-mono text-sm tracking-wider text-fg select-all">
              {createdPw.password}
            </code>
            <button
              onClick={copyPw}
              className="btn-secondary text-xs whitespace-nowrap"
            >
              {copied ? <><Check size={12} className="text-success-fg" /> {t('app_password_copied')}</> : <><Copy size={12} /> {t('app_password_copy')}</>}
            </button>
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={() => setCreatedPw(null)} className="btn-primary text-xs">
              <Check size={12} /> {t('app_password_done')}
            </button>
          </div>
        </div>
      )}

      {/* Inline editor for new passwords */}
      {creating && !createdPw && (
        <div className="mb-4 border border-line rounded-md p-4 bg-info-bg/40 animate-fly-in">
          <label className="block text-sm font-medium text-fg-muted mb-1">{t('app_password_name')}</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
            placeholder="z. B. Thunderbird"
            className="input text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') startCreate();
              if (e.key === 'Escape') { setCreating(false); setNewName(''); }
            }}
          />
          <div className="mt-3 flex items-center gap-2 justify-end">
            <button onClick={() => { setCreating(false); setNewName(''); }} className="btn-ghost text-xs">
              <XIcon size={13} /> Abbrechen
            </button>
            <button
              onClick={startCreate}
              disabled={!newName.trim() || reauthFor !== null}
              className="btn-primary text-xs"
            >
              {reauthFor !== null ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Erstellen
            </button>
          </div>
        </div>
      )}

      {reauthFor !== null && (
        <PasswordPromptDialog
          title="App-Passwort erstellen"
          confirmLabel="Erstellen"
          description="App-Passwörter umgehen die Zwei-Faktor-Anmeldung. Bitte bestätigen Sie mit Ihrem aktuellen Passwort."
          allowMfaCode
          onConfirm={createWithReauth}
          onClose={() => setReauthFor(null)}
        />
      )}

      {/* List */}
      <div className="border border-line rounded-md divide-y divide-line bg-surface">
        <div className="px-4 py-2 text-xs font-medium text-fg-subtle uppercase tracking-wide bg-surface-2 rounded-t-md">
          Name · {t('app_password_created')} · {t('app_password_last_used')}
        </div>
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-fg-subtle">…</div>
        ) : list.length === 0 ? (
          <div className="px-4 py-6 text-sm text-fg-subtle text-center">{t('app_password_empty')}</div>
        ) : (
          list.map((ap) => (
            <div key={ap.id} className="px-4 py-2.5 flex items-center gap-3 group hover:bg-surface-2 transition-colors">
              <Smartphone size={16} className="text-fg-subtle shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-fg truncate">{ap.name}</p>
                <p className="text-xs text-fg-subtle">
                  {t('app_password_created')}: {fmtDate(new Date(ap.createdAt), 'dd.MM.yyyy HH:mm')}
                  {' · '}
                  {ap.lastUsedAt
                    ? `${t('app_password_last_used')}: ${fmtDate(new Date(ap.lastUsedAt), 'dd.MM.yyyy HH:mm')}`
                    : t('app_password_never_used')}
                </p>
              </div>
              <button
                onClick={() => {
                  if (window.confirm(t('app_password_revoke_q'))) deleteMutation.mutate(ap.id);
                }}
                className="p-1.5 rounded text-fg-subtle hover:text-danger-fg hover:bg-danger-bg transition-all active:scale-90 opacity-0 group-hover:opacity-100"
                title={t('app_password_revoke')} aria-label={t('app_password_revoke')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES SECTION
// ═══════════════════════════════════════════════════════════════════════════════
function CategoriesSection() {
  const t = useT();
  const qc = useQueryClient();
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: { name: string; color: string }) =>
      api.post<Category>('/categories', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(t('folder_created'));
      setCreating(false);
    },
    onError: (e: Error) => toast.error(e.message || 'Fehler'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Category> }) =>
      api.patch(`/categories/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message || 'Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(t('folder_deleted'));
    },
    onError: (e: Error) => toast.error(e.message || 'Fehler'),
  });

  return (
    <section>
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-xl font-semibold text-fg">{t('categories')}</h2>
        <button
          onClick={() => setCreating(true)}
          className="btn-primary text-sm"
        >
          <Plus size={14} /> {t('new_category')}
        </button>
      </div>
      <p className="text-sm text-fg-muted mb-6 max-w-lg">{t('categories_help')}</p>

      {/* List */}
      <div className="border border-line rounded-md divide-y divide-line bg-surface">
        <div className="px-4 py-2 text-xs font-medium text-fg-subtle uppercase tracking-wide bg-surface-2 rounded-t-md">
          {t('category_name')}
        </div>
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-fg-subtle">…</div>
        ) : categories.length === 0 && !creating ? (
          <div className="px-4 py-6 text-sm text-fg-subtle text-center">{t('no_categories')}</div>
        ) : (
          <>
            {categories.map((cat) =>
              editing?.id === cat.id ? (
                <CategoryEditRow
                  key={cat.id}
                  initial={cat}
                  onCancel={() => setEditing(null)}
                  onSave={(body) => updateMutation.mutate({ id: cat.id, body })}
                />
              ) : (
                <CategoryRow
                  key={cat.id}
                  cat={cat}
                  onEdit={() => setEditing(cat)}
                  onDelete={() => {
                    if (window.confirm(`Kategorie „${cat.name}" wirklich löschen?`)) {
                      deleteMutation.mutate(cat.id);
                    }
                  }}
                  onToggleFavorite={() => updateMutation.mutate({ id: cat.id, body: { isFavorite: !cat.isFavorite } })}
                />
              )
            )}
            {creating && (
              <CategoryEditRow
                initial={{ id: '', name: '', color: CATEGORY_PALETTE[10]! }}
                onCancel={() => setCreating(false)}
                onSave={(body) => createMutation.mutate({ name: body.name!, color: body.color! })}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function CategoryRow({
  cat, onEdit, onDelete, onToggleFavorite,
}: {
  cat: Category;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 group hover:bg-surface-2 transition-colors">
      <Tag size={16} style={{ color: cat.color, fill: `${cat.color}33` }} className="shrink-0" />
      <span className="flex-1 text-sm text-fg truncate">{cat.name}</span>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button aria-label="Favorit"
          onClick={onToggleFavorite}
          className="p-1.5 rounded text-fg-subtle hover:text-warning-fg hover:bg-surface-2 transition-all active:scale-90"
          title="Favorit"
        >
          <Star size={14} className={cat.isFavorite ? 'fill-warning-fg text-warning-fg' : ''} />
        </button>
        <button aria-label="Bearbeiten" onClick={onEdit} className="p-1.5 rounded text-fg-subtle hover:text-fg-muted hover:bg-surface-2 transition-all active:scale-90" title="Bearbeiten">
          <Pencil size={14} />
        </button>
        <button aria-label="Löschen" onClick={onDelete} className="p-1.5 rounded text-fg-subtle hover:text-danger-fg hover:bg-danger-bg transition-all active:scale-90" title="Löschen">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function CategoryEditRow({
  initial, onCancel, onSave,
}: {
  initial: { id: string; name: string; color: string };
  onCancel: () => void;
  onSave: (body: { name?: string; color?: string }) => void;
}) {
  const [name, setName]   = useState(initial.name);
  const [color, setColor] = useState(initial.color);

  return (
    <div className="px-4 py-3 bg-info-bg/40">
      <div className="flex items-center gap-3 mb-3">
        <Tag size={16} style={{ color, fill: `${color}33` }} className="shrink-0" />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Kategoriename …"
          className="input flex-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) onSave({ name: name.trim(), color });
            if (e.key === 'Escape') onCancel();
          }}
        />
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {CATEGORY_PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-6 h-6 rounded-full transition-all duration-150 ${color === c ? 'ring-2 ring-offset-2 ring-line-strong scale-110' : 'hover:scale-110'}`}
            style={{ backgroundColor: c }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button onClick={onCancel} className="btn-ghost text-xs">
          <XIcon size={13} /> Abbrechen
        </button>
        <button
          onClick={() => name.trim() && onSave({ name: name.trim(), color })}
          disabled={!name.trim()}
          className="btn-primary text-xs"
        >
          <Check size={13} /> Speichern
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LANGUAGE SECTION
// ═══════════════════════════════════════════════════════════════════════════════
function LanguageSection() {
  const t = useT();
  const { lang, pending, setPending, applyPending } = useLanguageStore();
  const dirty = pending !== lang;

  return (
    <section>
      <h2 className="text-xl font-semibold text-fg mb-1">{t('section_language')}</h2>
      <p className="text-sm text-fg-muted mb-6">{t('lang_help')}</p>

      <div className="space-y-2 mb-6">
        {LANGS.map(({ code, flag, nameKey }) => {
          const selected = pending === code;
          return (
            <button
              key={code}
              onClick={() => setPending(code)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-md border text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent/5 text-fg'
                  : 'border-line hover:border-line-strong text-fg-muted'
              }`}
            >
              <span className="text-2xl">{flag}</span>
              <span className="flex-1 font-medium">{t(nameKey)}</span>
              {selected && <Check size={18} className="text-accent-fg" />}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            applyPending();
            toast.success(t('lang_changed'));
          }}
          disabled={!dirty}
          className="px-4 py-2 bg-accent text-white rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
        >
          {t('save')}
        </button>
        {dirty && (
          <button
            onClick={() => setPending(lang)}
            className="px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 rounded-md"
          >
            {t('cancel')}
          </button>
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INACTIVITY TIMEOUT — personal override of the global value
// ═══════════════════════════════════════════════════════════════════════════════
function InactivitySection() {
  interface Prefs { inactivityTimeoutMinutes: number | null; inactivityTimeoutMinutesGlobal: number }
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Prefs>({
    queryKey: ['user-preferences'],
    queryFn: () => api.get<Prefs>('/user/preferences'),
  });

  const [localVal, setLocalVal] = useState<string>('');
  const [usePersonal, setUsePersonal] = useState(false);

  useEffect(() => {
    if (!data) return;
    const personal = data.inactivityTimeoutMinutes;
    setUsePersonal(personal !== null);
    setLocalVal(personal !== null ? String(personal) : String(data.inactivityTimeoutMinutesGlobal));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (val: number | null) => api.put('/user/preferences', { inactivityTimeoutMinutes: val }),
    onSuccess: () => {
      toast.success('Einstellung gespeichert');
      void qc.invalidateQueries({ queryKey: ['user-preferences'] });
    },
    onError: () => toast.error('Fehler beim Speichern'),
  });

  const globalVal = data?.inactivityTimeoutMinutesGlobal ?? 30;

  const QUICK = [
    { label: 'Deaktiviert', value: 0 },
    { label: '5 min', value: 5 },
    { label: '15 min', value: 15 },
    { label: '30 min', value: 30 },
    { label: '1 h', value: 60 },
    { label: '2 h', value: 120 },
  ];

  const numVal = parseInt(localVal, 10);
  const isValid = !Number.isNaN(numVal) && numVal >= 0 && numVal <= 1440;

  function handleSave() {
    if (!isValid) return;
    if (!usePersonal) {
      saveMutation.mutate(null); // null = use global setting
    } else {
      saveMutation.mutate(numVal);
    }
  }

  if (isLoading) return <div className="py-8 text-center text-sm text-fg-subtle">Wird geladen…</div>;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-fg">Automatischer Logout bei Inaktivität</h2>
        <p className="text-sm text-fg-subtle mt-0.5">
          Legt fest, nach wie vielen Minuten ohne Interaktion Sie automatisch abgemeldet werden.
        </p>
      </div>

      {/* Show global setting */}
      <div className="bg-info-bg border border-info-line rounded-lg px-4 py-3 text-sm text-accent-fg">
        <span className="font-medium">Globale Einstellung des Servers:</span>{' '}
        {globalVal === 0 ? 'Deaktiviert' : `${globalVal} Minuten`}
      </div>

      {/* Personal override */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={usePersonal}
            onChange={(e) => {
              setUsePersonal(e.target.checked);
              if (!e.target.checked) setLocalVal(String(globalVal));
            }}
            className="h-4 w-4 rounded border-line-strong text-accent-fg focus:ring-accent-fg"
          />
          <span className="text-sm font-medium text-fg-muted">Eigenen Wert festlegen (überschreibt globale Einstellung)</span>
        </label>

        {usePersonal && (
          <div className="space-y-3 pl-6">
            <div className="flex items-center gap-3">
              <input
                type="number"
                value={localVal}
                onChange={(e) => setLocalVal(e.target.value)}
                min={0}
                max={1440}
                className="input w-24"
              />
              <span className="text-sm text-fg-subtle">Minuten (0 = deaktiviert)</span>
            </div>

            {/* Quick buttons */}
            <div className="flex flex-wrap gap-2">
              {QUICK.map(({ label, value }) => (
                <button
                  key={value}
                  onClick={() => setLocalVal(String(value))}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    parseInt(localVal, 10) === value
                      ? 'bg-accent text-white border-accent'
                      : 'border-line-strong text-fg-muted hover:border-accent hover:text-accent-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {isValid && numVal > 0 && numVal < 5 && (
              <p className="text-xs text-warning-fg">
                ⚠ Sehr kurze Zeitspannen können störend sein.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending || (usePersonal && !isValid)}
          className="px-4 py-2 bg-accent text-white rounded-md hover:opacity-90 disabled:opacity-50 text-sm font-medium"
        >
          {saveMutation.isPending ? 'Speichern…' : 'Speichern'}
        </button>
        {usePersonal && (
          <button
            onClick={() => { setUsePersonal(false); setLocalVal(String(globalVal)); saveMutation.mutate(null); }}
            className="px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 rounded-md"
          >
            Auf Serverstandard zurücksetzen
          </button>
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function ViewSection() {
  const { density, setDensity, readingPane, setReadingPane, groupByConversation, setGroupByConversation } = useUiPrefs();
  const { productName } = useBranding();

  // Reading pane options
  const paneOptions: { value: ReadingPane; label: string; desc: string; Icon: React.ElementType }[] = [
    { value: 'right',  label: 'Rechts',   desc: 'Lesebereich rechts neben der Nachrichtenliste (Standard)', Icon: PanelRight  },
    { value: 'bottom', label: 'Unten',    desc: 'Lesebereich unterhalb der Nachrichtenliste',               Icon: PanelBottom },
    { value: 'off',    label: 'Aus',      desc: 'Kein Lesebereich — Nachrichten im Vollbildmodus öffnen',  Icon: EyeOff      },
  ];

  // Density options
  const densityOptions: { value: Density; label: string; desc: string }[] = [
    { value: 'compact',     label: 'Kompakt',      desc: 'Schmale Zeilen — mehr Nachrichten auf einen Blick' },
    { value: 'normal',      label: 'Normal',       desc: 'Ausgeglichene Darstellung (Standard)' },
    { value: 'comfortable', label: 'Komfortabel',  desc: 'Großzügige Abstände — mehr Luft zwischen den Zeilen' },
  ];

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-fg mb-1">Ansicht</h2>
        <p className="text-sm text-fg-muted">Layout und Darstellungsoptionen für {productName} anpassen.</p>
      </div>

      {/* ── Reading pane ────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-fg mb-3 flex items-center gap-2">
          <Layout size={15} className="text-fg-subtle" />
          Lesebereich
        </h3>
        <div className="space-y-2">
          {paneOptions.map(({ value, label, desc, Icon }) => (
            <label
              key={value}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                readingPane === value
                  ? 'border-accent bg-accent/5'
                  : 'border-line hover:border-line-strong hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="readingPane"
                value={value}
                checked={readingPane === value}
                onChange={() => setReadingPane(value)}
                className="text-accent-fg focus:ring-accent-fg"
              />
              <Icon size={16} className={readingPane === value ? 'text-accent-fg' : 'text-fg-subtle'} />
              <div className="flex-1">
                <div className="text-sm font-medium text-fg">{label}</div>
                <div className="text-xs text-fg-subtle">{desc}</div>
              </div>
              {readingPane === value && <Check size={14} className="text-accent-fg shrink-0" />}
            </label>
          ))}
        </div>
      </div>

      {/* ── Message density ──────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-fg mb-3 flex items-center gap-2">
          <Rows3 size={15} className="text-fg-subtle" />
          Nachrichtendichte
        </h3>
        <div className="space-y-2">
          {densityOptions.map(({ value, label, desc }) => (
            <label
              key={value}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                density === value
                  ? 'border-accent bg-accent/5'
                  : 'border-line hover:border-line-strong hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="density"
                value={value}
                checked={density === value}
                onChange={() => setDensity(value)}
                className="text-accent-fg focus:ring-accent-fg"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-fg">{label}</div>
                <div className="text-xs text-fg-subtle">{desc}</div>
              </div>
              {density === value && <Check size={14} className="text-accent-fg shrink-0" />}
            </label>
          ))}
        </div>
      </div>

      {/* ── Conversation view ────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-fg mb-3">Konversationen</h3>
        <Toggle
          checked={groupByConversation}
          onChange={setGroupByConversation}
          label="Nachrichten nach Konversation gruppieren"
        />
        <p className="text-xs text-fg-subtle mt-2 ml-14">Zusammengehörige Nachrichten (gleicher Betreff) werden gebündelt angezeigt.</p>
      </div>

      {/* ── 9.4: sort order ─────────────────────────────────────────────────── */}
      <MailSortSettings />

      {/* ── Keyboard shortcuts + undo send ───────────────────────────────────── */}
      <ViewKeyboardSettings />
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETENTION POLICIES — read-only overview of the PERSONAL tags
// ═══════════════════════════════════════════════════════════════════════════════
function RetentionSection() {
  const t = useT();
  const { data: tags = [], isLoading } = useQuery({
    queryKey: ['retention-tags'],
    queryFn: () => api.get<RetentionTagDto[]>('/retention-tags'),
  });

  const actionLabel = (a: RetentionTagDto['action']): string => {
    switch (a) {
      case 'MOVE_TO_ARCHIVE':              return t('retention_action_archive');
      case 'DELETE_AND_ALLOW_RECOVERY':    return t('retention_action_delete_recover');
      case 'PERMANENTLY_DELETE':           return t('retention_action_delete_permanent');
      case 'MARK_AS_PAST_RETENTION_LIMIT': return t('retention_action_mark');
    }
  };

  return (
    <section>
      <h2 className="text-xl font-semibold text-fg mb-1">{t('retention_section_title')}</h2>
      <p className="text-sm text-fg-muted mb-6 max-w-lg">{t('retention_section_desc')}</p>

      <div className="border border-line rounded-md divide-y divide-line bg-surface">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-fg-subtle">…</div>
        ) : tags.length === 0 ? (
          <div className="px-4 py-6 text-sm text-fg-subtle text-center">{t('retention_no_tags')}</div>
        ) : (
          tags.map((tg) => (
            <div key={tg.id} className="px-4 py-3 flex items-center gap-3">
              <Clock size={16} className="shrink-0 text-fg-subtle" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fg truncate">{tg.name}</div>
                {tg.description && (
                  <div className="text-xs text-fg-subtle truncate">{tg.description}</div>
                )}
              </div>
              <div className="shrink-0 text-xs text-fg-muted tabular-nums">
                {tg.retentionDays} {t('retention_days')}
              </div>
              <div className="shrink-0 text-xs text-fg-subtle w-44 text-right truncate">
                {actionLabel(tg.action)}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ExternalClientsSection (v3.18.40)
//
// Shows all setup data for external clients (desktop clients + CalDAV plugin,
// Apple Calendar, Thunderbird, eM Client, iPhone, Android).
// ═══════════════════════════════════════════════════════════════════════════════

// 9.4: only protocols switched on for the account — `protocols` lists them, the
// setup data of a protocol that is off is null (lib/externalClients.ts).
interface ClientConfig {
  user: { email: string; displayName: string };
  requiresAppPassword: boolean;
  protocols?: ClientProtocols;
  mail: {
    imap: { host: string; port: number; ssl: boolean } | null;
    pop3: { host: string; port: number; ssl: boolean } | null;
    smtp: { host: string; port: number; tls: boolean } | null;
  };
  caldav: {
    accountUrl: string;
    calendars: { id: string; name: string; isDefault: boolean; url: string }[];
  } | null;
  carddav: {
    accountUrl: string;
    defaultUrl: string;
  } | null;
}

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line last:border-0">
      <span className="text-xs text-fg-subtle w-32 shrink-0">{label}</span>
      <code className={`flex-1 text-xs ${mono ? 'font-mono' : ''} text-fg break-all`}>
        {value}
      </code>
      <button aria-label={`${label} kopieren`}
        onClick={() => { void copyToClipboard(value); toast.success(`${label} kopiert`); }}
        className="shrink-0 p-1.5 text-fg-subtle hover:text-accent-fg rounded hover:bg-surface-2"
        title={`${label} kopieren`}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

// v8.1: automatic setup — Apple configuration profile (.mobileconfig) download and
// hints for clients that configure themselves (autoconfig / Autodiscover).
// Module level (never define components inline). 9.4: `profiles` = the variants
// the account's protocol switches allow (lib/externalClients.ts).
function AutoSetupCard({ email, requiresAppPassword, profiles }: {
  email: string; requiresAppPassword: boolean; profiles: AppleProfileKind[];
}) {
  const [busy, setBusy] = useState<AppleProfileKind | null>(null);
  const download = async (kind: AppleProfileKind) => {
    setBusy(kind);
    try {
      if (isAppleMobileDevice(navigator.userAgent, navigator.maxTouchPoints)) {
        // 9.1 iOS/iPadOS: Safari opens the profile installer only on a plain navigation —
        // single-use 60 s ticket instead of the token (blob downloads are unreliable there)
        const { ticket } = await api.post<{ ticket: string }>(APPLE_PROFILE_TICKET_PATH, {});
        openAppleProfileTicket(window.location, kind, ticket);
        return;
      }
      // fetch with the Authorization header — no token in the URL
      saveBlob(await fetchBlob(appleProfilePath(kind)), appleProfileFileName(email, kind));
    } catch {
      toast.error('Profil konnte nicht geladen werden');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-6 bg-surface border border-line rounded-lg p-5">
      <h3 className="text-base font-semibold text-fg flex items-center gap-2 mb-1">
        <Smartphone size={16} className="text-accent-fg" /> Automatische Einrichtung
      </h3>
      <p className="text-xs text-fg-subtle mb-4">
        Thunderbird, K-9 Mail / FairEmail, eM Client und Desktop-Mailprogramme mit Autodiscover richten das Konto nach Eingabe von
        E-Mail-Adresse und Passwort selbst ein (Autoconfig / Autodiscover). Für iPhone, iPad und Mac
        gibt es ein Konfigurationsprofil mit E-Mail, Kalender und Kontakten.
      </p>
      <div className="flex flex-wrap gap-2">
        {profiles.includes('imap') && (
          <button
            type="button"
            onClick={() => void download('imap')}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'imap' ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
            Profil für iPhone/iPad/Mac laden
          </button>
        )}
        {profiles.includes('eas') && (
          <button
            type="button"
            onClick={() => void download('eas')}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-fg-muted bg-surface-2 rounded-lg hover:bg-surface-3 disabled:opacity-50"
            title="Ein ActiveSync-Konto statt IMAP + CalDAV + CardDAV"
          >
            {busy === 'eas' ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
            Variante ActiveSync
          </button>
        )}
      </div>
      <ol className="list-decimal ml-5 mt-4 text-xs text-fg-muted space-y-1">
        <li>Profil herunterladen (am besten direkt auf dem Gerät in Safari öffnen, oder per AirDrop übertragen).</li>
        <li>iPhone/iPad: <strong>Einstellungen → Profil geladen</strong> → Installieren. Mac: <strong>Systemeinstellungen → Allgemein → Geräteverwaltung</strong>.</li>
        <li>
          Beim Installieren fragt das Gerät nach dem Passwort —{' '}
          {requiresAppPassword
            ? <strong>wegen aktiver MFA ein App-Passwort verwenden</strong>
            : 'dein Login-Passwort (bei aktiver MFA ein App-Passwort)'}.
          Das Profil selbst enthält kein Passwort.
        </li>
        <li>Nur eine der beiden Varianten installieren, sonst erscheint das Konto doppelt.</li>
      </ol>
    </div>
  );
}

function ExternalClientsSection() {
  const { productName } = useBranding();
  const { data: cfg, isLoading } = useQuery<ClientConfig>({
    queryKey: ['client-config'],
    queryFn: () => api.get<ClientConfig>('/user/client-config'),
  });

  if (isLoading) {
    return <div className="p-8 text-center"><Loader2 className="animate-spin mx-auto text-fg-subtle" /></div>;
  }
  if (!cfg) return null;
  const sections = externalClientSections(cfg.protocols);
  const { caldav, carddav } = cfg;

  return (
    <section>
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-fg flex items-center gap-2">
          <Cable size={20} className="text-accent-fg" />
          Externe Clients
        </h2>
        <p className="text-sm text-fg-subtle mt-1">
          Setup-Daten für E-Mail-Programme, Kalender-Apps und mobile Geräte.
        </p>
      </header>

      {!sections.any && (
        <p className="text-sm text-fg-subtle">
          Für dieses Konto sind keine externen Clients freigeschaltet. Bitte wenden Sie sich an Ihren Administrator.
        </p>
      )}

      {/* Desktop client notice banner (calendar / contacts) */}
      {sections.dav && <div className="mb-6 bg-warning-bg border border-warning-line rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Info size={18} className="text-warning-fg shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-warning-fg mb-1">
              Desktop-Mailprogramme &amp; Kalender / Kontakte
            </h3>
            <p className="text-xs text-warning-fg leading-relaxed">
              Desktop-Mailprogramme richten E-Mail über <strong>IMAP/SMTP</strong> ein (siehe unten) — funktioniert
              automatisch via Autodiscover. Für <strong>Kalender und Kontakte</strong> haben manche Desktop-Mailprogramme
              keinen eingebauten CalDAV/CardDAV-Support. Drei Wege:
            </p>
            <ol className="list-decimal ml-5 mt-2 text-xs text-warning-fg space-y-1">
              <li>
                <strong>Outlook CalDav Synchronizer</strong> (kostenloses Open-Source-Plugin):{' '}
                <a href="https://caldavsynchronizer.org/" target="_blank" rel="noopener noreferrer" className="underline hover:text-warning-fg">
                  caldavsynchronizer.org <ExternalLink size={10} className="inline" />
                </a>{' '}— Schritt-für-Schritt-Anleitung unten.
              </li>
              <li>
                <strong>Webmail im Browser</strong> nutzen — Kalender + Kontakte funktionieren vollständig im
                {productName}-Webclient (oben rechts „Kalender"/„Kontakte"-Tab).
              </li>
              <li>
                <strong>Alternative Clients</strong> mit nativem CalDAV/CardDAV: Apple Kalender + Kontakte (macOS),
                Thunderbird mit TbSync-Add-on, eM Client (kostenlos für Privatnutzung).
              </li>
            </ol>
          </div>
        </div>
      </div>}

      {/* App password notice */}
      {cfg.requiresAppPassword && (
        <div className="mb-6 bg-info-bg border border-info-line rounded-lg p-4 flex items-start gap-3">
          <Key size={18} className="text-accent-fg shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-accent-fg">
              Du hast MFA aktiv — App-Passwort erforderlich
            </p>
            <p className="text-xs text-accent-fg mt-1">
              Externe Clients können MFA nicht durchführen. Generiere ein App-Passwort unter
              „Einstellungen → App-Passwörter" und nutze das bei IMAP/SMTP/CalDAV/CardDAV-Logins
              statt deines normalen Passworts.
            </p>
          </div>
        </div>
      )}

      {sections.profiles.length > 0 && (
        <AutoSetupCard email={cfg.user.email} requiresAppPassword={cfg.requiresAppPassword} profiles={sections.profiles} />
      )}

      {/* E-Mail (IMAP / SMTP / POP3) */}
      {sections.mail && <div className="mb-6 bg-surface border border-line rounded-lg p-5">
        <h3 className="text-base font-semibold text-fg flex items-center gap-2 mb-1">
          <MailIcon size={16} className="text-accent-fg" /> E-Mail (IMAP / SMTP)
        </h3>
        <p className="text-xs text-fg-subtle mb-4">
          Für Desktop-Mailprogramme, Apple Mail, Thunderbird, K-9 Mail (Android) — wird via Autodiscover automatisch erkannt.
        </p>
        <div className="grid md:grid-cols-2 gap-6">
          {cfg.mail.imap && <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle mb-2">
              Eingehend (IMAP)
            </h4>
            <CopyRow label="Server" value={cfg.mail.imap.host} />
            <CopyRow label="Port" value={String(cfg.mail.imap.port)} mono={false} />
            <CopyRow label="Verschlüsselung" value={cfg.mail.imap.ssl ? 'SSL/TLS' : 'STARTTLS'} mono={false} />
            <CopyRow label="Benutzername" value={cfg.user.email} />
          </div>}
          {cfg.mail.smtp && <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle mb-2">
              Ausgehend (SMTP)
            </h4>
            <CopyRow label="Server" value={cfg.mail.smtp.host} />
            <CopyRow label="Port" value={String(cfg.mail.smtp.port)} mono={false} />
            <CopyRow label="Verschlüsselung" value={cfg.mail.smtp.tls ? 'STARTTLS' : 'Keine'} mono={false} />
            <CopyRow label="Benutzername" value={cfg.user.email} />
          </div>}
        </div>
        {cfg.mail.pop3 && <details className="mt-4 text-xs text-fg-subtle">
          <summary className="cursor-pointer hover:text-fg-muted">
            POP3 (für ältere Clients, nicht empfohlen — synchronisiert nicht zwischen Geräten)
          </summary>
          <div className="mt-2 ml-3">
            <CopyRow label="Server" value={cfg.mail.pop3.host} />
            <CopyRow label="Port" value={String(cfg.mail.pop3.port)} mono={false} />
            <CopyRow label="Verschlüsselung" value={cfg.mail.pop3.ssl ? 'SSL/TLS' : 'STARTTLS'} mono={false} />
          </div>
        </details>}
      </div>}

      {/* CalDAV */}
      {caldav && <div className="mb-6 bg-surface border border-line rounded-lg p-5">
        <h3 className="text-base font-semibold text-fg flex items-center gap-2 mb-1">
          <CalendarDays size={16} className="text-accent-fg" /> Kalender (CalDAV)
        </h3>
        <p className="text-xs text-fg-subtle mb-4">
          Für Apple Kalender, Thunderbird Lightning, eM Client, DAVx⁵ (Android), Desktop-Mailprogramme mit Sync-Plugin (CalDav Synchronizer).
        </p>
        <CopyRow label="Account-URL" value={caldav.accountUrl} />
        <CopyRow label="Benutzername" value={cfg.user.email} />
        <CopyRow label="Passwort" value={cfg.requiresAppPassword ? '(App-Passwort)' : '(dein Login-Passwort)'} mono={false} />
        {caldav.calendars.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-fg-muted hover:text-fg">
              Direkte Kalender-URLs ({caldav.calendars.length}) — für Clients ohne Auto-Discovery
            </summary>
            <div className="mt-2 ml-3 space-y-1">
              {caldav.calendars.map((c) => (
                <CopyRow key={c.id} label={c.name + (c.isDefault ? ' ★' : '')} value={c.url} />
              ))}
            </div>
          </details>
        )}
      </div>}

      {/* CardDAV */}
      {carddav && <div className="mb-6 bg-surface border border-line rounded-lg p-5">
        <h3 className="text-base font-semibold text-fg flex items-center gap-2 mb-1">
          <BookUser size={16} className="text-accent-fg" /> Kontakte (CardDAV)
        </h3>
        <p className="text-xs text-fg-subtle mb-4">
          Für Apple Kontakte, Thunderbird CardBook, eM Client, DAVx⁵, Desktop-Mailprogramme mit Sync-Plugin (CalDav Synchronizer).
        </p>
        <CopyRow label="Account-URL" value={carddav.accountUrl} />
        <CopyRow label="Adressbuch-URL" value={carddav.defaultUrl} />
        <CopyRow label="Benutzername" value={cfg.user.email} />
        <CopyRow label="Passwort" value={cfg.requiresAppPassword ? '(App-Passwort)' : '(dein Login-Passwort)'} mono={false} />
      </div>}

      {/* Outlook CalDav Synchronizer guide */}
      {caldav && carddav && <div className="bg-surface border border-line rounded-lg p-5">
        <h3 className="text-base font-semibold text-fg flex items-center gap-2 mb-3">
          <ExternalLink size={16} className="text-accent-fg" /> Sync-Plugin CalDav Synchronizer einrichten
        </h3>
        <ol className="list-decimal ml-5 text-sm text-fg-muted space-y-3">
          <li>
            <strong>Plugin herunterladen + installieren</strong>:
            <a href="https://github.com/aluxnimm/outlookcaldavsynchronizer/releases/latest"
               target="_blank" rel="noopener noreferrer"
               className="text-accent-fg hover:underline ml-1 inline-flex items-center gap-1">
              GitHub Releases <ExternalLink size={11} />
            </a>
            <span className="text-xs text-fg-subtle block mt-1">
              Lade die neueste <code>OutlookCalDavSynchronizer-x.x.x.zip</code>, entpacke und führe <code>setup.exe</code> aus.
              Outlook neu starten.
            </span>
          </li>
          <li>
            <strong>In Outlook</strong>: Tab „CalDav Synchronizer" → „Synchronization Profiles" → „+ Add" → „Generic CalDAV/CardDAV".
          </li>
          <li>
            <strong>Kalender-Profil erstellen</strong>:
            <div className="text-xs text-fg-muted ml-2 mt-1 space-y-0.5">
              <div>• <strong>Outlook Folder</strong>: „Kalender" (lokaler Outlook-Kalender)</div>
              <div>• <strong>DAV URL</strong>: <code className="bg-surface-2 px-1">{caldav.accountUrl}</code></div>
              <div>• <strong>Username</strong>: <code className="bg-surface-2 px-1">{cfg.user.email}</code></div>
              <div>• <strong>Password</strong>: {cfg.requiresAppPassword ? 'App-Passwort (Einstellungen → App-Passwörter)' : 'dein Login-Passwort'}</div>
              <div>• <strong>Test Connection</strong> klicken → wählt automatisch verfügbare Kalender</div>
              <div>• <strong>Synchronization Settings</strong>: „Outlook ↔ Server (Two-Way)", Intervall z.B. 5 Min.</div>
            </div>
          </li>
          <li>
            <strong>Kontakte-Profil erstellen</strong> (gleich wiederholen):
            <div className="text-xs text-fg-muted ml-2 mt-1 space-y-0.5">
              <div>• <strong>Outlook Folder</strong>: „Kontakte" (lokaler Outlook-Ordner)</div>
              <div>• <strong>DAV URL</strong>: <code className="bg-surface-2 px-1">{carddav.defaultUrl}</code></div>
              <div>• Rest wie oben</div>
            </div>
          </li>
          <li>
            <strong>Erste Synchronisierung</strong> manuell anstoßen („Synchronize now"). Danach läuft alles
            automatisch im Hintergrund. Termine und Kontakte erscheinen in Outlook und bleiben bidirektional
            mit {productName} synchron.
          </li>
        </ol>
      </div>}
    </section>
  );
}

const NAV: { group: TranslationKey; items: { id: Section; label: TranslationKey; icon: React.ElementType; indent?: true }[] }[] = [
  {
    group: 'section_account',
    items: [
      { id: 'profile',         label: 'section_profile',          icon: User       },
      { id: 'password',        label: 'section_password',         icon: Lock       },
      { id: 'appPasswords',    label: 'app_passwords',            icon: Smartphone },
      { id: 'externalClients', label: 'section_external_clients', icon: Cable      },
      { id: 'oof',             label: 'section_oof',              icon: BellOff    },
      { id: 'rules',           label: 'section_rules',            icon: ListFilter },
      { id: 'signature',       label: 'section_signature',        icon: PenLine    },
      { id: 'templates',       label: 'section_templates',        icon: FileText   },
      { id: 'categories',      label: 'categories',               icon: Tag        },
      { id: 'retention',       label: 'retention_section_title',  icon: Clock      },
      { id: 'storage',         label: 'section_storage',          icon: HardDrive  },
      // 9.4: sub-entry of Speicher
      { id: 'recover',         label: 'settings_nav_recover',     icon: RotateCcw },
    ],
  },
  {
    group: 'section_general',
    items: [
      { id: 'view',       label: 'view_settings',      icon: Layout       },
      { id: 'reading',    label: 'section_reading',    icon: MailIcon     },
      { id: 'compose',    label: 'section_compose',    icon: PenLine      },
      { id: 'theme',      label: 'section_theme',      icon: Palette      },
      { id: 'language',   label: 'section_language',   icon: Globe        },
      { id: 'regional',   label: 'section_regional',   icon: Clock        },
      { id: 'calendar',   label: 'calendar',           icon: CalendarDays },
      { id: 'notifications', label: 'section_notifications', icon: Bell },
      { id: 'inactivity', label: 'section_inactivity', icon: Shield       },
      { id: 'security',   label: 'section_security',   icon: ShieldCheck  },
    ],
  },
];

const SECTION_MAP: Record<Section, React.ComponentType> = {
  profile:      ProfileSection,
  password:     PasswordSection,
  oof:          OofSection,
  signature:    SignatureSettings,
  templates:    TemplateSettings,
  storage:      StorageSection,
  recover:      RecoverSection,
  theme:        ThemeSection,
  security:     SecuritySection,
  language:     LanguageSection,
  calendar:     CalendarSettings,
  reading:      ReadingSettings,
  compose:      ComposeSettings,
  regional:     RegionalSettings,
  categories:   CategoriesSection,
  retention:    RetentionSection,
  appPasswords:    AppPasswordsSection,
  externalClients: ExternalClientsSection,
  inactivity:      InactivitySection,
  view:         ViewSection,
  rules:        RulesSection,
  notifications: NotificationsSection,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
export function SettingsPage() {
  const t = useT();
  // Deep link via hash (e.g. /settings#rules from the message list context menu)
  const { hash } = useLocation();
  const hashSection = hash.replace(/^#/, '');
  const sectionFromHash = Object.prototype.hasOwnProperty.call(SECTION_MAP, hashSection) ? hashSection as Section : null;
  const [section, setSection] = useState<Section>(sectionFromHash ?? 'profile');
  useEffect(() => { if (sectionFromHash) setSection(sectionFromHash); }, [sectionFromHash]);
  // 9.4: sections of modules the webmail policy switched off are not offered
  const { features } = useWebmailFeatures();
  const shown = isSettingsSectionVisible(section, features) ? section : 'profile';
  const SectionComp = SECTION_MAP[shown];

  return (
    // 10.1: one card floating on the canvas (lib/paneLayout.ts) — the background shows around it
    <div className="flex flex-1 min-w-0 min-h-0 md:p-2">
    <div className={`flex flex-col md:flex-row flex-1 min-w-0 ${PANE_CARD_CLASS}`}>
      {/* Left navigation */}
      <aside className="w-full md:w-56 shrink-0 max-md:max-h-[35%] md:border-r max-md:border-b border-line pt-4 overflow-y-auto">
        {NAV.map(({ group, items }) => (
          <div key={group} className="mb-2">
            <p className="px-4 py-1 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{t(group)}</p>
            {items.filter(({ id }) => isSettingsSectionVisible(id, features)).map(({ id, label, icon: Icon, indent }) => (
              <button key={id} onClick={() => setSection(id)} className={settingsNavClass({ active: shown === id, indent })}>
                <Icon size={settingsNavIconSize(indent)} />
                {t(label)}
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* Right content area — external clients needs more width for URLs */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 md:p-8">
        <div className={shown === 'externalClients' ? 'max-w-5xl' : shown === 'recover' ? 'max-w-3xl' : 'max-w-xl'}>
          <SectionComp />
        </div>
      </div>
    </div>
    </div>
  );
}
