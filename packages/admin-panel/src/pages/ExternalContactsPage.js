import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookUser, Plus, Pencil, Trash2, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
function ContactModal({ contact, onClose }) {
    const qc = useQueryClient();
    const isEdit = contact !== null;
    const [form, setForm] = useState({
        email: contact?.email ?? '',
        displayName: contact?.displayName ?? '',
        firstName: contact?.firstName ?? '',
        lastName: contact?.lastName ?? '',
        company: contact?.company ?? '',
        department: contact?.department ?? '',
        phone: contact?.phone ?? '',
        mobile: contact?.mobile ?? '',
        hiddenFromGal: contact?.hiddenFromGal ?? false,
        notes: contact?.notes ?? '',
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => isEdit
            ? api.put(`/admin/contacts/${contact.id}`, form)
            : api.post('/admin/contacts', form),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-ext-contacts'] });
            toast.success(isEdit ? 'Kontakt aktualisiert' : 'Kontakt erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    const Field = ({ label, k, placeholder }) => (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: label }), _jsx("input", { value: form[k], onChange: e => set(k, e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: placeholder })] }));
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'Kontakt bearbeiten' : 'Neuer externer Kontakt' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-3", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Field, { label: "Vorname", k: "firstName", placeholder: "Max" }), _jsx(Field, { label: "Nachname", k: "lastName", placeholder: "Mustermann" })] }), _jsx(Field, { label: "Anzeigename *", k: "displayName", placeholder: "Max Mustermann" }), _jsx(Field, { label: "E-Mail-Adresse *", k: "email", placeholder: "max@extern.com" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Field, { label: "Unternehmen", k: "company", placeholder: "Acme GmbH" }), _jsx(Field, { label: "Abteilung", k: "department", placeholder: "Vertrieb" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Field, { label: "Telefon", k: "phone", placeholder: "+49 89 \u2026" }), _jsx(Field, { label: "Mobil", k: "mobile", placeholder: "+49 170 \u2026" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Notizen" }), _jsx("textarea", { value: form.notes, onChange: e => set('notes', e.target.value), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form.hiddenFromGal, onChange: e => set('hiddenFromGal', e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "In der Globalen Adressliste (GAL) ausblenden" })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.email || !form.displayName, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function ExternalContactsPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [modal, setModal] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data, isLoading } = useQuery({
        queryKey: ['admin-ext-contacts', search],
        queryFn: () => api.get(`/admin/contacts?search=${encodeURIComponent(search)}&limit=200`),
    });
    const contacts = data?.contacts ?? [];
    const deleteContact = useMutation({
        mutationFn: (id) => api.delete(`/admin/contacts/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-ext-contacts'] });
            toast.success('Kontakt gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(BookUser, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Externe Kontakte" }), _jsx("p", { className: "text-sm text-gray-500", children: "E-Mail-Kontakte die in der GAL erscheinen" })] })] }), _jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neuer Kontakt"] })] }), _jsxs("div", { className: "flex items-center gap-2 mb-4 bg-white border border-gray-300 rounded px-3 py-1.5 w-full max-w-sm", children: [_jsx(Search, { size: 14, className: "text-gray-400" }), _jsx("input", { value: search, onChange: e => setSearch(e.target.value), className: "flex-1 text-sm focus:outline-none", placeholder: "Name, E-Mail oder Unternehmen\u2026" })] }), _jsxs("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: [_jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "text-left px-4 py-3", children: "Name" }), _jsx("th", { className: "text-left px-4 py-3", children: "E-Mail" }), _jsx("th", { className: "text-left px-4 py-3", children: "Unternehmen" }), _jsx("th", { className: "text-left px-4 py-3", children: "Telefon" }), _jsx("th", { className: "text-left px-4 py-3", children: "GAL" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : contacts.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: search ? 'Keine Kontakte gefunden' : 'Noch keine externen Kontakte angelegt' }) })) : contacts.map(c => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: c.displayName }), c.department && _jsx("p", { className: "text-xs text-gray-500", children: c.department })] }), _jsx("td", { className: "px-4 py-3 text-gray-700", children: c.email }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: c.company || '—' }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: c.phone || c.mobile || '—' }), _jsx("td", { className: "px-4 py-3", children: c.hiddenFromGal
                                                ? _jsx("span", { className: "text-xs text-gray-400", children: "Ausgeblendet" })
                                                : _jsx("span", { className: "text-xs text-green-600", children: "Sichtbar" }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setModal(c), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(c), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 13 }) })] }) })] }, c.id))) })] }), data && _jsxs("div", { className: "px-4 py-2 text-xs text-gray-400 border-t border-gray-100", children: [data.total, " Kontakte gesamt"] })] }), modal !== null && (_jsx(ContactModal, { contact: modal === 'create' ? null : modal, onClose: () => setModal(null) })), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Kontakt l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.displayName }), " wirklich gel\u00F6scht werden?"] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deleteContact.mutate(deleteConfirm.id), disabled: deleteContact.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deleteContact.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
