import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, Pencil, Trash2, ChevronRight, ChevronDown, Lock, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Folder Modal ─────────────────────────────────────────────────────────────
function FolderModal({ folder, parentId, onClose, }) {
    const qc = useQueryClient();
    const [form, setForm] = useState({
        name: folder?.name ?? '',
        displayName: folder?.displayName ?? '',
        description: folder?.description ?? '',
    });
    const save = useMutation({
        mutationFn: () => folder
            ? api.put(`/admin/public-folders/${folder.id}`, form)
            : api.post('/admin/public-folders', { ...form, ...(parentId ? { parentId } : {}) }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-public-folders'] });
            toast.success(folder ? 'Ordner aktualisiert' : 'Ordner erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 z-50 flex items-center justify-center", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-md p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: folder ? 'Ordner bearbeiten' : parentId ? 'Unterordner erstellen' : 'Stammordner erstellen' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Interner Name *" }), _jsx("input", { value: form.name, onChange: e => setForm(f => ({ ...f, name: e.target.value })), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "allgemein" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Anzeigename *" }), _jsx("input", { value: form.displayName, onChange: e => setForm(f => ({ ...f, displayName: e.target.value })), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "Allgemein" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("textarea", { value: form.description, onChange: e => setForm(f => ({ ...f, description: e.target.value })), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none", placeholder: "Optionale Beschreibung" })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-5", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: !form.name || !form.displayName || save.isPending, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : 'Speichern' })] })] }) }));
}
// ─── ACL Panel ────────────────────────────────────────────────────────────────
const PERM_LABELS = { READ: 'Lesen', WRITE: 'Lesen & Schreiben', FULL: 'Vollzugriff' };
function AclPanel({ folder, onClose }) {
    const qc = useQueryClient();
    const [newEmail, setNewEmail] = useState('');
    const [newPerm, setNewPerm] = useState('READ');
    const { data: acl = [] } = useQuery({
        queryKey: ['admin-public-folders-acl', folder.id],
        queryFn: () => api.get(`/admin/public-folders/${folder.id}/acl`),
    });
    const grant = useMutation({
        mutationFn: () => api.post(`/admin/public-folders/${folder.id}/acl`, { userEmail: newEmail, permission: newPerm }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-public-folders-acl', folder.id] });
            toast.success('Berechtigung hinzugefügt');
            setNewEmail('');
        },
        onError: (e) => toast.error(e.message),
    });
    const revoke = useMutation({
        mutationFn: (userId) => api.delete(`/admin/public-folders/${folder.id}/acl/${userId}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-public-folders-acl', folder.id] });
            toast.success('Berechtigung entfernt');
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 z-50 flex items-center justify-center", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Zugriffsrechte" }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: folder.displayName })] }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsx("div", { className: "border border-gray-200 rounded-lg overflow-hidden mb-4", children: acl.length === 0 ? (_jsx("p", { className: "text-center text-sm text-gray-400 py-6", children: "Keine benutzerdefinierten Rechte" })) : acl.map(e => (_jsxs("div", { className: "flex items-center justify-between px-4 py-2.5 border-b border-gray-100 last:border-0", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-800 font-medium", children: e.userEmail }), _jsx("p", { className: "text-xs text-gray-500", children: PERM_LABELS[e.permission] })] }), _jsx("button", { onClick: () => revoke.mutate(e.userId), className: "text-gray-400 hover:text-red-500 transition-colors", children: _jsx(X, { size: 14 }) })] }, e.id))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: newEmail, onChange: e => setNewEmail(e.target.value), className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "user@example.com" }), _jsxs("select", { value: newPerm, onChange: e => setNewPerm(e.target.value), className: "border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "READ", children: "Lesen" }), _jsx("option", { value: "WRITE", children: "Lesen & Schreiben" }), _jsx("option", { value: "FULL", children: "Vollzugriff" })] }), _jsxs("button", { onClick: () => grant.mutate(), disabled: !newEmail || grant.isPending, className: "flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: [_jsx(Plus, { size: 13 }), " Hinzuf\u00FCgen"] })] })] }) }));
}
// ─── Folder Row (recursive) ───────────────────────────────────────────────────
function FolderRow({ folder, depth, onEdit, onDelete, onAddChild, onAcl, }) {
    const [expanded, setExpanded] = useState(depth === 0);
    const hasChildren = folder.children.length > 0;
    return (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50 group", children: [_jsx("td", { className: "px-4 py-2.5", children: _jsxs("div", { className: "flex items-center", style: { paddingLeft: depth * 20 }, children: [_jsx("button", { onClick: () => setExpanded(v => !v), className: `mr-1.5 text-gray-400 ${hasChildren ? 'hover:text-gray-600' : 'invisible'}`, children: expanded ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }) }), _jsx(FolderOpen, { size: 14, className: "text-yellow-500 mr-2 shrink-0" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-900 font-medium", children: folder.displayName }), folder.description && _jsx("p", { className: "text-xs text-gray-400", children: folder.description })] })] }) }), _jsx("td", { className: "px-4 py-2.5 text-xs font-mono text-gray-500", children: folder.name }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-500", children: folder.messageCount.toLocaleString('de-DE') }), _jsx("td", { className: "px-4 py-2.5", children: _jsxs("div", { className: "flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end", children: [_jsx("button", { onClick: () => onAddChild(folder.id), title: "Unterordner erstellen", className: "p-1 text-gray-400 hover:text-accent rounded", children: _jsx(FolderPlus, { size: 13 }) }), _jsx("button", { onClick: () => onAcl(folder), title: "Zugriffsrechte", className: "p-1 text-gray-400 hover:text-blue-500 rounded", children: _jsx(Lock, { size: 13 }) }), _jsx("button", { onClick: () => onEdit(folder), title: "Bearbeiten", className: "p-1 text-gray-400 hover:text-gray-700 rounded", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => onDelete(folder), title: "L\u00F6schen", className: "p-1 text-gray-400 hover:text-red-500 rounded", children: _jsx(Trash2, { size: 13 }) })] }) })] }), expanded && folder.children.map(child => (_jsx(FolderRow, { folder: child, depth: depth + 1, onEdit: onEdit, onDelete: onDelete, onAddChild: onAddChild, onAcl: onAcl }, child.id)))] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function PublicFoldersPage() {
    const qc = useQueryClient();
    const [modal, setModal] = useState(null);
    const { data: folders = [], isLoading } = useQuery({
        queryKey: ['admin-public-folders'],
        queryFn: () => api.get('/admin/public-folders'),
    });
    const del = useMutation({
        mutationFn: (id) => api.delete(`/admin/public-folders/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-public-folders'] });
            toast.success('Ordner gelöscht');
        },
        onError: (e) => toast.error(e.message),
    });
    const handleDelete = (f) => {
        if (confirm(`Ordner „${f.displayName}" und alle Unterordner löschen?`)) {
            del.mutate(f.id);
        }
    };
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(FolderOpen, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "\u00D6ffentliche Ordner" }), _jsx("p", { className: "text-sm text-gray-500", children: "Freigegebene Ordner f\u00FCr alle Benutzer der Organisation" })] })] }), _jsxs("button", { onClick: () => setModal({ type: 'create-root' }), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(FolderPlus, { size: 15 }), " Stammordner erstellen"] })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Ordner" }), _jsx("th", { className: "text-left px-4 py-3", children: "Name" }), _jsx("th", { className: "text-left px-4 py-3", children: "Nachrichten" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : folders.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "text-center py-12 text-gray-400", children: "Noch keine \u00F6ffentlichen Ordner vorhanden" }) })) : folders.map(f => (_jsx(FolderRow, { folder: f, depth: 0, onEdit: folder => setModal({ type: 'edit', folder }), onDelete: handleDelete, onAddChild: parentId => setModal({ type: 'create-child', parentId }), onAcl: folder => setModal({ type: 'acl', folder }) }, f.id))) })] }) }), modal?.type === 'create-root' && (_jsx(FolderModal, { onClose: () => setModal(null) })), modal?.type === 'create-child' && (_jsx(FolderModal, { parentId: modal.parentId, onClose: () => setModal(null) })), modal?.type === 'edit' && (_jsx(FolderModal, { folder: modal.folder, onClose: () => setModal(null) })), modal?.type === 'acl' && (_jsx(AclPanel, { folder: modal.folder, onClose: () => setModal(null) }))] }));
}
