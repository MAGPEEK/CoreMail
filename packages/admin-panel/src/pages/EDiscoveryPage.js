import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchCheck, Plus, Trash2, Play, Download, Lock, Unlock, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
    const map = {
        PENDING: 'bg-gray-100 text-gray-600',
        RUNNING: 'bg-blue-100 text-blue-700',
        COMPLETED: 'bg-green-100 text-green-700',
        FAILED: 'bg-red-100 text-red-700',
    };
    const labels = {
        PENDING: 'Ausstehend', RUNNING: 'Läuft', COMPLETED: 'Abgeschlossen', FAILED: 'Fehlgeschlagen',
    };
    return (_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status]}`, children: labels[status] }));
}
function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// ─── Create Search Modal ──────────────────────────────────────────────────────
function CreateSearchModal({ onClose }) {
    const qc = useQueryClient();
    const [form, setForm] = useState({
        name: '', description: '',
        keywords: '', senderAddresses: '', recipientAddresses: '',
        dateFrom: '', dateTo: '', subjectContains: '',
    });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => api.post('/admin/ediscovery/searches', {
            name: form.name,
            description: form.description,
            query: {
                ...(form.keywords ? { keywords: form.keywords } : {}),
                ...(form.senderAddresses ? { senderAddresses: form.senderAddresses.split(',').map(s => s.trim()).filter(Boolean) } : {}),
                ...(form.recipientAddresses ? { recipientAddresses: form.recipientAddresses.split(',').map(s => s.trim()).filter(Boolean) } : {}),
                ...(form.dateFrom ? { dateFrom: new Date(form.dateFrom).toISOString() } : {}),
                ...(form.dateTo ? { dateTo: new Date(form.dateTo).toISOString() } : {}),
                ...(form.subjectContains ? { subjectContains: form.subjectContains } : {}),
            },
            mailboxIds: [],
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] });
            toast.success('Suche erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    const F = ({ label, k, placeholder, type = 'text' }) => (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: label }), _jsx("input", { type: type, value: form[k], onChange: e => set(k, e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: placeholder })] }));
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Neue eDiscovery-Suche" }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-3", children: [_jsx(F, { label: "Name *", k: "name", placeholder: "Projekt Gamma Untersuchung" }), _jsx(F, { label: "Beschreibung", k: "description", placeholder: "Optionale Beschreibung" }), _jsx("div", { className: "border-t border-gray-100 pt-3", children: _jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "Suchkriterien" }) }), _jsx(F, { label: "Stichw\u00F6rter", k: "keywords", placeholder: "Begriff1 Begriff2" }), _jsx(F, { label: "Betreff enth\u00E4lt", k: "subjectContains", placeholder: "Re: Vertrag" }), _jsx(F, { label: "Absender (kommagetrennt)", k: "senderAddresses", placeholder: "user@domain.com, \u2026" }), _jsx(F, { label: "Empf\u00E4nger (kommagetrennt)", k: "recipientAddresses", placeholder: "user@domain.com, \u2026" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(F, { label: "Datum von", k: "dateFrom", type: "date" }), _jsx(F, { label: "Datum bis", k: "dateTo", type: "date" })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.name, className: "px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50", children: save.isPending ? 'Erstellen…' : 'Erstellen' })] })] }) }));
}
// ─── Create Hold Modal ────────────────────────────────────────────────────────
function CreateHoldModal({ onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [mailboxIds, setMailboxIds] = useState('');
    const save = useMutation({
        mutationFn: () => api.post('/admin/ediscovery/holds', {
            name, description,
            mailboxIds: mailboxIds.split(',').map(s => s.trim()).filter(Boolean),
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] });
            toast.success('Legal Hold erstellt');
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-md", children: [_jsxs("div", { className: "px-6 py-4 border-b border-gray-200 flex items-center justify-between", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Neuer Legal Hold" }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 text-xl leading-none", children: "\u00D7" })] }), _jsxs("div", { className: "px-6 py-4 space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Name *" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", placeholder: "z.B. Rechtsstreit M\u00FCller vs. AG" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "Beschreibung" }), _jsx("textarea", { value: description, onChange: e => setDescription(e.target.value), rows: 2, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-700 mb-1", children: "User-IDs (kommagetrennt)" }), _jsx("textarea", { value: mailboxIds, onChange: e => setMailboxIds(e.target.value), rows: 3, className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none", placeholder: "cuid1, cuid2, \u2026" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "User-IDs aus der Postfachverwaltung" })] })] }), _jsxs("div", { className: "px-6 py-4 border-t border-gray-200 flex justify-end gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50", children: "Abbrechen" }), _jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !name || !mailboxIds.trim(), className: "px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50", children: save.isPending ? 'Sperren…' : 'Hold aktivieren' })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function EDiscoveryPage() {
    const qc = useQueryClient();
    const [tab, setTab] = useState('searches');
    const [createSearch, setCreateSearch] = useState(false);
    const [createHold, setCreateHold] = useState(false);
    const [expandedSearch, setExpandedSearch] = useState(null);
    const { data: searches = [], isLoading: searchLoading } = useQuery({
        queryKey: ['admin-ediscovery-searches'],
        queryFn: () => api.get('/admin/ediscovery/searches'),
        refetchInterval: 5000, // poll for status changes
    });
    const { data: holds = [], isLoading: holdLoading } = useQuery({
        queryKey: ['admin-ediscovery-holds'],
        queryFn: () => api.get('/admin/ediscovery/holds'),
    });
    const runSearch = useMutation({
        mutationFn: (id) => api.post(`/admin/ediscovery/searches/${id}/run`, {}),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gestartet'); },
        onError: (e) => toast.error(e.message),
    });
    const exportSearch = useMutation({
        mutationFn: (id) => api.post(`/admin/ediscovery/searches/${id}/export`, {}),
        onSuccess: () => toast.success('Export-Job gestartet — Download-Link folgt'),
        onError: (e) => toast.error(e.message),
    });
    const deleteSearch = useMutation({
        mutationFn: (id) => api.delete(`/admin/ediscovery/searches/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    const releaseHold = useMutation({
        mutationFn: (id) => api.delete(`/admin/ediscovery/holds/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] }); toast.success('Legal Hold aufgehoben'); },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(SearchCheck, { size: 22, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "eDiscovery & Legal Hold" }), _jsx("p", { className: "text-sm text-gray-500", children: "Postfach-Suche, Datenexport und Aufbewahrungssperren" })] })] }), _jsxs("button", { onClick: () => tab === 'searches' ? setCreateSearch(true) : setCreateHold(true), className: `flex items-center gap-2 px-4 py-2 text-sm text-white rounded hover:opacity-90 ${tab === 'holds' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent/90'}`, children: [_jsx(Plus, { size: 15 }), " ", tab === 'searches' ? 'Neue Suche' : 'Neuer Legal Hold'] })] }), _jsx("div", { className: "flex border-b border-gray-200 mb-4", children: ['searches', 'holds'].map(t => (_jsx("button", { onClick: () => setTab(t), className: `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'}`, children: t === 'searches' ? `Suchen (${searches.length})` : `Legal Holds (${holds.filter(h => h.active).length} aktiv)` }, t))) }), tab === 'searches' && (_jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx("th", { className: "w-6 px-3 py-3" }), _jsx("th", { className: "text-left px-4 py-3", children: "Suche" }), _jsx("th", { className: "text-left px-4 py-3", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3", children: "Ergebnisse" }), _jsx("th", { className: "text-left px-4 py-3", children: "Erstellt" }), _jsx("th", { className: "px-4 py-3" })] }) }), _jsx("tbody", { children: searchLoading ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Laden\u2026" }) })) : searches.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "text-center py-12 text-gray-400", children: "Noch keine Suchen angelegt" }) })) : searches.map(s => (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "border-b border-gray-100 hover:bg-gray-50", children: [_jsx("td", { className: "px-3 py-3", children: _jsx("button", { onClick: () => setExpandedSearch(expandedSearch === s.id ? null : s.id), className: "text-gray-400 hover:text-gray-600", children: expandedSearch === s.id ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }) }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900", children: s.name }), s.description && _jsx("p", { className: "text-xs text-gray-500", children: s.description })] }), _jsx("td", { className: "px-4 py-3", children: _jsx(StatusBadge, { status: s.status }) }), _jsx("td", { className: "px-4 py-3 text-gray-700", children: s.status === 'COMPLETED' ? s.resultCount.toLocaleString('de-DE') : '—' }), _jsx("td", { className: "px-4 py-3 text-xs text-gray-500", children: fmtDate(s.createdAt) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [s.status !== 'RUNNING' && (_jsx("button", { onClick: () => runSearch.mutate(s.id), className: "p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded", title: "Suche starten", children: _jsx(Play, { size: 13 }) })), s.status === 'COMPLETED' && (_jsx("button", { onClick: () => exportSearch.mutate(s.id), className: "p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded", title: "Exportieren", children: _jsx(Download, { size: 13 }) })), _jsx("button", { onClick: () => deleteSearch.mutate(s.id), className: "p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) })] }) })] }, s.id), expandedSearch === s.id && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-0", children: _jsxs("div", { className: "bg-gray-50 border-t border-gray-100 px-8 py-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "Suchkriterien" }), _jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [s.query.keywords && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Stichw\u00F6rter:" }), " ", _jsx("span", { className: "text-gray-800", children: s.query.keywords })] }), s.query.subjectContains && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Betreff:" }), " ", _jsx("span", { className: "text-gray-800", children: s.query.subjectContains })] }), s.query.senderAddresses?.length ? _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Absender:" }), " ", _jsx("span", { className: "text-gray-800", children: s.query.senderAddresses.join(', ') })] }) : null, s.query.recipientAddresses?.length ? _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Empf\u00E4nger:" }), " ", _jsx("span", { className: "text-gray-800", children: s.query.recipientAddresses.join(', ') })] }) : null, s.query.dateFrom && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Von:" }), " ", _jsx("span", { className: "text-gray-800", children: new Date(s.query.dateFrom).toLocaleDateString('de-DE') })] }), s.query.dateTo && _jsxs("div", { children: [_jsx("span", { className: "text-gray-500", children: "Bis:" }), " ", _jsx("span", { className: "text-gray-800", children: new Date(s.query.dateTo).toLocaleDateString('de-DE') })] })] }), s.exportPath && (_jsxs("div", { className: "mt-2", children: [_jsx("span", { className: "text-xs text-gray-500", children: "Export:" }), _jsx("a", { href: s.exportPath, className: "text-xs text-blue-600 hover:underline ml-1", children: s.exportPath })] }))] }) }) }, `${s.id}-details`))] }))) })] }) })), tab === 'holds' && (_jsx("div", { className: "space-y-3", children: holdLoading ? (_jsx("p", { className: "text-gray-400 text-center py-12", children: "Laden\u2026" })) : holds.length === 0 ? (_jsx("p", { className: "text-gray-400 text-center py-12", children: "Keine Legal Holds vorhanden" })) : holds.map(h => (_jsx("div", { className: `bg-white rounded-lg border p-4 ${h.active ? 'border-red-200' : 'border-gray-200 opacity-60'}`, children: _jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2 mb-1", children: [_jsx(Lock, { size: 14, className: h.active ? 'text-red-500' : 'text-gray-400' }), _jsx("span", { className: "font-medium text-gray-900", children: h.name }), _jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${h.active ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`, children: h.active ? 'Aktiv' : 'Aufgehoben' })] }), h.description && _jsx("p", { className: "text-xs text-gray-500 mb-1", children: h.description }), _jsxs("p", { className: "text-xs text-gray-500", children: [h.mailboxIds.length, " Postf\u00E4cher gesperrt \u00B7 Aktiviert ", fmtDate(h.appliedAt), h.releasedAt && ` · Aufgehoben ${fmtDate(h.releasedAt)}`] })] }), h.active && (_jsxs("button", { onClick: () => releaseHold.mutate(h.id), className: "flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50", children: [_jsx(Unlock, { size: 12 }), " Aufheben"] }))] }) }, h.id))) })), createSearch && _jsx(CreateSearchModal, { onClose: () => setCreateSearch(false) }), createHold && _jsx(CreateHoldModal, { onClose: () => setCreateHold(false) })] }));
}
