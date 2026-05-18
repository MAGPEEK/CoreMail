import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Building2, Plus, Trash2, Pencil, X, Loader2, Users, Share2, List } from 'lucide-react';
import { api } from '../api/client.js';
export function OrganisationPage() {
    const [tab, setTab] = useState('sharing');
    const qc = useQueryClient();
    const { data: policies = [], isLoading: loadingPolicies } = useQuery({
        queryKey: ['sharing-policies'],
        queryFn: () => api.get('/api/v1/admin/organisation/sharing-policies'),
        enabled: tab === 'sharing',
    });
    const { data: addressLists = [], isLoading: loadingLists } = useQuery({
        queryKey: ['address-lists'],
        queryFn: () => api.get('/api/v1/admin/organisation/address-lists'),
        enabled: tab === 'address-lists',
    });
    const [galSearch, setGalSearch] = useState('');
    const [galDebouncedSearch, setGalDebounced] = useState('');
    const { data: gal } = useQuery({
        queryKey: ['gal', galDebouncedSearch],
        queryFn: () => api.get(`/api/v1/admin/organisation/gal?search=${encodeURIComponent(galDebouncedSearch)}&limit=100`),
        enabled: tab === 'gal',
    });
    const deletePolicyMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/organisation/sharing-policies/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sharing-policies'] }); toast.success('Gelöscht'); },
        onError: () => toast.error('Fehler'),
    });
    const deleteListMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/organisation/address-lists/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['address-lists'] }); toast.success('Gelöscht'); },
        onError: () => toast.error('Fehler'),
    });
    const [editPolicy, setEditPolicy] = useState(null);
    const [createPolicy, setCreatePolicy] = useState(false);
    const [editList, setEditList] = useState(null);
    const [createList, setCreateList] = useState(false);
    const typeIcon = {
        USER: '👤', SHARED: '📫', GROUP: '👥', ROOM: '🏢', EQUIPMENT: '🖥️',
    };
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(Building2, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "Organisation" }), _jsx("p", { className: "text-sm text-gray-500", children: "Freigaberichtlinien \u00B7 Adresslisten \u00B7 Globale Adressliste" })] })] }), _jsx("div", { className: "flex gap-1 bg-gray-100 rounded-lg p-1 mb-5 w-fit", children: [
                    { key: 'sharing', label: 'Freigaberichtlinien', icon: Share2 },
                    { key: 'address-lists', label: 'Adresslisten', icon: List },
                    { key: 'gal', label: 'Globale Adressliste', icon: Users },
                ].map(t => (_jsxs("button", { onClick: () => setTab(t.key), className: `flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === t.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600 hover:text-gray-900'}`, children: [_jsx(t.icon, { size: 13 }), " ", t.label] }, t.key))) }), tab === 'sharing' && (_jsxs("div", { children: [_jsx("div", { className: "flex justify-end mb-3", children: _jsxs("button", { onClick: () => setCreatePolicy(true), className: "flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Neue Richtlinie"] }) }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: loadingPolicies ? (_jsxs("div", { className: "flex items-center justify-center py-10 text-gray-400", children: [_jsx(Loader2, { size: 18, className: "animate-spin mr-2" }), "Lade\u2026"] })) : policies.length === 0 ? (_jsx("p", { className: "text-center py-10 text-sm text-gray-400", children: "Keine Freigaberichtlinien" })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Name" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Freigabe" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Domains" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: policies.map(p => (_jsxs("tr", { className: `hover:bg-gray-50 ${!p.enabled ? 'opacity-50' : ''}`, children: [_jsxs("td", { className: "px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: p.name }), p.isDefault && _jsx("span", { className: "badge badge-blue text-xs", children: "Standard" })] }), p.description && _jsx("p", { className: "text-xs text-gray-400", children: p.description })] }), _jsx("td", { className: "px-4 py-3 text-sm text-gray-600", children: [p.allowCalendar && `Kalender (${p.calendarDetail})`, p.allowContacts && 'Kontakte'].filter(Boolean).join(' · ') || '–' }), _jsx("td", { className: "px-4 py-3 text-sm text-gray-600", children: p.allowedDomains.length === 0 ? 'Alle' : p.allowedDomains.join(', ') }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setEditPolicy(p), className: "p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (!p.isDefault && window.confirm(`"${p.name}" löschen?`))
                                                                deletePolicyMutation.mutate(p.id); }, disabled: p.isDefault, className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-30", children: _jsx(Trash2, { size: 14 }) })] }) })] }, p.id))) })] })) })] })), tab === 'address-lists' && (_jsxs("div", { children: [_jsx("div", { className: "flex justify-end mb-3", children: _jsxs("button", { onClick: () => setCreateList(true), className: "flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Neue Adressliste"] }) }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: loadingLists ? (_jsxs("div", { className: "flex items-center justify-center py-10 text-gray-400", children: [_jsx(Loader2, { size: 18, className: "animate-spin mr-2" }), "Lade\u2026"] })) : addressLists.length === 0 ? (_jsx("p", { className: "text-center py-10 text-sm text-gray-400", children: "Keine Adresslisten" })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Name" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Typ" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: addressLists.map(l => (_jsxs("tr", { className: "hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: l.name }), l.isGal && _jsx("span", { className: "badge badge-blue text-xs", children: "GAL" })] }), l.description && _jsx("p", { className: "text-xs text-gray-400", children: l.description })] }), _jsx("td", { className: "px-4 py-3 text-sm text-gray-600", children: l.isGal ? 'Globale Adressliste' : 'Benutzerdefiniert' }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setEditList(l), className: "p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (window.confirm(`"${l.name}" löschen?`))
                                                                deleteListMutation.mutate(l.id); }, className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded", children: _jsx(Trash2, { size: 14 }) })] }) })] }, l.id))) })] })) })] })), tab === 'gal' && (_jsxs("div", { children: [_jsx("div", { className: "mb-4", children: _jsx("input", { value: galSearch, onChange: e => { setGalSearch(e.target.value); setTimeout(() => setGalDebounced(e.target.value), 300); }, className: "input max-w-sm", placeholder: "Namen oder E-Mail suchen\u2026" }) }), gal && (_jsx("div", { className: "grid grid-cols-2 gap-4", children: ([
                            { title: 'Benutzer', items: gal.users },
                            { title: 'Freigegebene Postfächer', items: gal.shared },
                            { title: 'Verteilergruppen', items: gal.groups },
                            { title: 'Ressourcen', items: gal.resources },
                        ]).map(section => (_jsxs("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: [_jsx("div", { className: "px-4 py-2.5 bg-gray-50 border-b border-gray-200", children: _jsxs("p", { className: "text-xs font-semibold text-gray-500 uppercase", children: [section.title, " (", section.items.length, ")"] }) }), section.items.length === 0
                                    ? _jsx("p", { className: "text-center py-6 text-sm text-gray-400", children: "Keine Eintr\u00E4ge" })
                                    : (_jsx("ul", { className: "divide-y divide-gray-100 max-h-64 overflow-y-auto", children: section.items.map(e => (_jsxs("li", { className: "flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50", children: [_jsx("span", { className: "text-base", children: typeIcon[e.type] ?? '📧' }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: e.displayName }), _jsx("p", { className: "text-xs text-gray-400", children: e.email })] })] }, e.id))) }))] }, section.title))) }))] })), (createPolicy || editPolicy) && (_jsx(SharingPolicyModal, { policy: editPolicy ?? undefined, onClose: () => { setCreatePolicy(false); setEditPolicy(null); } })), (createList || editList) && (_jsx(AddressListModal, { list: editList ?? undefined, onClose: () => { setCreateList(false); setEditList(null); } }))] }));
}
function SharingPolicyModal({ policy, onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState(policy?.name ?? '');
    const [description, setDesc] = useState(policy?.description ?? '');
    const [allowedDomains, setDomains] = useState(policy?.allowedDomains.join('\n') ?? '');
    const [allowCalendar, setAllowCal] = useState(policy?.allowCalendar ?? true);
    const [calendarDetail, setCalDetail] = useState(policy?.calendarDetail ?? 'FREEBUSY');
    const [allowContacts, setAllowCont] = useState(policy?.allowContacts ?? false);
    const [isDefault, setIsDefault] = useState(policy?.isDefault ?? false);
    const mutation = useMutation({
        mutationFn: () => {
            const body = { name, description, allowedDomains: allowedDomains.split('\n').map(d => d.trim()).filter(Boolean), allowCalendar, calendarDetail, allowContacts, isDefault };
            return policy ? api.put(`/api/v1/admin/organisation/sharing-policies/${policy.id}`, body) : api.post('/api/v1/admin/organisation/sharing-policies', body);
        },
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sharing-policies'] }); toast.success(policy ? 'Gespeichert' : 'Erstellt'); onClose(); },
        onError: () => toast.error('Fehler'),
    });
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-md", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: policy ? 'Richtlinie bearbeiten' : 'Neue Freigaberichtlinie' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Name" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Beschreibung" }), _jsx("input", { value: description, onChange: e => setDesc(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Erlaubte Domains (eine pro Zeile, leer = alle extern)" }), _jsx("textarea", { value: allowedDomains, onChange: e => setDomains(e.target.value), rows: 3, className: "input text-sm font-mono", placeholder: "partner.com" })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: allowCalendar, onChange: e => setAllowCal(e.target.checked), className: "rounded" }), "Kalenderfreigabe"] }), allowCalendar && (_jsxs("select", { value: calendarDetail, onChange: e => setCalDetail(e.target.value), className: "input ml-5 w-48", children: [_jsx("option", { value: "FREEBUSY", children: "Nur Frei/Gebucht" }), _jsx("option", { value: "LIMITED", children: "Eingeschr\u00E4nkt (Titel)" }), _jsx("option", { value: "FULL", children: "Vollst\u00E4ndig" })] })), _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: allowContacts, onChange: e => setAllowCont(e.target.checked), className: "rounded" }), "Kontaktfreigabe"] }), _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: isDefault, onChange: e => setIsDefault(e.target.checked), className: "rounded" }), "Als Standardrichtlinie"] })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), policy ? 'Speichern' : 'Erstellen'] })] })] })] }) }));
}
function AddressListModal({ list, onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState(list?.name ?? '');
    const [description, setDesc] = useState(list?.description ?? '');
    const [isGal, setIsGal] = useState(list?.isGal ?? false);
    const mutation = useMutation({
        mutationFn: () => {
            const body = { name, description, isGal, filter: {} };
            return list ? api.put(`/api/v1/admin/organisation/address-lists/${list.id}`, body) : api.post('/api/v1/admin/organisation/address-lists', body);
        },
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['address-lists'] }); toast.success(list ? 'Gespeichert' : 'Erstellt'); onClose(); },
        onError: () => toast.error('Fehler'),
    });
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-md", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: list ? 'Adressliste bearbeiten' : 'Neue Adressliste' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Name" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Beschreibung" }), _jsx("input", { value: description, onChange: e => setDesc(e.target.value), className: "input" })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: isGal, onChange: e => setIsGal(e.target.checked), className: "rounded" }), "Als Globale Adressliste (GAL) markieren"] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), list ? 'Speichern' : 'Erstellen'] })] })] })] }) }));
}
