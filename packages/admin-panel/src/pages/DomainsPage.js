import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, X, CheckCircle } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
export function DomainsPage() {
    const qc = useQueryClient();
    const [showCreate, setShowCreate] = useState(false);
    const [name, setName] = useState('');
    const [dkimRecord, setDkimRecord] = useState(null);
    const { data: domains } = useQuery({ queryKey: ['admin-domains'], queryFn: () => api.get('/admin/domains') });
    const createMutation = useMutation({
        mutationFn: () => api.post('/admin/domains', { name }),
        onSuccess: () => { toast.success('Domain erstellt'); qc.invalidateQueries({ queryKey: ['admin-domains'] }); setShowCreate(false); setName(''); },
        onError: (err) => toast.error(err.message),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/admin/domains/${id}`),
        onSuccess: () => { toast.success('Domain gelöscht'); qc.invalidateQueries({ queryKey: ['admin-domains'] }); },
        onError: (err) => toast.error(err.message),
    });
    const fetchDkim = async (id) => {
        try {
            setDkimRecord(await api.get(`/admin/domains/${id}/dkim-record`));
        }
        catch (err) {
            toast.error(err instanceof Error ? err.message : 'Fehler');
        }
    };
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Domains" }), _jsxs("button", { onClick: () => setShowCreate(true), className: "btn-primary", children: [_jsx(Plus, { size: 15 }), " Domain hinzuf\u00FCgen"] })] }), _jsxs("div", { className: "card p-0 overflow-hidden", children: [_jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsx("tr", { children: ['Domain', 'DKIM-Selektor', 'Status', ''].map((h) => (_jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: h }, h))) }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: (domains ?? []).map((d) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-2.5 font-medium text-gray-800", children: d.name }), _jsx("td", { className: "px-4 py-2.5 font-mono text-xs text-gray-500", children: d.dkimSelector }), _jsx("td", { className: "px-4 py-2.5", children: _jsx("span", { className: `badge ${d.active ? 'badge-green' : 'badge-red'}`, children: d.active ? 'Aktiv' : 'Inaktiv' }) }), _jsx("td", { className: "px-4 py-2.5", children: _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("button", { onClick: () => fetchDkim(d.id), className: "btn-ghost text-xs p-1", title: "DKIM DNS Record anzeigen", children: [_jsx(CheckCircle, { size: 13 }), " DKIM"] }), _jsx("button", { onClick: () => { if (confirm(`${d.name} löschen?`))
                                                            deleteMutation.mutate(d.id); }, className: "btn-ghost p-1 text-xs text-red-500 hover:bg-red-50", children: _jsx(Trash2, { size: 13 }) })] }) })] }, d.id))) })] }), (domains ?? []).length === 0 && _jsx("div", { className: "py-8 text-center text-gray-400 text-sm", children: "Keine Domains konfiguriert" })] }), dkimRecord && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl w-full max-w-xl p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "DKIM DNS-Eintrag" }), _jsx("button", { onClick: () => setDkimRecord(null), className: "btn-ghost p-1", children: _jsx(X, { size: 16 }) })] }), _jsx("p", { className: "text-sm text-gray-600 mb-3", children: "F\u00FCgen Sie diesen TXT-Eintrag in Ihrem DNS hinzu:" }), _jsxs("div", { className: "space-y-2", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-500", children: "DNS-Name" }), _jsxs("div", { className: "flex items-center gap-2 mt-1", children: [_jsx("code", { className: "flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono break-all", children: dkimRecord.dnsName }), _jsx("button", { onClick: () => { navigator.clipboard.writeText(dkimRecord.dnsName); toast.success('Kopiert'); }, className: "btn-ghost p-1.5", children: _jsx(Copy, { size: 13 }) })] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-500", children: "TXT-Wert" }), _jsxs("div", { className: "flex items-start gap-2 mt-1", children: [_jsx("code", { className: "flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono break-all", children: dkimRecord.dnsValue }), _jsx("button", { onClick: () => { navigator.clipboard.writeText(dkimRecord.dnsValue); toast.success('Kopiert'); }, className: "btn-ghost p-1.5 mt-0.5", children: _jsx(Copy, { size: 13 }) })] })] })] })] }) })), showCreate && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl w-full max-w-sm p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "Domain hinzuf\u00FCgen" }), _jsx("button", { onClick: () => setShowCreate(false), className: "btn-ghost p-1", children: _jsx(X, { size: 16 }) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Domain-Name" }), _jsx("input", { className: "input", value: name, onChange: (e) => setName(e.target.value), placeholder: "company.com" })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-4", children: [_jsx("button", { onClick: () => setShowCreate(false), className: "btn-secondary", children: "Abbrechen" }), _jsx("button", { onClick: () => createMutation.mutate(), disabled: !name || createMutation.isPending, className: "btn-primary disabled:opacity-50", children: createMutation.isPending ? 'Hinzufügen...' : 'Hinzufügen' })] })] }) }))] }));
}
