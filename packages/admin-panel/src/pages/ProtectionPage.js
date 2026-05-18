import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, Zap, Bug, Database, Clock, Globe, Paperclip, CheckCircle, XCircle, RefreshCw, Plus, Trash2, AlertTriangle, } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
const SUB_NAV = [
    { id: 'overview', label: 'Übersicht', icon: LayoutDashboard },
    { id: 'rspamd', label: 'Rspamd 4.0', icon: Zap },
    { id: 'antivirus', label: 'Antivirus', icon: Bug },
    { id: 'dnsbl', label: 'DNSBL', icon: Database },
    { id: 'greylisting', label: 'Greylisting', icon: Clock },
    { id: 'geoip', label: 'Länderfilter', icon: Globe },
    { id: 'attachments', label: 'Anhänge', icon: Paperclip },
];
// ── Helper: online badge ───────────────────────────────────────────────────────
function OnlineBadge({ online }) {
    return (_jsxs("span", { className: `inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${online ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`, children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${online ? 'bg-green-500' : 'bg-red-500'}` }), online ? 'Online' : 'Offline'] }));
}
// ── Helper: section save button ───────────────────────────────────────────────
function SaveBtn({ onClick, pending }) {
    return (_jsx("button", { onClick: onClick, disabled: pending, className: "btn-primary text-sm disabled:opacity-50", children: pending ? 'Speichern...' : 'Speichern' }));
}
// ── Helper: number input ──────────────────────────────────────────────────────
function NumInput({ label, value, onChange, min, max, step = 1, unit }) {
    return (_jsxs("div", { className: "flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0", children: [_jsx("span", { className: "text-sm text-gray-700", children: label }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("input", { type: "number", min: min, max: max, step: step, value: value, onChange: e => onChange(parseFloat(e.target.value) || min), className: "w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent" }), unit && _jsx("span", { className: "text-xs text-gray-400 w-8", children: unit })] })] }));
}
// ── Helper: toggle row ────────────────────────────────────────────────────────
function ToggleRow({ label, desc, value, onChange }) {
    return (_jsxs("div", { className: "flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-800 font-medium", children: label }), desc && _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: desc })] }), _jsx(Toggle, { active: value, onToggle: () => onChange(!value) })] }));
}
// ── COUNTRIES list (ISO 3166-1 alpha-2 + German names) ────────────────────────
const COUNTRIES = [
    ['AF', 'Afghanistan'], ['AL', 'Albanien'], ['DZ', 'Algerien'], ['AD', 'Andorra'], ['AO', 'Angola'],
    ['AR', 'Argentinien'], ['AM', 'Armenien'], ['AU', 'Australien'], ['AT', 'Österreich'], ['AZ', 'Aserbaidschan'],
    ['BD', 'Bangladesch'], ['BY', 'Belarus'], ['BE', 'Belgien'], ['BO', 'Bolivien'], ['BA', 'Bosnien und Herzegowina'],
    ['BR', 'Brasilien'], ['BG', 'Bulgarien'], ['CN', 'China'], ['CL', 'Chile'], ['CO', 'Kolumbien'],
    ['HR', 'Kroatien'], ['CY', 'Zypern'], ['CZ', 'Tschechien'], ['DK', 'Dänemark'], ['EG', 'Ägypten'],
    ['EE', 'Estland'], ['FI', 'Finnland'], ['FR', 'Frankreich'], ['GE', 'Georgien'], ['DE', 'Deutschland'],
    ['GH', 'Ghana'], ['GR', 'Griechenland'], ['GT', 'Guatemala'], ['HU', 'Ungarn'], ['IN', 'Indien'],
    ['ID', 'Indonesien'], ['IR', 'Iran'], ['IQ', 'Irak'], ['IE', 'Irland'], ['IL', 'Israel'],
    ['IT', 'Italien'], ['JP', 'Japan'], ['KZ', 'Kasachstan'], ['KE', 'Kenia'], ['KR', 'Südkorea'],
    ['XK', 'Kosovo'], ['KW', 'Kuwait'], ['KG', 'Kirgisistan'], ['LV', 'Lettland'], ['LB', 'Libanon'],
    ['LT', 'Litauen'], ['LU', 'Luxemburg'], ['MK', 'Nordmazedonien'], ['MY', 'Malaysia'], ['ML', 'Mali'],
    ['MT', 'Malta'], ['MX', 'Mexiko'], ['MD', 'Moldau'], ['ME', 'Montenegro'], ['MA', 'Marokko'],
    ['NL', 'Niederlande'], ['NZ', 'Neuseeland'], ['NG', 'Nigeria'], ['NO', 'Norwegen'], ['PK', 'Pakistan'],
    ['PE', 'Peru'], ['PH', 'Philippinen'], ['PL', 'Polen'], ['PT', 'Portugal'], ['RO', 'Rumänien'],
    ['RU', 'Russland'], ['SA', 'Saudi-Arabien'], ['RS', 'Serbien'], ['SK', 'Slowakei'], ['SI', 'Slowenien'],
    ['ZA', 'Südafrika'], ['ES', 'Spanien'], ['SE', 'Schweden'], ['CH', 'Schweiz'], ['TW', 'Taiwan'],
    ['TJ', 'Tadschikistan'], ['TH', 'Thailand'], ['TR', 'Türkei'], ['TM', 'Turkmenistan'], ['UA', 'Ukraine'],
    ['AE', 'Vereinigte Arabische Emirate'], ['GB', 'Vereinigtes Königreich'], ['US', 'USA'],
    ['UZ', 'Usbekistan'], ['VN', 'Vietnam'], ['YE', 'Jemen'], ['ZW', 'Simbabwe'],
];
// ═════════════════════════════════════════════════════════════════════════════
// OverviewSection
// ═════════════════════════════════════════════════════════════════════════════
function OverviewSection() {
    const qc = useQueryClient();
    const { data: status, isLoading, dataUpdatedAt } = useQuery({
        queryKey: ['admin', 'security', 'status'],
        queryFn: () => api.get('/admin/security/status'),
        refetchInterval: 30_000,
    });
    const r = status?.rspamd;
    const c = status?.clamav;
    const stat = r?.stat;
    function fmtUptime(sec) {
        if (!sec)
            return '—';
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
        return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Container-Status" }), _jsxs("button", { onClick: () => qc.invalidateQueries({ queryKey: ['admin', 'security', 'status'] }), className: "btn-ghost text-xs gap-1", children: [_jsx(RefreshCw, { size: 13, className: isLoading ? 'animate-spin' : '' }), "Aktualisieren"] })] }), dataUpdatedAt > 0 && (_jsxs("p", { className: "text-xs text-gray-400", children: ["Zuletzt aktualisiert: ", new Date(dataUpdatedAt).toLocaleTimeString('de-DE')] })), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center", children: _jsx(Zap, { size: 16, className: "text-purple-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: "Rspamd" }), _jsxs("p", { className: "text-xs text-gray-400", children: [stat?.version ?? 'v4.0', " \u00B7 Anti-Spam"] })] })] }), isLoading ? _jsx("span", { className: "text-xs text-gray-400", children: "\u2026" }) : _jsx(OnlineBadge, { online: !!r?.online })] }), r?.online && stat && (_jsxs("div", { className: "grid grid-cols-3 gap-2 pt-1 border-t border-gray-100", children: [_jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-lg font-bold text-gray-900", children: (stat.scanned ?? 0).toLocaleString() }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Gescannt" })] }), _jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-lg font-bold text-red-600", children: (stat.spam_count ?? 0).toLocaleString() }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Spam" })] }), _jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-lg font-bold text-green-600", children: (stat.ham_count ?? 0).toLocaleString() }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Ham" })] })] })), r?.online && stat?.uptime !== undefined && (_jsxs("p", { className: "text-xs text-gray-400 border-t border-gray-100 pt-2", children: ["Uptime: ", fmtUptime(stat.uptime)] })), !r?.online && r?.error && (_jsxs("p", { className: "text-xs text-red-500 flex items-center gap-1", children: [_jsx(AlertTriangle, { size: 11 }), " ", r.error] }))] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center", children: _jsx(Bug, { size: 16, className: "text-emerald-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: "ClamAV" }), _jsx("p", { className: "text-xs text-gray-400", children: "Open-Source Antivirus" })] })] }), isLoading ? _jsx("span", { className: "text-xs text-gray-400", children: "\u2026" }) : _jsx(OnlineBadge, { online: !!c?.online })] }), c?.online && c.version && (_jsx("div", { className: "pt-1 border-t border-gray-100", children: _jsx("p", { className: "text-xs text-gray-600 font-mono bg-gray-50 rounded px-2 py-1 break-all", children: c.version }) })), !c?.online && c?.error && (_jsxs("p", { className: "text-xs text-red-500 flex items-center gap-1", children: [_jsx(AlertTriangle, { size: 11 }), " ", c.error] })), c?.online && (_jsx("p", { className: "text-xs text-gray-400 border-t border-gray-100 pt-2", children: "Signaturdatenbank wird t\u00E4glich aktualisiert (freshclam)" }))] })] }), _jsxs("div", { className: "card overflow-hidden", children: [_jsx("div", { className: "px-4 py-2.5 bg-gray-50 border-b border-gray-200", children: _jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktive Schutzma\u00DFnahmen" }) }), _jsx("table", { className: "w-full text-sm", children: _jsx("tbody", { className: "divide-y divide-gray-100", children: [
                                { label: 'SPF-Prüfung', ok: true, note: 'Sender Policy Framework' },
                                { label: 'DKIM-Validierung', ok: true, note: 'DomainKeys Identified Mail' },
                                { label: 'DMARC-Auswertung', ok: true, note: 'Domain-based Message Authentication' },
                                { label: 'ARC-Validierung', ok: true, note: 'Authenticated Received Chain' },
                                { label: 'Anti-Spam (Rspamd)', ok: !!r?.online, note: r?.online ? `v${stat?.version ?? '4.0'} aktiv` : 'Container nicht erreichbar' },
                                { label: 'Antivirus (ClamAV)', ok: !!c?.online, note: c?.online ? 'Signaturen aktuell' : 'Container nicht erreichbar' },
                                { label: 'Greylisting', ok: true, note: '5 min Wartezeit für Erstverbindungen' },
                                { label: 'DNSBL (Spamhaus ZEN)', ok: true, note: 'zen.spamhaus.org' },
                                { label: 'DNSBL (SpamCop)', ok: true, note: 'bl.spamcop.net' },
                                { label: 'Attachment-Filter', ok: true, note: 'Gefährliche Dateitypen blockiert' },
                            ].map(f => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-2.5 font-medium text-gray-800 w-48", children: f.label }), _jsx("td", { className: "px-4 py-2.5 text-gray-400 text-xs", children: f.note }), _jsx("td", { className: "px-4 py-2.5 text-right pr-5", children: f.ok
                                            ? _jsx(CheckCircle, { size: 16, className: "text-green-500 ml-auto" })
                                            : _jsx(XCircle, { size: 16, className: "text-red-400  ml-auto" }) })] }, f.label))) }) })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// RspamdSection
// ═════════════════════════════════════════════════════════════════════════════
function RspamdSection({ settings, onSave }) {
    // Thresholds
    const [enabled, setEnabled] = useState(settings.rspamdEnabled);
    const [greylist, setGreylist] = useState(settings.rspamdGreylistScore);
    const [spam, setSpam] = useState(settings.rspamdSpamScore);
    const [reject, setReject] = useState(settings.rspamdRejectScore);
    // Autolearn
    const [autolearn, setAutolearn] = useState(settings.rspamdAutolearn);
    const [autolearnSpam, setAutolearnSpam] = useState(settings.rspamdAutolearnSpam);
    const [autolearnHam, setAutolearnHam] = useState(settings.rspamdAutolearnHam);
    // Header
    const [addSpamHeader, setAddSpamHeader] = useState(settings.rspamdAddSpamHeader);
    const [extendedHeaders, setExtendedHeaders] = useState(settings.rspamdExtendedHeaders);
    const [rewriteSubject, setRewriteSubject] = useState(settings.rspamdRewriteSubject);
    const [subjectTag, setSubjectTag] = useState(settings.rspamdSubjectTag);
    // Module
    const [phishing, setPhishing] = useState(settings.rspamdPhishingEnabled);
    const [fuzzy, setFuzzy] = useState(settings.rspamdFuzzyEnabled);
    const [url, setUrl] = useState(settings.rspamdUrlEnabled);
    const [mxCheck, setMxCheck] = useState(settings.rspamdMxCheckEnabled);
    const { data: stat, isLoading } = useQuery({
        queryKey: ['admin', 'security', 'rspamd', 'stat'],
        queryFn: () => api.get('/admin/security/rspamd/stat'),
        retry: false,
    });
    const learnMut = useMutation({
        mutationFn: (type) => api.post(`/admin/security/rspamd/learn/${type}`, {}),
        onSuccess: (_, type) => toast.success(`Rspamd Bayes: ${type === 'spam' ? 'Spam' : 'Ham'} gelernt`),
        onError: () => toast.error('Rspamd nicht erreichbar'),
    });
    function save() {
        if (greylist >= spam) {
            toast.error('Greylisting-Score muss kleiner als Spam-Score sein');
            return;
        }
        if (spam >= reject) {
            toast.error('Spam-Score muss kleiner als Reject-Score sein');
            return;
        }
        onSave({
            rspamdEnabled: enabled,
            rspamdGreylistScore: greylist,
            rspamdSpamScore: spam,
            rspamdRejectScore: reject,
            rspamdAutolearn: autolearn,
            rspamdAutolearnSpam: autolearnSpam,
            rspamdAutolearnHam: autolearnHam,
            rspamdAddSpamHeader: addSpamHeader,
            rspamdExtendedHeaders: extendedHeaders,
            rspamdRewriteSubject: rewriteSubject,
            rspamdSubjectTag: subjectTag,
            rspamdPhishingEnabled: phishing,
            rspamdFuzzyEnabled: fuzzy,
            rspamdUrlEnabled: url,
            rspamdMxCheckEnabled: mxCheck,
        });
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Rspamd 4.0 Konfiguration" }), _jsx(SaveBtn, { onClick: save, pending: false })] }), isLoading && _jsx("p", { className: "text-xs text-gray-400", children: "Lade Rspamd-Statistiken\u2026" }), stat && (_jsx("div", { className: "grid grid-cols-4 gap-3", children: [
                    { label: 'Version', value: stat.version ?? '—' },
                    { label: 'Gescannt', value: (stat.scanned ?? 0).toLocaleString() },
                    { label: 'Spam', value: (stat.spam_count ?? 0).toLocaleString() },
                    { label: 'Uptime', value: stat.uptime ? `${Math.floor(stat.uptime / 3600)}h` : '—' },
                ].map(s => (_jsxs("div", { className: "card p-3 text-center", children: [_jsx("p", { className: "text-lg font-bold text-gray-900", children: s.value }), _jsx("p", { className: "text-xs text-gray-400", children: s.label })] }, s.label))) })), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Aktions-Schwellwerte" }), _jsx("div", { className: "bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 my-2", children: "Score \u2265 Greylist \u2192 Greylisting \u00A0\u00B7\u00A0 Score \u2265 Spam \u2192 Header hinzuf\u00FCgen \u00A0\u00B7\u00A0 Score \u2265 Reject \u2192 Ablehnen" }), _jsx(ToggleRow, { label: "Rspamd aktiviert", value: enabled, onChange: setEnabled }), _jsx(NumInput, { label: "Greylisting-Score", value: greylist, onChange: setGreylist, min: 0, max: 20, step: 0.5 }), _jsx(NumInput, { label: "Spam-Score (Add Header)", value: spam, onChange: setSpam, min: 0, max: 30, step: 0.5 }), _jsx(NumInput, { label: "Reject-Score", value: reject, onChange: setReject, min: 0, max: 100, step: 0.5 })] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Bayes Autolearn" }), _jsx("p", { className: "text-xs text-gray-400 py-1", children: "Rspamd lernt automatisch aus eindeutigen Mails. Nachrichten mit Score \u00FCber dem Spam-Schwellwert werden als Spam trainiert, unter dem Ham-Schwellwert als Ham." }), _jsx(ToggleRow, { label: "Autolearn aktiviert", desc: "Bayes-Klassifikator lernt automatisch ohne manuelles Training", value: autolearn, onChange: setAutolearn }), _jsx(NumInput, { label: "Autolearn Spam-Schwellwert", value: autolearnSpam, onChange: setAutolearnSpam, min: 6, max: 100, step: 0.5 }), _jsx(NumInput, { label: "Autolearn Ham-Schwellwert", value: autolearnHam, onChange: setAutolearnHam, min: -10, max: 0, step: 0.5 })] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "E-Mail-Header Modifikation" }), _jsx(ToggleRow, { label: "X-Spam-Header hinzuf\u00FCgen", desc: "F\u00FCgt X-Spam-Flag, X-Spam-Score und X-Spam-Status zu verd\u00E4chtigen Mails hinzu", value: addSpamHeader, onChange: setAddSpamHeader }), _jsx(ToggleRow, { label: "Erweiterte Rspamd-Header", desc: "X-Rspamd-Score, X-Rspamd-Action und X-Rspamd-Pre-Result bei allen Mails", value: extendedHeaders, onChange: setExtendedHeaders }), _jsx(ToggleRow, { label: "Betreff umschreiben", desc: "Spam-Mails erhalten einen Pr\u00E4fix im Betreff (z.B. [SPAM])", value: rewriteSubject, onChange: setRewriteSubject }), rewriteSubject && (_jsxs("div", { className: "flex items-center justify-between py-2.5 border-b border-gray-100", children: [_jsx("span", { className: "text-sm text-gray-700", children: "Betreff-Pr\u00E4fix" }), _jsx("input", { type: "text", value: subjectTag, onChange: e => setSubjectTag(e.target.value), maxLength: 32, className: "w-32 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] }))] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Rspamd-Module" }), _jsx("p", { className: "text-xs text-gray-400 py-1", children: "SPF, DKIM, DMARC und ARC sind immer aktiv. Die folgenden Module k\u00F6nnen einzeln gesteuert werden:" }), _jsx(ToggleRow, { label: "Phishing-Erkennung", desc: "Analysiert URLs und Header auf Phishing-Merkmale (phishing_detection)", value: phishing, onChange: setPhishing }), _jsx(ToggleRow, { label: "Fuzzy-Hash-Matching", desc: "Erkennt bekannte Spam-Muster anhand von Fuzzy-Hashes (Rspamd-Fuzzy-Storage)", value: fuzzy, onChange: setFuzzy }), _jsx(ToggleRow, { label: "URL-Reputationspr\u00FCfung", desc: "Pr\u00FCft Links gegen URIBL und SURBL Blacklisten (rbl-Modul)", value: url, onChange: setUrl }), _jsx(ToggleRow, { label: "MX-DNS-Pr\u00FCfung", desc: "Verifiziert ob die Absender-Domain g\u00FCltige MX-Eintr\u00E4ge hat", value: mxCheck, onChange: setMxCheck }), _jsxs("div", { className: "pt-2 mt-1 border-t border-gray-100", children: [_jsx("p", { className: "text-xs text-gray-400 mb-2", children: "Immer aktiv (nicht deaktivierbar):" }), _jsx("div", { className: "grid grid-cols-2 gap-1.5", children: [
                                    ['SPF', 'Sender Policy Framework'],
                                    ['DKIM', 'DKIM-Signatur Validierung'],
                                    ['DMARC', 'DMARC Policy Auswertung'],
                                    ['ARC', 'Authenticated Received Chain'],
                                    ['Bayes', 'Bayes-Klassifikator'],
                                    ['MIME', 'MIME-Struktur-Analyse'],
                                ].map(([name, desc]) => (_jsxs("div", { className: "flex items-center gap-2 text-xs bg-gray-50 rounded px-2.5 py-1.5", children: [_jsx(CheckCircle, { size: 12, className: "text-green-500 shrink-0" }), _jsx("span", { className: "font-medium text-gray-700", children: name }), _jsx("span", { className: "text-gray-400 truncate", children: desc })] }, name))) })] })] }), _jsxs("div", { className: "card p-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100 mb-3", children: "Bayes manuell trainieren" }), _jsx("p", { className: "text-xs text-gray-400 mb-3", children: "Manuelle Trainingsimpulse f\u00FCr den Bayes-Klassifikator. Im Normalbetrieb \u00FCbernimmt Autolearn diese Aufgabe automatisch." }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => learnMut.mutate('spam'), disabled: learnMut.isPending, className: "btn-secondary text-sm text-red-600 border-red-200 hover:bg-red-50", children: "Als Spam trainieren" }), _jsx("button", { onClick: () => learnMut.mutate('ham'), disabled: learnMut.isPending, className: "btn-secondary text-sm text-green-600 border-green-200 hover:bg-green-50", children: "Als Ham trainieren" })] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// AntivirusSection
// ═════════════════════════════════════════════════════════════════════════════
function AntivirusSection({ settings, onSave }) {
    const [enabled, setEnabled] = useState(settings.clamavEnabled);
    const [action, setAction] = useState(settings.clamavAction ?? 'quarantine');
    const [blockOnFailure, setBlockOnFailure] = useState(settings.clamavBlockOnFailure ?? false);
    const [scanArchives, setScanArchives] = useState(settings.clamavScanArchives ?? true);
    const [scanHtml, setScanHtml] = useState(settings.clamavScanHtml ?? true);
    const [blockEncrypted, setBlockEncrypted] = useState(settings.clamavBlockEncryptedArch ?? false);
    const [maxFileSize, setMaxFileSize] = useState(settings.clamavMaxFileSizeMb ?? 25);
    const [maxScanSize, setMaxScanSize] = useState(settings.clamavMaxScanSizeMb ?? 100);
    const { data: status } = useQuery({
        queryKey: ['admin', 'security', 'status'],
        queryFn: () => api.get('/admin/security/status'),
        refetchInterval: 30_000,
    });
    const c = status?.clamav;
    function save() {
        onSave({
            clamavEnabled: enabled,
            clamavAction: action,
            clamavBlockOnFailure: blockOnFailure,
            clamavScanArchives: scanArchives,
            clamavScanHtml: scanHtml,
            clamavBlockEncryptedArch: blockEncrypted,
            clamavMaxFileSizeMb: maxFileSize,
            clamavMaxScanSizeMb: maxScanSize,
        });
    }
    const actionLabels = {
        quarantine: { label: 'Quarantäne', desc: 'Virus-Mail in Junk verschieben', color: 'amber' },
        reject: { label: 'Ablehnen', desc: 'SMTP-Verbindung mit Fehler abweisen', color: 'red' },
        pass: { label: 'Durchlassen', desc: 'Nur markieren, nicht blockieren', color: 'gray' },
    };
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Antivirus \u2014 ClamAV" }), _jsx(SaveBtn, { onClick: save, pending: false })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center", children: _jsx(Bug, { size: 16, className: "text-emerald-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold", children: "ClamAV" }), _jsx("p", { className: "text-xs text-gray-400", children: "Open-Source Antivirus Engine" })] })] }), _jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-sm text-gray-600", children: "Status" }), _jsx(OnlineBadge, { online: !!c?.online })] }), c?.version && (_jsxs("div", { className: "flex items-start justify-between py-1", children: [_jsx("span", { className: "text-sm text-gray-600", children: "Version" }), _jsx("span", { className: "text-xs font-mono text-gray-700 text-right max-w-[200px] break-all", children: c.version })] })), _jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-sm text-gray-600", children: "Signaturen" }), _jsx("span", { className: "text-xs text-gray-500", children: "T\u00E4glich via freshclam" })] }), _jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-sm text-gray-600", children: "Verbindung" }), _jsx("span", { className: "text-xs font-mono text-gray-500", children: "clamav:3310 (INSTREAM)" })] })] }), _jsxs("div", { className: "card p-4 space-y-2", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "\u00DCber ClamAV" }), _jsx("p", { className: "text-xs text-gray-500 leading-relaxed", children: "ClamAV ist eine freie, plattform\u00FCbergreifende Anti-Malware Engine (GPL). Sie erkennt Viren, Trojaner und andere sch\u00E4dliche Bedrohungen in E-Mail-Anh\u00E4ngen via TCP INSTREAM-Protokoll." }), _jsx("div", { className: "flex flex-wrap gap-1.5 pt-1", children: ['GPL Open-Source', 'ClamDB Signaturen', 'Archive-Scan', 'freshclam Updates'].map(t => (_jsx("span", { className: "text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200", children: t }, t))) })] })] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Grundeinstellungen" }), _jsx(ToggleRow, { label: "ClamAV aktiviert", desc: "Scannt alle eingehenden E-Mail-Anh\u00E4nge auf Viren und Malware", value: enabled, onChange: setEnabled }), _jsx(ToggleRow, { label: "Bei ClamAV-Ausfall blockieren", desc: "Eingehende Mails ablehnen wenn ClamAV nicht erreichbar ist (fail-closed)", value: blockOnFailure, onChange: setBlockOnFailure })] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Aktion bei Virenfund" }), _jsx("div", { className: "grid grid-cols-3 gap-2", children: ['quarantine', 'reject', 'pass'].map(a => {
                            const meta = actionLabels[a];
                            return (_jsxs("button", { onClick: () => setAction(a), className: `rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors text-left ${action === a
                                    ? 'border-accent bg-accent/10 text-accent'
                                    : 'border-gray-200 text-gray-600 hover:border-gray-300'}`, children: [_jsx("p", { className: "font-semibold", children: meta?.label }), _jsx("p", { className: "text-[10px] mt-0.5 opacity-70", children: meta?.desc })] }, a));
                        }) }), action === 'pass' && (_jsxs("div", { className: "bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-start gap-1.5", children: [_jsx(AlertTriangle, { size: 12, className: "shrink-0 mt-0.5" }), "Modus \"Durchlassen\" sch\u00FCtzt nicht vor Viren \u2014 nur f\u00FCr Diagnose-Zwecke empfohlen."] }))] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100", children: "Scan-Optionen" }), _jsx(ToggleRow, { label: "Archive scannen", desc: "ZIP, RAR, TAR, GZ und andere Archivformate werden entpackt und gescannt", value: scanArchives, onChange: setScanArchives }), _jsx(ToggleRow, { label: "HTML-Inhalt scannen", desc: "HTML-Teile der E-Mail auf eingebettete Schadskripte pr\u00FCfen", value: scanHtml, onChange: setScanHtml }), _jsx(ToggleRow, { label: "Verschl\u00FCsselte Archive blockieren", desc: "Passwortgesch\u00FCtzte Archive ablehnen (k\u00F6nnen nicht gescannt werden)", value: blockEncrypted, onChange: setBlockEncrypted }), _jsx(NumInput, { label: "Max. Dateigr\u00F6\u00DFe (je Anhang)", value: maxFileSize, onChange: setMaxFileSize, min: 1, max: 500, unit: "MB" }), _jsx(NumInput, { label: "Max. Gesamt-Scan-Gr\u00F6\u00DFe", value: maxScanSize, onChange: setMaxScanSize, min: 1, max: 2048, unit: "MB" })] }), _jsxs("div", { className: "bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700 flex items-start gap-2", children: [_jsx(AlertTriangle, { size: 13, className: "shrink-0 mt-0.5" }), _jsxs("span", { children: ["ClamAV l\u00E4uft als separater Docker-Container (", _jsx("code", { className: "bg-blue-100 px-1 rounded", children: "clamav/clamav:stable" }), "). freshclam aktualisiert die Signaturdatenbank t\u00E4glich automatisch. Signaturdatenbank: ", _jsx("strong", { children: "ClamAV DB (CVD)" }), " + optionale 3rd-Party Signaturen."] })] })] }));
}
function ActionBadge({ action }) {
    const styles = {
        REJECT: 'bg-red-50 text-red-700 border-red-200',
        TAG: 'bg-amber-50 text-amber-700 border-amber-200',
        SCORE_ONLY: 'bg-blue-50 text-blue-700 border-blue-200',
    };
    const labels = { REJECT: 'Ablehnen', TAG: 'Markieren', SCORE_ONLY: 'Score' };
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${styles[action]}`, children: labels[action] }));
}
function DnsblSection({ settings, onSave }) {
    const qc = useQueryClient();
    const [enabled, setEnabled] = useState(settings.dnsblEnabled);
    const [tab, setTab] = useState('zones');
    // ── Master-Toggle ──────────────────────────────────────────────────────────
    const masterSave = () => onSave({ dnsblEnabled: enabled });
    // ── Zonen ──────────────────────────────────────────────────────────────────
    const { data: zones = [], isLoading: zonesLoading } = useQuery({
        queryKey: ['admin', 'dnsbl-zones'],
        queryFn: () => api.get('/admin/security/dnsbl'),
    });
    const invalidateZones = () => qc.invalidateQueries({ queryKey: ['admin', 'dnsbl-zones'] });
    const patchZone = useMutation({
        mutationFn: ({ id, body }) => api.patch(`/admin/security/dnsbl/${id}`, body),
        onSuccess: invalidateZones,
        onError: (e) => toast.error(e.message || 'Fehler beim Speichern'),
    });
    const deleteZone = useMutation({
        mutationFn: (id) => api.delete(`/admin/security/dnsbl/${id}`),
        onSuccess: () => { invalidateZones(); toast.success('Zone gelöscht'); },
        onError: (e) => toast.error(e.message || 'Fehler beim Löschen'),
    });
    const createZone = useMutation({
        mutationFn: (body) => api.post('/admin/security/dnsbl', body),
        onSuccess: () => { invalidateZones(); toast.success('Zone angelegt'); setNewHost(''); setNewName(''); setShowAdd(false); },
        onError: (e) => toast.error(e.message || 'Fehler beim Anlegen'),
    });
    const [showAdd, setShowAdd] = useState(false);
    const [newHost, setNewHost] = useState('');
    const [newName, setNewName] = useState('');
    const [newAction, setNewAction] = useState('REJECT');
    const [newWeight, setNewWeight] = useState(5);
    const [newWhitelist, setNewWhitelist] = useState(false);
    // ── Test ───────────────────────────────────────────────────────────────────
    const [testIp, setTestIp] = useState('');
    const testMutation = useMutation({
        mutationFn: (ip) => api.post('/admin/security/dnsbl/test', { ip }),
        onError: (e) => toast.error(e.message || 'Test fehlgeschlagen'),
    });
    // ── Stats ──────────────────────────────────────────────────────────────────
    const [statsDays, setStatsDays] = useState(7);
    const { data: stats } = useQuery({
        queryKey: ['admin', 'dnsbl-stats', statsDays],
        queryFn: () => api.get(`/admin/security/dnsbl/stats?days=${statsDays}`),
        enabled: tab === 'stats',
        refetchInterval: tab === 'stats' ? 30_000 : false,
    });
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "DNSBL-Konfiguration" }), _jsx(SaveBtn, { onClick: masterSave, pending: false })] }), _jsx("div", { className: "card p-4 space-y-1", children: _jsx(ToggleRow, { label: "DNSBL aktiviert", desc: "Pr\u00FCft Absender-IPs gegen DNS-Blacklisten und ggf. Whitelisten (DNSWL)", value: enabled, onChange: setEnabled }) }), _jsx("div", { className: "flex gap-1 border-b border-gray-200", children: [
                    { id: 'zones', label: 'Zonen', count: zones.length },
                    { id: 'test', label: 'Test', count: undefined },
                    { id: 'stats', label: 'Statistik', count: undefined },
                ].map(({ id, label, count }) => (_jsxs("button", { onClick: () => setTab(id), className: `px-4 py-2 text-sm border-b-2 transition-colors ${tab === id
                        ? 'border-accent text-accent font-semibold'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`, children: [label, count !== undefined && (_jsx("span", { className: "ml-1.5 text-xs bg-gray-100 px-1.5 py-0.5 rounded-full text-gray-600", children: count }))] }, id))) }), tab === 'zones' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("p", { className: "text-sm text-gray-600", children: [zones.filter(z => z.enabled).length, " aktive von ", zones.length, " Zonen"] }), _jsxs("button", { onClick: () => setShowAdd((v) => !v), className: "btn-secondary text-sm gap-1", children: [_jsx(Plus, { size: 13 }), " Eigene Zone"] })] }), showAdd && (_jsxs("div", { className: "card p-4 border-2 border-accent/30 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Neue DNSBL/DNSWL-Zone anlegen" }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsx("input", { value: newHost, onChange: (e) => setNewHost(e.target.value), placeholder: "zen.spamhaus.org", className: "border border-gray-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsx("input", { value: newName, onChange: (e) => setNewName(e.target.value), placeholder: "Anzeigename", className: "border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { className: "flex items-center gap-3 flex-wrap", children: [_jsxs("select", { value: newAction, onChange: (e) => setNewAction(e.target.value), className: "border border-gray-300 rounded px-2 py-1.5 text-sm", children: [_jsx("option", { value: "REJECT", children: "Ablehnen" }), _jsx("option", { value: "TAG", children: "Als Spam markieren" }), _jsx("option", { value: "SCORE_ONLY", children: "Nur Score (rspamd)" })] }), _jsxs("label", { className: "text-sm text-gray-700 flex items-center gap-1", children: ["Score:", _jsx("input", { type: "number", min: 0, max: 100, value: newWeight, onChange: (e) => setNewWeight(parseInt(e.target.value, 10) || 0), className: "w-16 border border-gray-300 rounded px-2 py-1 text-sm" })] }), _jsxs("label", { className: "text-sm text-gray-700 flex items-center gap-1.5", children: [_jsx("input", { type: "checkbox", checked: newWhitelist, onChange: (e) => setNewWhitelist(e.target.checked) }), "Whitelist (DNSWL)"] })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setShowAdd(false), className: "btn-ghost text-sm", children: "Abbrechen" }), _jsx("button", { onClick: () => createZone.mutate({ host: newHost.trim(), name: newName.trim() || newHost.trim(), action: newAction, weight: newWeight, isWhitelist: newWhitelist, enabled: true }), disabled: !newHost.trim() || createZone.isPending, className: "btn-primary text-sm", children: "Anlegen" })] })] })), _jsxs("div", { className: "space-y-2", children: [zonesLoading && _jsx("p", { className: "text-sm text-gray-400", children: "Lade \u2026" }), zones.map((z) => (_jsx("div", { className: `card p-3 ${!z.enabled ? 'opacity-60' : ''}`, children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Toggle, { active: z.enabled, onToggle: () => patchZone.mutate({ id: z.id, body: { enabled: !z.enabled } }) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-sm font-semibold text-gray-900", children: z.name }), _jsx("code", { className: "text-xs text-gray-500", children: z.host }), z.isWhitelist && (_jsx("span", { className: "text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded", children: "WHITELIST" })), z.isBuiltin && (_jsx("span", { className: "text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded", children: "Built-in" })), _jsx(ActionBadge, { action: z.action })] }), z.description && (_jsx("p", { className: "text-xs text-gray-500 mt-1", children: z.description })), _jsxs("div", { className: "flex items-center gap-3 mt-2", children: [_jsxs("label", { className: "flex items-center gap-1 text-xs text-gray-600", children: ["Aktion:", _jsxs("select", { value: z.action, onChange: (e) => patchZone.mutate({ id: z.id, body: { action: e.target.value } }), className: "border border-gray-200 rounded px-1.5 py-0.5 text-xs", children: [_jsx("option", { value: "REJECT", children: "Ablehnen" }), _jsx("option", { value: "TAG", children: "Markieren" }), _jsx("option", { value: "SCORE_ONLY", children: "Score" })] })] }), _jsxs("label", { className: "flex items-center gap-1 text-xs text-gray-600", children: ["Score:", _jsx("input", { type: "number", min: 0, max: 100, defaultValue: z.weight, onBlur: (e) => {
                                                                        const v = parseInt(e.target.value, 10);
                                                                        if (v !== z.weight)
                                                                            patchZone.mutate({ id: z.id, body: { weight: v } });
                                                                    }, className: "w-14 border border-gray-200 rounded px-1.5 py-0.5 text-xs" })] })] })] }), !z.isBuiltin && (_jsx("button", { onClick: () => {
                                                if (window.confirm(`Zone „${z.name}" wirklich löschen?`))
                                                    deleteZone.mutate(z.id);
                                            }, className: "text-gray-400 hover:text-red-500 transition-colors p-1", children: _jsx(Trash2, { size: 14 }) }))] }) }, z.id)))] })] })), tab === 'test' && (_jsxs("div", { className: "card p-4 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "DNSBL-Check f\u00FCr IP testen" }), _jsx("p", { className: "text-xs text-gray-500", children: "Pr\u00FCft die IP gegen alle konfigurierten Zonen (auch deaktivierte). Antwortzeit ca. 2 s pro Zone." }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: testIp, onChange: (e) => setTestIp(e.target.value), onKeyDown: (e) => e.key === 'Enter' && testIp.trim() && testMutation.mutate(testIp.trim()), placeholder: "z. B. 185.220.101.1 oder 2001:db8::1", className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("button", { onClick: () => testIp.trim() && testMutation.mutate(testIp.trim()), disabled: !testIp.trim() || testMutation.isPending, className: "btn-primary text-sm gap-1", children: [testMutation.isPending ? _jsx(RefreshCw, { size: 13, className: "animate-spin" }) : _jsx(Database, { size: 13 }), "Testen"] })] }), testMutation.data && (_jsxs("div", { className: "border-t border-gray-100 pt-3 space-y-1.5", children: [_jsxs("p", { className: "text-xs text-gray-500", children: ["Ergebnis f\u00FCr ", _jsx("code", { className: "font-mono", children: testMutation.data.ip }), ":"] }), testMutation.data.results.map((r) => (_jsxs("div", { className: `flex items-center gap-2 px-3 py-1.5 rounded text-sm ${r.listed
                                    ? (r.isWhitelist ? 'bg-emerald-50' : 'bg-red-50')
                                    : 'bg-gray-50'}`, children: [r.listed
                                        ? _jsx(CheckCircle, { size: 14, className: r.isWhitelist ? 'text-emerald-600' : 'text-red-600' })
                                        : _jsx(XCircle, { size: 14, className: "text-gray-400" }), _jsx("span", { className: "font-medium", children: r.name }), _jsx("code", { className: "text-xs text-gray-500", children: r.host }), !r.enabled && _jsx("span", { className: "text-[10px] bg-gray-200 px-1.5 rounded", children: "deaktiviert" }), _jsx("span", { className: "ml-auto text-xs", children: r.listed
                                            ? _jsxs("span", { className: r.isWhitelist ? 'text-emerald-700 font-mono' : 'text-red-700 font-mono', children: ["gelistet \u2192 ", r.response] })
                                            : _jsx("span", { className: "text-gray-400", children: "nicht gelistet" }) })] }, r.zoneId)))] }))] })), tab === 'stats' && (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-sm text-gray-600", children: "Zeitraum:" }), [1, 7, 30].map((d) => (_jsx("button", { onClick: () => setStatsDays(d), className: `px-3 py-1 text-xs rounded-full transition-colors ${statsDays === d ? 'bg-accent text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`, children: d === 1 ? '24 h' : `${d} Tage` }, d)))] }), stats && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "card p-4", children: [_jsx("p", { className: "text-2xl font-bold text-gray-900", children: stats.total.toLocaleString('de-DE') }), _jsxs("p", { className: "text-xs text-gray-500", children: ["Treffer in den letzten ", stats.days === 1 ? '24 h' : `${stats.days} Tagen`] })] }), _jsxs("div", { className: "card p-4", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700 mb-2", children: "Top-Zonen" }), stats.perZone.length === 0
                                        ? _jsx("p", { className: "text-xs text-gray-400", children: "Keine Treffer" })
                                        : stats.perZone.map((p) => (_jsxs("div", { className: "flex items-center gap-2 py-1.5", children: [_jsx("span", { className: "text-sm font-medium text-gray-700", children: p.name }), _jsx("code", { className: "text-xs text-gray-400", children: p.host }), _jsx("div", { className: "flex-1 bg-gray-100 h-2 rounded", children: _jsx("div", { className: "bg-accent h-2 rounded", style: { width: `${stats.perZone[0] ? (p.hits / stats.perZone[0].hits) * 100 : 0}%` } }) }), _jsx("span", { className: "text-sm tabular-nums text-gray-700 w-16 text-right", children: p.hits })] }, p.zoneId)))] }), _jsxs("div", { className: "card p-4", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700 mb-2", children: "Letzte Treffer" }), stats.recent.length === 0
                                        ? _jsx("p", { className: "text-xs text-gray-400", children: "Keine Treffer" })
                                        : (_jsx("div", { className: "space-y-1 max-h-80 overflow-y-auto", children: stats.recent.map((h) => (_jsxs("div", { className: "flex items-center gap-2 text-xs py-1 border-b border-gray-50 last:border-0", children: [_jsx(AlertTriangle, { size: 11, className: "text-red-500 shrink-0" }), _jsx("code", { className: "font-mono text-gray-700 w-32 truncate", children: h.ip }), _jsx("span", { className: "text-gray-600", children: h.zoneName }), _jsx("span", { className: "ml-auto text-gray-400", children: new Date(h.hitAt).toLocaleString('de-DE') })] }, h.id))) }))] })] }))] }))] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// GreylistingSection
