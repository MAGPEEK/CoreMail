import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Smartphone, Trash2, WifiOff, Loader2, ShieldOff } from 'lucide-react';
import { api } from '../api/client.js';
function StatusBadge({ status }) {
    const base = 'px-2 py-0.5 rounded text-xs font-medium';
    if (status === 'OK')
        return _jsx("span", { className: `${base} bg-green-100 text-green-700`, children: "OK" });
    if (status === 'PENDING')
        return _jsx("span", { className: `${base} bg-yellow-100 text-yellow-700`, children: "Ausstehend" });
    if (status === 'BLOCKED')
        return _jsx("span", { className: `${base} bg-red-100 text-red-700`, children: "Gesperrt" });
    if (status === 'WIPED')
        return _jsx("span", { className: `${base} bg-gray-100 text-gray-500`, children: "Gel\u00F6scht" });
    return _jsx("span", { className: `${base} bg-gray-100 text-gray-600`, children: status });
}
export function MobileDevicesPage() {
    const qc = useQueryClient();
    const [statusFilter, setStatusFilter] = useState('');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [limit] = useState(50);
    const { data, isLoading } = useQuery({
        queryKey: ['admin-mobile-devices', statusFilter, search, page, limit],
        queryFn: () => api.get(`/api/v1/admin/mobile/devices?status=${statusFilter}&search=${encodeURIComponent(search)}&page=${page}&limit=${limit}`),
        refetchInterval: 30_000,
    });
    const statusMutation = useMutation({
        mutationFn: ({ id, status }) => api.patch(`/api/v1/admin/mobile/devices/${id}/status`, { status }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Status aktualisiert'); },
        onError: () => toast.error('Fehler'),
    });
    const wipeMutation = useMutation({
        mutationFn: (id) => api.post(`/api/v1/admin/mobile/devices/${id}/wipe`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Remote Wipe angefordert'); },
        onError: () => toast.error('Fehler'),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/mobile/devices/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Gerät entfernt'); },
        onError: () => toast.error('Fehler'),
    });
    const items = data?.items ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(Smartphone, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "Mobile Ger\u00E4te" }), _jsxs("p", { className: "text-sm text-gray-500", children: [total, " Ger\u00E4t", total !== 1 ? 'e' : '', " registriert"] })] })] }), _jsxs("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: [_jsxs("div", { className: "flex gap-3 p-3 border-b border-gray-200", children: [_jsx("input", { value: search, onChange: e => { setSearch(e.target.value); setPage(1); }, placeholder: "Ger\u00E4t oder Benutzer suchen\u2026", className: "input max-w-xs" }), _jsxs("select", { value: statusFilter, onChange: e => { setStatusFilter(e.target.value); setPage(1); }, className: "input w-44", children: [_jsx("option", { value: "", children: "Alle Status" }), _jsx("option", { value: "OK", children: "OK" }), _jsx("option", { value: "PENDING", children: "Ausstehend" }), _jsx("option", { value: "BLOCKED", children: "Gesperrt" }), _jsx("option", { value: "WIPED", children: "Gel\u00F6scht" })] })] }), isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade\u2026"] })) : items.length === 0 ? (_jsxs("div", { className: "text-center py-12 text-gray-400 text-sm", children: [_jsx(Smartphone, { size: 28, className: "mx-auto mb-2 opacity-30" }), "Keine Ger\u00E4te gefunden"] })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Ger\u00E4t" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Benutzer" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Letzter Sync" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: items.map(device => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Smartphone, { size: 16, className: "text-gray-400 shrink-0" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: device.deviceFriendlyName || device.deviceType || 'Unbekanntes Gerät' }), _jsxs("p", { className: "text-xs text-gray-400 font-mono", children: [device.deviceId.slice(0, 16), "\u2026"] })] })] }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "text-sm text-gray-900", children: device.user.displayName }), _jsx("p", { className: "text-xs text-gray-400", children: device.user.email })] }), _jsx("td", { className: "px-4 py-3", children: _jsx(StatusBadge, { status: device.status }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "text-xs text-gray-500", children: device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString('de-DE') : '–' }), device.remoteWipeAt && (_jsxs("p", { className: "text-xs text-red-500", children: ["Wipe: ", new Date(device.remoteWipeAt).toLocaleDateString('de-DE')] }))] }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [device.status !== 'BLOCKED' && device.status !== 'WIPED' && (_jsx("button", { onClick: () => statusMutation.mutate({ id: device.id, status: 'BLOCKED' }), title: "Sperren", className: "p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors", children: _jsx(ShieldOff, { size: 14 }) })), device.status === 'BLOCKED' && (_jsx("button", { onClick: () => statusMutation.mutate({ id: device.id, status: 'OK' }), title: "Entsperren", className: "p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors text-xs font-medium px-2", children: "OK" })), device.status !== 'WIPED' && (_jsx("button", { onClick: () => { if (window.confirm(`Remote Wipe für "${device.deviceFriendlyName || device.deviceId}" anfordern? Dies löscht alle Daten auf dem Gerät!`))
                                                            wipeMutation.mutate(device.id); }, title: "Remote Wipe", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(WifiOff, { size: 14 }) })), _jsx("button", { onClick: () => { if (window.confirm('Gerät deregistrieren?'))
                                                            deleteMutation.mutate(device.id); }, title: "Entfernen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, device.id))) })] })), pages > 1 && (_jsxs("div", { className: "flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500", children: [_jsxs("span", { children: [total, " Ger\u00E4te"] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u2039" }), _jsxs("span", { className: "px-3 py-1", children: ["Seite ", page, " / ", pages] }), _jsx("button", { onClick: () => setPage(p => Math.min(pages, p + 1)), disabled: page === pages, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u203A" })] })] }))] })] }));
}
