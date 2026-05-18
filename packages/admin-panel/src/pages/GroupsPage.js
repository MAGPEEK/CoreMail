import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Plus, Pencil, Trash2, UserPlus, UserMinus, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
function TypeBadge({ type }) {
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${type === 'DYNAMIC' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`, children: type === 'DYNAMIC' ? 'Dynamisch' : 'Statisch' }));
}
function StatusBadge({ active }) {
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: active ? 'Aktiv' : 'Inaktiv' }));
}
function MemberTypeBadge({ type }) {
    const map = {
        USER: 'bg-blue-100 text-blue-700',
        SHARED_MAILBOX: 'bg-yellow-100 text-yellow-700',
        GROUP: 'bg-purple-100 text-purple-700',
        EXTERNAL: 'bg-gray-100 text-gray-600',
    };
    const labels = {
        USER: 'User', SHARED_MAILBOX: 'Shared', GROUP: 'Gruppe', EXTERNAL: 'Extern',
    };
    return (_jsx("span", { className: `inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${map[type]}`, children: labels[type] }));
}
function GroupModal({ group, domains, onClose, }) {
    const qc = useQueryClient();
    const isEdit = group !== null;
    const [form, setForm] = useState({
        email: group?.email ?? '',
        displayName: group?.displayName ?? '',
        description: group?.description ?? '',
        domainId: group?.domainId ?? (domains[0]?.id ?? ''),
        groupType: group?.groupType ?? 'STATIC',
        ldapFilter: group?.ldapFilter ?? '',
        requireSenderAuth: group?.requireSenderAuth ?? false,
        allowExternal: group?.allowExternal ?? true,
        moderationEnabled: group?.moderationEnabled ?? false,
        hiddenFromGal: group?.hiddenFromGal ?? false,
    });
    const save = useMutation({
        mutationFn: () => isEdit
            ? api.put(`/admin/groups/${group.id}`, {
                displayName: form.displayName,
                description: form.description,
                requireSenderAuth: form.requireSenderAuth,
                allowExternal: form.allowExternal,
                moderationEnabled: form.moderationEnabled,
                hiddenFromGal: form.hiddenFromGal,
                ...(form.groupType === 'DYNAMIC' ? { ldapFilter: form.ldapFilter } : {}),
            })
            : api.post('/admin/groups', {
                email: form.email,
                displayName: form.displayName,
                description: form.description,
                domainId: form.domainId,
                groupType: form.groupType,
                requireSenderAuth: form.requireSenderAuth,
                allowExternal: form.allowExternal,
                moderationEnabled: form.moderationEnabled,
                hiddenFromGal: form.hiddenFromGal,
                ...(form.groupType === 'DYNAMIC' ? { ldapFilter: form.ldapFilter } : {}),
            }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-groups'] });
            toast.success(isEdit ? 'Gruppe aktualisiert' : 'Gruppe erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'Gruppe bearbeiten' : 'Neue Verteilergruppe' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-4", children: [!isEdit && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Typ" }), _jsx("div", { className: "flex gap-3", children: ['STATIC', 'DYNAMIC'].map(t => (_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "radio", checked: form.groupType === t, onChange: () => set('groupType', t), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: t === 'STATIC' ? 'Statisch (manuelle Mitglieder)' : 'Dynamisch (LDAP-Filter)' })] }, t))) })] })), !isEdit && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "E-Mail-Adresse" }), _jsx("input", { value: form.email, onChange: e => set('email', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "verteilung@domain.com" })] })), !isEdit && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Domain" }), _jsx("select", { value: form.domainId, onChange: e => set('domainId', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: domains.map(d => _jsx("option", { value: d.id, children: d.name }, d.id)) })] })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Anzeigename" }), _jsx("input", { value: form.displayName, onChange: e => set('displayName', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. Vertriebs-Team" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("textarea", { value: form.description, onChange: e => set('description', e.target.value), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" })] }), form.groupType === 'DYNAMIC' && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "LDAP-Filter" }), _jsx("input", { value: form.ldapFilter, onChange: e => set('ldapFilter', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "(department=Vertrieb)" })] })), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-700", children: "Optionen" }), [
                                    ['requireSenderAuth', 'Nur authentifizierte Absender'],
                                    ['allowExternal', 'Externe Absender erlauben'],
                                    ['moderationEnabled', 'Moderation aktivieren'],
                                    ['hiddenFromGal', 'In GAL ausblenden'],
                                ].map(([k, label]) => (_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form[k], onChange: e => set(k, e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: label })] }, k)))] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Members Panel ────────────────────────────────────────────────────────────
function MembersPanel({ group }) {
    const qc = useQueryClient();
    const [newEmail, setNewEmail] = useState('');
    const [newType, setNewType] = useState('USER');
    const { data: members = [] } = useQuery({
        queryKey: ['admin-group-members', group.id],
        queryFn: () => api.get(`/admin/groups/${group.id}/members`),
    });
    const addMember = useMutation({
        mutationFn: () => api.post(`/admin/groups/${group.id}/members`, { memberEmail: newEmail.trim(), memberType: newType }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-group-members', group.id] });
            void qc.invalidateQueries({ queryKey: ['admin-groups'] });
            setNewEmail('');
            toast.success('Mitglied hinzugefügt');
        },
        onError: (e) => toast.error(e.message),
    });
    const removeMember = useMutation({
        mutationFn: (email) => api.delete(`/admin/groups/${group.id}/members/${encodeURIComponent(email)}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-group-members', group.id] });
            void qc.invalidateQueries({ queryKey: ['admin-groups'] });
            toast.success('Mitglied entfernt');
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "border-t border-gray-100 bg-gray-50 px-6 py-4", children: [_jsxs("h3", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3", children: ["Mitglieder (", members.length, ")"] }), group.groupType === 'STATIC' && (_jsxs("div", { className: "flex gap-2 mb-3", children: [_jsx("input", { value: newEmail, onChange: e => setNewEmail(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && newEmail.trim())
                            addMember.mutate(); }, className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "E-Mail-Adresse eingeben" }), _jsxs("select", { value: newType, onChange: e => setNewType(e.target.value), className: "border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "USER", children: "User" }), _jsx("option", { value: "SHARED_MAILBOX", children: "Shared Mailbox" }), _jsx("option", { value: "GROUP", children: "Gruppe" }), _jsx("option", { value: "EXTERNAL", children: "Extern" })] }), _jsxs("button", { onClick: () => { if (newEmail.trim())
                            addMember.mutate(); }, disabled: !newEmail.trim() || addMember.isPending, className: "flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: [_jsx(UserPlus, { size: 13 }), " Hinzuf\u00FCgen"] })] })), group.groupType === 'DYNAMIC' && (_jsx("p", { className: "text-xs text-gray-500 mb-3 italic", children: "Dynamische Gruppe \u2014 Mitglieder werden \u00FCber den LDAP-Filter ermittelt." })), members.length === 0 ? (_jsx("p", { className: "text-sm text-gray-400 italic", children: "Noch keine Mitglieder" })) : (_jsx("ul", { className: "space-y-1", children: members.map(m => (_jsxs("li", { className: "flex items-center justify-between py-1 px-2 rounded hover:bg-white group", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(MemberTypeBadge, { type: m.memberType }), _jsx("span", { className: "text-sm text-gray-700", children: m.memberEmail })] }), group.groupType === 'STATIC' && (_jsx("button", { onClick: () => removeMember.mutate(m.memberEmail), className: "opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity", children: _jsx(UserMinus, { size: 13 }) }))] }, m.id))) }))] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function GroupsPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState('ALL');
    const [modal, setModal] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data: groups = [], isLoading } = useQuery({
        queryKey: ['admin-groups'],
        queryFn: () => api.get('/admin/groups'),
    });
    const { data: domains = [] } = useQuery({
        queryKey: ['admin-domains-list'],
        queryFn: () => api.get('/admin/domains?limit=500').then(r => r.domains),
        select: (d) => {
            if (Array.isArray(d))
                return d;
            if (d && typeof d === 'object' && 'domains' in d)
                return d.domains;
            return [];
        },
    });
    const toggleActive = useMutation({
        mutationFn: (g) => api.put(`/admin/groups/${g.id}`, { active: !g.active }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-groups'] }); },
        onError: (e) => toast.error(e.message),
    });
    const deleteGroup = useMutation({
        mutationFn: (id) => api.delete(`/admin/groups/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-groups'] });
            toast.success('Gruppe gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    const filtered = groups.filter(g => {
        if (typeFilter !== 'ALL' && g.groupType !== typeFilter)
            return false;
        if (search && !(g.displayName ?? '').toLowerCase().includes(search.toLowerCase()) &&
            !(g.email ?? '').toLowerCase().includes(search.toLowerCase()))
            return false;
        return true;
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Users, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Verteilergruppen" }), _jsxs("p", { className: "text-sm text-gray-500", children: [groups.length, " Gruppen gesamt"] })] })] }), _jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neue Gruppe"] })] }), _jsxs("div", { className: "flex gap-3 mb-4", children: [_jsx("input", { value: search, onChange: e => setSearch(e.target.value), className: "flex-1 max-w-xs border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "Suchen\u2026" }), _jsx("div", { className: "flex border border-gray-300 rounded overflow-hidden text-sm", children: ['ALL', 'STATIC', 'DYNAMIC'].map(t => (_jsx("button", { onClick: () => setTypeFilter(t), className: `px-3 py-1.5 ${typeFilter === t ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`, children: t === 'ALL' ? 'Alle' : t === 'STATIC' ? 'Statisch' : 'Dynamisch' }, t))) })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200", children: [_jsx("th", { className: "w-6 px-3 py-3" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Gruppe" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Typ" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Mitglieder" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "GAL" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : filtered.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Keine Gruppen gefunden" }) })) : filtered.map(g => (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsx("td", { className: "px-3 py-3", children: _jsx("button", { onClick: () => setExpanded(expanded === g.id ? null : g.id), className: "text-gray-400 hover:text-gray-600", children: expanded === g.id ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }) }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: g.displayName }), _jsx("p", { className: "text-xs text-gray-500", children: g.email }), g.description && _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: g.description })] }), _jsx("td", { className: "px-4 py-3", children: _jsx(TypeBadge, { type: g.groupType }) }), _jsx("td", { className: "px-4 py-3 text-gray-700", children: g._count.members }), _jsx("td", { className: "px-4 py-3", children: _jsx("button", { onClick: () => toggleActive.mutate(g), children: _jsx(StatusBadge, { active: g.active }) }) }), _jsx("td", { className: "px-4 py-3", children: g.hiddenFromGal
                                                    ? _jsx("span", { className: "text-xs text-gray-400", children: "Ausgeblendet" })
                                                    : _jsx("span", { className: "text-xs text-green-600", children: "Sichtbar" }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setModal(g), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", title: "Bearbeiten", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(g), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) })] }) })] }, g.id), expanded === g.id && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "p-0", children: _jsx(MembersPanel, { group: g }) }) }, `${g.id}-members`))] }))) })] }) }), modal !== null && (_jsx(GroupModal, { group: modal === 'create' ? null : modal, domains: domains, onClose: () => setModal(null) })), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Gruppe l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.displayName }), " wirklich gel\u00F6scht werden? Alle Mitgliedschaften werden entfernt."] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deleteGroup.mutate(deleteConfirm.id), disabled: deleteGroup.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deleteGroup.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
