import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { User, PenLine, BellOff, Shield, Key, HardDrive, Trash2, ChevronDown, Loader2, Lock, Palette, Sun, Moon, Monitor, Check, ShieldCheck, ShieldOff, Copy, RefreshCw, AlertTriangle, } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../api/client.js';
import { useThemeStore, ACCENT_COLORS } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import toast from 'react-hot-toast';
// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtBytes(b) {
    if (b === 0)
        return '0 B';
    if (b < 1024)
        return `${b} B`;
    if (b < 1024 * 1024)
        return `${(b / 1024).toFixed(2)} KB`;
    if (b < 1024 * 1024 * 1024)
        return `${(b / 1024 / 1024).toFixed(2)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function today() { return new Date().toISOString().split('T')[0]; }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }
// Passwort-Stärke ─────────────────────────────────────────────────────────────
function getPasswordStrength(pw) {
    if (!pw)
        return { score: 0, label: '', colorClass: '' };
    let score = 0;
    if (pw.length >= 8)
        score++;
    if (pw.length >= 12)
        score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw))
        score++;
    if (/[0-9]/.test(pw))
        score++;
    if (/[^a-zA-Z0-9]/.test(pw))
        score++;
    const s = Math.min(score, 4);
    const labels = ['', 'Schwach', 'Mittel', 'Gut', 'Stark'];
    const colorClasses = ['', 'bg-red-500', 'bg-orange-400', 'bg-yellow-400', 'bg-green-500'];
    return { score: s, label: labels[s] ?? '', colorClass: colorClasses[s] ?? '' };
}
// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label }) {
    return (_jsxs("label", { className: "flex items-center gap-3 cursor-pointer select-none", children: [_jsx("button", { type: "button", role: "switch", "aria-checked": checked, onClick: () => onChange(!checked), className: `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${checked ? 'bg-accent' : 'bg-gray-300'}`, children: _jsx("span", { className: `inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}` }) }), _jsx("span", { className: "text-sm text-gray-800", children: label })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// PROFIL
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileSection() {
    const qc = useQueryClient();
    const { data } = useQuery({
        queryKey: ['user-profile'],
        queryFn: () => api.get('/user/profile'),
    });
    const [name, setName] = useState('');
    useEffect(() => { if (data?.displayName)
        setName(data.displayName); }, [data?.displayName]);
    const mutation = useMutation({
        mutationFn: () => api.put('/user/profile', { displayName: name }),
        onSuccess: () => { toast.success('Profil gespeichert'); void qc.invalidateQueries({ queryKey: ['user-profile'] }); },
        onError: (err) => toast.error(err.message),
    });
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "E-Mail-Konto" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "Kontoinformationen und Anzeigename" })] }), _jsxs("div", { className: "space-y-4 max-w-md", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "E-Mail-Adresse" }), _jsx("input", { className: "input bg-gray-50 text-gray-500 cursor-not-allowed", value: data?.email ?? '', disabled: true })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Anzeigename" }), _jsx("input", { className: "input", value: name, onChange: e => setName(e.target.value), placeholder: "Ihr Name" })] }), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? _jsxs(_Fragment, { children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), " Speichern\u2026"] }) : 'Speichern' })] })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// PASSWORT ÄNDERN
// ═══════════════════════════════════════════════════════════════════════════════
function PasswordSection() {
    const [currentPw, setCurrentPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const [showCurrent, setShowCurrent] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const strength = getPasswordStrength(newPw);
    const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
    const mutation = useMutation({
        mutationFn: () => api.post('/user/change-password', { currentPassword: currentPw, newPassword: newPw }),
        onSuccess: () => {
            toast.success('Passwort erfolgreich geändert');
            setCurrentPw('');
            setNewPw('');
            setConfirmPw('');
        },
        onError: (err) => toast.error(err.message),
    });
    const canSubmit = currentPw.length > 0 && newPw.length >= 8 && newPw === confirmPw && !mutation.isPending;
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Passwort \u00E4ndern" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "Legen Sie ein neues Passwort f\u00FCr Ihr Konto fest" })] }), _jsxs("div", { className: "space-y-4 max-w-md", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Aktuelles Passwort" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: showCurrent ? 'text' : 'password', className: "input pr-10", value: currentPw, onChange: e => setCurrentPw(e.target.value), placeholder: "Aktuelles Passwort eingeben", autoComplete: "current-password" }), _jsx("button", { type: "button", onClick: () => setShowCurrent(v => !v), className: "absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600", children: showCurrent ? _jsx(EyeOffIcon, {}) : _jsx(EyeIcon, {}) })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Neues Passwort" }), _jsxs("div", { className: "relative", children: [_jsx("input", { type: showNew ? 'text' : 'password', className: "input pr-10", value: newPw, onChange: e => setNewPw(e.target.value), placeholder: "Mindestens 8 Zeichen", autoComplete: "new-password" }), _jsx("button", { type: "button", onClick: () => setShowNew(v => !v), className: "absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600", children: showNew ? _jsx(EyeOffIcon, {}) : _jsx(EyeIcon, {}) })] }), newPw.length > 0 && (_jsxs("div", { className: "mt-2 space-y-1", children: [_jsx("div", { className: "flex gap-1", children: [1, 2, 3, 4].map(i => (_jsx("div", { className: `h-1.5 flex-1 rounded-full transition-colors ${i <= strength.score ? strength.colorClass : 'bg-gray-200'}` }, i))) }), strength.label && (_jsxs("p", { className: `text-xs font-medium ${strength.score <= 1 ? 'text-red-500'
                                            : strength.score === 2 ? 'text-orange-500'
                                                : strength.score === 3 ? 'text-yellow-600'
                                                    : 'text-green-600'}`, children: ["St\u00E4rke: ", strength.label] }))] }))] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Passwort best\u00E4tigen" }), _jsx("input", { type: "password", className: `input ${mismatch ? 'border-red-400 focus:border-red-400 focus:ring-red-200' : ''}`, value: confirmPw, onChange: e => setConfirmPw(e.target.value), placeholder: "Neues Passwort wiederholen", autoComplete: "new-password" }), mismatch && (_jsx("p", { className: "text-xs text-red-500 mt-1", children: "Die Passw\u00F6rter stimmen nicht \u00FCberein" }))] }), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: !canSubmit, children: mutation.isPending ? _jsxs(_Fragment, { children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), " Passwort \u00E4ndern\u2026"] }) : 'Passwort ändern' })] })] }));
}
// Minimale SVG-Icons für Passwort-Sichtbarkeit ───────────────────────────────
function EyeIcon() {
    return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }), _jsx("circle", { cx: "12", cy: "12", r: "3" })] }));
}
function EyeOffIcon() {
    return (_jsxs("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }), _jsx("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }), _jsx("line", { x1: "1", y1: "1", x2: "23", y2: "23" })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// DESIGN (THEME)
// ═══════════════════════════════════════════════════════════════════════════════
const THEME_OPTIONS = [
    { id: 'light', label: 'Hell', desc: 'Immer helles Design', icon: Sun },
    { id: 'dark', label: 'Dunkel', desc: 'Immer dunkles Design', icon: Moon },
    { id: 'system', label: 'System', desc: 'Folgt den Systemeinstellungen automatisch', icon: Monitor },
];
function ThemeSection() {
    const { theme, accentRgb, setTheme, setAccent } = useThemeStore();
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Design" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "Erscheinungsbild und Akzentfarbe des Webclients" })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-sm font-medium text-gray-700", children: "Farbschema" }), _jsx("div", { className: "grid grid-cols-3 gap-3 max-w-lg", children: THEME_OPTIONS.map(({ id, label, desc, icon: Icon }) => {
                            const active = theme === id;
                            return (_jsxs("button", { onClick: () => setTheme(id), className: `relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-left ${active
                                    ? 'border-accent bg-accent/5'
                                    : 'border-gray-200 hover:border-gray-300 bg-white'}`, children: [active && (_jsx("span", { className: "absolute top-2 right-2 w-5 h-5 bg-accent rounded-full flex items-center justify-center", children: _jsx(Check, { size: 11, className: "text-white", strokeWidth: 3 }) })), _jsxs("div", { className: `w-full h-14 rounded-lg overflow-hidden border ${id === 'dark' ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'}`, children: [_jsxs("div", { className: `h-4 ${id === 'dark' ? 'bg-gray-700' : 'bg-gray-100'} flex items-center gap-1 px-2`, children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${id === 'dark' ? 'bg-gray-500' : 'bg-gray-300'}` }), _jsx("span", { className: `w-8 h-1 rounded ${id === 'dark' ? 'bg-gray-500' : 'bg-gray-200'}` })] }), _jsxs("div", { className: "flex gap-1 p-1.5", children: [_jsx("span", { className: `w-8 h-6 rounded ${id === 'dark' ? 'bg-gray-700' : 'bg-gray-100'}` }), _jsx("span", { className: `flex-1 h-6 rounded ${id === 'dark' ? 'bg-gray-750' : 'bg-white'} border ${id === 'dark' ? 'border-gray-600' : 'border-gray-200'}` })] })] }), _jsxs("div", { className: "flex items-center gap-1.5 w-full", children: [_jsx(Icon, { size: 13, className: active ? 'text-accent' : 'text-gray-500' }), _jsx("span", { className: `text-xs font-semibold ${active ? 'text-accent' : 'text-gray-700'}`, children: label })] }), _jsx("p", { className: "text-[10px] text-gray-400 leading-tight w-full", children: desc })] }, id));
                        }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-sm font-medium text-gray-700", children: "Akzentfarbe" }), _jsx("div", { className: "flex flex-wrap gap-3", children: ACCENT_COLORS.map(({ name, hex, rgb }) => {
                            const active = accentRgb === rgb;
                            return (_jsx("button", { title: name, onClick: () => setAccent(rgb), className: `w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center ${active ? 'border-gray-800 scale-110 shadow-md' : 'border-transparent hover:scale-105'}`, style: { backgroundColor: hex }, children: active && _jsx(Check, { size: 14, className: "text-white", strokeWidth: 3 }) }, rgb));
                        }) }), _jsx("p", { className: "text-xs text-gray-400", children: "Die Akzentfarbe wird f\u00FCr Schaltfl\u00E4chen, Links und Markierungen verwendet." })] })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATUREN
