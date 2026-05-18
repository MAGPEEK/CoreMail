import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Pencil, Trash2, RotateCcw, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
const ALL_SCOPES = ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews', 'admin'];
// ─── Client Modal ─────────────────────────────────────────────────────────────
function ClientModal({ client, onClose }) {
    const qc = useQueryClient();
    const isEdit = client !== null;
    const [form, setForm] = useState({
        name: client?.name ?? '',
        description: client?.description ?? '',
        redirectUris: client?.redirectUris.join('\n') ?? '',
        allowedScopes: client?.allowedScopes ?? ['openid', 'email', 'mail', 'ews'],
        trusted: client?.trusted ?? false,
    });
    const toggleScope = (s) => setForm(f => ({
        ...f,
        allowedScopes: f.allowedScopes.includes(s)
            ? f.allowedScopes.filter(x => x !== s)
            : [...f.allowedScopes, s],
    }));
    const save = useMutation({
        mutationFn: () => {
            const body = {
                name: form.name,
                description: form.description,
                redirectUris: form.redirectUris.split('\n').map(s => s.trim()).filter(Boolean),
                allowedScopes: form.allowedScopes,
                trusted: form.trusted,
            };
            return isEdit
                ? api.put(`/admin/oauth/clients/${client.id}`, body)
                : api.post('/admin/oauth/clients', body);
        },
        onSuccess: (res) => {
            void qc.invalidateQueries({ queryKey: ['admin-oauth-clients'] });
            const r = res;
            if (r?.rawSecret) {
                toast.success(`Client erstellt! Secret (einmalig): ${r.rawSecret}`, { duration: 15000 });
            }
            else {
                toast.success(isEdit ? 'Client aktualisiert' : 'Client erstellt');
            }
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'OAuth2-Client bearbeiten' : 'Neuer OAuth2-Client' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Name *" }), _jsx("input", { value: form.name, onChange: e => setForm(f => ({ ...f, name: e.target.value })), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. Outlook Modern Auth" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("input", { value: form.description, onChange: e => setForm(f => ({ ...f, description: e.target.value })), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { children: [_jsxs("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: ["Redirect-URIs ", _jsx("span", { className: "text-gray-400", children: "(eine pro Zeile)" })] }), _jsx("textarea", { value: form.redirectUris, onChange: e => setForm(f => ({ ...f, redirectUris: e.target.value })), rows: 3, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none", placeholder: "https://app.example.com/callback" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-2", children: "Erlaubte Scopes" }), _jsx("div", { className: "flex flex-wrap gap-2", children: ALL_SCOPES.map(s => (_jsx("button", { onClick: () => toggleScope(s), className: `px-2.5 py-1 rounded text-xs font-medium border transition-colors ${form.allowedScopes.includes(s)
                                            ? 'bg-accent text-white border-accent'
                                            : 'border-gray-300 text-gray-600 hover:border-accent'}`, children: s }, s))) })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.trusted, onChange: e => setForm(f => ({ ...f, trusted: e.target.checked })), className: "accent-accent" }), _jsxs("div", { children: [_jsx("span", { className: "text-sm text-gray-700", children: "Vertrauensw\u00FCrdiger Client" }), _jsx("p", { className: "text-xs text-gray-500", children: "\u00DCberspringt Zustimmungsdialog (z.B. eigene First-Party-Apps)" })] })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.name || !form.redirectUris.trim(), className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function OAuthClientsPage() {
    const qc = useQueryClient();
    const [tab, setTab] = useState('clients');
    const [modal, setModal] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data: clients = [], isLoading } = useQuery({
        queryKey: ['admin-oauth-clients'],
        queryFn: () => api.get('/admin/oauth/clients'),
    });
    const { data: tokens = [] } = useQuery({
        queryKey: ['admin-oauth-tokens'],
        queryFn: () => api.get('/admin/oauth/tokens'),
        enabled: tab === 'tokens',
    });
    const rotateSecret = useMutation({
        mutationFn: (id) => api.post(`/admin/oauth/clients/${id}/rotate-secret`, {}),
        onSuccess: (res) => {
            const r = res;
            if (r?.rawSecret) {
                toast.success(`Neues Secret (einmalig): ${r.rawSecret}`, { duration: 15000 });
            }
        },
        onError: (e) => toast.error(e.message),
    });
    const deleteClient = useMutation({
        mutationFn: (id) => api.delete(`/admin/oauth/clients/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-oauth-clients'] });
            toast.success('Client gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    const revokeToken = useMutation({
        mutationFn: (id) => api.delete(`/admin/oauth/tokens/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-oauth-tokens'] }); toast.success('Token widerrufen'); },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(KeyRound, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "OAuth2 / Modern Auth" }), _jsx("p", { className: "text-sm text-gray-500", children: "OAuth2-Clients f\u00FCr Outlook Modern Authentication" })] })] }), tab === 'clients' && (_jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neuer Client"] }))] }), _jsx("div", { className: "flex border-b border-gray-200 mb-4", children: ['clients', 'tokens'].map(t => (_jsx("button", { onClick: () => setTab(t), className: `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'}`, children: t === 'clients' ? `Clients (${clients.length})` : 'Aktive Tokens' }, t))) }), tab === 'clients' && (_jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Client" }), _jsx("th", { className: "text-left px-4 py-3", children: "Client-ID" }), _jsx("th", { className: "text-left px-4 py-3", children: "Scopes" }), _jsx("th", { className: "text-left px-4 py-3", children: "Typ" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : clients.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "text-center py-12 text-gray-400", children: "Noch keine OAuth2-Clients registriert" }) })) : clients.map(c => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: c.name }), c.description && _jsx("p", { className: "text-xs text-gray-500", children: c.description })] }), _jsx("td", { className: "px-4 py-3 font-mono text-xs text-gray-600", children: c.clientId }), _jsx("td", { className: "px-4 py-3", children: _jsx("div", { className: "flex flex-wrap gap-1", children: c.allowedScopes.map(s => (_jsx("span", { className: "px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded", children: s }, s))) }) }), _jsx("td", { className: "px-4 py-3", children: c.trusted
                                            ? _jsxs("span", { className: "flex items-center gap-1 text-xs text-green-600", children: [_jsx(ShieldCheck, { size: 12 }), " Vertrauensw\u00FCrdig"] })
                                            : _jsx("span", { className: "text-xs text-gray-400", children: "Standard" }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => rotateSecret.mutate(c.id), className: "p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 rounded", title: "Secret rotieren", children: _jsx(RotateCcw, { size: 13 }) }), _jsx("button", { onClick: () => setModal(c), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", title: "Bearbeiten", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(c), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) })] }) })] }, c.id))) })] }) })), tab === 'tokens' && (_jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Benutzer" }), _jsx("th", { className: "text-left px-4 py-3", children: "Client-ID" }), _jsx("th", { className: "text-left px-4 py-3", children: "Scopes" }), _jsx("th", { className: "text-left px-4 py-3", children: "L\u00E4uft ab" }), _jsx("th", { className: "text-left px-4 py-3", children: "Status" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: tokens.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Keine aktiven Tokens" }) })) : tokens.map(t => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsx("td", { className: "px-4 py-3 font-mono text-xs text-gray-600", children: t.userId }), _jsx("td", { className: "px-4 py-3 font-mono text-xs text-gray-600", children: t.clientId }), _jsx("td", { className: "px-4 py-3", children: _jsx("div", { className: "flex flex-wrap gap-1", children: t.scopes.map(s => (_jsx("span", { className: "px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded", children: s }, s))) }) }), _jsx("td", { className: "px-4 py-3 text-xs text-gray-600", children: new Date(t.expiresAt).toLocaleString('de-DE') }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${t.revoked ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`, children: t.revoked ? 'Widerrufen' : 'Aktiv' }) }), _jsx("td", { className: "px-4 py-3 text-right", children: !t.revoked && (_jsx("button", { onClick: () => revokeToken.mutate(t.id), className: "px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50", children: "Widerrufen" })) })] }, t.id))) })] }) })), modal !== null && _jsx(ClientModal, { client: modal === 'create' ? null : modal, onClose: () => setModal(null) }), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Client l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.name }), " gel\u00F6scht werden? Alle Tokens werden ung\u00FCltig."] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deleteClient.mutate(deleteConfirm.id), disabled: deleteClient.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deleteClient.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
