import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Mail, Phone, Building2, X, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
export function ContactsPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState(null);
    const [editMode, setEditMode] = useState(false);
    const [formData, setFormData] = useState({});
    const { data: contacts } = useQuery({
        queryKey: ['contacts', search],
        queryFn: () => api.get(`/contacts${search.length >= 2 ? `?q=${encodeURIComponent(search)}` : ''}`),
        staleTime: 10_000,
    });
    const createMutation = useMutation({
        mutationFn: (data) => api.post('/contacts', data),
        onSuccess: (c) => {
            toast.success('Kontakt erstellt');
            qc.invalidateQueries({ queryKey: ['contacts'] });
            setSelected(c);
            setEditMode(false);
        },
        onError: (err) => toast.error(err.message),
    });
    const updateMutation = useMutation({
        mutationFn: ({ id, data }) => api.put(`/contacts/${id}`, data),
        onSuccess: (c) => {
            toast.success('Kontakt gespeichert');
            qc.invalidateQueries({ queryKey: ['contacts'] });
            setSelected(c);
            setEditMode(false);
        },
        onError: (err) => toast.error(err.message),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/contacts/${id}`),
        onSuccess: () => {
            toast.success('Kontakt gelöscht');
            qc.invalidateQueries({ queryKey: ['contacts'] });
            setSelected(null);
        },
    });
    const startNew = () => {
        setSelected(null);
        setFormData({ displayName: '', email: '', company: '', phone: '' });
        setEditMode(true);
    };
    const startEdit = (c) => {
        setFormData({ displayName: c.displayName, email: c.email, company: c.company, phone: c.phone });
        setEditMode(true);
    };
    const handleSave = () => {
        if (selected) {
            updateMutation.mutate({ id: selected.id, data: formData });
        }
        else {
            createMutation.mutate(formData);
        }
    };
    const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return (_jsxs("div", { className: "flex flex-1 overflow-hidden", children: [_jsxs("div", { className: "w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col", children: [_jsxs("div", { className: "p-3 border-b border-gray-100 flex gap-2", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Search, { size: 14, className: "absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { value: search, onChange: (e) => setSearch(e.target.value), className: "input pl-8 text-xs", placeholder: "Kontakt suchen..." })] }), _jsx("button", { onClick: startNew, className: "btn-primary text-xs shrink-0", children: _jsx(Plus, { size: 14 }) })] }), _jsxs("div", { className: "flex-1 overflow-y-auto", children: [(contacts ?? []).map((c) => (_jsxs("button", { onClick: () => { setSelected(c); setEditMode(false); }, className: `w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${selected?.id === c.id ? 'bg-accent/5' : ''}`, children: [_jsx("div", { className: "w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold shrink-0", children: initials(c.displayName) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-sm font-medium text-gray-800 truncate", children: c.displayName }), _jsx("p", { className: "text-xs text-gray-500 truncate", children: c.email })] })] }, c.id))), contacts?.length === 0 && (_jsx("div", { className: "py-8 text-center text-gray-400 text-sm", children: "Keine Kontakte gefunden" }))] })] }), _jsx("div", { className: "flex-1 overflow-y-auto bg-white", children: editMode ? (_jsxs("div", { className: "max-w-lg p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsx("h2", { className: "text-base font-semibold", children: selected ? 'Kontakt bearbeiten' : 'Neuer Kontakt' }), _jsx("button", { onClick: () => { setEditMode(false); setFormData({}); }, className: "btn-ghost p-1", children: _jsx(X, { size: 16 }) })] }), _jsx("div", { className: "space-y-3", children: [
                                { label: 'Name', key: 'displayName', type: 'text', required: true },
                                { label: 'E-Mail', key: 'email', type: 'email', required: false },
                                { label: 'Telefon', key: 'phone', type: 'tel', required: false },
                                { label: 'Firma', key: 'company', type: 'text', required: false },
                            ].map(({ label, key, type }) => (_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: label }), _jsx("input", { type: type, className: "input", value: formData[key] ?? '', onChange: (e) => setFormData({ ...formData, [key]: e.target.value }) })] }, key))) }), _jsxs("div", { className: "flex gap-2 mt-5", children: [_jsx("button", { onClick: () => { setEditMode(false); setFormData({}); }, className: "btn-secondary", children: "Abbrechen" }), _jsx("button", { onClick: handleSave, disabled: !formData.displayName || createMutation.isPending || updateMutation.isPending, className: "btn-primary disabled:opacity-50", children: "Speichern" })] })] })) : selected ? (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-start gap-4 mb-6", children: [_jsx("div", { className: "w-16 h-16 rounded-full bg-accent flex items-center justify-center text-white text-xl font-bold", children: initials(selected.displayName) }), _jsxs("div", { children: [_jsx("h2", { className: "text-xl font-semibold text-gray-900", children: selected.displayName }), selected.company && _jsx("p", { className: "text-gray-500 text-sm", children: selected.company })] }), _jsxs("div", { className: "ml-auto flex gap-1", children: [_jsxs("button", { onClick: () => startEdit(selected), className: "btn-secondary text-xs", children: [_jsx(Pencil, { size: 13 }), " Bearbeiten"] }), _jsxs("button", { onClick: () => deleteMutation.mutate(selected.id), className: "btn-ghost text-xs text-red-600", children: [_jsx(Trash2, { size: 13 }), " L\u00F6schen"] })] })] }), _jsxs("div", { className: "space-y-2", children: [selected.email && (_jsxs("div", { className: "flex items-center gap-3 text-sm", children: [_jsx(Mail, { size: 15, className: "text-gray-400" }), _jsx("a", { href: `mailto:${selected.email}`, className: "text-accent hover:underline", children: selected.email })] })), selected.phone && (_jsxs("div", { className: "flex items-center gap-3 text-sm", children: [_jsx(Phone, { size: 15, className: "text-gray-400" }), _jsx("span", { children: selected.phone })] })), selected.company && (_jsxs("div", { className: "flex items-center gap-3 text-sm", children: [_jsx(Building2, { size: 15, className: "text-gray-400" }), _jsx("span", { children: selected.company })] }))] })] })) : (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm h-full", children: "Kontakt ausw\u00E4hlen oder neu erstellen" })) })] }));
}