// ═══════════════════════════════════════════════════════════════════════════════
function SignatureSection() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['user-signature'],
        queryFn: () => api.get('/user/signature'),
    });
    const [autoNew, setAutoNew] = useState(true);
    const [autoReply, setAutoReply] = useState(false);
    useEffect(() => {
        if (data) {
            setAutoNew(data.autoNew);
            setAutoReply(data.autoReply);
        }
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
    if (isLoading)
        return _jsx("div", { className: "flex justify-center py-12 text-gray-400", children: _jsx(Loader2, { size: 18, className: "animate-spin" }) });
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Signaturen" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "Wird automatisch an neue E-Mails angeh\u00E4ngt" })] }), _jsxs("div", { className: "border border-gray-200 rounded-lg overflow-hidden", children: [_jsx("div", { className: "flex items-center gap-1 px-3 py-2 border-b border-gray-200 bg-gray-50 flex-wrap", children: [
                            { label: 'B', cmd: () => editor?.chain().focus().toggleBold().run(), active: editor?.isActive('bold') },
                            { label: 'I', cmd: () => editor?.chain().focus().toggleItalic().run(), active: editor?.isActive('italic') },
                            { label: 'U', cmd: () => editor?.chain().focus().toggleStrike().run(), active: editor?.isActive('strike') },
                        ].map(({ label, cmd, active }) => (_jsx("button", { onMouseDown: e => { e.preventDefault(); cmd(); }, className: `w-7 h-7 text-xs font-semibold rounded transition-colors ${active ? 'bg-accent text-white' : 'hover:bg-gray-200 text-gray-700'}`, children: label }, label))) }), _jsx("div", { className: "px-3 py-3", children: _jsx(EditorContent, { editor: editor }) })] }), _jsxs("div", { className: "space-y-3 py-3 border-t border-gray-100", children: [_jsx("p", { className: "text-sm font-medium text-gray-700", children: "Signatur automatisch einf\u00FCgen" }), _jsx(Toggle, { checked: autoNew, onChange: setAutoNew, label: "Bei neuen E-Mails" }), _jsx(Toggle, { checked: autoReply, onChange: setAutoReply, label: "Bei Antworten und Weiterleitungen" })] }), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? _jsxs(_Fragment, { children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), " Speichern\u2026"] }) : 'Speichern' })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATISCHE ANTWORTEN (OOF)
