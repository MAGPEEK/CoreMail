import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api } from '../api/client.js';
const LEVEL_BADGE = {
    ERROR: 'badge-red',
    WARN: 'badge-yellow',
    INFO: 'badge-blue',
    DEBUG: 'badge-gray',
};
export function LogsPage() {
    const [level, setLevel] = useState('');
    const [service, setService] = useState('');
    const [q, setQ] = useState('');
    const params = new URLSearchParams({ limit: '100' });
    if (level)
        params.set('level', level);
    if (service)
        params.set('service', service);
    if (q)
        params.set('q', q);
    const { data } = useQuery({
        queryKey: ['admin-logs', level, service, q],
        queryFn: () => api.get(`/admin/logs?${params}`),
        refetchInterval: 15_000,
    });
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "System-Protokolle" }), _jsxs("div", { className: "flex gap-3 flex-wrap", children: [_jsxs("select", { className: "input w-40", value: level, onChange: (e) => setLevel(e.target.value), children: [_jsx("option", { value: "", children: "Alle Level" }), ['ERROR', 'WARN', 'INFO', 'DEBUG'].map((l) => _jsx("option", { value: l, children: l }, l))] }), _jsx("input", { className: "input w-44", placeholder: "Service filtern...", value: service, onChange: (e) => setService(e.target.value) }), _jsx("input", { className: "input flex-1 min-w-48", placeholder: "Nachricht suchen...", value: q, onChange: (e) => setQ(e.target.value) })] }), _jsxs("div", { className: "card p-0 overflow-hidden", children: [_jsxs("div", { className: "px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500", children: [data?.total ?? 0, " Eintr\u00E4ge"] }), _jsxs("div", { className: "overflow-x-auto", children: [_jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsx("tr", { children: ['Zeit', 'Level', 'Service', 'Nachricht'].map((h) => (_jsx("th", { className: "text-left px-3 py-2 font-medium text-gray-500", children: h }, h))) }) }), _jsx("tbody", { className: "divide-y divide-gray-50", children: (data?.logs ?? []).map((log) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors font-mono", children: [_jsx("td", { className: "px-3 py-1.5 text-gray-400 whitespace-nowrap", children: format(new Date(log.timestamp), 'HH:mm:ss.SSS') }), _jsx("td", { className: "px-3 py-1.5", children: _jsx("span", { className: `badge ${LEVEL_BADGE[log.level] ?? 'badge-gray'}`, children: log.level }) }), _jsx("td", { className: "px-3 py-1.5 text-gray-500 whitespace-nowrap", children: log.service }), _jsx("td", { className: "px-3 py-1.5 text-gray-700 max-w-lg truncate", children: log.message })] }, log.id))) })] }), (data?.logs ?? []).length === 0 && (_jsx("div", { className: "py-8 text-center text-gray-400 text-sm", children: "Keine Protokolleintr\u00E4ge" }))] })] })] }));
}
