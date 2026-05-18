import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, X, Copy, CheckCircle, ChevronDown } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
// ── Add-Domain-Modal ──────────────────────────────────────────────────────────
function AddDomainModal({ onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [selector, setSelector] = useState('coremail');
    const createMutation = useMutation({
        mutationFn: () => api.post('/admin/domains', { name: name.trim(), dkimSelector: selector }),
        onSuccess: () => {
            toast.success('Domain wurde hinzugefügt');
            void qc.invalidateQueries({ queryKey: ['admin-domains'] });
            onClose();
        },
        onError: (err) => toast.error(err.message || 'Fehler beim Anlegen'),
    });
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl w-full max-w-sm p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Domain hinzuf\u00FCgen" }), _jsx("button", { onClick: onClose, className: "p-1 text-gray-400 hover:text-gray-600 rounded", children: _jsx(X, { size: 16 }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsxs("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: ["Domain-Name ", _jsx("span", { className: "text-red-500", children: "*" })] }), _jsx("input", { className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", value: name, onChange: e => setName(e.target.value), placeholder: "example.com", autoFocus: true, onKeyDown: e => e.key === 'Enter' && name.trim() && createMutation.mutate() })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "DKIM-Selektor" }), _jsx("input", { className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", value: selector, onChange: e => setSelector(e.target.value), placeholder: "coremail" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "DKIM-Schl\u00FCsselpaar wird automatisch generiert" })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-5", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors", children: "Abbrechen" }), _jsx("button", { onClick: () => createMutation.mutate(), disabled: !name.trim() || createMutation.isPending, className: "px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50", children: createMutation.isPending ? 'Hinzufügen…' : 'Hinzufügen' })] })] }) }));
}
// ── Edit-Domain-Modal ─────────────────────────────────────────────────────────
function EditDomainModal({ domain, onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState(domain.name);
    const [selector, setSelector] = useState(domain.dkimSelector);
    const [dkimRecord, setDkimRecord] = useState(null);
    const updateMutation = useMutation({
        mutationFn: () => api.put(`/admin/domains/${domain.id}`, { name: name.trim(), dkimSelector: selector }),
        onSuccess: () => {
            toast.success('Domain aktualisiert');
            void qc.invalidateQueries({ queryKey: ['admin-domains'] });
            onClose();
        },
        onError: (err) => toast.error(err.message || 'Fehler'),
    });
    const deleteMutation = useMutation({
        mutationFn: () => api.delete(`/admin/domains/${domain.id}`),
        onSuccess: () => {
            toast.success('Domain gelöscht');
            void qc.invalidateQueries({ queryKey: ['admin-domains'] });
            onClose();
        },
        onError: (err) => toast.error(err.message || 'Fehler beim Löschen'),
    });
    const loadDkim = async () => {
        try {
            const r = await api.get(`/admin/domains/${domain.id}/dkim-record`);
            setDkimRecord(r);
        }
        catch {
            toast.error('DKIM-Record konnte nicht geladen werden');
        }
    };
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl w-full max-w-lg p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Domain bearbeiten" }), _jsx("button", { onClick: onClose, className: "p-1 text-gray-400 hover:text-gray-600 rounded", children: _jsx(X, { size: 16 }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Domain-Name" }), _jsx("input", { className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", value: name, onChange: e => setName(e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "DKIM-Selektor" }), _jsx("input", { className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500", value: selector, onChange: e => setSelector(e.target.value) })] }), _jsxs("div", { className: "flex items-center gap-4 pt-1", children: [_jsx("span", { className: `text-xs px-2 py-0.5 rounded-full font-medium ${domain.primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`, children: domain.primary ? 'Primäre Domain' : 'Sekundäre Domain' }), _jsxs("span", { className: "text-xs text-gray-400", children: [domain._count.users, " Postfach/Postf\u00E4cher"] })] }), _jsx("div", { className: "pt-1", children: _jsxs("button", { onClick: loadDkim, className: "flex items-center gap-1.5 text-xs text-blue-600 hover:underline", children: [_jsx(CheckCircle, { size: 13 }), "DKIM DNS-Eintrag anzeigen"] }) }), dkimRecord && (_jsxs("div", { className: "bg-gray-50 rounded-lg p-3 space-y-2 border border-gray-200", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-500 font-medium", children: "DNS-Name" }), _jsxs("div", { className: "flex items-center gap-2 mt-1", children: [_jsx("code", { className: "flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all", children: dkimRecord.dnsName }), _jsx("button", { onClick: () => { void navigator.clipboard.writeText(dkimRecord.dnsName); toast.success('Kopiert'); }, className: "p-1 text-gray-400 hover:text-gray-600", children: _jsx(Copy, { size: 12 }) })] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs text-gray-500 font-medium", children: "TXT-Wert" }), _jsxs("div", { className: "flex items-start gap-2 mt-1", children: [_jsx("code", { className: "flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all", children: dkimRecord.dnsValue }), _jsx("button", { onClick: () => { void navigator.clipboard.writeText(dkimRecord.dnsValue); toast.success('Kopiert'); }, className: "p-1 text-gray-400 hover:text-gray-600 mt-0.5", children: _jsx(Copy, { size: 12 }) })] })] })] }))] }), _jsxs("div", { className: "flex items-center justify-between mt-5", children: [_jsx("button", { onClick: () => {
                                if (confirm(`Domain "${domain.name}" wirklich löschen?`))
                                    deleteMutation.mutate();
                            }, disabled: domain.primary || deleteMutation.isPending, className: "px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed", title: domain.primary ? 'Primäre Domain kann nicht gelöscht werden' : undefined, children: "L\u00F6schen" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors", children: "Abbrechen" }), _jsx("button", { onClick: () => updateMutation.mutate(), disabled: !name.trim() || updateMutation.isPending, className: "px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50", children: updateMutation.isPending ? 'Speichern…' : 'Speichern' })] })] })] }) }));
}
// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function DomainsPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [limit, setLimit] = useState(50);
    const [page, setPage] = useState(1);
    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null);
    // Debounced search query string
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useMemo(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(t);
    }, [search]);
    const { data, isLoading } = useQuery({
        queryKey: ['admin-domains', debouncedSearch, page, limit],
        queryFn: () => api.get(`/admin/domains?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`),
        placeholderData: prev => prev,
    });
    const domains = data?.domains ?? [];
    const total = data?.total ?? 0;
    const totalPages = Math.ceil(total / limit);
    const toggleMutation = useMutation({
        mutationFn: (id) => api.patch(`/admin/domains/${id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-domains'] }),
        onError: () => toast.error('Fehler beim Umschalten'),
    });
    const makePrimaryMutation = useMutation({
        mutationFn: (id) => api.post(`/admin/domains/${id}/make-primary`, {}),
        onSuccess: () => {
            toast.success('Primäre Domain gesetzt');
            void qc.invalidateQueries({ queryKey: ['admin-domains'] });
        },
        onError: () => toast.error('Fehler beim Setzen der primären Domain'),
    });
    return (_jsxs("div", { className: "min-h-full bg-gray-100", children: [_jsx("div", { className: "bg-white border-b border-gray-200 px-8 py-5", children: _jsx("div", { className: "flex items-center justify-between", children: _jsx("h1", { className: "text-2xl font-bold text-gray-900", children: "Manage Domains" }) }) }), _jsx("div", { className: "p-8", children: _jsxs("div", { className: "bg-white rounded-lg shadow-sm border border-gray-200", children: [_jsxs("div", { className: "flex items-center gap-4 p-5 border-b border-gray-200", children: [_jsx("h2", { className: "text-lg font-bold text-gray-900 shrink-0", children: "Domains" }), _jsx("div", { className: "flex-1 max-w-lg", children: _jsx("input", { type: "text", value: search, onChange: e => { setSearch(e.target.value); setPage(1); }, placeholder: "Search domains", className: "w-full border border-gray-300 rounded px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-center placeholder-gray-400" }) }), _jsx("div", { className: "flex-1" }), _jsxs("button", { onClick: () => setShowAdd(true), className: "flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors uppercase tracking-wide", children: [_jsx(Plus, { size: 15 }), "ADD DOMAIN"] })] }), _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-gray-200", children: [_jsx("th", { className: "text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide w-12", children: "#" }), _jsx("th", { className: "text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide", children: "DOMAIN NAME" }), _jsx("th", { className: "px-6 py-3 w-44" }), _jsx("th", { className: "text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide", children: "STATUS" }), _jsx("th", { className: "text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide", children: "ACTIONS" })] }) }), _jsxs("tbody", { className: "divide-y divide-gray-100", children: [isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "py-12 text-center text-gray-400 text-sm", children: "Lade\u2026" }) })), !isLoading && domains.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "py-12 text-center text-gray-400 text-sm", children: search ? 'Keine Domains gefunden' : 'Noch keine Domains angelegt' }) })), domains.map((d, i) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-6 py-4 text-gray-500 text-sm", children: (page - 1) * limit + i + 1 }), _jsx("td", { className: "px-6 py-4 text-gray-800 text-sm font-medium", children: d.name }), _jsx("td", { className: "px-6 py-4", children: d.primary ? (_jsx("span", { className: "text-sm text-gray-500", children: "Primary Domain" })) : (_jsx("button", { onClick: () => makePrimaryMutation.mutate(d.id), disabled: makePrimaryMutation.isPending, className: "px-4 py-1.5 text-xs font-bold text-blue-600 border border-blue-300 rounded hover:bg-blue-50 transition-colors uppercase tracking-wide disabled:opacity-50", children: "MAKE PRIMARY" })) }), _jsx("td", { className: "px-6 py-4 text-center", children: _jsx(Toggle, { active: d.active, onToggle: () => toggleMutation.mutate(d.id) }) }), _jsx("td", { className: "px-6 py-4 text-center", children: _jsx("button", { onClick: () => setEditing(d), className: "p-1.5 text-blue-500 hover:text-blue-700 border border-blue-200 rounded hover:bg-blue-50 transition-colors", title: "Domain bearbeiten", children: _jsx(Pencil, { size: 14 }) }) })] }, d.id)))] })] }), _jsxs("div", { className: "flex items-center gap-3 px-6 py-3 border-t border-gray-200", children: [_jsxs("div", { className: "relative flex items-center", children: [_jsx("select", { value: limit, onChange: e => { setLimit(Number(e.target.value)); setPage(1); }, className: "appearance-none border border-gray-300 rounded px-3 py-1.5 pr-7 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer", children: [10, 25, 50, 100].map(n => _jsx("option", { value: n, children: n }, n)) }), _jsx(ChevronDown, { size: 12, className: "absolute right-2 text-gray-400 pointer-events-none" })] }), _jsx("span", { className: "text-sm text-gray-500", children: "domains per page" }), _jsx("div", { className: "flex-1" }), totalPages > 1 && (_jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1, className: "px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40", children: "\u2039" }), _jsxs("span", { className: "text-sm text-gray-600", children: [page, " / ", totalPages] }), _jsx("button", { onClick: () => setPage(p => Math.min(totalPages, p + 1)), disabled: page === totalPages, className: "px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40", children: "\u203A" })] })), _jsxs("span", { className: "text-xs text-gray-400", children: [total, " Domain", total !== 1 ? 's' : '', " gesamt"] })] })] }) }), showAdd && _jsx(AddDomainModal, { onClose: () => setShowAdd(false) }), editing && _jsx(EditDomainModal, { domain: editing, onClose: () => setEditing(null) })] }));
}
