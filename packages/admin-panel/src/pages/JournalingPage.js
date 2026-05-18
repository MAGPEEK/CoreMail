import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookText, Plus, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
const SCOPE_LABELS = {
    ALL: 'Alle Nachrichten', INBOUND: 'Eingehend', OUTBOUND: 'Ausgehend', INTERNAL: 'Intern',
};
const RECIPIENT_LABELS = {
    ALL_MAILBOXES: 'Alle Postfächer', SPECIFIC_USERS: 'Bestimmte User', DOMAIN: 'Domain',
};
// ─── Rule Modal ───────────────────────────────────────────────────────────────
function RuleModal({ rule, onClose }) {
    const qc = useQueryClient();
    const isEdit = rule !== null;
    const [form, setForm] = useState({
        name: rule?.name ?? '',
        description: rule?.description ?? '',
        journalAddress: rule?.journalAddress ?? '',
        scope: rule?.scope ?? 'ALL',
        recipientType: rule?.recipientType ?? 'ALL_MAILBOXES',
        wrapAsReport: rule?.wrapAsReport ?? true,
        enabled: rule?.enabled ?? true,
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => isEdit
            ? api.put(`/admin/compliance/journaling/${rule.id}`, form)
            : api.post('/admin/compliance/journaling', form),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-journaling'] });
            toast.success(isEdit ? 'Regel aktualisiert' : 'Regel erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'Regel bearbeiten' : 'Neue Journaling-Regel' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Name *" }), _jsx("input", { value: form.name, onChange: e => set('name', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. Compliance-Archivierung" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Journal-Adresse * (Ziel f\u00FCr Kopien)" }), _jsx("input", { value: form.journalAddress, onChange: e => set('journalAddress', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "archiv@compliance.com" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Scope" }), _jsx("select", { value: form.scope, onChange: e => set('scope', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: Object.entries(SCOPE_LABELS).map(([v, l]) => (_jsx("option", { value: v, children: l }, v))) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Gilt f\u00FCr" }), _jsx("select", { value: form.recipientType, onChange: e => set('recipientType', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: Object.entries(RECIPIENT_LABELS).map(([v, l]) => (_jsx("option", { value: v, children: l }, v))) })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("textarea", { value: form.description, onChange: e => set('description', e.target.value), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" })] }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.wrapAsReport, onChange: e => set('wrapAsReport', e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "Als RFC 3462 Journal-Report einh\u00FCllen" })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.enabled, onChange: e => set('enabled', e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "Aktiviert" })] })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.name || !form.journalAddress, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function JournalingPage() {
    const qc = useQueryClient();
    const [modal, setModal] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data: rules = [], isLoading } = useQuery({
        queryKey: ['admin-journaling'],
        queryFn: () => api.get('/admin/compliance/journaling'),
    });
    const toggle = useMutation({
        mutationFn: (r) => api.post(`/admin/compliance/journaling/${r.id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-journaling'] }),
        onError: (e) => toast.error(e.message),
    });
    const deleteRule = useMutation({
        mutationFn: (id) => api.delete(`/admin/compliance/journaling/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-journaling'] });
            toast.success('Regel gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(BookText, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Journaling-Regeln" }), _jsx("p", { className: "text-sm text-gray-500", children: "Kopien aller Nachrichten an eine Compliance-Adresse senden (RFC 3462)" })] })] }), _jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neue Regel"] })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Regel" }), _jsx("th", { className: "text-left px-4 py-3", children: "Journal-Adresse" }), _jsx("th", { className: "text-left px-4 py-3", children: "Scope" }), _jsx("th", { className: "text-left px-4 py-3", children: "Gilt f\u00FCr" }), _jsx("th", { className: "text-left px-4 py-3", children: "Status" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : rules.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Noch keine Journaling-Regeln konfiguriert" }) })) : rules.map(r => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: r.name }), r.description && _jsx("p", { className: "text-xs text-gray-500", children: r.description })] }), _jsx("td", { className: "px-4 py-3 font-mono text-xs text-gray-700", children: r.journalAddress }), _jsx("td", { className: "px-4 py-3 text-gray-600 text-xs", children: SCOPE_LABELS[r.scope] }), _jsx("td", { className: "px-4 py-3 text-gray-600 text-xs", children: RECIPIENT_LABELS[r.recipientType] }), _jsx("td", { className: "px-4 py-3", children: _jsx("button", { onClick: () => toggle.mutate(r), children: _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${r.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: r.enabled ? 'Aktiv' : 'Deaktiviert' }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setModal(r), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(r), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 13 }) })] }) })] }, r.id))) })] }) }), modal !== null && _jsx(RuleModal, { rule: modal === 'create' ? null : modal, onClose: () => setModal(null) }), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Regel l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.name }), " wirklich gel\u00F6scht werden?"] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deleteRule.mutate(deleteConfirm.id), disabled: deleteRule.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deleteRule.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
