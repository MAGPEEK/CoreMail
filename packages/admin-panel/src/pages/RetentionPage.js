import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Plus, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
const ACTION_LABELS = {
    ARCHIVE: 'Archivieren', DELETE: 'Löschen', MOVE_TO_FOLDER: 'In Ordner verschieben',
};
const ACTION_COLORS = {
    ARCHIVE: 'bg-blue-100 text-blue-700',
    DELETE: 'bg-red-100 text-red-700',
    MOVE_TO_FOLDER: 'bg-yellow-100 text-yellow-700',
};
const SCOPE_LABELS = {
    ALL_ITEMS: 'Alle Elemente', INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet',
    DELETED_ITEMS: 'Gelöschte Elemente', JUNK: 'Junk-E-Mail',
};
function daysLabel(d) {
    if (d % 365 === 0)
        return `${d / 365} Jahr${d / 365 !== 1 ? 'e' : ''}`;
    if (d % 30 === 0)
        return `${d / 30} Monat${d / 30 !== 1 ? 'e' : ''}`;
    return `${d} Tag${d !== 1 ? 'e' : ''}`;
}
// ─── Policy Modal ─────────────────────────────────────────────────────────────
function PolicyModal({ policy, onClose }) {
    const qc = useQueryClient();
    const isEdit = policy !== null;
    const [form, setForm] = useState({
        name: policy?.name ?? '',
        description: policy?.description ?? '',
        retentionDays: policy?.retentionDays?.toString() ?? '365',
        action: policy?.action ?? 'ARCHIVE',
        targetFolder: policy?.targetFolder ?? '',
        scope: policy?.scope ?? 'ALL_ITEMS',
        respectLegalHold: policy?.respectLegalHold ?? true,
        enabled: policy?.enabled ?? true,
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => {
            const body = {
                name: form.name,
                description: form.description,
                retentionDays: parseInt(form.retentionDays),
                action: form.action,
                scope: form.scope,
                respectLegalHold: form.respectLegalHold,
                enabled: form.enabled,
                ...(form.action === 'MOVE_TO_FOLDER' ? { targetFolder: form.targetFolder } : {}),
            };
            return isEdit
                ? api.put(`/admin/compliance/retention/${policy.id}`, body)
                : api.post('/admin/compliance/retention', body);
        },
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-retention'] });
            toast.success(isEdit ? 'Richtlinie aktualisiert' : 'Richtlinie erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'Richtlinie bearbeiten' : 'Neue Aufbewahrungsrichtlinie' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Name *" }), _jsx("input", { value: form.name, onChange: e => set('name', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. 7-Jahre-Archivierung" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Aufbewahrungsdauer (Tage)" }), _jsx("input", { type: "number", min: "1", value: form.retentionDays, onChange: e => set('retentionDays', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: daysLabel(parseInt(form.retentionDays) || 0) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Aktion nach Ablauf" }), _jsx("select", { value: form.action, onChange: e => set('action', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: Object.entries(ACTION_LABELS).map(([v, l]) => (_jsx("option", { value: v, children: l }, v))) })] })] }), form.action === 'MOVE_TO_FOLDER' && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Ziel-Ordner" }), _jsx("input", { value: form.targetFolder, onChange: e => set('targetFolder', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "Archiv" })] })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Gilt f\u00FCr" }), _jsx("select", { value: form.scope, onChange: e => set('scope', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: Object.entries(SCOPE_LABELS).map(([v, l]) => (_jsx("option", { value: v, children: l }, v))) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("textarea", { value: form.description, onChange: e => set('description', e.target.value), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" })] }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.respectLegalHold, onChange: e => set('respectLegalHold', e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "Legal Hold beachten" })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.enabled, onChange: e => set('enabled', e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "Aktiviert" })] })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.name || !form.retentionDays, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function RetentionPage() {
    const qc = useQueryClient();
    const [modal, setModal] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data: policies = [], isLoading } = useQuery({
        queryKey: ['admin-retention'],
        queryFn: () => api.get('/admin/compliance/retention'),
    });
    const toggle = useMutation({
        mutationFn: (p) => api.post(`/admin/compliance/retention/${p.id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-retention'] }),
        onError: (e) => toast.error(e.message),
    });
    const deletePolicy = useMutation({
        mutationFn: (id) => api.delete(`/admin/compliance/retention/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-retention'] });
            toast.success('Richtlinie gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Archive, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Aufbewahrungsrichtlinien" }), _jsx("p", { className: "text-sm text-gray-500", children: "Automatisches Archivieren oder L\u00F6schen \u00E4lterer Nachrichten" })] })] }), _jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neue Richtlinie"] })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Richtlinie" }), _jsx("th", { className: "text-left px-4 py-3", children: "Aufbewahrung" }), _jsx("th", { className: "text-left px-4 py-3", children: "Aktion" }), _jsx("th", { className: "text-left px-4 py-3", children: "Scope" }), _jsx("th", { className: "text-left px-4 py-3", children: "Zuweisungen" }), _jsx("th", { className: "text-left px-4 py-3", children: "Status" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : policies.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Noch keine Aufbewahrungsrichtlinien konfiguriert" }) })) : policies.map(p => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: p.name }), p.description && _jsx("p", { className: "text-xs text-gray-500", children: p.description })] }), _jsx("td", { className: "px-4 py-3 font-medium text-gray-700", children: daysLabel(p.retentionDays) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[p.action]}`, children: [ACTION_LABELS[p.action], p.action === 'MOVE_TO_FOLDER' && p.targetFolder ? ` → ${p.targetFolder}` : ''] }) }), _jsx("td", { className: "px-4 py-3 text-xs text-gray-600", children: SCOPE_LABELS[p.scope] }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: p._count?.assignments ?? 0 }), _jsx("td", { className: "px-4 py-3", children: _jsx("button", { onClick: () => toggle.mutate(p), children: _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${p.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: p.enabled ? 'Aktiv' : 'Deaktiviert' }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setModal(p), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(p), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 13 }) })] }) })] }, p.id))) })] }) }), modal !== null && _jsx(PolicyModal, { policy: modal === 'create' ? null : modal, onClose: () => setModal(null) }), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Richtlinie l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.name }), " wirklich gel\u00F6scht werden?"] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deletePolicy.mutate(deleteConfirm.id), disabled: deletePolicy.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deletePolicy.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
