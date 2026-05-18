import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldHalf, Search, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Role Metadata ────────────────────────────────────────────────────────────
const ROLE_META = {
    ORGANIZATION_MANAGEMENT: {
        label: 'Organization Management',
        description: 'Vollzugriff auf alle BCP-Bereiche',
        color: 'bg-red-100 text-red-700',
    },
    RECIPIENT_MANAGEMENT: {
        label: 'Recipient Management',
        description: 'Empfänger, Gruppen, Postfächer verwalten',
        color: 'bg-orange-100 text-orange-700',
    },
    SERVER_MANAGEMENT: {
        label: 'Server Management',
        description: 'Server, Zertifikate, Queues verwalten',
        color: 'bg-yellow-100 text-yellow-700',
    },
    COMPLIANCE_MANAGEMENT: {
        label: 'Compliance Management',
        description: 'eDiscovery, Journaling, Aufbewahrung',
        color: 'bg-purple-100 text-purple-700',
    },
    HYGIENE_MANAGEMENT: {
        label: 'Hygiene Management',
        description: 'Spam-/Malware-Schutzrichtlinien',
        color: 'bg-blue-100 text-blue-700',
    },
    HELP_DESK: {
        label: 'Help Desk',
        description: 'Passwort-Reset, Postfach-Status',
        color: 'bg-cyan-100 text-cyan-700',
    },
    VIEW_ONLY_ORG: {
        label: 'View Only Organization',
        description: 'Nur-Lesen auf alle Einstellungen',
        color: 'bg-gray-100 text-gray-600',
    },
    USER: {
        label: 'User',
        description: 'Kein Administratorzugriff',
        color: 'bg-gray-100 text-gray-400',
    },
};
function RoleBadge({ role }) {
    const m = ROLE_META[role];
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.color}`, children: m.label }));
}
// ─── Role Selector ────────────────────────────────────────────────────────────
function RoleSelector({ userId, currentRole }) {
    const qc = useQueryClient();
    const [open, setOpen] = useState(false);
    const update = useMutation({
        mutationFn: (role) => api.put(`/admin/mailboxes/${userId}`, { role }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-rbac-users'] });
            toast.success('Rolle aktualisiert');
            setOpen(false);
        },
        onError: (e) => toast.error(e.message),
    });
    const adminRoles = [
        'ORGANIZATION_MANAGEMENT', 'RECIPIENT_MANAGEMENT', 'SERVER_MANAGEMENT',
        'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'HELP_DESK', 'VIEW_ONLY_ORG', 'USER',
    ];
    return (_jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setOpen(o => !o), className: "flex items-center gap-1.5 px-2 py-1 rounded border border-gray-200 hover:border-accent hover:bg-accent/5 transition-colors", children: [_jsx(RoleBadge, { role: currentRole }), _jsx(ChevronDown, { size: 11, className: "text-gray-400" })] }), open && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-10", onClick: () => setOpen(false) }), _jsx("div", { className: "absolute right-0 top-full mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-20 py-1 overflow-hidden", children: adminRoles.map(r => {
                            const m = ROLE_META[r];
                            return (_jsxs("button", { onClick: () => update.mutate(r), className: `w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-start gap-3 ${r === currentRole ? 'bg-accent/5' : ''}`, children: [_jsx("div", { className: "pt-0.5", children: _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.color}`, children: m.label }) }), _jsx("div", { children: _jsx("p", { className: "text-xs text-gray-500", children: m.description }) }), r === currentRole && _jsx("span", { className: "ml-auto text-accent text-xs", children: "\u2713" })] }, r));
                        }) })] }))] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function RbacPage() {
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('ALL');
    const { data, isLoading } = useQuery({
        queryKey: ['admin-rbac-users'],
        queryFn: () => api.get('/admin/mailboxes?limit=500'),
    });
    const users = Array.isArray(data)
        ? data
        : (data?.mailboxes ?? data?.users ?? []);
    const filtered = users.filter(u => {
        if (roleFilter === 'ADMINS' && u.role === 'USER')
            return false;
        if (roleFilter !== 'ALL' && roleFilter !== 'ADMINS' && u.role !== roleFilter)
            return false;
        if (search && !u.displayName.toLowerCase().includes(search.toLowerCase()) &&
            !u.email.toLowerCase().includes(search.toLowerCase()))
            return false;
        return true;
    });
    const adminCount = users.filter(u => u.role !== 'USER').length;
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(ShieldHalf, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Berechtigungen (RBAC)" }), _jsxs("p", { className: "text-sm text-gray-500", children: [users.length, " Benutzer \u00B7 ", adminCount, " mit Admin-Rollen"] })] })] }), _jsxs("div", { className: "bg-white rounded-lg border border-gray-200 p-4 mb-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3", children: "Rollenbeschreibungen" }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: Object.entries(ROLE_META)
                            .filter(([r]) => r !== 'USER')
                            .map(([role, m]) => (_jsxs("div", { className: "flex items-start gap-2", children: [_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${m.color}`, children: m.label }), _jsx("span", { className: "text-xs text-gray-500", children: m.description })] }, role))) })] }), _jsxs("div", { className: "flex gap-3 mb-4", children: [_jsxs("div", { className: "flex items-center gap-2 bg-white border border-gray-300 rounded px-3 py-1.5 flex-1 max-w-xs", children: [_jsx(Search, { size: 14, className: "text-gray-400" }), _jsx("input", { value: search, onChange: e => setSearch(e.target.value), className: "flex-1 text-sm focus:outline-none", placeholder: "Name oder E-Mail\u2026" })] }), _jsxs("select", { value: roleFilter, onChange: e => setRoleFilter(e.target.value), className: "border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "ALL", children: "Alle Rollen" }), _jsx("option", { value: "ADMINS", children: "Nur Admins" }), Object.keys(ROLE_META).map(r => (_jsx("option", { value: r, children: ROLE_META[r].label }, r)))] })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Benutzer" }), _jsx("th", { className: "text-left px-4 py-3", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3", children: "Aktuelle Rolle" }), _jsx("th", { className: "text-right px-4 py-3", children: "Rolle \u00E4ndern" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : filtered.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "text-center py-12 text-gray-400", children: "Keine Benutzer gefunden" }) })) : filtered.map(u => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: u.displayName }), _jsx("p", { className: "text-xs text-gray-500", children: u.email })] }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${u.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: u.active ? 'Aktiv' : 'Inaktiv' }) }), _jsx("td", { className: "px-4 py-3", children: _jsx(RoleBadge, { role: u.role }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsx(RoleSelector, { userId: u.id, currentRole: u.role }) })] }, u.id))) })] }) })] }));
}
