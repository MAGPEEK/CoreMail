import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, RefreshCw, Trash2, RotateCcw, AlertCircle, Clock, Mail, ChevronDown, ChevronRight, Settings, Layers, CheckCircle2, XCircle, AlertTriangle, Play, Hourglass, Save, } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
const SECTIONS = [
    { key: 'overview', label: 'Übersicht', icon: _jsx(Layers, { size: 14 }) },
    { key: 'outbound', label: 'Ausgehend', icon: _jsx(Mail, { size: 14 }) },
    { key: 'retry', label: 'Wiederholung', icon: _jsx(RotateCcw, { size: 14 }) },
    { key: 'deadletter', label: 'Dead Letter', icon: _jsx(XCircle, { size: 14 }) },
    { key: 'settings', label: 'Einstellungen', icon: _jsx(Settings, { size: 14 }) },
];
// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDt(iso) {
    if (!iso)
        return '—';
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtAge(iso) {
    if (!iso)
        return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000)
        return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000)
        return `${Math.round(ms / 60_000)}min`;
    if (ms < 86_400_000)
        return `${Math.round(ms / 3_600_000)}h`;
    return `${Math.round(ms / 86_400_000)}d`;
}
function NumInput({ label, value, onChange, min, max, unit, description, }) {
    return (_jsxs("div", { className: "flex items-start justify-between py-3 border-b border-gray-100 last:border-0", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: label }), description && _jsx("p", { className: "text-xs text-gray-500 mt-0.5 max-w-md", children: description })] }), _jsxs("div", { className: "flex items-center gap-2 ml-4", children: [_jsx("input", { type: "number", min: min, max: max, value: value, onChange: e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min))), className: "w-20 text-right border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), unit && _jsx("span", { className: "text-xs text-gray-500 w-10", children: unit })] })] }));
}
// ─── Sparkline component ──────────────────────────────────────────────────────
function Sparkbar({ value, max, color }) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return (_jsx("div", { className: "w-full h-1.5 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${color}`, style: { width: `${pct}%` } }) }));
}
// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, color, onClick, active, }) {
    const colors = {
        blue: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', bar: 'bg-blue-400' },
        green: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', bar: 'bg-green-400' },
        yellow: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', bar: 'bg-yellow-400' },
        red: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', bar: 'bg-red-400' },
        gray: { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200', bar: 'bg-gray-300' },
    };
    const c = colors[color] ?? colors.gray;
    return (_jsxs("button", { onClick: onClick, className: `text-left rounded-xl border p-4 transition-all hover:shadow-md w-full ${c.bg} ${c.border} ${active ? 'ring-2 ring-accent ring-offset-1' : ''}`, children: [_jsxs("div", { className: "flex items-start justify-between mb-3", children: [_jsx("div", { className: `w-8 h-8 rounded-lg flex items-center justify-center ${c.bg} ${c.text}`, children: icon }), _jsx("span", { className: `text-2xl font-bold ${c.text}`, children: value.toLocaleString('de-DE') })] }), _jsx("p", { className: "text-xs font-semibold text-gray-600", children: label })] }));
}
// ─── Job Table ────────────────────────────────────────────────────────────────
function JobTable({ jobs, loading, showRetry, showDelete, onRetry, onDelete, emptyText = 'Keine Nachrichten', }) {
    const [expandedId, setExpandedId] = useState(null);
    return (_jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-2.5 w-6" }), _jsx("th", { className: "text-left px-4 py-2.5", children: "Absender" }), _jsx("th", { className: "text-left px-4 py-2.5", children: "Empf\u00E4nger" }), _jsx("th", { className: "text-left px-4 py-2.5", children: "Eingestellt" }), _jsx("th", { className: "text-center px-4 py-2.5", children: "Versuche" }), showRetry && _jsx("th", { className: "text-left px-4 py-2.5", children: "N\u00E4chster Versuch" }), _jsx("th", { className: "px-4 py-2.5" })] }) }), _jsx("tbody", { children: loading ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : jobs.length === 0 ? (_jsx("tr", { children: _jsxs("td", { colSpan: 7, className: "text-center py-12", children: [_jsx(CheckCircle2, { size: 28, className: "mx-auto text-gray-300 mb-2" }), _jsx("p", { className: "text-sm text-gray-400", children: emptyText })] }) })) : jobs.map(job => {
                        const isExpanded = expandedId === job.id;
                        const from = job.from ?? '—';
                        const to = (job.to ?? []).join(', ') || '—';
                        const attempts = `${job.attemptsMade} / ${job.maxAttempts}`;
                        const attemptsColor = job.attemptsMade >= job.maxAttempts ? 'bg-red-100 text-red-700'
                            : job.attemptsMade > 2 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600';
                        return (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50 cursor-pointer", onClick: () => setExpandedId(isExpanded ? null : job.id), children: [_jsx("td", { className: "px-4 py-3 text-gray-400", children: isExpanded ? _jsx(ChevronDown, { size: 13 }) : _jsx(ChevronRight, { size: 13 }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Mail, { size: 11, className: "text-gray-400 shrink-0" }), _jsx("span", { className: "text-xs font-mono text-gray-700 truncate max-w-[160px]", children: from })] }) }), _jsx("td", { className: "px-4 py-3 text-xs font-mono text-gray-700 truncate max-w-[160px]", children: to }), _jsxs("td", { className: "px-4 py-3 text-xs text-gray-500 whitespace-nowrap", children: [_jsx("div", { children: fmtDt(job.createdAt) }), _jsxs("div", { className: "text-gray-400", children: [fmtAge(job.createdAt), " her"] })] }), _jsx("td", { className: "px-4 py-3 text-center", children: _jsx("span", { className: `inline-block px-1.5 py-0.5 rounded text-xs font-medium ${attemptsColor}`, children: attempts }) }), showRetry && (_jsx("td", { className: "px-4 py-3 text-xs text-gray-500", children: job.nextRunAt ? fmtDt(job.nextRunAt) : '—' })), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-1.5", children: [showRetry && onRetry && (_jsx("button", { title: "Jetzt wiederholen", onClick: e => { e.stopPropagation(); onRetry(job.id); }, className: "p-1 text-gray-400 hover:text-blue-600 transition-colors", children: _jsx(RotateCcw, { size: 13 }) })), showDelete && onDelete && (_jsx("button", { title: "L\u00F6schen", onClick: e => { e.stopPropagation(); onDelete(job.id); }, className: "p-1 text-gray-400 hover:text-red-500 transition-colors", children: _jsx(Trash2, { size: 13 }) }))] }) })] }, job.id), isExpanded && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "p-0", children: _jsxs("div", { className: "bg-gray-50 border-t border-gray-100 px-8 py-4 space-y-2 text-xs", children: [_jsxs("div", { className: "grid grid-cols-2 gap-x-8 gap-y-1.5", children: [_jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "Job-ID:" }), _jsx("span", { className: "font-mono text-gray-700", children: job.id })] }), job.messageId && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "Message-ID:" }), _jsx("span", { className: "font-mono text-gray-700 truncate", children: job.messageId })] }), job.dkimDomain && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "DKIM-Domain:" }), _jsx("span", { className: "font-mono text-gray-700", children: job.dkimDomain })] }), job.processedAt && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "Verarbeitet:" }), _jsx("span", { className: "text-gray-700", children: fmtDt(job.processedAt) })] }), job.nextRunAt && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "N\u00E4chster Versuch:" }), _jsx("span", { className: "text-gray-700", children: fmtDt(job.nextRunAt) })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-500 inline-block w-28", children: "An:" }), _jsx("span", { className: "font-mono text-gray-700", children: to })] })] }), job.failedReason && (_jsxs("div", { className: "mt-2 p-2.5 bg-red-50 border border-red-100 rounded", children: [_jsx("p", { className: "text-red-600 font-medium mb-0.5", children: "Fehlerursache:" }), _jsx("p", { className: "text-red-700 font-mono", children: job.failedReason })] })), (job.stacktrace ?? []).length > 0 && (_jsx("pre", { className: "mt-1 p-2 bg-gray-900 text-gray-300 rounded text-[11px] overflow-auto max-h-28 leading-relaxed", children: job.stacktrace?.join('\n') }))] }) }) }, `${job.id}-detail`))] }));
                    }) })] }) }));
}
// ─── Overview Section ─────────────────────────────────────────────────────────
function OverviewSection({ stats, onSectionChange, }) {
    const total = (stats?.waiting ?? 0) + (stats?.active ?? 0) + (stats?.delayed ?? 0);
    const maxBar = Math.max(stats?.waiting ?? 0, stats?.active ?? 0, stats?.delayed ?? 0, stats?.failed ?? 0, 1);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "grid grid-cols-2 lg:grid-cols-5 gap-3", children: [_jsx(StatCard, { label: "Wartend", value: stats?.waiting ?? 0, color: "blue", icon: _jsx(Hourglass, { size: 16 }), onClick: () => onSectionChange('outbound') }), _jsx(StatCard, { label: "Aktiv", value: stats?.active ?? 0, color: "green", icon: _jsx(Play, { size: 16 }), onClick: () => onSectionChange('outbound') }), _jsx(StatCard, { label: "Wiederholung", value: stats?.delayed ?? 0, color: "yellow", icon: _jsx(Clock, { size: 16 }), onClick: () => onSectionChange('retry') }), _jsx(StatCard, { label: "Dead Letter", value: stats?.failed ?? 0, color: "red", icon: _jsx(XCircle, { size: 16 }), onClick: () => onSectionChange('deadletter') }), _jsx(StatCard, { label: "Zugestellt", value: stats?.completed ?? 0, color: "gray", icon: _jsx(CheckCircle2, { size: 16 }) })] }), (stats?.failed ?? 0) > 0 && (_jsxs("div", { className: "flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4", children: [_jsx(AlertCircle, { size: 16, className: "shrink-0 text-red-500 mt-0.5" }), _jsxs("div", { className: "flex-1", children: [_jsxs("p", { className: "text-sm font-medium text-red-800", children: [stats.failed, " Nachricht", stats.failed !== 1 ? 'en' : '', " dauerhaft nicht zustellbar"] }), _jsx("p", { className: "text-xs text-red-600 mt-0.5", children: "Diese Nachrichten befinden sich in der Dead-Letter-Queue. Ursache pr\u00FCfen und ggf. manuell wiederholen." })] }), _jsx("button", { onClick: () => onSectionChange('deadletter'), className: "shrink-0 text-xs font-medium text-red-700 border border-red-200 rounded px-3 py-1.5 hover:bg-red-100", children: "\u00D6ffnen \u2192" })] })), _jsxs("div", { className: "card p-5 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Queue-Verteilung" }), _jsxs("p", { className: "text-xs text-gray-400", children: [total, " ausstehend gesamt"] })] }), _jsx("div", { className: "space-y-3", children: [
                            { label: 'Wartend', value: stats?.waiting ?? 0, bar: 'bg-blue-400' },
                            { label: 'Aktiv', value: stats?.active ?? 0, bar: 'bg-green-400' },
                            { label: 'Wiederholung', value: stats?.delayed ?? 0, bar: 'bg-yellow-400' },
                            { label: 'Dead Letter', value: stats?.failed ?? 0, bar: 'bg-red-400' },
                        ].map(row => (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-xs text-gray-500 w-28", children: row.label }), _jsx("div", { className: "flex-1", children: _jsx(Sparkbar, { value: row.value, max: maxBar, color: row.bar }) }), _jsx("span", { className: "text-xs font-semibold text-gray-700 w-8 text-right", children: row.value })] }, row.label))) }), _jsxs("p", { className: "text-xs text-gray-400 pt-1 border-t border-gray-100", children: ["Zuletzt aktualisiert: ", stats ? fmtDt(stats.timestamp) : '—'] })] }), _jsx("div", { className: "grid grid-cols-2 gap-3", children: [
                    { icon: _jsx(Hourglass, { size: 15, className: "text-blue-500" }), title: 'Wartend', text: 'Nachrichten, die auf einen freien Worker-Slot warten und bereit zur Zustellung sind.' },
                    { icon: _jsx(Play, { size: 15, className: "text-green-500" }), title: 'Aktiv', text: 'Nachrichten, die gerade über SMTP zugestellt werden (laufende Verbindung).' },
                    { icon: _jsx(Clock, { size: 15, className: "text-yellow-500" }), title: 'Wiederholung', text: 'Fehlgeschlagene Versuche mit exponential Backoff — werden automatisch neu versucht.' },
                    { icon: _jsx(XCircle, { size: 15, className: "text-red-500" }), title: 'Dead Letter', text: 'Alle Retry-Versuche erschöpft. Manuelle Freigabe oder Löschen erforderlich.' },
                ].map(c => (_jsxs("div", { className: "card p-4 flex gap-3", children: [_jsx("div", { className: "shrink-0 mt-0.5", children: c.icon }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-800", children: c.title }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5 leading-relaxed", children: c.text })] })] }, c.title))) })] }));
}
// ─── Jobs Section (Ausgehend / Retry / Dead Letter) ───────────────────────────
function JobsSection({ stateFilter, title, description, badge, emptyText, showRetry = false, showRetryAll = false, }) {
    const qc = useQueryClient();
    const [page, setPage] = useState(1);
    const LIMIT = 50;
    const { data, isLoading, refetch } = useQuery({
        queryKey: ['admin-queue-jobs', stateFilter, page],
        queryFn: () => api.get(`/admin/queues/jobs?state=${stateFilter}&page=${page}&limit=${LIMIT}`),
        refetchInterval: 10_000,
    });
    const invalidate = () => {
        void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
        void qc.invalidateQueries({ queryKey: ['admin-queue-stats'] });
    };
    const retryMut = useMutation({
        mutationFn: (id) => api.post(`/admin/queues/jobs/${id}/retry`),
        onSuccess: () => { invalidate(); toast.success('Nachricht zur Wiederholung eingestellt'); },
        onError: (e) => toast.error(e.message),
    });
    const retryAllMut = useMutation({
        mutationFn: () => api.post('/admin/queues/retry-failed'),
        onSuccess: (r) => { invalidate(); toast.success(`${r.retried} Nachricht${r.retried !== 1 ? 'en' : ''} zur Wiederholung eingestellt`); },
        onError: (e) => toast.error(e.message),
    });
    const deleteMut = useMutation({
        mutationFn: (id) => api.delete(`/admin/queues/jobs/${id}`),
        onSuccess: () => { invalidate(); toast.success('Nachricht gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    const flushMut = useMutation({
        mutationFn: () => api.post('/admin/queues/flush', { state: stateFilter }),
        onSuccess: () => { invalidate(); toast.success('Queue geleert'); },
        onError: (e) => toast.error(e.message),
    });
    const jobs = data?.jobs ?? [];
    const total = data?.total ?? 0;
    const pages = Math.ceil(total / LIMIT);
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("h2", { className: "text-sm font-semibold text-gray-900", children: title }), badge && _jsx("span", { className: "text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600", children: badge }), _jsxs("span", { className: "text-xs text-gray-400", children: [total, " Nachrichten"] })] }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: description })] }), _jsxs("div", { className: "flex items-center gap-2", children: [showRetryAll && jobs.length > 0 && (_jsxs("button", { onClick: () => retryAllMut.mutate(), disabled: retryAllMut.isPending, className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-700 border border-blue-200 rounded hover:bg-blue-50", children: [_jsx(RotateCcw, { size: 12 }), " Alle wiederholen"] })), jobs.length > 0 && (_jsxs("button", { onClick: () => { if (confirm(`Queue „${title}" komplett leeren?`))
                                    flushMut.mutate(); }, disabled: flushMut.isPending, className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50", children: [_jsx(Trash2, { size: 12 }), " Queue leeren"] })), _jsxs("button", { onClick: () => refetch(), className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: [_jsx(RefreshCw, { size: 12 }), " Aktualisieren"] })] })] }), _jsx(JobTable, { jobs: jobs, loading: isLoading, showRetry: showRetry, showDelete: true, onRetry: id => retryMut.mutate(id), onDelete: id => { if (confirm('Nachricht aus Queue löschen?'))
                    deleteMut.mutate(id); }, emptyText: emptyText }), pages > 1 && (_jsxs("div", { className: "flex items-center justify-between text-xs text-gray-500", children: [_jsxs("span", { children: [total, " Nachrichten \u00B7 Seite ", page, " / ", pages] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setPage(1), disabled: page === 1, className: "px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "\u00AB" }), _jsx("button", { onClick: () => setPage(p => p - 1), disabled: page === 1, className: "px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "\u2039 Zur\u00FCck" }), Array.from({ length: Math.min(5, pages) }, (_, i) => {
                                const p = page <= 3 ? i + 1 : page + i - 2;
                                if (p < 1 || p > pages)
                                    return null;
                                return (_jsx("button", { onClick: () => setPage(p), className: `px-2 py-1 border rounded ${p === page ? 'border-accent bg-accent/10 text-accent font-semibold' : 'border-gray-200 hover:bg-gray-50'}`, children: p }, p));
                            }), _jsx("button", { onClick: () => setPage(p => p + 1), disabled: page === pages, className: "px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "Weiter \u203A" }), _jsx("button", { onClick: () => setPage(pages), disabled: page === pages, className: "px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "\u00BB" })] })] }))] }));
}
// ─── Settings Section ─────────────────────────────────────────────────────────
function SettingsSection() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ['admin-queue-settings'],
        queryFn: () => api.get('/admin/queues/settings'),
    });
    const [vals, setVals] = useState(null);
    const loaded = useRef(false);
    useEffect(() => {
        if (data && !loaded.current) {
            setVals(data);
            loaded.current = true;
        }
    }, [data]);
    const save = useMutation({
        mutationFn: (v) => api.put('/admin/queues/settings', v),
        onSuccess: (d) => { void qc.invalidateQueries({ queryKey: ['admin-queue-settings'] }); setVals(d); toast.success('Einstellungen gespeichert'); },
        onError: (e) => toast.error(e.message),
    });
    if (isLoading || !vals)
        return _jsx("div", { className: "py-12 text-center text-gray-400 text-sm", children: "Laden\u2026" });
    const set = (k, v) => setVals(prev => prev ? { ...prev, [k]: v } : prev);
    return (_jsxs("div", { className: "space-y-5 max-w-2xl", children: [_jsxs("div", { className: "card p-5", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700 mb-1", children: "Retry-Verhalten" }), _jsx("p", { className: "text-xs text-gray-500 mb-4", children: "Bei einem Zustellfehler wird die Nachricht mit exponentiellem Backoff erneut versucht. Nach Ersch\u00F6pfen aller Versuche wandert sie in die Dead-Letter-Queue." }), _jsxs("div", { className: "divide-y divide-gray-100", children: [_jsx(NumInput, { label: "Max. Wiederholungsversuche", value: vals.maxRetryAttempts, onChange: v => set('maxRetryAttempts', v), min: 1, max: 50, unit: "Versuche", description: "Anzahl der Gesamtversuche inkl. Erstversuch. Danach \u2192 Dead Letter." }), _jsx(NumInput, { label: "Basis-Backoff-Delay", value: vals.retryBackoffDelaySec, onChange: v => set('retryBackoffDelaySec', v), min: 10, max: 3600, unit: "Sek.", description: "Initiale Wartezeit vor dem ersten Retry. Jeder weitere Versuch verdoppelt die Wartezeit (exponential backoff)." })] }), _jsxs("div", { className: "mt-4 p-3 bg-gray-50 rounded-lg", children: [_jsx("p", { className: "text-xs font-medium text-gray-600 mb-2", children: "Beispiel-Zeitplan (Versuch \u2192 Wartezeit):" }), _jsxs("div", { className: "flex flex-wrap gap-1.5", children: [Array.from({ length: Math.min(vals.maxRetryAttempts, 6) }, (_, i) => {
                                        const delay = vals.retryBackoffDelaySec * Math.pow(2, i);
                                        const label = delay >= 3600 ? `${(delay / 3600).toFixed(1)}h` : delay >= 60 ? `${Math.round(delay / 60)}min` : `${delay}s`;
                                        return (_jsxs("span", { className: "text-xs px-2 py-1 bg-white border border-gray-200 rounded", children: ["#", i + 2, ": +", label] }, i));
                                    }), vals.maxRetryAttempts > 6 && _jsxs("span", { className: "text-xs text-gray-400 px-1 py-1", children: ["\u2026 +", vals.maxRetryAttempts - 6, " weitere"] })] })] })] }), _jsxs("div", { className: "card p-5", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700 mb-1", children: "Aufbewahrungsfristen" }), _jsx("p", { className: "text-xs text-gray-500 mb-4", children: "Bestimmt, wie lange Nachrichten in den verschiedenen Queues aufbewahrt werden, bevor sie automatisch bereinigt werden." }), _jsxs("div", { className: "divide-y divide-gray-100", children: [_jsx(NumInput, { label: "Dead-Letter-Aufbewahrung", value: vals.deadLetterRetentionDays, onChange: v => set('deadLetterRetentionDays', v), min: 1, max: 365, unit: "Tage", description: "Dauerhaft nicht zustellbare Nachrichten bleiben f\u00FCr diese Dauer in der Dead-Letter-Queue sichtbar." }), _jsx(NumInput, { label: "Ausgehende Queue", value: vals.outboundRetentionHours, onChange: v => set('outboundRetentionHours', v), min: 1, max: 720, unit: "Stunden", description: "Nachrichten in der ausgehenden Queue werden sp\u00E4testens nach dieser Zeit aus dem System entfernt." }), _jsx(NumInput, { label: "Zugestellte Nachrichten", value: vals.completedRetentionHours, onChange: v => set('completedRetentionHours', v), min: 1, max: 720, unit: "Stunden", description: "Erfolgreich zugestellte Nachrichten f\u00FCr Queue-History sichtbar halten (max. 100 Eintr\u00E4ge)." })] })] }), _jsxs("div", { className: "card p-5 space-y-4", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Automatisierung" }), _jsxs("div", { className: "flex items-start justify-between py-2", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: "Dead Letter automatisch bereinigen" }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: "Nachrichten in der Dead-Letter-Queue werden nach Ablauf der Aufbewahrungsfrist automatisch gel\u00F6scht." })] }), _jsx(Toggle, { active: vals.autoFlushDead, onToggle: () => set('autoFlushDead', !vals.autoFlushDead) })] }), _jsxs("div", { className: "flex items-start justify-between py-2 border-t border-gray-100", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: "Warnung bei neuen Dead Letters" }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: "Zeigt eine Warnmeldung in der \u00DCbersicht an, wenn neue Nachrichten in die Dead-Letter-Queue wandern." })] }), _jsx(Toggle, { active: vals.notifyOnDeadLetter, onToggle: () => set('notifyOnDeadLetter', !vals.notifyOnDeadLetter) })] })] }), _jsxs("div", { className: "flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700", children: [_jsx(AlertTriangle, { size: 13, className: "shrink-0 mt-0.5 text-blue-500" }), _jsxs("p", { children: [_jsx("strong", { children: "RFC 5321 \u00A7 4.5.4.1" }), ": SMTP-Server m\u00FCssen Zustellversuche mindestens 4\u20135 Tage lang wiederholen. Die empfohlene Mindest-Aufbewahrung f\u00FCr ausgehende Mails betr\u00E4gt daher ", _jsx("strong", { children: "120 Stunden" }), " (5 Tage)."] })] }), _jsxs("button", { onClick: () => save.mutate(vals), disabled: save.isPending, className: "flex items-center gap-2 px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60", children: [_jsx(Save, { size: 14 }), save.isPending ? 'Speichern…' : 'Einstellungen speichern'] })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function QueuesPage() {
    const [section, setSection] = useState('overview');
    const qc = useQueryClient();
    const { data: stats, refetch } = useQuery({
        queryKey: ['admin-queue-stats'],
        queryFn: () => api.get('/admin/queues/stats'),
        refetchInterval: 5_000,
    });
    const deadCount = stats?.failed ?? 0;
    return (_jsxs("div", { className: "h-full flex", children: [_jsxs("nav", { className: "w-44 shrink-0 bg-[#1e2433] flex flex-col py-4 gap-0.5 overflow-y-auto", children: [_jsx("p", { className: "text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2", children: "Warteschlangen" }), SECTIONS.map(s => (_jsxs("button", { onClick: () => setSection(s.key), className: `flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors relative ${section === s.key
                            ? 'bg-white/10 text-white'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'}`, children: [s.icon, _jsx("span", { children: s.label }), s.key === 'deadletter' && deadCount > 0 && (_jsx("span", { className: "ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5 font-bold leading-none", children: deadCount > 99 ? '99+' : deadCount }))] }, s.key)))] }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "p-6 max-w-5xl", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Inbox, { size: 20, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "SMTP-Warteschlangen" }), _jsxs("p", { className: "text-xs text-gray-500", children: [SECTIONS.find(s => s.key === section)?.label, " \u00B7 Live-Aktualisierung alle 5 s"] })] })] }), _jsxs("button", { onClick: () => {
                                        void refetch();
                                        void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
                                    }, className: "flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: [_jsx(RefreshCw, { size: 13 }), " Aktualisieren"] })] }), section === 'overview' && _jsx(OverviewSection, { stats: stats, onSectionChange: setSection }), section === 'outbound' && (_jsx(JobsSection, { stateFilter: "waiting", title: "Ausgehende Nachrichten", description: "Nachrichten, die auf Zustellung warten oder gerade aktiv zugestellt werden.", badge: "Wartend + Aktiv", emptyText: "Keine Nachrichten in der ausgehenden Queue" })), section === 'retry' && (_jsx(JobsSection, { stateFilter: "delayed", title: "Wiederholungsversuche", description: "Fehlgeschlagene Nachrichten mit Backoff-Verz\u00F6gerung \u2014 werden automatisch erneut versucht.", badge: "Exponential Backoff", emptyText: "Keine Nachrichten in der Retry-Queue", showRetry: true })), section === 'deadletter' && (_jsx(JobsSection, { stateFilter: "failed", title: "Dead-Letter-Queue", description: "Alle Retry-Versuche ersch\u00F6pft. Nachrichten manuell wiederholen oder dauerhaft l\u00F6schen.", badge: "Manueller Eingriff erforderlich", emptyText: "Keine Dead-Letter-Nachrichten \u2014 alles in Ordnung!", showRetry: true, showRetryAll: true })), section === 'settings' && _jsx(SettingsSection, {})] }) })] }));
}