// ═════════════════════════════════════════════════════════════════════════════
function GreylistingSection({ settings, onSave }) {
    const [enabled, setEnabled] = useState(settings.greylistEnabled);
    const [wait, setWait] = useState(settings.greylistWaitSec);
    const [ttl, setTtl] = useState(settings.greylistTtlHours);
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Greylisting" }), _jsx(SaveBtn, { onClick: () => onSave({ greylistEnabled: enabled, greylistWaitSec: wait, greylistTtlHours: ttl }), pending: false })] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx(ToggleRow, { label: "Greylisting aktiviert", desc: "Unbekannte Absender werden beim ersten Versuch tempor\u00E4r abgewiesen (SMTP 451)", value: enabled, onChange: setEnabled }), _jsx(NumInput, { label: "Wartezeit", value: wait, onChange: setWait, min: 60, max: 3600, step: 60, unit: "Sek" }), _jsx(NumInput, { label: "Whitelist-TTL (nach Passieren)", value: ttl, onChange: setTtl, min: 1, max: 168, unit: "Std" })] }), _jsxs("div", { className: "card p-4 text-sm text-gray-600 space-y-2", children: [_jsx("p", { className: "font-medium text-gray-800", children: "Wie Greylisting funktioniert" }), _jsxs("ol", { className: "list-decimal list-inside space-y-1 text-xs text-gray-500", children: [_jsx("li", { children: "Erstkontakt: Verbindung wird mit SMTP 451 (Temp. Fehler) abgelehnt" }), _jsxs("li", { children: ["Legitime Server versuchen es nach ", Math.round(wait / 60), " min erneut \u2192 wird akzeptiert"] }), _jsxs("li", { children: ["Das Triplet (IP + Absender + Empf\u00E4nger) wird ", ttl, "h lang in die Whitelist aufgenommen"] }), _jsx("li", { children: "Spam-Bots wiederholen meist nicht \u2192 effektive Blockierung" })] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// GeoipSection
// ═════════════════════════════════════════════════════════════════════════════
function GeoipSection({ settings, onSave }) {
    const [mode, setMode] = useState(settings.geoipMode);
    const [countries, setCountries] = useState(settings.geoipCountries);
    const [search, setSearch] = useState('');
    const filtered = COUNTRIES.filter(([code, name]) => name.toLowerCase().includes(search.toLowerCase()) || code.toLowerCase().includes(search.toLowerCase()));
    function toggle(code) {
        setCountries(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "GeoIP-L\u00E4nderfilter" }), _jsx(SaveBtn, { onClick: () => onSave({ geoipMode: mode, geoipCountries: countries }), pending: false })] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Filtermodus" }), _jsx("div", { className: "grid grid-cols-3 gap-2", children: ['DISABLED', 'WHITELIST', 'BLACKLIST'].map(m => (_jsxs("button", { onClick: () => setMode(m), className: `rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors text-left ${mode === m ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`, children: [_jsx("p", { className: "font-semibold", children: m === 'DISABLED' ? 'Deaktiviert' : m === 'WHITELIST' ? 'Whitelist' : 'Blacklist' }), _jsx("p", { className: "text-[10px] mt-0.5 opacity-70", children: m === 'DISABLED' ? 'Kein Länderfilter' :
                                        m === 'WHITELIST' ? 'Nur ausgewählte Länder' : 'Ausgewählte Länder blockieren' })] }, m))) })] }), mode !== 'DISABLED' && (_jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("p", { className: "text-sm font-semibold text-gray-700", children: [mode === 'WHITELIST' ? 'Erlaubte Länder' : 'Blockierte Länder', _jsxs("span", { className: "ml-2 text-xs font-normal text-gray-400", children: ["(", countries.length, " ausgew\u00E4hlt)"] })] }), _jsx("input", { value: search, onChange: e => setSearch(e.target.value), placeholder: "Suchen\u2026", className: "border border-gray-200 rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsx("div", { className: "grid grid-cols-3 gap-1 max-h-64 overflow-y-auto", children: filtered.map(([code, name]) => (_jsxs("label", { className: "flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: countries.includes(code), onChange: () => toggle(code), className: "rounded border-gray-300 text-accent focus:ring-accent" }), _jsxs("span", { className: "text-xs text-gray-700 truncate", title: name, children: [_jsx("span", { className: "font-mono text-gray-400 mr-1", children: code }), name] })] }, code))) }), countries.length > 0 && (_jsx("button", { onClick: () => setCountries([]), className: "text-xs text-gray-400 hover:text-red-500", children: "Auswahl zur\u00FCcksetzen" }))] }))] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// AttachmentsSection
