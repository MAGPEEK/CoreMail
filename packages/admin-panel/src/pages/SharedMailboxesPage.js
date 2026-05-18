import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Inbox, Plus, Trash2, Pencil, UserPlus, X, Loader2, Shield } from 'lucide-react';
import { api } from '../api/client.js';
const PERM_LABELS = {
    FULL_ACCESS: 'Vollzugriff', SEND_AS: 'Senden als',
    SEND_ON_BEHALF: 'Im Auftrag senden', READ_ONLY: 'Nur lesen',
};
export function SharedMailboxesPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [page, setPage] = useState(1);
    const [limit] = useState(50);
    const [editItem, setEditItem] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [permItem, setPermItem] = useState(null);
    useMemo(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(t);
    }, [search]);
    const { data, isLoading } = useQuery({
        queryKey: ['admin-shared-mailboxes', debouncedSearch, page, limit],
        queryFn: () => api.get(`/api/v1/admin/shared-mailboxes?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/shared-mailboxes/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Gelöscht'); },
        onError: () => toast.error('Löschen fehlgeschlagen'),
    });
    const items = data?.items ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Inbox, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "Freigegebene Postf\u00E4cher" }), _jsxs("p", { className: "text-sm text-gray-500", children: [total, " Postfach", total !== 1 ? 'fächer' : ''] })] })] }), _jsxs("button", { onClick: () => setCreateOpen(true), className: "flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Neues Postfach"] })] }), _jsxs("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: [_jsx("div", { className: "p-3 border-b border-gray-200", children: _jsx("input", { value: search, onChange: e => { setSearch(e.target.value); setPage(1); }, placeholder: "Postf\u00E4cher durchsuchen\u2026", className: "input max-w-sm" }) }), isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade\u2026"] })) : items.length === 0 ? (_jsx("div", { className: "text-center py-12 text-gray-400 text-sm", children: "Keine freigegebenen Postf\u00E4cher" })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "E-Mail / Name" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Berechtigungen" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: items.map(item => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900 text-sm", children: item.email }), _jsx("p", { className: "text-xs text-gray-400", children: item.displayName })] }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex flex-wrap gap-1", children: [item.permissions.length === 0
                                                        ? _jsx("span", { className: "text-xs text-gray-400", children: "\u2013" })
                                                        : item.permissions.slice(0, 3).map(p => (_jsxs("span", { className: "px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs", children: [p.user.email.split('@')[0], " \u00B7 ", PERM_LABELS[p.permission]] }, p.id))), item.permissions.length > 3 && (_jsxs("span", { className: "text-xs text-gray-400", children: ["+", item.permissions.length - 3] }))] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `px-2 py-0.5 rounded text-xs font-medium ${item.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: item.active ? 'Aktiv' : 'Inaktiv' }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setPermItem(item), title: "Berechtigungen", className: "p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors", children: _jsx(Shield, { size: 14 }) }), _jsx("button", { onClick: () => setEditItem(item), title: "Bearbeiten", className: "p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (window.confirm(`"${item.email}" löschen?`))
                                                            deleteMutation.mutate(item.id); }, title: "L\u00F6schen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, item.id))) })] })), pages > 1 && (_jsxs("div", { className: "flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500", children: [_jsxs("span", { children: [total, " Eintr\u00E4ge"] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u2039" }), _jsxs("span", { className: "px-3 py-1", children: ["Seite ", page, " / ", pages] }), _jsx("button", { onClick: () => setPage(p => Math.min(pages, p + 1)), disabled: page === pages, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u203A" })] })] }))] }), createOpen && _jsx(SharedMailboxModal, { onClose: () => setCreateOpen(false) }), editItem && _jsx(SharedMailboxModal, { item: editItem, onClose: () => setEditItem(null) }), permItem && _jsx(PermissionsModal, { item: permItem, onClose: () => setPermItem(null) })] }));
}
// ── Create/Edit Modal ─────────────────────────────────────────────────────────
function SharedMailboxModal({ item, onClose }) {
    const qc = useQueryClient();
    const [email, setEmail] = useState(item?.email ?? '');
    const [name, setName] = useState(item?.displayName ?? '');
    const [domainId, setDomainId] = useState(item?.domainId ?? '');
    const [active, setActive] = useState(item?.active ?? true);
    const { data: domains = [] } = useQuery({
        queryKey: ['admin-domains-list'],
        queryFn: () => api.get('/admin/domains?limit=500').then(r => r.domains),
    });
    const mutation = useMutation({
        mutationFn: () => item
            ? api.put(`/api/v1/admin/shared-mailboxes/${item.id}`, { displayName: name, active })
            : api.post('/api/v1/admin/shared-mailboxes', { email, displayName: name, domainId }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
            toast.success(item ? 'Gespeichert' : 'Erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message || 'Fehler'),
    });
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-md", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: item ? 'Postfach bearbeiten' : 'Neues freigegebenes Postfach' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [!item && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "E-Mail-Adresse" }), _jsx("input", { value: email, onChange: e => setEmail(e.target.value), className: "input", placeholder: "support@domain.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Domain" }), _jsxs("select", { value: domainId, onChange: e => setDomainId(e.target.value), className: "input", children: [_jsx("option", { value: "", children: "Domain w\u00E4hlen\u2026" }), domains.map(d => _jsx("option", { value: d.id, children: d.name }, d.id))] })] })] })), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Anzeigename" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input", placeholder: "Support-Team" })] }), item && (_jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: active, onChange: e => setActive(e.target.checked), className: "rounded" }), "Aktiv"] })), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name || (!item && (!email || !domainId)), className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), item ? 'Speichern' : 'Erstellen'] })] })] })] }) }));
}
// ── Permissions Modal ─────────────────────────────────────────────────────────
function PermissionsModal({ item, onClose }) {
    const qc = useQueryClient();
    const [userId, setUserId] = useState('');
    const [permission, setPerm] = useState('FULL_ACCESS');
    const [userSearch, setUserSearch] = useState('');
    const { data: users = [] } = useQuery({
        queryKey: ['admin-users-list', userSearch],
        queryFn: () => api.get(`/admin/mailboxes`).then(r => Array.isArray(r) ? r.filter(u => u.email.includes(userSearch) || (u.displayName ?? '').includes(userSearch)).slice(0, 50) : []),
        enabled: userSearch.length > 1,
    });
    const addMutation = useMutation({
        mutationFn: () => api.post(`/api/v1/admin/shared-mailboxes/${item.id}/permissions`, { userId, permission }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Berechtigung hinzugefügt'); setUserId(''); setUserSearch(''); },
        onError: () => toast.error('Fehler'),
    });
    const removeMutation = useMutation({
        mutationFn: (uid) => api.delete(`/api/v1/admin/shared-mailboxes/${item.id}/permissions/${uid}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Entfernt'); },
        onError: () => toast.error('Fehler'),
    });
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-lg", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200", children: [_jsxs("div", { children: [_jsx("h2", { className: "font-semibold text-gray-900", children: "Berechtigungen" }), _jsx("p", { className: "text-xs text-gray-500", children: item.email })] }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [item.permissions.length === 0 && (_jsx("p", { className: "text-sm text-gray-400 text-center py-2", children: "Noch keine Berechtigungen" })), item.permissions.map(p => (_jsxs("div", { className: "flex items-center justify-between p-2 bg-gray-50 rounded-lg", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: p.user.displayName }), _jsxs("p", { className: "text-xs text-gray-500", children: [p.user.email, " \u00B7 ", PERM_LABELS[p.permission]] })] }), _jsx("button", { onClick: () => removeMutation.mutate(p.userId), className: "p-1 text-gray-400 hover:text-red-600 transition-colors", children: _jsx(X, { size: 14 }) })] }, p.id)))] }), _jsxs("div", { className: "border-t border-gray-200 pt-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase mb-2", children: "Berechtigung hinzuf\u00FCgen" }), _jsxs("div", { className: "space-y-2", children: [_jsx("input", { value: userSearch, onChange: e => setUserSearch(e.target.value), className: "input", placeholder: "Benutzer suchen\u2026" }), users.length > 0 && (_jsx("select", { size: 4, value: userId, onChange: e => setUserId(e.target.value), className: "input h-auto", children: users.map(u => _jsxs("option", { value: u.id, children: [u.displayName, " (", u.email, ")"] }, u.id)) })), _jsx("select", { value: permission, onChange: e => setPerm(e.target.value), className: "input", children: Object.entries(PERM_LABELS).map(([k, v]) => (_jsx("option", { value: k, children: v }, k))) }), _jsxs("button", { onClick: () => addMutation.mutate(), disabled: !userId || addMutation.isPending, className: "btn-primary w-full flex items-center justify-center gap-1.5", children: [addMutation.isPending ? _jsx(Loader2, { size: 14, className: "animate-spin" }) : _jsx(UserPlus, { size: 14 }), "Hinzuf\u00FCgen"] })] })] })] })] }) }));
}
