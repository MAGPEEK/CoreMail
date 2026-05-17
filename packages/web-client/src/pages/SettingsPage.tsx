import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  User, PenLine, BellOff, Shield, Key, HardDrive, Trash2,
  ChevronDown, Loader2, Lock, Palette, Sun, Moon, Monitor, Check,
  ShieldCheck, ShieldOff, Copy, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../api/client.js';
import { useThemeStore, ACCENT_COLORS, type ThemeMode } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import toast from 'react-hot-toast';

// ── Typen ─────────────────────────────────────────────────────────────────────
type Section = 'profile' | 'oof' | 'signature' | 'storage' | 'security' | 'password' | 'theme';

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

interface SigData { signature: string; autoNew: boolean; autoReply: boolean }

interface StorageFolder { id: string; name: string; displayName: string; sizeBytes: number; messageCount: number }
interface StorageData { quotaBytes: number; usedBytes: number; folders: StorageFolder[] }

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function today()    { return new Date().toISOString().split('T')[0]!; }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]!; }

// Passwort-Stärke ─────────────────────────────────────────────────────────────
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
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          checked ? 'bg-accent' : 'bg-gray-300'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`} />
      </button>
      <span className="text-sm text-gray-800">{label}</span>
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFIL
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
        <h2 className="text-lg font-semibold text-gray-900">E-Mail-Konto</h2>
        <p className="text-sm text-gray-500 mt-0.5">Kontoinformationen und Anzeigename</p>
      </div>
      <div className="space-y-4 max-w-md">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail-Adresse</label>
          <input className="input bg-gray-50 text-gray-500 cursor-not-allowed" value={data?.email ?? ''} disabled />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Anzeigename</label>
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
// PASSWORT ÄNDERN
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
        <h2 className="text-lg font-semibold text-gray-900">Passwort ändern</h2>
        <p className="text-sm text-gray-500 mt-0.5">Legen Sie ein neues Passwort für Ihr Konto fest</p>
      </div>

      <div className="space-y-4 max-w-md">
        {/* Aktuelles Passwort */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Aktuelles Passwort</label>
          <div className="relative">
            <input
              type={showCurrent ? 'text' : 'password'}
              className="input pr-10"
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              placeholder="Aktuelles Passwort eingeben"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowCurrent(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showCurrent ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        {/* Neues Passwort */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Neues Passwort</label>
          <div className="relative">
            <input
              type={showNew ? 'text' : 'password'}
              className="input pr-10"
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="Mindestens 8 Zeichen"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowNew(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showNew ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {/* Stärkemeter */}
          {newPw.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-colors ${
                      i <= strength.score ? strength.colorClass : 'bg-gray-200'
                    }`}
                  />
                ))}
              </div>
              {strength.label && (
                <p className={`text-xs font-medium ${
                  strength.score <= 1 ? 'text-red-500'
                  : strength.score === 2 ? 'text-orange-500'
                  : strength.score === 3 ? 'text-yellow-600'
                  : 'text-green-600'
                }`}>
                  Stärke: {strength.label}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Passwort bestätigen */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Passwort bestätigen</label>
          <input
            type="password"
            className={`input ${mismatch ? 'border-red-400 focus:border-red-400 focus:ring-red-200' : ''}`}
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            placeholder="Neues Passwort wiederholen"
            autoComplete="new-password"
          />
          {mismatch && (
            <p className="text-xs text-red-500 mt-1">Die Passwörter stimmen nicht überein</p>
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

// Minimale SVG-Icons für Passwort-Sichtbarkeit ───────────────────────────────
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

function ThemeSection() {
  const { theme, accentRgb, setTheme, setAccent } = useThemeStore();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Design</h2>
        <p className="text-sm text-gray-500 mt-0.5">Erscheinungsbild und Akzentfarbe des Webclients</p>
      </div>

      {/* Farbschema */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-700">Farbschema</p>
        <div className="grid grid-cols-3 gap-3 max-w-lg">
          {THEME_OPTIONS.map(({ id, label, desc, icon: Icon }) => {
            const active = theme === id;
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-left ${
                  active
                    ? 'border-accent bg-accent/5'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                {active && (
                  <span className="absolute top-2 right-2 w-5 h-5 bg-accent rounded-full flex items-center justify-center">
                    <Check size={11} className="text-white" strokeWidth={3} />
                  </span>
                )}
                {/* Vorschau-Box */}
                <div className={`w-full h-14 rounded-lg overflow-hidden border ${
                  id === 'dark' ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'
                }`}>
                  <div className={`h-4 ${id === 'dark' ? 'bg-gray-700' : 'bg-gray-100'} flex items-center gap-1 px-2`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${id === 'dark' ? 'bg-gray-500' : 'bg-gray-300'}`} />
                    <span className={`w-8 h-1 rounded ${id === 'dark' ? 'bg-gray-500' : 'bg-gray-200'}`} />
                  </div>
                  <div className="flex gap-1 p-1.5">
                    <span className={`w-8 h-6 rounded ${id === 'dark' ? 'bg-gray-700' : 'bg-gray-100'}`} />
                    <span className={`flex-1 h-6 rounded ${id === 'dark' ? 'bg-gray-750' : 'bg-white'} border ${id === 'dark' ? 'border-gray-600' : 'border-gray-200'}`} />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 w-full">
                  <Icon size={13} className={active ? 'text-accent' : 'text-gray-500'} />
                  <span className={`text-xs font-semibold ${active ? 'text-accent' : 'text-gray-700'}`}>{label}</span>
                </div>
                <p className="text-[10px] text-gray-400 leading-tight w-full">{desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Akzentfarbe */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-gray-700">Akzentfarbe</p>
        <div className="flex flex-wrap gap-3">
          {ACCENT_COLORS.map(({ name, hex, rgb }) => {
            const active = accentRgb === rgb;
            return (
              <button
                key={rgb}
                title={name}
                onClick={() => setAccent(rgb)}
                className={`w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center ${
                  active ? 'border-gray-800 scale-110 shadow-md' : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: hex }}
              >
                {active && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-400">
          Die Akzentfarbe wird für Schaltflächen, Links und Markierungen verwendet.
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATUREN
// ═══════════════════════════════════════════════════════════════════════════════
function SignatureSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['user-signature'],
    queryFn: () => api.get<SigData>('/user/signature'),
  });

  const [autoNew,   setAutoNew]   = useState(true);
  const [autoReply, setAutoReply] = useState(false);

  useEffect(() => {
    if (data) { setAutoNew(data.autoNew); setAutoReply(data.autoReply); }
  }, [data]);

  const editor = useEditor({
    extensions: [StarterKit],
    content: data?.signature ?? '',
    editorProps: { attributes: { class: 'outline-none min-h-[140px] text-sm text-gray-800' } },
  });

  // Inhalt setzen wenn Daten geladen
  useEffect(() => {
    if (editor && data?.signature && editor.isEmpty) {
      editor.commands.setContent(data.signature);
    }
  }, [editor, data?.signature]);

  const mutation = useMutation({
    mutationFn: () => api.put('/user/signature', { signature: editor?.getHTML() ?? '', autoNew, autoReply }),
    onSuccess: () => { toast.success('Signatur gespeichert'); void qc.invalidateQueries({ queryKey: ['user-signature'] }); },
    onError: () => toast.error('Fehler beim Speichern'),
  });

  if (isLoading) return <div className="flex justify-center py-12 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Signaturen</h2>
        <p className="text-sm text-gray-500 mt-0.5">Wird automatisch an neue E-Mails angehängt</p>
      </div>

      {/* Rich-Text Editor */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 bg-gray-50 flex-wrap">
          {[
            { label: 'B', cmd: () => editor?.chain().focus().toggleBold().run(),      active: editor?.isActive('bold')   },
            { label: 'I', cmd: () => editor?.chain().focus().toggleItalic().run(),    active: editor?.isActive('italic') },
            { label: 'U', cmd: () => editor?.chain().focus().toggleStrike().run(),    active: editor?.isActive('strike') },
          ].map(({ label, cmd, active }) => (
            <button key={label} onMouseDown={e => { e.preventDefault(); cmd(); }}
              className={`w-7 h-7 text-xs font-semibold rounded transition-colors ${active ? 'bg-accent text-white' : 'hover:bg-gray-200 text-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="px-3 py-3">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Auto-Insert Optionen */}
      <div className="space-y-3 py-3 border-t border-gray-100">
        <p className="text-sm font-medium text-gray-700">Signatur automatisch einfügen</p>
        <Toggle checked={autoNew}   onChange={setAutoNew}   label="Bei neuen E-Mails" />
        <Toggle checked={autoReply} onChange={setAutoReply} label="Bei Antworten und Weiterleitungen" />
      </div>

      <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Speichern…</> : 'Speichern'}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATISCHE ANTWORTEN (OOF)
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

  if (isLoading) return <div className="flex justify-center py-12 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>;

  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Automatische Antworten</h2>
        <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">
          Verwenden Sie automatische Antworten, um anderen mitzuteilen, dass Sie im Urlaub sind oder Ihre E-Mails zurzeit nicht beantworten können.
          Sie können festlegen, dass Ihre Antworten an einem bestimmten Zeitpunkt beginnen und enden. Andernfalls bleiben sie aktiviert, bis Sie sie deaktivieren.
        </p>
      </div>

      {/* Haupt-Toggle */}
      <Toggle checked={enabled} onChange={setEnabled} label="Automatische Antworten aktivieren" />

      {/* Optionen wenn aktiviert */}
      {enabled && (
        <div className="space-y-5 pl-1">

          {/* Zeitraum */}
          <div className="space-y-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={useTimeRange} onChange={e => setUseTimeRange(e.target.checked)}
                className="w-4 h-4 accent-accent rounded" />
              <span className="text-sm text-gray-700">Antworten nur in einem bestimmten Zeitraum senden</span>
            </label>

            <div className={`space-y-2 pl-6 ${!useTimeRange ? 'opacity-40 pointer-events-none' : ''}`}>
              {/* Startzeit */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600 w-16">Startzeit</span>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="input text-sm w-36" />
                <div className="relative">
                  <select value={startTime} onChange={e => setStartTime(e.target.value)}
                    className="input text-sm pr-8 appearance-none w-28">
                    {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                </div>
              </div>
              {/* Endzeit */}
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600 w-16">Endzeit</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                  className="input text-sm w-36" />
                <div className="relative">
                  <select value={endTime} onChange={e => setEndTime(e.target.value)}
                    className="input text-sm pr-8 appearance-none w-28">
                    {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                </div>
              </div>
              {useTimeRange && (
                <p className="text-xs text-accent pl-0">
                  Der Zeitraum wird als Abwesenheitstermin in Ihrem Kalender eingetragen.
                </p>
              )}
            </div>
          </div>

          {/* Interne Antwort */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Antwort an Personen innerhalb Ihrer Organisation</label>
            <textarea
              value={internalMsg} onChange={e => setInternalMsg(e.target.value)}
              rows={4} className="input resize-none text-sm"
              placeholder="Ich bin momentan nicht erreichbar und antworte Ihrer Nachricht so schnell wie möglich." />
          </div>

          {/* Externe Antwort */}
          <div className="space-y-3 pt-1">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" checked={externalEnabled} onChange={e => setExternalEnabled(e.target.checked)}
                className="w-4 h-4 accent-accent rounded" />
              <span className="text-sm text-gray-700">Antworten an Personen außerhalb Ihrer Organisation senden</span>
            </label>

            <div className={`pl-6 space-y-3 ${!externalEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={externalOnlyContacts} onChange={e => setExternalOnlyContacts(e.target.checked)}
                  className="w-4 h-4 accent-accent rounded" />
                <span className="text-sm text-gray-700">Antworten nur an Kontakte senden</span>
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
// SPEICHER
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
  INBOX: () => <span className="text-gray-400">📥</span>,
  Trash: Trash2,
  Junk:  () => <span className="text-gray-400">⚠️</span>,
};

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

  if (isLoading) return <div className="flex justify-center py-12 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>;

  const quota = data?.quotaBytes ?? 0;
  const used  = data?.usedBytes  ?? 0;
  const pct   = quota > 0 ? Math.min((used / quota) * 100, 100) : 0;
  const folders = data?.folders ?? [];

  // Farbe pro Ordner
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
        <h2 className="text-lg font-semibold text-gray-900">Speicher</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Sie haben {fmtBytes(quota)} E-Mail-Speicher mit diesem Konto, das Anlagen und Nachrichten in allen Ordnern umfasst.
        </p>
      </div>

      {/* Verwendungsanzeige */}
      <div className="space-y-2">
        <p className="text-sm text-gray-700">
          <span className="font-medium">{fmtBytes(used)}</span> von <span className="font-medium">{fmtBytes(quota)}</span>{' '}
          (<span className="font-medium">{pct.toFixed(1)}%</span>) verwendet
        </p>

        {/* Gestapelter Balken */}
        <div className="h-4 w-full bg-gray-100 rounded-full overflow-hidden flex">
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

        {/* Legende */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          {folders.filter(f => f.sizeBytes > 0).map((f, i) => (
            <div key={f.id} className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: colorFor(f.name, i) }} />
              {FOLDER_DISPLAY[f.name] ?? f.displayName}
            </div>
          ))}
        </div>
      </div>

      {/* Tabelle */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Speicher verwalten</h3>
        <p className="text-xs text-gray-500 mb-3">
          Wenn Sie Inhalte aus einem Ordner leeren, können Sie Speicherplatz freigeben. Elemente werden endgültig gelöscht.
        </p>

        {folders.length === 0 ? (
          <p className="text-sm text-gray-400 py-4">Keine Daten verfügbar.</p>
        ) : (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Ordner</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Größe</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Nachrichten</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Verwalten</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {folders.map((f, i) => {
                  const FIcon = FOLDER_ICON_MAP[f.name] ?? Trash2;
                  const isConfirming = confirming === f.id;
                  const displayName = FOLDER_DISPLAY[f.name] ?? f.displayName;
                  return (
                    <tr key={f.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span style={{ color: colorFor(f.name, i) }}>
                            <FIcon size={14} />
                          </span>
                          <span className="text-gray-800">{displayName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{fmtBytes(f.sizeBytes)}</td>
                      <td className="px-4 py-3 text-gray-600">{f.messageCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        {isConfirming ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-gray-500">Sicher?</span>
                            <button onClick={() => emptyMut.mutate(f.id)} disabled={emptyMut.isPending}
                              className="px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 transition-colors">
                              {emptyMut.isPending ? '…' : 'Ja, leeren'}
                            </button>
                            <button onClick={() => setConfirming(null)}
                              className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800">
                              Abbrechen
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirming(f.id)}
                            className="flex items-center gap-1.5 ml-auto px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50 hover:text-red-600 hover:border-red-300 transition-colors">
                            <Trash2 size={12} />
                            Leeren
                            <ChevronDown size={11} className="text-gray-400" />
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
// SICHERHEIT
// ═══════════════════════════════════════════════════════════════════════════════
// ── TOTP-Setup-Wizard (integriert) ────────────────────────────────────────────
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

// Auth-Fetch-Helper für /auth/* Routen (außerhalb von /api/v1/)
async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().accessToken ?? '';
  const isGet = !init.method || init.method === 'GET';
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(isGet ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function SecuritySection() {
  const qc = useQueryClient();
  const [totpStep, setTotpStep] = useState<TotpStep>('idle');
  const [setupData, setSetupData] = useState<TotpSetupData | null>(null);
  const [confirmDigits, setConfirmDigits] = useState(['', '', '', '', '', '']);
  const [confirmError, setConfirmError] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);

  const { data: mfaStatus, isLoading: statusLoading } = useQuery<MfaStatus>({
    queryKey: ['mfa-status'],
    queryFn: () => authFetch<MfaStatus>('/auth/mfa/status'),
    staleTime: 0,
  });

  const setupMutation = useMutation({
    mutationFn: () => authFetch<TotpSetupData>('/auth/mfa/totp/setup', { method: 'POST' }),
    onSuccess: (data) => {
      setSetupData(data);
      setTotpStep('setup');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirmMutation = useMutation({
    mutationFn: (code: string) =>
      authFetch<{ ok: boolean }>('/auth/mfa/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    onSuccess: async () => {
      const data = await authFetch<{ codes: string[] }>('/auth/mfa/backup-codes/generate', { method: 'POST' });
      setBackupCodes(data.codes);
      setTotpStep('done');
      void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    },
    onError: (e: Error) => {
      setConfirmError(e.message);
      setConfirmDigits(['', '', '', '', '', '']);
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    },
  });

  const disableMutation = useMutation({
    mutationFn: () => authFetch<{ ok: boolean }>('/auth/mfa/totp', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('2FA wurde deaktiviert');
      setTotpStep('idle');
      setSetupData(null);
      setBackupCodes(null);
      void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenBackupMutation = useMutation({
    mutationFn: () => authFetch<{ codes: string[] }>('/auth/mfa/backup-codes/generate', { method: 'POST' }),
    onSuccess: (data) => {
      setBackupCodes(data.codes);
      toast.success('Neue Backup-Codes generiert');
      void qc.invalidateQueries({ queryKey: ['mfa-status'] });
    },
    onError: (e: Error) => toast.error(e.message),
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
    if (setupData?.secret) { void navigator.clipboard.writeText(setupData.secret); toast.success('Secret kopiert'); }
  };
  const copyBackupCodes = () => {
    if (backupCodes) { void navigator.clipboard.writeText(backupCodes.join('\n')); toast.success('Backup-Codes kopiert'); }
  };

  return (
    <div className="space-y-5 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Sicherheit</h2>
        <p className="text-sm text-gray-500 mt-0.5">App-Passwörter und Zwei-Faktor-Authentifizierung</p>
      </div>

      {/* App-Passwörter (Link bleibt) */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <Key size={15} className="text-gray-400" />
          <span className="text-sm font-medium">App-Passwörter</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">Für E-Mail-Clients (Outlook, Thunderbird) ohne Hauptpasswort verbinden.</p>
        <a href="/auth/app-passwords" target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
          App-Passwörter verwalten
        </a>
      </div>

      {/* ── 2FA Karte ── */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={15} className="text-gray-400" />
            <span className="text-sm font-medium">Zwei-Faktor-Authentifizierung (TOTP)</span>
          </div>
          {statusLoading ? (
            <Loader2 size={14} className="animate-spin text-gray-400" />
          ) : mfaStatus?.totpEnabled ? (
            <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
              <ShieldCheck size={12} /> Aktiv
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">
              <ShieldOff size={12} /> Inaktiv
            </span>
          )}
        </div>

        {/* ── Status: inaktiv → Setup starten ── */}
        {!mfaStatus?.totpEnabled && totpStep === 'idle' && (
          <>
            <p className="text-xs text-gray-500">
              Schützen Sie Ihr Konto mit einer Authenticator-App (z.B. Google Authenticator, Authy, Microsoft Authenticator).
            </p>
            <button
              onClick={() => setupMutation.mutate()}
              disabled={setupMutation.isPending}
              className="btn-primary text-xs flex items-center gap-1.5"
            >
              {setupMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              2FA einrichten
            </button>
          </>
        )}

        {/* ── Schritt 1: QR-Code anzeigen ── */}
        {totpStep === 'setup' && setupData && (
          <div className="space-y-3">
            <p className="text-xs text-gray-600 font-medium">
              1. Scannen Sie den QR-Code mit Ihrer Authenticator-App:
            </p>
            <div className="flex justify-center">
              <img src={setupData.qrCodeDataUrl} alt="TOTP QR Code" className="w-40 h-40 border border-gray-200 rounded" />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Oder geben Sie den Secret-Schlüssel manuell ein:</p>
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded px-3 py-1.5">
                <code className="text-xs font-mono text-gray-700 flex-1 select-all break-all">{setupData.secret}</code>
                <button onClick={copySecret} className="text-gray-400 hover:text-gray-600 shrink-0">
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

        {/* ── Schritt 2: Code bestätigen ── */}
        {totpStep === 'confirm' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-600 font-medium">
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
                  className="w-9 h-11 text-center text-lg font-bold border-2 rounded-lg focus:outline-none focus:border-accent transition-colors"
                  style={{ borderColor: d ? 'var(--color-accent)' : undefined }}
                />
              ))}
            </div>
            {confirmError && (
              <p className="text-xs text-red-600 flex items-center gap-1">
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

        {/* ── Schritt 3: Erfolg + Backup-Codes ── */}
        {totpStep === 'done' && backupCodes && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-700 text-sm font-medium">
              <ShieldCheck size={16} /> 2FA erfolgreich aktiviert!
            </div>
            <div>
              <p className="text-xs text-gray-600 font-medium mb-1">Backup-Codes (je einmalig verwendbar):</p>
              <p className="text-xs text-gray-500 mb-2">Speichern Sie diese Codes sicher. Sie können damit bei verlorenem Gerät einloggen.</p>
              <div className="grid grid-cols-2 gap-1 bg-white border border-gray-200 rounded p-3 font-mono text-xs">
                {backupCodes.map((c, i) => <span key={i} className="text-gray-700">{c}</span>)}
              </div>
              <button onClick={copyBackupCodes} className="mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                <Copy size={11} /> Alle kopieren
              </button>
            </div>
            <button onClick={() => setTotpStep('idle')} className="btn-secondary text-xs">Fertig</button>
          </div>
        )}

        {/* ── Aktiv: Verwaltung ── */}
        {mfaStatus?.totpEnabled && totpStep === 'idle' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs text-gray-600">
              <div className="bg-white border border-gray-200 rounded p-2 text-center">
                <p className="font-semibold text-base text-gray-900">{mfaStatus.backupCodesCount}</p>
                <p>Backup-Codes verbleibend</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => regenBackupMutation.mutate()}
                disabled={regenBackupMutation.isPending}
                className="btn-secondary text-xs flex items-center gap-1.5"
              >
                {regenBackupMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Backup-Codes neu generieren
              </button>
              <button
                onClick={() => { if (confirm('2FA wirklich deaktivieren?')) disableMutation.mutate(); }}
                disabled={disableMutation.isPending}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
              >
                {disableMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <ShieldOff size={12} />}
                2FA deaktivieren
              </button>
            </div>
            {regenBackupMutation.data?.codes && (
              <div>
                <p className="text-xs text-gray-600 font-medium mb-1">Neue Backup-Codes:</p>
                <div className="grid grid-cols-2 gap-1 bg-white border border-gray-200 rounded p-3 font-mono text-xs">
                  {regenBackupMutation.data.codes.map((c, i) => <span key={i} className="text-gray-700">{c}</span>)}
                </div>
                <button
                  onClick={() => { void navigator.clipboard.writeText((regenBackupMutation.data?.codes ?? []).join('\n')); toast.success('Kopiert'); }}
                  className="mt-1 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                >
                  <Copy size={11} /> Alle kopieren
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
const NAV: { group: string; items: { id: Section; label: string; icon: React.ElementType }[] }[] = [
  {
    group: 'Konto',
    items: [
      { id: 'profile',   label: 'E-Mail-Konto',           icon: User      },
      { id: 'password',  label: 'Passwort',                icon: Lock      },
      { id: 'oof',       label: 'Automatische Antworten',  icon: BellOff   },
      { id: 'signature', label: 'Signaturen',              icon: PenLine   },
      { id: 'storage',   label: 'Speicher',                icon: HardDrive },
    ],
  },
  {
    group: 'Allgemein',
    items: [
      { id: 'theme',    label: 'Design',     icon: Palette },
      { id: 'security', label: 'Sicherheit', icon: Shield  },
    ],
  },
];

const SECTION_MAP: Record<Section, React.ComponentType> = {
  profile:   ProfileSection,
  password:  PasswordSection,
  oof:       OofSection,
  signature: SignatureSection,
  storage:   StorageSection,
  theme:     ThemeSection,
  security:  SecuritySection,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HAUPT-EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
export function SettingsPage() {
  const [section, setSection] = useState<Section>('profile');
  const SectionComp = SECTION_MAP[section];

  return (
    <div className="flex flex-1 overflow-hidden bg-white">
      {/* Linke Navigation — OWA-Stil */}
      <aside className="w-56 shrink-0 border-r border-gray-200 pt-4 bg-white overflow-y-auto">
        {NAV.map(({ group, items }) => (
          <div key={group} className="mb-2">
            <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">{group}</p>
            {items.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setSection(id)}
                className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                  section === id
                    ? 'bg-accent/10 text-accent font-semibold border-l-2 border-accent'
                    : 'text-gray-700 hover:bg-gray-50 border-l-2 border-transparent'
                }`}>
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* Rechter Inhaltsbereich */}
      <div className="flex-1 overflow-y-auto p-8 bg-white">
        <div className="max-w-xl">
          <SectionComp />
        </div>
      </div>
    </div>
  );
}
