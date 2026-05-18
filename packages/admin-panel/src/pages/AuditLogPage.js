import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Download, Trash2, Search, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtDt(iso) {
    return new Date(iso).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
}
function ActionBadge({ action }) {
    const color = action.startsWith('CREATE') ? 'bg-green-100 text-green-700'
        : action.startsWith('DELETE') ? 'bg-red-100 text-red-700'
            : action.startsWith('UPDATE') || action.startsWith('PUT') ? 'bg-blue-100 text-blue-700'
                : action.startsWith('LOGIN') ? 'bg-purple-100 text-purple-700'
                    : 'bg-gray-100 text-gray-600';
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${color}`, children: action }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 100;
export function AuditLogPage() {
    const qc = useQueryClient();
    const [filters, setFilters] = useState({
        action: '', targetType: '', from: '', to: '', success: '',
    });
    const [offset, setOffset] = useState(0);
    const [expandedId, setExpandedId] = useState(null);
    const query = useQuery({
        queryKey: ['admin-audit-log', filters, offset],
        queryFn: () => {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
            if (filters.action)
                params.set('action', filters.action);
            if (filters.targetType)
                params.set('targetType', filters.targetType);
            if (filters.from)
                params.set('from', new Date(filters.from).toISOString());
            if (filters.to)
                params.set('to', new Date(filters.to + 'T23:59:59').toISOString());
            if (filters.success !== '')
                params.set('success', filters.success);
            return api.get(`/admin/audit-log?${params.toString()}`);
        },
    });
    const purge = useMutation({
        mutationFn: (days) => api.delete(`/admin/audit-log/purge?olderThanDays=${days}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-audit-log'] }); toast.success('Einträge gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    const handleExport = () => {
        const params = new URLSearchParams();
        if (filters.action)
            params.set('action', filters.action);
        if (filters.targetType)
            params.set('targetType', filters.targetType);
        if (filters.from)
            params.set('from', new Date(filters.from).toISOString());
        if (filters.to)
            params.set('to', new Date(filters.to + 'T23:59:59').toISOString());
        window.open(`/api/v1/admin/audit-log/export?${params.toString()}`, '_blank');
    };
    const data = query.data;
    const entries = data?.entries ?? [];
    const total = data?.total ?? 0;
    const pages = Math.ceil(total / PAGE_SIZE);
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const setFilter = (k, v) => {
        setFilters(f => ({ ...f, [k]: v }));
        setOffset(0);
    };
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(ClipboardList, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Audit-Log" }), _jsx("p", { className: "text-sm text-gray-500", children: "Alle Admin-Aktionen protokolliert" })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: handleExport, className: "flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50", children: [_jsx(Download, { size: 14 }), " CSV exportieren"] }), _jsxs("button", { onClick: () => { if (confirm('Einträge älter als 90 Tage löschen?'))
                                    purge.mutate(90); }, className: "flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded hover:bg-red-50", children: [_jsx(Trash2, { size: 14 }), " Bereinigen"] })] })] }), _jsxs("div", { className: "flex flex-wrap gap-2 mb-4", children: [_jsxs("div", { className: "flex items-center gap-1.5 bg-white border border-gray-300 rounded px-3 py-1.5", children: [_jsx(Search, { size: 13, className: "text-gray-400" }), _jsx("input", { value: filters.action, onChange: e => setFilter('action', e.target.value), className: "w-36 text-sm focus:outline-none", placeholder: "Aktion\u2026" })] }), _jsx("input", { value: filters.targetType, onChange: e => setFilter('targetType', e.target.value), className: "border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36", placeholder: "Zieltyp\u2026" }), _jsx("input", { type: "date", value: filters.from, onChange: e => setFilter('from', e.target.value), className: "border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), _jsx("input", { type: "date", value: filters.to, onChange: e => setFilter('to', e.target.value), className: "border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("select", { value: filters.success, onChange: e => setFilter('success', e.target.value), className: "border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "", children: "Alle" }), _jsx("option", { value: "true", children: "Erfolgreich" }), _jsx("option", { value: "false", children: "Fehlgeschlagen" })] }), (filters.action || filters.targetType || filters.from || filters.to || filters.success) && (_jsx("button", { onClick: () => { setFilters({ action: '', targetType: '', from: '', to: '', success: '' }); setOffset(0); }, className: "px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50", children: "Filter zur\u00FCcksetzen" }))] }), _jsxs("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: [_jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Zeitpunkt" }), _jsx("th", { className: "text-left px-4 py-3", children: "Akteur" }), _jsx("th", { className: "text-left px-4 py-3", children: "Aktion" }), _jsx("th", { className: "text-left px-4 py-3", children: "Ziel" }), _jsx("th", { className: "text-left px-4 py-3", children: "IP" }), _jsx("th", { className: "text-center px-4 py-3", children: "Status" })] }) }), _jsx("tbody", { children: query.isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : entries.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Keine Eintr\u00E4ge gefunden" }) })) : entries.map(e => (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50 cursor-pointer", onClick: () => setExpandedId(expandedId === e.id ? null : e.id), children: [_jsx("td", { className: "px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap", children: fmtDt(e.timestamp) }), _jsx("td", { className: "px-4 py-2.5", children: _jsx("p", { className: "text-gray-900 text-xs font-medium", children: e.actorEmail }) }), _jsx("td", { className: "px-4 py-2.5", children: _jsx(ActionBadge, { action: e.action }) }), _jsxs("td", { className: "px-4 py-2.5 text-xs text-gray-600", children: [_jsx("span", { className: "text-gray-400", children: e.targetType }), e.targetName && _jsx("span", { className: "ml-1 text-gray-700", children: e.targetName })] }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-500 font-mono", children: e.ipAddress ?? '—' }), _jsx("td", { className: "px-4 py-2.5 text-center", children: e.success
                                                        ? _jsx(CheckCircle2, { size: 15, className: "text-green-500 mx-auto" })
                                                        : _jsx(XCircle, { size: 15, className: "text-red-500 mx-auto" }) })] }, e.id), expandedId === e.id && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-0", children: _jsx("div", { className: "bg-gray-50 border-t border-gray-100 px-8 py-3", children: _jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [e.targetId && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Ziel-ID: " }), _jsx("span", { className: "font-mono text-gray-700", children: e.targetId })] }), e.actorId && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Akteur-ID: " }), _jsx("span", { className: "font-mono text-gray-700", children: e.actorId })] }), e.errorMsg && _jsxs("div", { className: "col-span-3", children: [_jsx("span", { className: "text-red-500", children: "Fehler: " }), _jsx("span", { className: "text-gray-700", children: e.errorMsg })] }), e.changes && Object.keys(e.changes).length > 0 && (_jsxs("div", { className: "col-span-3", children: [_jsx("span", { className: "text-gray-500", children: "\u00C4nderungen: " }), _jsx("pre", { className: "inline text-gray-700 text-xs", children: JSON.stringify(e.changes, null, 2) })] }))] }) }) }) }, `${e.id}-detail`))] }))) })] }), total > PAGE_SIZE && (_jsxs("div", { className: "px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500", children: [_jsxs("span", { children: [total.toLocaleString('de-DE'), " Eintr\u00E4ge \u00B7 Seite ", page, " / ", pages] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)), disabled: offset === 0, className: "px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "\u2190 Zur\u00FCck" }), _jsx("button", { onClick: () => setOffset(offset + PAGE_SIZE), disabled: offset + PAGE_SIZE >= total, className: "px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40", children: "Weiter \u2192" })] })] }))] })] }));
}