// ═════════════════════════════════════════════════════════════════════════════
function AttachmentsSection({ settings, onSave }) {
    const [enabled, setEnabled] = useState(settings.attachmentEnabled);
    const [maxSize, setMaxSize] = useState(settings.attachmentMaxSizeMb);
    const [exts, setExts] = useState(settings.attachmentBlockedExt);
    const [newExt, setNewExt] = useState('');
    function addExt() {
        const e = newExt.trim().toLowerCase().replace(/^\./, '');
        if (!e || exts.includes(e)) {
            setNewExt('');
            return;
        }
        setExts(prev => [...prev, e]);
        setNewExt('');
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Anh\u00E4nge-Filter" }), _jsx(SaveBtn, { onClick: () => onSave({ attachmentEnabled: enabled, attachmentMaxSizeMb: maxSize, attachmentBlockedExt: exts }), pending: false })] }), _jsxs("div", { className: "card p-4 space-y-1", children: [_jsx(ToggleRow, { label: "Anh\u00E4nge-Filter aktiviert", desc: "Blockiert gef\u00E4hrliche Dateitypen in E-Mail-Anh\u00E4ngen", value: enabled, onChange: setEnabled }), _jsx(NumInput, { label: "Maximale Anhangsgr\u00F6\u00DFe", value: maxSize, onChange: setMaxSize, min: 1, max: 500, unit: "MB" })] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Blockierte Dateiendungen" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: exts.map(ext => (_jsxs("span", { className: "flex items-center gap-1 bg-red-50 border border-red-200 text-red-700 text-xs px-2 py-0.5 rounded-full", children: [".", ext, _jsx("button", { onClick: () => setExts(prev => prev.filter(e => e !== ext)), className: "hover:text-red-900 ml-0.5", children: _jsx(XCircle, { size: 11 }) })] }, ext))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: newExt, onChange: e => setNewExt(e.target.value), onKeyDown: e => e.key === 'Enter' && addExt(), placeholder: "z.B. exe", className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("button", { onClick: addExt, className: "btn-secondary text-sm gap-1", children: [_jsx(Plus, { size: 13 }), " Hinzuf\u00FCgen"] })] }), _jsxs("div", { className: "flex flex-wrap gap-1.5 pt-1 border-t border-gray-100", children: [_jsx("p", { className: "w-full text-xs text-gray-400 mb-1", children: "Schnell hinzuf\u00FCgen:" }), ['ps1', 'vba', 'jar', 'msp', 'reg', 'inf', 'lnk', 'url', 'xls', 'doc'].filter(e => !exts.includes(e)).map(e => (_jsxs("button", { onClick: () => setExts(prev => [...prev, e]), className: "text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded transition-colors", children: ["+.", e] }, e)))] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// ProtectionPage (root)
// ═════════════════════════════════════════════════════════════════════════════
export function ProtectionPage() {
    const [section, setSection] = useState('overview');
    const qc = useQueryClient();
    const { data: settings } = useQuery({
        queryKey: ['admin', 'security', 'settings'],
        queryFn: () => api.get('/admin/security/settings'),
    });
    const saveMut = useMutation({
        mutationFn: (data) => api.put('/admin/security/settings', data),
        onSuccess: () => {
            toast.success('Einstellungen gespeichert');
            qc.invalidateQueries({ queryKey: ['admin', 'security', 'settings'] });
        },
        onError: () => toast.error('Fehler beim Speichern'),
    });
    function handleSave(data) {
        saveMut.mutate(data);
    }
    return (_jsxs("div", { className: "flex h-full", children: [_jsxs("aside", { className: "w-44 shrink-0 bg-[#1e2433] flex flex-col h-full", children: [_jsx("div", { className: "px-3 py-3 border-b border-white/10", children: _jsx("p", { className: "text-[10px] font-bold uppercase tracking-widest text-gray-400", children: "Schutzfilter" }) }), _jsx("nav", { className: "flex-1 py-2 space-y-0.5", children: SUB_NAV.map(({ id, label, icon: Icon }) => (_jsxs("button", { onClick: () => setSection(id), className: `w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${section === id
                                ? 'bg-white/10 text-white border-l-2 border-accent'
                                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`, children: [_jsx(Icon, { size: 13, className: "shrink-0" }), label] }, id))) })] }), _jsxs("div", { className: "flex-1 overflow-y-auto p-6", children: [!settings && (_jsx("div", { className: "text-sm text-gray-400", children: "Lade Einstellungen\u2026" })), settings && (_jsxs(_Fragment, { children: [section === 'overview' && _jsx(OverviewSection, {}), section === 'rspamd' && _jsx(RspamdSection, { settings: settings, onSave: handleSave }), section === 'antivirus' && _jsx(AntivirusSection, { settings: settings, onSave: handleSave }), section === 'dnsbl' && _jsx(DnsblSection, { settings: settings, onSave: handleSave }), section === 'greylisting' && _jsx(GreylistingSection, { settings: settings, onSave: handleSave }), section === 'geoip' && _jsx(GeoipSection, { settings: settings, onSave: handleSave }), section === 'attachments' && _jsx(AttachmentsSection, { settings: settings, onSave: handleSave })] }))] })] }));
}
