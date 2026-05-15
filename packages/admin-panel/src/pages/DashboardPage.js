import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Mail, Users, Server, AlertTriangle } from 'lucide-react';
import { api } from '../api/client.js';
function StatCard({ label, value, icon: Icon, color }) {
    return (_jsxs("div", { className: "card flex items-center gap-4", children: [_jsx("div", { className: `w-11 h-11 rounded-lg flex items-center justify-center ${color}`, children: _jsx(Icon, { size: 20, className: "text-white" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-gray-900", children: value }), _jsx("p", { className: "text-xs text-gray-500", children: label })] })] }));
}
export function DashboardPage() {
    const { data: queues } = useQuery({
        queryKey: ['admin-queues'],
        queryFn: () => api.get('/admin/queues'),
        refetchInterval: 10_000,
    });
    const { data: domains } = useQuery({
        queryKey: ['admin-domains'],
        queryFn: () => api.get('/admin/domains'),
    });
    const outbound = queues?.find((q) => q.name === 'smtp:outbound')?.count ?? 0;
    const deadLetter = queues?.find((q) => q.name === 'smtp:outbound:dead')?.count ?? 0;
    return (_jsxs("div", { className: "p-6 space-y-6", children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "System\u00FCbersicht" }), _jsxs("div", { className: "grid grid-cols-4 gap-4", children: [_jsx(StatCard, { label: "Domains", value: domains?.length ?? '—', icon: Server, color: "bg-accent" }), _jsx(StatCard, { label: "Ausgehende Queue", value: outbound, icon: Mail, color: "bg-blue-500" }), _jsx(StatCard, { label: "Dead Letters", value: deadLetter, icon: AlertTriangle, color: deadLetter > 0 ? 'bg-red-500' : 'bg-gray-400' }), _jsx(StatCard, { label: "Services", value: "Gesund", icon: Users, color: "bg-green-500" })] }), _jsxs("div", { className: "card", children: [_jsx("h2", { className: "text-sm font-semibold text-gray-700 mb-4", children: "SMTP-Warteschlangen" }), _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-gray-100", children: [_jsx("th", { className: "text-left py-2 font-medium text-gray-500", children: "Queue" }), _jsx("th", { className: "text-right py-2 font-medium text-gray-500", children: "Eintr\u00E4ge" }), _jsx("th", { className: "text-right py-2 font-medium text-gray-500", children: "Status" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-50", children: (queues ?? []).map((q) => (_jsxs("tr", { children: [_jsx("td", { className: "py-2 font-mono text-xs text-gray-600", children: q.name }), _jsx("td", { className: "py-2 text-right font-medium", children: q.count }), _jsx("td", { className: "py-2 text-right", children: q.name.includes('dead') && q.count > 0
                                                ? _jsx("span", { className: "badge-red", children: "Fehler" })
                                                : q.count > 100
                                                    ? _jsx("span", { className: "badge-yellow", children: "Hoch" })
                                                    : _jsx("span", { className: "badge-green", children: "OK" }) })] }, q.name))) })] })] })] }));
}