// ═══════════════════════════════════════════════════════════════════════════════
function OofSection() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['user-oof'],
        queryFn: () => api.get('/user/oof'),
    });
    const [enabled, setEnabled] = useState(false);
    const [useTimeRange, setUseTimeRange] = useState(false);
    const [startDate, setStartDate] = useState(today());
    const [startTime, setStartTime] = useState('08:00');
    const [endDate, setEndDate] = useState(tomorrow());
    const [endTime, setEndTime] = useState('18:00');
    const [internalMsg, setInternalMsg] = useState('');
    const [externalEnabled, setExternalEnabled] = useState(true);
    const [externalOnlyContacts, setExternalOnlyContacts] = useState(false);
    const [externalMsg, setExternalMsg] = useState('');
    useEffect(() => {
        if (!data)
            return;
        setEnabled(data.enabled);
        setUseTimeRange(data.useTimeRange);
        setInternalMsg(data.internalMessage);
        setExternalEnabled(data.externalEnabled);
        setExternalOnlyContacts(data.externalOnlyContacts);
        setExternalMsg(data.externalMessage);
        if (data.startDate) {
            const d = new Date(data.startDate);
            setStartDate(d.toISOString().split('T')[0]);
            setStartTime(d.toTimeString().slice(0, 5));
        }
        if (data.endDate) {
            const d = new Date(data.endDate);
            setEndDate(d.toISOString().split('T')[0]);
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
                endDate: `${endDate}T${endTime}:00`,
            } : {}),
        }),
        onSuccess: () => { toast.success('Automatische Antworten gespeichert'); void qc.invalidateQueries({ queryKey: ['user-oof'] }); },
        onError: () => toast.error('Fehler beim Speichern'),
    });
    const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    if (isLoading)
        return _jsx("div", { className: "flex justify-center py-12 text-gray-400", children: _jsx(Loader2, { size: 18, className: "animate-spin" }) });
    return (_jsxs("div", { className: "space-y-5 max-w-xl", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Automatische Antworten" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5 leading-relaxed", children: "Verwenden Sie automatische Antworten, um anderen mitzuteilen, dass Sie im Urlaub sind oder Ihre E-Mails zurzeit nicht beantworten k\u00F6nnen. Sie k\u00F6nnen festlegen, dass Ihre Antworten an einem bestimmten Zeitpunkt beginnen und enden. Andernfalls bleiben sie aktiviert, bis Sie sie deaktivieren." })] }), _jsx(Toggle, { checked: enabled, onChange: setEnabled, label: "Automatische Antworten aktivieren" }), enabled && (_jsxs("div", { className: "space-y-5 pl-1", children: [_jsxs("div", { className: "space-y-3", children: [_jsxs("label", { className: "flex items-center gap-2.5 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: useTimeRange, onChange: e => setUseTimeRange(e.target.checked), className: "w-4 h-4 accent-accent rounded" }), _jsx("span", { className: "text-sm text-gray-700", children: "Antworten nur in einem bestimmten Zeitraum senden" })] }), _jsxs("div", { className: `space-y-2 pl-6 ${!useTimeRange ? 'opacity-40 pointer-events-none' : ''}`, children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-sm text-gray-600 w-16", children: "Startzeit" }), _jsx("input", { type: "date", value: startDate, onChange: e => setStartDate(e.target.value), className: "input text-sm w-36" }), _jsxs("div", { className: "relative", children: [_jsx("select", { value: startTime, onChange: e => setStartTime(e.target.value), className: "input text-sm pr-8 appearance-none w-28", children: HOURS.map(h => _jsx("option", { value: h, children: h }, h)) }), _jsx(ChevronDown, { size: 14, className: "absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" })] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-sm text-gray-600 w-16", children: "Endzeit" }), _jsx("input", { type: "date", value: endDate, onChange: e => setEndDate(e.target.value), className: "input text-sm w-36" }), _jsxs("div", { className: "relative", children: [_jsx("select", { value: endTime, onChange: e => setEndTime(e.target.value), className: "input text-sm pr-8 appearance-none w-28", children: HOURS.map(h => _jsx("option", { value: h, children: h }, h)) }), _jsx(ChevronDown, { size: 14, className: "absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" })] })] }), useTimeRange && (_jsx("p", { className: "text-xs text-accent pl-0", children: "Der Zeitraum wird als Abwesenheitstermin in Ihrem Kalender eingetragen." }))] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-sm font-medium text-gray-700", children: "Antwort an Personen innerhalb Ihrer Organisation" }), _jsx("textarea", { value: internalMsg, onChange: e => setInternalMsg(e.target.value), rows: 4, className: "input resize-none text-sm", placeholder: "Ich bin momentan nicht erreichbar und antworte Ihrer Nachricht so schnell wie m\u00F6glich." })] }), _jsxs("div", { className: "space-y-3 pt-1", children: [_jsxs("label", { className: "flex items-center gap-2.5 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: externalEnabled, onChange: e => setExternalEnabled(e.target.checked), className: "w-4 h-4 accent-accent rounded" }), _jsx("span", { className: "text-sm text-gray-700", children: "Antworten an Personen au\u00DFerhalb Ihrer Organisation senden" })] }), _jsxs("div", { className: `pl-6 space-y-3 ${!externalEnabled ? 'opacity-40 pointer-events-none' : ''}`, children: [_jsxs("label", { className: "flex items-center gap-2.5 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: externalOnlyContacts, onChange: e => setExternalOnlyContacts(e.target.checked), className: "w-4 h-4 accent-accent rounded" }), _jsx("span", { className: "text-sm text-gray-700", children: "Antworten nur an Kontakte senden" })] }), _jsx("textarea", { value: externalMsg, onChange: e => setExternalMsg(e.target.value), rows: 4, className: "input resize-none text-sm", placeholder: "Ich bin momentan im Urlaub und nicht erreichbar." })] })] })] })), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? _jsxs(_Fragment, { children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), " Speichern\u2026"] }) : 'Speichern' })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// SPEICHER
