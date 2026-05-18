import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Users, Globe, Mail, HardDrive, Activity, AlertTriangle, CheckCircle, Clock, TrendingUp, Inbox, RefreshCw, XCircle, Layers, ShieldCheck, UserPlus, } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, } from 'recharts';
import { api } from '../api/client.js';
// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtNum(n) {
    return n.toLocaleString('de-DE');
}
function timeAgo(iso) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60)
        return `vor ${diff}s`;
    if (diff < 3600)
        return `vor ${Math.floor(diff / 60)}min`;
    if (diff < 86400)
        return `vor ${Math.floor(diff / 3600)}h`;
    return `vor ${Math.floor(diff / 86400)}d`;
}
function barColor(pct) {
    if (pct >= 90)
        return 'bg-red-500';
    if (pct >= 75)
        return 'bg-yellow-400';
    return 'bg-green-500';
}
// ── KPI-Karte ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, color, trend, }) {
    return (_jsxs("div", { className: "card flex flex-col gap-3", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsx("div", { className: `w-10 h-10 rounded-xl flex items-center justify-center ${color}`, children: _jsx(Icon, { size: 18, className: "text-white" }) }), trend && (_jsxs("span", { className: `text-xs font-medium px-2 py-0.5 rounded-full ${trend.value >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`, children: [trend.value >= 0 ? '↑' : '↓', " ", Math.abs(trend.value), " ", trend.label] }))] }), _jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-gray-900 tabular-nums", children: typeof value === 'number' ? fmtNum(value) : value }), _jsx("p", { className: "text-xs font-medium text-gray-500 mt-0.5", children: label }), sub && _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: sub })] })] }));
}
// ── Abschnitt-Titel ───────────────────────────────────────────────────────────
function SectionTitle({ icon: Icon, title }) {
    return (_jsxs("div", { className: "flex items-center gap-2 mb-3", children: [_jsx(Icon, { size: 15, className: "text-gray-400" }), _jsx("h2", { className: "text-sm font-semibold text-gray-700", children: title })] }));
}
// ── Queue-Badge ───────────────────────────────────────────────────────────────
function QueueBadge({ label, value, variant }) {
    const colors = {
        default: 'bg-blue-50 border-blue-100 text-blue-700',
        warn: 'bg-yellow-50 border-yellow-100 text-yellow-700',
        error: 'bg-red-50 border-red-100 text-red-700',
        success: 'bg-green-50 border-green-100 text-green-700',
    };
    return (_jsxs("div", { className: `flex flex-col items-center justify-center border rounded-xl p-4 ${colors[variant]}`, children: [_jsx("p", { className: "text-2xl font-bold tabular-nums", children: fmtNum(value) }), _jsx("p", { className: "text-xs mt-1 font-medium opacity-80", children: label })] }));
}
// ── Tooltip (Recharts) ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
    if (!active || !payload?.length)
        return null;
    return (_jsxs("div", { className: "bg-white border border-gray-200 rounded-lg shadow-md px-3 py-2 text-xs", children: [_jsx("p", { className: "text-gray-500", children: label }), _jsxs("p", { className: "font-semibold text-gray-900", children: [fmtNum(payload[0]?.value ?? 0), " Mails"] })] }));
}
// ── Hauptkomponente ───────────────────────────────────────────────────────────
export function DashboardPage() {
    const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
        queryKey: ['admin-dashboard'],
        queryFn: () => api.get('/admin/dashboard'),
        refetchInterval: 30_000, // alle 30 Sekunden automatisch aktualisieren
    });
    const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('de-DE') : '—';
    if (isLoading) {
        return (_jsx("div", { className: "flex items-center justify-center h-64", children: _jsxs("div", { className: "flex items-center gap-2 text-gray-400", children: [_jsx(RefreshCw, { size: 16, className: "animate-spin" }), _jsx("span", { className: "text-sm", children: "Dashboard wird geladen\u2026" })] }) }));
    }
    if (!data)
        return null;
    const { users, domains, messages, storage, queues, recentErrors, recentAuditEvents } = data;
    const totalQueueItems = queues.waiting + queues.active + queues.delayed;
    const hasQueueProblem = queues.failed > 0;
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-[1400px]", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "System\u00FCbersicht" }), _jsxs("p", { className: "text-xs text-gray-400 mt-0.5", children: ["Letzte Aktualisierung: ", lastUpdate, " \u00B7 Auto-Refresh alle 30s"] })] }), _jsxs("button", { onClick: () => void refetch(), className: "btn-secondary text-xs", title: "Jetzt aktualisieren", children: [_jsx(RefreshCw, { size: 13 }), "Aktualisieren"] })] }), _jsxs("div", { className: "grid grid-cols-2 lg:grid-cols-4 gap-4", children: [_jsx(KpiCard, { icon: Users, color: "bg-blue-500", label: "Benutzer gesamt", value: users.total, sub: `${users.active} aktiv · ${users.inactive} deaktiviert`, trend: { value: users.newWeek, label: 'diese Woche neu' } }), _jsx(KpiCard, { icon: Globe, color: "bg-indigo-500", label: "Domains", value: domains.total, sub: `${data.sharedMailboxes} geteilte Postfächer · ${data.groups} Gruppen` }), _jsx(KpiCard, { icon: Mail, color: "bg-sky-500", label: "E-Mails gesamt", value: messages.total, sub: `${fmtNum(messages.newDay)} heute · ${fmtNum(messages.newWeek)} diese Woche`, trend: { value: messages.newDay, label: 'heute' } }), _jsx(KpiCard, { icon: HardDrive, color: "bg-violet-500", label: "Gesamt-Speicher", value: fmtBytes(storage.totalUsedBytes), sub: `Top-Nutzer: ${storage.topUsers[0]?.displayName ?? '—'} (${fmtBytes(storage.topUsers[0]?.usedBytes ?? 0)})` })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-4", children: [_jsxs("div", { className: "card", children: [_jsx(SectionTitle, { icon: Layers, title: "SMTP-Queue-Status" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(QueueBadge, { label: "Wartend", value: queues.waiting, variant: queues.waiting > 100 ? 'warn' : 'default' }), _jsx(QueueBadge, { label: "Aktiv", value: queues.active, variant: queues.active > 0 ? 'success' : 'default' }), _jsx(QueueBadge, { label: "Fehlerhaft", value: queues.failed, variant: queues.failed > 0 ? 'error' : 'success' }), _jsx(QueueBadge, { label: "Verz\u00F6gert", value: queues.delayed, variant: queues.delayed > 0 ? 'warn' : 'default' })] }), _jsx("div", { className: `mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${hasQueueProblem
                                    ? 'bg-red-50 text-red-700'
                                    : totalQueueItems > 200
                                        ? 'bg-yellow-50 text-yellow-700'
                                        : 'bg-green-50 text-green-700'}`, children: hasQueueProblem
                                    ? _jsxs(_Fragment, { children: [_jsx(XCircle, { size: 13 }), " ", queues.failed, " fehlerhafte Jobs \u2014 \u00DCberpr\u00FCfung empfohlen"] })
                                    : totalQueueItems > 200
                                        ? _jsxs(_Fragment, { children: [_jsx(AlertTriangle, { size: 13 }), " Hohe Queue-Last (", totalQueueItems, " Jobs)"] })
                                        : _jsxs(_Fragment, { children: [_jsx(CheckCircle, { size: 13 }), " Alle Queues im Normalbetrieb"] }) })] }), _jsxs("div", { className: "card lg:col-span-2", children: [_jsx(SectionTitle, { icon: TrendingUp, title: "E-Mail-Aktivit\u00E4t (letzte 7 Tage)" }), _jsx(ResponsiveContainer, { width: "100%", height: 160, children: _jsxs(AreaChart, { data: messages.mailsChart, margin: { top: 4, right: 8, left: -20, bottom: 0 }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "mailGrad", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "5%", stopColor: "#3b82f6", stopOpacity: 0.3 }), _jsx("stop", { offset: "95%", stopColor: "#3b82f6", stopOpacity: 0 })] }) }), _jsx(CartesianGrid, { strokeDasharray: "3 3", stroke: "#f0f0f0" }), _jsx(XAxis, { dataKey: "day", tick: { fontSize: 11, fill: '#9ca3af' }, axisLine: false, tickLine: false }), _jsx(YAxis, { tick: { fontSize: 11, fill: '#9ca3af' }, axisLine: false, tickLine: false, allowDecimals: false }), _jsx(Tooltip, { content: _jsx(ChartTooltip, {}) }), _jsx(Area, { type: "monotone", dataKey: "count", stroke: "#3b82f6", strokeWidth: 2, fill: "url(#mailGrad)" })] }) })] })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-4", children: [_jsxs("div", { className: "card", children: [_jsx(SectionTitle, { icon: HardDrive, title: "Speicher-Ranking (Top 10)" }), _jsxs("div", { className: "space-y-3", children: [storage.topUsers.length === 0 && (_jsx("p", { className: "text-xs text-gray-400 text-center py-4", children: "Keine Daten" })), storage.topUsers.map((u, i) => (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-1", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [_jsxs("span", { className: "text-xs text-gray-400 w-4 shrink-0", children: ["#", i + 1] }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-xs font-medium text-gray-800 truncate", children: u.displayName }), _jsx("p", { className: "text-[11px] text-gray-400 truncate", children: u.email })] })] }), _jsxs("div", { className: "text-right shrink-0 ml-2", children: [_jsx("p", { className: "text-xs font-semibold text-gray-700", children: fmtBytes(u.usedBytes) }), _jsxs("p", { className: "text-[11px] text-gray-400", children: [u.usedPercent, "%"] })] })] }), _jsx("div", { className: "h-1.5 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${barColor(u.usedPercent)}`, style: { width: `${Math.min(u.usedPercent, 100)}%` } }) })] }, u.id)))] })] }), _jsxs("div", { className: "card", children: [_jsx(SectionTitle, { icon: Globe, title: "Domains & Benutzerverteilung" }), domains.list.length === 0 ? (_jsx("p", { className: "text-xs text-gray-400 text-center py-4", children: "Keine Domains konfiguriert" })) : (_jsxs(_Fragment, { children: [_jsx(ResponsiveContainer, { width: "100%", height: 120, children: _jsxs(BarChart, { data: domains.list, margin: { top: 4, right: 8, left: -20, bottom: 4 }, children: [_jsx(CartesianGrid, { strokeDasharray: "3 3", stroke: "#f0f0f0" }), _jsx(XAxis, { dataKey: "name", tick: { fontSize: 10, fill: '#9ca3af' }, axisLine: false, tickLine: false }), _jsx(YAxis, { tick: { fontSize: 10, fill: '#9ca3af' }, axisLine: false, tickLine: false, allowDecimals: false }), _jsx(Tooltip, { formatter: (v) => [`${v} Benutzer`, ''], contentStyle: { fontSize: 12, borderRadius: 8 } }), _jsx(Bar, { dataKey: "userCount", radius: [4, 4, 0, 0], maxBarSize: 40, children: domains.list.map((d, i) => (_jsx(Cell, { fill: ['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'][i % 5] }, d.id))) })] }) }), _jsx("div", { className: "mt-3 divide-y divide-gray-50", children: domains.list.map((d) => (_jsxs("div", { className: "flex items-center justify-between py-1.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `w-2 h-2 rounded-full shrink-0 ${d.active ? 'bg-green-400' : 'bg-gray-300'}` }), _jsx("span", { className: "text-xs font-mono text-gray-700", children: d.name })] }), _jsxs("span", { className: "text-xs text-gray-500", children: [d.userCount, " Benutzer"] })] }, d.id))) })] }))] })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-4", children: [_jsxs("div", { className: "card", children: [_jsx(SectionTitle, { icon: AlertTriangle, title: "Letzte Fehler & Warnungen (30 Tage)" }), recentErrors.length === 0 ? (_jsxs("div", { className: "flex items-center gap-2 py-6 justify-center text-green-600", children: [_jsx(CheckCircle, { size: 16 }), _jsx("span", { className: "text-sm", children: "Keine Fehler in den letzten 30 Tagen" })] })) : (_jsx("div", { className: "space-y-2", children: recentErrors.map((e) => (_jsxs("div", { className: "flex items-start gap-2.5 p-2 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors", children: [_jsx("span", { className: `shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${e.level === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`, children: e.level }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-xs text-gray-700 truncate", children: e.message }), _jsxs("p", { className: "text-[11px] text-gray-400 mt-0.5", children: [_jsx("span", { className: "font-mono", children: e.service }), " \u00B7 ", timeAgo(e.timestamp)] })] })] }, e.id))) }))] }), _jsxs("div", { className: "card", children: [_jsx(SectionTitle, { icon: ShieldCheck, title: "Letzte Admin-Aktionen" }), recentAuditEvents.length === 0 ? (_jsx("p", { className: "text-xs text-gray-400 text-center py-6", children: "Noch keine Aktionen protokolliert" })) : (_jsx("div", { className: "divide-y divide-gray-50", children: recentAuditEvents.map((e) => (_jsxs("div", { className: "flex items-start gap-2.5 py-2.5", children: [_jsx("div", { className: `shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${e.success ? 'bg-green-100' : 'bg-red-100'}`, children: e.success
                                                ? _jsx(CheckCircle, { size: 11, className: "text-green-600" })
                                                : _jsx(XCircle, { size: 11, className: "text-red-600" }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("p", { className: "text-xs text-gray-700", children: [_jsx("span", { className: "font-medium", children: e.actorEmail }), _jsx("span", { className: "text-gray-400", children: " \u00B7 " }), _jsx("span", { className: "font-mono text-gray-600", children: e.action }), e.targetName && (_jsxs("span", { className: "text-gray-400", children: [" \u2192 ", e.targetName] }))] }), _jsxs("p", { className: "text-[11px] text-gray-400 mt-0.5", children: [e.targetType, " \u00B7 ", timeAgo(e.timestamp)] })] })] }, e.id))) }))] })] }), _jsxs("div", { className: "grid grid-cols-2 lg:grid-cols-4 gap-4", children: [_jsxs("div", { className: "card flex items-center gap-3 py-3", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0", children: _jsx(Inbox, { size: 14, className: "text-blue-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Queue-Eintr\u00E4ge" }), _jsx("p", { className: "text-base font-bold text-gray-900", children: fmtNum(totalQueueItems) })] })] }), _jsxs("div", { className: "card flex items-center gap-3 py-3", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0", children: _jsx(Activity, { size: 14, className: "text-green-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Geliefert (kumuliert)" }), _jsx("p", { className: "text-base font-bold text-gray-900", children: fmtNum(queues.completed) })] })] }), _jsxs("div", { className: "card flex items-center gap-3 py-3", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0", children: _jsx(UserPlus, { size: 14, className: "text-purple-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Neue Benutzer (7 Tage)" }), _jsx("p", { className: "text-base font-bold text-gray-900", children: fmtNum(users.newWeek) })] })] }), _jsxs("div", { className: "card flex items-center gap-3 py-3", children: [_jsx("div", { className: "w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center shrink-0", children: _jsx(Clock, { size: 14, className: "text-orange-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Mails heute eingegangen" }), _jsx("p", { className: "text-base font-bold text-gray-900", children: fmtNum(messages.newDay) })] })] })] })] }));
}
