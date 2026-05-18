import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, MonitorSpeaker, Plus, Pencil, Trash2, CalendarX, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
function ResourceIcon({ type, size = 16 }) {
    return type === 'ROOM'
        ? _jsx(Building2, { size: size, className: "text-blue-500" })
        : _jsx(MonitorSpeaker, { size: size, className: "text-purple-500" });
}
function StatusBadge({ active }) {
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`, children: active ? 'Aktiv' : 'Inaktiv' }));
}
function BookingStatusBadge({ status }) {
    const map = {
        ACCEPTED: 'bg-green-100 text-green-700',
        DECLINED: 'bg-red-100 text-red-700',
        PENDING: 'bg-yellow-100 text-yellow-700',
        TENTATIVE: 'bg-blue-100 text-blue-700',
    };
    return (_jsx("span", { className: `inline-flex px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`, children: status }));
}
function fmtDt(iso) {
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// ─── Bookings Panel ───────────────────────────────────────────────────────────
function BookingsPanel({ resource }) {
    const qc = useQueryClient();
    const [from, setFrom] = useState(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.toISOString().slice(0, 10);
    });
    const [to, setTo] = useState(() => {
        const d = new Date();
        d.setDate(d.getDate() + 30);
        d.setHours(23, 59, 59, 0);
        return d.toISOString().slice(0, 10);
    });
    const { data: bookings = [] } = useQuery({
        queryKey: ['admin-resource-bookings', resource.id, from, to],
        queryFn: () => api.get(`/admin/resources/${resource.id}/bookings?from=${from}T00:00:00Z&to=${to}T23:59:59Z`),
    });
    const cancelBooking = useMutation({
        mutationFn: (bookingId) => api.delete(`/admin/resources/${resource.id}/bookings/${bookingId}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-resource-bookings', resource.id] });
            toast.success('Buchung storniert');
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "border-t border-gray-100 bg-gray-50 px-6 py-4", children: [_jsx("h3", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3", children: "Buchungen" }), _jsxs("div", { className: "flex gap-2 items-center mb-3", children: [_jsx("label", { className: "text-xs text-gray-600", children: "Von" }), _jsx("input", { type: "date", value: from, onChange: e => setFrom(e.target.value), className: "border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent" }), _jsx("label", { className: "text-xs text-gray-600", children: "Bis" }), _jsx("input", { type: "date", value: to, onChange: e => setTo(e.target.value), className: "border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent" })] }), bookings.length === 0 ? (_jsx("p", { className: "text-sm text-gray-400 italic", children: "Keine Buchungen im gew\u00E4hlten Zeitraum" })) : (_jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-gray-500 border-b border-gray-200", children: [_jsx("th", { className: "text-left pb-1 pr-4", children: "Zeitraum" }), _jsx("th", { className: "text-left pb-1 pr-4", children: "Organisator" }), _jsx("th", { className: "text-left pb-1 pr-4", children: "Betreff" }), _jsx("th", { className: "text-left pb-1 pr-4", children: "Status" }), _jsx("th", { className: "pb-1" })] }) }), _jsx("tbody", { children: bookings.map(b => (_jsxs("tr", { className: "border-b border-gray-100 hover:bg-white group", children: [_jsxs("td", { className: "py-1.5 pr-4 whitespace-nowrap text-gray-700", children: [fmtDt(b.dtStart), " \u2013 ", fmtDt(b.dtEnd)] }), _jsx("td", { className: "py-1.5 pr-4 text-gray-600", children: b.organizerEmail }), _jsx("td", { className: "py-1.5 pr-4 text-gray-700 max-w-[200px] truncate", children: b.subject }), _jsx("td", { className: "py-1.5 pr-4", children: _jsx(BookingStatusBadge, { status: b.status }) }), _jsx("td", { className: "py-1.5", children: _jsx("button", { onClick: () => cancelBooking.mutate(b.id), className: "opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity", title: "Stornieren", children: _jsx(CalendarX, { size: 12 }) }) })] }, b.id))) })] }))] }));
}
function ResourceModal({ resource, domains, onClose, }) {
    const qc = useQueryClient();
    const isEdit = resource !== null;
    const [form, setForm] = useState({
        email: resource?.email ?? '',
        displayName: resource?.displayName ?? '',
        resourceType: resource?.resourceType ?? 'ROOM',
        domainId: resource?.domainId ?? (domains[0]?.id ?? ''),
        location: resource?.location ?? '',
        phone: resource?.phone ?? '',
        capacity: resource?.capacity?.toString() ?? '',
        autoAccept: resource?.autoAccept ?? true,
        autoDeclineConflict: resource?.autoDeclineConflict ?? true,
        allowRecurring: resource?.allowRecurring ?? true,
        maxDurationMinutes: resource?.maxDurationMinutes?.toString() ?? '',
        bookingWindowDays: resource?.bookingWindowDays?.toString() ?? '180',
        requireApproval: resource?.requireApproval ?? false,
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => {
            const body = {
                displayName: form.displayName,
                location: form.location,
                phone: form.phone,
                ...(form.capacity ? { capacity: parseInt(form.capacity) } : {}),
                autoAccept: form.autoAccept,
                autoDeclineConflict: form.autoDeclineConflict,
                allowRecurring: form.allowRecurring,
                ...(form.maxDurationMinutes ? { maxDurationMinutes: parseInt(form.maxDurationMinutes) } : {}),
                bookingWindowDays: parseInt(form.bookingWindowDays),
                requireApproval: form.requireApproval,
            };
            return isEdit
                ? api.put(`/admin/resources/${resource.id}`, body)
                : api.post('/admin/resources', {
                    ...body, email: form.email, domainId: form.domainId, resourceType: form.resourceType,
                });
        },
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-resources'] });
            toast.success(isEdit ? 'Ressource aktualisiert' : 'Ressource erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: isEdit ? 'Ressource bearbeiten' : 'Neue Ressource' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-4", children: [!isEdit && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Typ" }), _jsx("div", { className: "flex gap-4", children: ['ROOM', 'EQUIPMENT'].map(t => (_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "radio", checked: form.resourceType === t, onChange: () => set('resourceType', t), className: "accent-accent" }), _jsx(ResourceIcon, { type: t, size: 14 }), _jsx("span", { className: "text-sm text-gray-700", children: t === 'ROOM' ? 'Raum' : 'Gerät/Equipment' })] }, t))) })] })), !isEdit && (_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "E-Mail" }), _jsx("input", { value: form.email, onChange: e => set('email', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "konferenz-a@domain.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Domain" }), _jsx("select", { value: form.domainId, onChange: e => set('domainId', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: domains.map(d => _jsx("option", { value: d.id, children: d.name }, d.id)) })] })] })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Anzeigename" }), _jsx("input", { value: form.displayName, onChange: e => set('displayName', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. Konferenzraum A" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Standort" }), _jsx("input", { value: form.location, onChange: e => set('location', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "Geb\u00E4ude 2, EG" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Telefon" }), _jsx("input", { value: form.phone, onChange: e => set('phone', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "+49 89 \u2026" })] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-3", children: [form.resourceType === 'ROOM' && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Kapazit\u00E4t (Pers.)" }), _jsx("input", { type: "number", min: "1", value: form.capacity, onChange: e => set('capacity', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "10" })] })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Max. Dauer (min)" }), _jsx("input", { type: "number", min: "1", value: form.maxDurationMinutes, onChange: e => set('maxDurationMinutes', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "unbegrenzt" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Buchungsfenster (Tage)" }), _jsx("input", { type: "number", min: "1", value: form.bookingWindowDays, onChange: e => set('bookingWindowDays', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-700", children: "Buchungsverhalten" }), [
                                    ['autoAccept', 'Anfragen automatisch annehmen'],
                                    ['autoDeclineConflict', 'Konflikte automatisch ablehnen'],
                                    ['allowRecurring', 'Wiederkehrende Termine erlauben'],
                                    ['requireApproval', 'Genehmigung durch Delegierten erforderlich'],
                                ].map(([k, label]) => (_jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: form[k], onChange: e => set(k, e.target.checked), className: "accent-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: label })] }, k)))] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function ResourcesPage() {
    const qc = useQueryClient();
    const [typeTab, setTypeTab] = useState('ROOM');
    const [search, setSearch] = useState('');
    const [modal, setModal] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const { data: resources = [], isLoading } = useQuery({
        queryKey: ['admin-resources'],
        queryFn: () => api.get('/admin/resources'),
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
        mutationFn: (r) => api.put(`/admin/resources/${r.id}`, { active: !r.active }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-resources'] }); },
        onError: (e) => toast.error(e.message),
    });
    const deleteResource = useMutation({
        mutationFn: (id) => api.delete(`/admin/resources/${id}`),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-resources'] });
            toast.success('Ressource gelöscht');
            setDeleteConfirm(null);
        },
        onError: (e) => toast.error(e.message),
    });
    const rooms = resources.filter(r => r.resourceType === 'ROOM');
    const equipment = resources.filter(r => r.resourceType === 'EQUIPMENT');
    const filtered = (typeTab === 'ROOM' ? rooms : equipment).filter(r => !search || r.displayName.toLowerCase().includes(search.toLowerCase()) ||
        r.email.toLowerCase().includes(search.toLowerCase()) ||
        r.location.toLowerCase().includes(search.toLowerCase()));
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Building2, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Ressourcenpostf\u00E4cher" }), _jsxs("p", { className: "text-sm text-gray-500", children: [rooms.length, " R\u00E4ume \u00B7 ", equipment.length, " Ger\u00E4te"] })] })] }), _jsxs("button", { onClick: () => setModal('create'), className: "flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90", children: [_jsx(Plus, { size: 15 }), " Neue Ressource"] })] }), _jsxs("div", { className: "flex items-center gap-4 mb-4", children: [_jsx("div", { className: "flex border border-gray-300 rounded overflow-hidden text-sm", children: ['ROOM', 'EQUIPMENT'].map(t => (_jsxs("button", { onClick: () => setTypeTab(t), className: `flex items-center gap-1.5 px-4 py-1.5 ${typeTab === t ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`, children: [_jsx(ResourceIcon, { type: t, size: 13 }), t === 'ROOM' ? `Räume (${rooms.length})` : `Geräte (${equipment.length})`] }, t))) }), _jsx("input", { value: search, onChange: e => setSearch(e.target.value), className: "flex-1 max-w-xs border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "Suchen\u2026" })] }), _jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200", children: [_jsx("th", { className: "w-6 px-3 py-3" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Ressource" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Standort" }), typeTab === 'ROOM' && (_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Kapazit\u00E4t" })), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Auto-Accept" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: isLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : filtered.length === 0 ? (_jsx("tr", { children: _jsxs("td", { colSpan: 7, className: "text-center py-12 text-gray-400", children: ["Keine ", typeTab === 'ROOM' ? 'Räume' : 'Geräte', " gefunden"] }) })) : filtered.map(r => (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsx("td", { className: "px-3 py-3", children: _jsx("button", { onClick: () => setExpanded(expanded === r.id ? null : r.id), className: "text-gray-400 hover:text-gray-600", children: expanded === r.id ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(ResourceIcon, { type: r.resourceType, size: 14 }), _jsxs("div", { children: [_jsx("p", { className: "font-medium text-gray-900", children: r.displayName }), _jsx("p", { className: "text-xs text-gray-500", children: r.email })] })] }) }), _jsx("td", { className: "px-4 py-3 text-gray-600", children: r.location || '—' }), typeTab === 'ROOM' && (_jsx("td", { className: "px-4 py-3 text-gray-700", children: r.capacity ? `${r.capacity} Pers.` : '—' })), _jsx("td", { className: "px-4 py-3", children: r.autoAccept
                                                    ? _jsx("span", { className: "text-xs text-green-600", children: "\u2713 Automatisch" })
                                                    : _jsx("span", { className: "text-xs text-gray-400", children: "Manuell" }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("button", { onClick: () => toggleActive.mutate(r), children: _jsx(StatusBadge, { active: r.active }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setModal(r), className: "p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded", title: "Bearbeiten", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => setDeleteConfirm(r), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) })] }) })] }, r.id), expanded === r.id && (_jsx("tr", { children: _jsx("td", { colSpan: typeTab === 'ROOM' ? 7 : 6, className: "p-0", children: _jsx(BookingsPanel, { resource: r }) }) }, `${r.id}-bookings`))] }))) })] }) }), modal !== null && (_jsx(ResourceModal, { resource: modal === 'create' ? null : modal, domains: domains, onClose: () => setModal(null) })), deleteConfirm && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-sm p-6", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900 mb-2", children: "Ressource l\u00F6schen" }), _jsxs("p", { className: "text-sm text-gray-600 mb-4", children: ["Soll ", _jsx("strong", { children: deleteConfirm.displayName }), " (", deleteConfirm.email, ") wirklich gel\u00F6scht werden? Alle Buchungen werden ebenfalls entfernt."] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => setDeleteConfirm(null), className: "px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => deleteResource.mutate(deleteConfirm.id), disabled: deleteResource.isPending, className: "px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50", children: deleteResource.isPending ? 'Löschen…' : 'Löschen' })] })] }) }))] }));
}