// ═══════════════════════════════════════════════════════════════════════════════
const FOLDER_COLORS = {
    INBOX: '#3b82f6',
    Sent: '#f59e0b',
    Trash: '#6b7280',
    Junk: '#eab308',
    Drafts: '#8b5cf6',
    Archive: '#10b981',
};
const FALLBACK_COLORS = ['#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#a78bfa'];
const FOLDER_ICON_MAP = {
    INBOX: () => _jsx("span", { className: "text-gray-400", children: "\uD83D\uDCE5" }),
    Trash: Trash2,
    Junk: () => _jsx("span", { className: "text-gray-400", children: "\u26A0\uFE0F" }),
};
function StorageSection() {
    const qc = useQueryClient();
    const [confirming, setConfirming] = useState(null);
    const { data, isLoading, refetch } = useQuery({
        queryKey: ['user-storage'],
        queryFn: () => api.get('/user/storage'),
    });
    const emptyMut = useMutation({
        mutationFn: (folderId) => api.delete(`/user/folders/${folderId}/empty`),
        onSuccess: () => {
            toast.success('Ordner geleert');
            setConfirming(null);
            void refetch();
            void qc.invalidateQueries({ queryKey: ['folders'] });
        },
        onError: () => toast.error('Fehler beim Leeren'),
    });
    if (isLoading)
        return _jsx("div", { className: "flex justify-center py-12 text-gray-400", children: _jsx(Loader2, { size: 18, className: "animate-spin" }) });
    const quota = data?.quotaBytes ?? 0;
    const used = data?.usedBytes ?? 0;
    const pct = quota > 0 ? Math.min((used / quota) * 100, 100) : 0;
    const folders = data?.folders ?? [];
    // Farbe pro Ordner
    const colorFor = (name, idx) => FOLDER_COLORS[name] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
    const FOLDER_DISPLAY = {
        INBOX: 'Posteingang',
        Drafts: 'Entwürfe',
        Sent: 'Gesendete Elemente',
        Trash: 'Gelöschte Elemente',
        Junk: 'Junk-E-Mail',
        Archive: 'Archiv',
    };
    return (_jsxs("div", { className: "space-y-6 max-w-2xl", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Speicher" }), _jsxs("p", { className: "text-sm text-gray-500 mt-0.5", children: ["Sie haben ", fmtBytes(quota), " E-Mail-Speicher mit diesem Konto, das Anlagen und Nachrichten in allen Ordnern umfasst."] })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("p", { className: "text-sm text-gray-700", children: [_jsx("span", { className: "font-medium", children: fmtBytes(used) }), " von ", _jsx("span", { className: "font-medium", children: fmtBytes(quota) }), ' ', "(", _jsxs("span", { className: "font-medium", children: [pct.toFixed(1), "%"] }), ") verwendet"] }), _jsx("div", { className: "h-4 w-full bg-gray-100 rounded-full overflow-hidden flex", children: folders.map((f, i) => {
                            const w = quota > 0 ? (f.sizeBytes / quota) * 100 : 0;
                            if (w < 0.5)
                                return null;
                            return (_jsx("div", { title: `${FOLDER_DISPLAY[f.name] ?? f.displayName}: ${fmtBytes(f.sizeBytes)}`, style: { width: `${w}%`, backgroundColor: colorFor(f.name, i) }, className: "h-full transition-all" }, f.id));
                        }) }), _jsx("div", { className: "flex flex-wrap gap-x-4 gap-y-1 mt-1", children: folders.filter(f => f.sizeBytes > 0).map((f, i) => (_jsxs("div", { className: "flex items-center gap-1.5 text-xs text-gray-600", children: [_jsx("span", { className: "w-3 h-3 rounded-sm shrink-0", style: { backgroundColor: colorFor(f.name, i) } }), FOLDER_DISPLAY[f.name] ?? f.displayName] }, f.id))) })] }), _jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-gray-900 mb-1", children: "Speicher verwalten" }), _jsx("p", { className: "text-xs text-gray-500 mb-3", children: "Wenn Sie Inhalte aus einem Ordner leeren, k\u00F6nnen Sie Speicherplatz freigeben. Elemente werden endg\u00FCltig gel\u00F6scht." }), folders.length === 0 ? (_jsx("p", { className: "text-sm text-gray-400 py-4", children: "Keine Daten verf\u00FCgbar." })) : (_jsx("div", { className: "border border-gray-200 rounded-lg overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Ordner" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Gr\u00F6\u00DFe" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Nachrichten" }), _jsx("th", { className: "text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Verwalten" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: folders.map((f, i) => {
                                        const FIcon = FOLDER_ICON_MAP[f.name] ?? Trash2;
                                        const isConfirming = confirming === f.id;
                                        const displayName = FOLDER_DISPLAY[f.name] ?? f.displayName;
                                        return (_jsxs("tr", { className: "hover:bg-gray-50", children: [_jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { style: { color: colorFor(f.name, i) }, children: _jsx(FIcon, { size: 14 }) }), _jsx("span", { className: "text-gray-800", children: displayName })] }) }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: fmtBytes(f.sizeBytes) }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: f.messageCount.toLocaleString() }), _jsx("td", { className: "px-4 py-3 text-right", children: isConfirming ? (_jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx("span", { className: "text-xs text-gray-500", children: "Sicher?" }), _jsx("button", { onClick: () => emptyMut.mutate(f.id), disabled: emptyMut.isPending, className: "px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 transition-colors", children: emptyMut.isPending ? '…' : 'Ja, leeren' }), _jsx("button", { onClick: () => setConfirming(null), className: "px-2 py-1 text-xs text-gray-600 hover:text-gray-800", children: "Abbrechen" })] })) : (_jsxs("button", { onClick: () => setConfirming(f.id), className: "flex items-center gap-1.5 ml-auto px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50 hover:text-red-600 hover:border-red-300 transition-colors", children: [_jsx(Trash2, { size: 12 }), "Leeren", _jsx(ChevronDown, { size: 11, className: "text-gray-400" })] })) })] }, f.id));
                                    }) })] }) }))] })] }));
}
// Auth-Fetch-Helper für /auth/* Routen (außerhalb von /api/v1/)
async function authFetch(path, init = {}) {
    const token = useAuthStore.getState().accessToken ?? '';
    const isGet = !init.method || init.method === 'GET';
    const res = await fetch(path, {
        ...init,
        headers: {
            ...(isGet ? {} : { 'Content-Type': 'application/json' }),
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
}
function SecuritySection() {
    const qc = useQueryClient();
    const [totpStep, setTotpStep] = useState('idle');
    const [setupData, setSetupData] = useState(null);
    const [confirmDigits, setConfirmDigits] = useState(['', '', '', '', '', '']);
    const [confirmError, setConfirmError] = useState('');
    const [backupCodes, setBackupCodes] = useState(null);
    const digitRefs = useRef([]);
    const { data: mfaStatus, isLoading: statusLoading } = useQuery({
        queryKey: ['mfa-status'],
        queryFn: () => authFetch('/auth/mfa/status'),
        staleTime: 0,
    });
    const setupMutation = useMutation({
        mutationFn: () => authFetch('/auth/mfa/totp/setup', { method: 'POST' }),
        onSuccess: (data) => {
            setSetupData(data);
            setTotpStep('setup');
        },
        onError: (e) => toast.error(e.message),
    });
    const confirmMutation = useMutation({
        mutationFn: (code) => authFetch('/auth/mfa/totp/confirm', {
            method: 'POST',
            body: JSON.stringify({ code }),
        }),
        onSuccess: async () => {
            const data = await authFetch('/auth/mfa/backup-codes/generate', { method: 'POST' });
            setBackupCodes(data.codes);
            setTotpStep('done');
            void qc.invalidateQueries({ queryKey: ['mfa-status'] });
        },
        onError: (e) => {
            setConfirmError(e.message);
            setConfirmDigits(['', '', '', '', '', '']);
            setTimeout(() => digitRefs.current[0]?.focus(), 50);
        },
    });
    const disableMutation = useMutation({
        mutationFn: () => authFetch('/auth/mfa/totp', { method: 'DELETE' }),
        onSuccess: () => {
            toast.success('2FA wurde deaktiviert');
            setTotpStep('idle');
            setSetupData(null);
            setBackupCodes(null);
            void qc.invalidateQueries({ queryKey: ['mfa-status'] });
        },
        onError: (e) => toast.error(e.message),
    });
    const regenBackupMutation = useMutation({
        mutationFn: () => authFetch('/auth/mfa/backup-codes/generate', { method: 'POST' }),
        onSuccess: (data) => {
            setBackupCodes(data.codes);
            toast.success('Neue Backup-Codes generiert');
            void qc.invalidateQueries({ queryKey: ['mfa-status'] });
        },
        onError: (e) => toast.error(e.message),
    });
    // OTP digit helpers
    const handleDigitChange = (i, val) => {
        const digit = val.replace(/\D/g, '').slice(-1);
        const next = [...confirmDigits];
        next[i] = digit;
        setConfirmDigits(next);
        if (digit && i < 5)
            digitRefs.current[i + 1]?.focus();
    };
    const handleDigitKeyDown = (i, e) => {
        if (e.key === 'Backspace' && !confirmDigits[i] && i > 0)
            digitRefs.current[i - 1]?.focus();
    };
    const handleDigitPaste = (e) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        if (pasted.length === 6) {
            e.preventDefault();
            setConfirmDigits(pasted.split(''));
            digitRefs.current[5]?.focus();
        }
    };
    const copySecret = () => {
        if (setupData?.secret) {
            void navigator.clipboard.writeText(setupData.secret);
            toast.success('Secret kopiert');
        }
    };
    const copyBackupCodes = () => {
        if (backupCodes) {
            void navigator.clipboard.writeText(backupCodes.join('\n'));
            toast.success('Backup-Codes kopiert');
        }
    };
    return (_jsxs("div", { className: "space-y-5 max-w-lg", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Sicherheit" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "App-Passw\u00F6rter und Zwei-Faktor-Authentifizierung" })] }), _jsxs("div", { className: "bg-gray-50 border border-gray-200 rounded-lg p-4", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Key, { size: 15, className: "text-gray-400" }), _jsx("span", { className: "text-sm font-medium", children: "App-Passw\u00F6rter" })] }), _jsx("p", { className: "text-xs text-gray-500 mb-3", children: "F\u00FCr E-Mail-Clients (Outlook, Thunderbird) ohne Hauptpasswort verbinden." }), _jsx("a", { href: "/auth/app-passwords", target: "_blank", rel: "noopener noreferrer", className: "btn-secondary text-xs", children: "App-Passw\u00F6rter verwalten" })] }), _jsxs("div", { className: "bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Shield, { size: 15, className: "text-gray-400" }), _jsx("span", { className: "text-sm font-medium", children: "Zwei-Faktor-Authentifizierung (TOTP)" })] }), statusLoading ? (_jsx(Loader2, { size: 14, className: "animate-spin text-gray-400" })) : mfaStatus?.totpEnabled ? (_jsxs("span", { className: "flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full", children: [_jsx(ShieldCheck, { size: 12 }), " Aktiv"] })) : (_jsxs("span", { className: "flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full", children: [_jsx(ShieldOff, { size: 12 }), " Inaktiv"] }))] }), !mfaStatus?.totpEnabled && totpStep === 'idle' && (_jsxs(_Fragment, { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Sch\u00FCtzen Sie Ihr Konto mit einer Authenticator-App (z.B. Google Authenticator, Authy, Microsoft Authenticator)." }), _jsxs("button", { onClick: () => setupMutation.mutate(), disabled: setupMutation.isPending, className: "btn-primary text-xs flex items-center gap-1.5", children: [setupMutation.isPending ? _jsx(Loader2, { size: 13, className: "animate-spin" }) : _jsx(ShieldCheck, { size: 13 }), "2FA einrichten"] })] })), totpStep === 'setup' && setupData && (_jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-xs text-gray-600 font-medium", children: "1. Scannen Sie den QR-Code mit Ihrer Authenticator-App:" }), _jsx("div", { className: "flex justify-center", children: _jsx("img", { src: setupData.qrCodeDataUrl, alt: "TOTP QR Code", className: "w-40 h-40 border border-gray-200 rounded" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500 mb-1", children: "Oder geben Sie den Secret-Schl\u00FCssel manuell ein:" }), _jsxs("div", { className: "flex items-center gap-2 bg-white border border-gray-200 rounded px-3 py-1.5", children: [_jsx("code", { className: "text-xs font-mono text-gray-700 flex-1 select-all break-all", children: setupData.secret }), _jsx("button", { onClick: copySecret, className: "text-gray-400 hover:text-gray-600 shrink-0", children: _jsx(Copy, { size: 13 }) })] })] }), _jsx("button", { onClick: () => { setTotpStep('confirm'); setTimeout(() => digitRefs.current[0]?.focus(), 50); }, className: "btn-primary text-xs", children: "Weiter \u2192 Code eingeben" })] })), totpStep === 'confirm' && (_jsxs("div", { className: "space-y-3", children: [_jsx("p", { className: "text-xs text-gray-600 font-medium", children: "2. Geben Sie den 6-stelligen Code aus Ihrer App ein:" }), _jsx("div", { className: "flex gap-2", onPaste: handleDigitPaste, children: confirmDigits.map((d, i) => (_jsx("input", { ref: (el) => { digitRefs.current[i] = el; }, type: "text", inputMode: "numeric", maxLength: 1, value: d, onChange: (e) => handleDigitChange(i, e.target.value), onKeyDown: (e) => handleDigitKeyDown(i, e), className: "w-9 h-11 text-center text-lg font-bold border-2 rounded-lg focus:outline-none focus:border-accent transition-colors", style: { borderColor: d ? 'var(--color-accent)' : undefined } }, i))) }), confirmError && (_jsxs("p", { className: "text-xs text-red-600 flex items-center gap-1", children: [_jsx(AlertTriangle, { size: 12 }), " ", confirmError] })), _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => confirmMutation.mutate(confirmDigits.join('')), disabled: confirmMutation.isPending || confirmDigits.join('').length < 6, className: "btn-primary text-xs flex items-center gap-1.5", children: [confirmMutation.isPending ? _jsx(Loader2, { size: 13, className: "animate-spin" }) : _jsx(Check, { size: 13 }), "Best\u00E4tigen"] }), _jsx("button", { onClick: () => { setTotpStep('setup'); setConfirmError(''); setConfirmDigits(['', '', '', '', '', '']); }, className: "btn-secondary text-xs", children: "Zur\u00FCck" })] })] })), totpStep === 'done' && backupCodes && (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-green-700 text-sm font-medium", children: [_jsx(ShieldCheck, { size: 16 }), " 2FA erfolgreich aktiviert!"] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-600 font-medium mb-1", children: "Backup-Codes (je einmalig verwendbar):" }), _jsx("p", { className: "text-xs text-gray-500 mb-2", children: "Speichern Sie diese Codes sicher. Sie k\u00F6nnen damit bei verlorenem Ger\u00E4t einloggen." }), _jsx("div", { className: "grid grid-cols-2 gap-1 bg-white border border-gray-200 rounded p-3 font-mono text-xs", children: backupCodes.map((c, i) => _jsx("span", { className: "text-gray-700", children: c }, i)) }), _jsxs("button", { onClick: copyBackupCodes, className: "mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700", children: [_jsx(Copy, { size: 11 }), " Alle kopieren"] })] }), _jsx("button", { onClick: () => setTotpStep('idle'), className: "btn-secondary text-xs", children: "Fertig" })] })), mfaStatus?.totpEnabled && totpStep === 'idle' && (_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "grid grid-cols-2 gap-3 text-xs text-gray-600", children: _jsxs("div", { className: "bg-white border border-gray-200 rounded p-2 text-center", children: [_jsx("p", { className: "font-semibold text-base text-gray-900", children: mfaStatus.backupCodesCount }), _jsx("p", { children: "Backup-Codes verbleibend" })] }) }), _jsxs("div", { className: "flex gap-2 flex-wrap", children: [_jsxs("button", { onClick: () => regenBackupMutation.mutate(), disabled: regenBackupMutation.isPending, className: "btn-secondary text-xs flex items-center gap-1.5", children: [regenBackupMutation.isPending ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : _jsx(RefreshCw, { size: 12 }), "Backup-Codes neu generieren"] }), _jsxs("button", { onClick: () => { if (confirm('2FA wirklich deaktivieren?'))
                                            disableMutation.mutate(); }, disabled: disableMutation.isPending, className: "text-xs flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50", children: [disableMutation.isPending ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : _jsx(ShieldOff, { size: 12 }), "2FA deaktivieren"] })] }), regenBackupMutation.data?.codes && (_jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-600 font-medium mb-1", children: "Neue Backup-Codes:" }), _jsx("div", { className: "grid grid-cols-2 gap-1 bg-white border border-gray-200 rounded p-3 font-mono text-xs", children: regenBackupMutation.data.codes.map((c, i) => _jsx("span", { className: "text-gray-700", children: c }, i)) }), _jsxs("button", { onClick: () => { void navigator.clipboard.writeText((regenBackupMutation.data?.codes ?? []).join('\n')); toast.success('Kopiert'); }, className: "mt-1 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700", children: [_jsx(Copy, { size: 11 }), " Alle kopieren"] })] }))] }))] })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
const NAV = [
    {
        group: 'Konto',
        items: [
            { id: 'profile', label: 'E-Mail-Konto', icon: User },
            { id: 'password', label: 'Passwort', icon: Lock },
            { id: 'oof', label: 'Automatische Antworten', icon: BellOff },
            { id: 'signature', label: 'Signaturen', icon: PenLine },
            { id: 'storage', label: 'Speicher', icon: HardDrive },
        ],
    },
    {
        group: 'Allgemein',
        items: [
            { id: 'theme', label: 'Design', icon: Palette },
            { id: 'security', label: 'Sicherheit', icon: Shield },
        ],
    },
];
const SECTION_MAP = {
    profile: ProfileSection,
    password: PasswordSection,
    oof: OofSection,
    signature: SignatureSection,
    storage: StorageSection,
    theme: ThemeSection,
    security: SecuritySection,
};
// ═══════════════════════════════════════════════════════════════════════════════
// HAUPT-EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
export function SettingsPage() {
    const [section, setSection] = useState('profile');
    const SectionComp = SECTION_MAP[section];
    return (_jsxs("div", { className: "flex flex-1 overflow-hidden bg-white", children: [_jsx("aside", { className: "w-56 shrink-0 border-r border-gray-200 pt-4 bg-white overflow-y-auto", children: NAV.map(({ group, items }) => (_jsxs("div", { className: "mb-2", children: [_jsx("p", { className: "px-4 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: group }), items.map(({ id, label, icon: Icon }) => (_jsxs("button", { onClick: () => setSection(id), className: `w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${section === id
                                ? 'bg-accent/10 text-accent font-semibold border-l-2 border-accent'
                                : 'text-gray-700 hover:bg-gray-50 border-l-2 border-transparent'}`, children: [_jsx(Icon, { size: 14 }), label] }, id)))] }, group))) }), _jsx("div", { className: "flex-1 overflow-y-auto p-8 bg-white", children: _jsx("div", { className: "max-w-xl", children: _jsx(SectionComp, {}) }) })] }));
}
