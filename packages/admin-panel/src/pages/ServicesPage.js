import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, LayoutGrid, Mail, Inbox, Archive, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
const SVC_SLUG = {
    SMTP_RECEIVE: 'smtp-receive',
    IMAP: 'imap',
    POP3: 'pop3',
};
const SERVICES = [
    { key: 'SMTP_RECEIVE', label: 'SMTP Inbound', ports: '25 · 465 · 587', icon: Inbox },
    { key: 'IMAP', label: 'IMAP', ports: '143 · 993', icon: Mail },
    { key: 'POP3', label: 'POP3', ports: '110 · 995', icon: Archive },
];
function ListenerModal({ initial, onSave, onClose }) {
    const [form, setForm] = useState({
        address: initial?.address ?? '0.0.0.0',
        port: initial?.port ?? '',
        ssl: initial?.ssl ?? false,
        active: initial?.active ?? true,
    });
    const set = (f, v) => setForm(prev => ({ ...prev, [f]: v }));
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-sm p-6", children: [_jsx("h3", { className: "text-base font-semibold text-gray-800 mb-4", children: initial ? 'Listener bearbeiten' : 'Listener hinzufügen' }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "IP-Adresse" }), _jsx("input", { type: "text", value: form.address, onChange: e => set('address', e.target.value), placeholder: "0.0.0.0", className: "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Port" }), _jsx("input", { type: "number", value: form.port, onChange: e => set('port', e.target.value), placeholder: "25", min: 1, max: 65535, className: "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" })] }), _jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-xs font-medium text-gray-600", children: "SSL/TLS" }), _jsx(Toggle, { active: form.ssl, onToggle: () => set('ssl', !form.ssl) })] }), _jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "text-xs font-medium text-gray-600", children: "Aktiv" }), _jsx(Toggle, { active: form.active, onToggle: () => set('active', !form.active) })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-5", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors", children: "Abbrechen" }), _jsx("button", { onClick: () => {
                                if (!form.port || isNaN(Number(form.port))) {
                                    toast.error('Bitte einen gültigen Port eingeben');
                                    return;
                                }
                                onSave(form);
                            }, className: "px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors", children: "Speichern" })] })] }) }));
}
// ── Listener-Tabelle ──────────────────────────────────────────────────────────
function ListenersTable({ svcKey }) {
    const qc = useQueryClient();
    const slug = SVC_SLUG[svcKey];
    const [modal, setModal] = useState(null);
    const { data: listeners = [], isLoading } = useQuery({
        queryKey: ['service-listeners', svcKey],
        queryFn: () => api.get(`/admin/services/listeners/${slug}`),
    });
    const editing = modal && modal !== 'add' ? listeners.find(l => l.id === modal) : null;
    const invalidate = () => {
        void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] });
        void qc.invalidateQueries({ queryKey: ['services-overview'] });
    };
    const addMut = useMutation({
        mutationFn: (d) => api.post(`/admin/services/listeners/${slug}`, {
            address: d.address, port: Number(d.port), ssl: d.ssl, active: d.active,
        }),
        onSuccess: () => { invalidate(); setModal(null); toast.success('Listener hinzugefügt'); },
        onError: () => toast.error('Fehler beim Hinzufügen'),
    });
    const editMut = useMutation({
        mutationFn: ({ id, d }) => api.put(`/admin/services/listeners/${id}`, {
            address: d.address, port: Number(d.port), ssl: d.ssl, active: d.active,
        }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); setModal(null); toast.success('Gespeichert'); },
        onError: () => toast.error('Fehler beim Speichern'),
    });
    const toggleMut = useMutation({
        mutationFn: (id) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }),
        onError: () => toast.error('Fehler'),
    });
    const deleteMut = useMutation({
        mutationFn: (id) => api.delete(`/admin/services/listeners/${id}`),
        onSuccess: () => { invalidate(); toast.success('Gelöscht'); },
        onError: () => toast.error('Fehler beim Löschen'),
    });
    const svc = SERVICES.find(s => s.key === svcKey);
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: svc.label }), _jsxs("p", { className: "text-xs text-gray-400", children: ["Standard-Ports: ", svc.ports] })] }), _jsxs("button", { onClick: () => setModal('add'), className: "flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Listener hinzuf\u00FCgen"] })] }), isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-16 text-gray-400", children: [_jsx(Loader2, { size: 18, className: "animate-spin mr-2" }), " Lade\u2026"] })) : listeners.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center py-16 text-gray-400", children: [_jsx("p", { className: "text-sm", children: "Keine Listener konfiguriert" }), _jsx("button", { onClick: () => setModal('add'), className: "mt-3 text-blue-600 text-sm hover:underline", children: "Ersten Listener hinzuf\u00FCgen" })] })) : (_jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200", children: [_jsx("th", { className: "text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-10", children: "#" }), _jsx("th", { className: "text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Address:Port" }), _jsx("th", { className: "text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: listeners.map((l, i) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-6 py-4 text-gray-400 font-mono text-xs", children: i + 1 }), _jsx("td", { className: "px-6 py-4", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "font-mono font-medium text-gray-800", children: [l.address, ":", l.port] }), l.ssl && (_jsxs("span", { className: "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200", children: [_jsx(Lock, { size: 10 }), " SSL"] }))] }) }), _jsx("td", { className: "px-6 py-4 text-right", children: _jsx(Toggle, { active: l.active, onToggle: () => toggleMut.mutate(l.id) }) }), _jsx("td", { className: "px-6 py-4", children: _jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx("button", { onClick: () => setModal(l.id), className: "p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors border border-gray-200", title: "Bearbeiten", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (confirm(`Listener ${l.address}:${l.port} löschen?`))
                                                        deleteMut.mutate(l.id); }, className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors border border-gray-200", title: "L\u00F6schen", children: _jsx(Trash2, { size: 14 }) })] }) })] }, l.id))) })] }) })), modal === 'add' && _jsx(ListenerModal, { onSave: d => addMut.mutate(d), onClose: () => setModal(null) }), modal && modal !== 'add' && editing && (_jsx(ListenerModal, { initial: { address: editing.address, port: String(editing.port), ssl: editing.ssl, active: editing.active }, onSave: d => editMut.mutate({ id: modal, d }), onClose: () => setModal(null) }))] }));
}
// ── Übersicht ─────────────────────────────────────────────────────────────────
function Overview({ onSelect }) {
    const { data: overview, isLoading } = useQuery({
        queryKey: ['services-overview'],
        queryFn: () => api.get('/admin/services/overview'),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "mb-5", children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Services" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "Protokoll-Listener \u2014 IP-Adressen und Ports der eingehenden Verbindungen" })] }), isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-16 text-gray-400", children: [_jsx(Loader2, { size: 18, className: "animate-spin mr-2" }), " Lade\u2026"] })) : (_jsx("div", { className: "grid grid-cols-3 gap-4 max-w-2xl", children: SERVICES.map(({ key, label, ports, icon: Icon }) => {
                    const entry = overview?.[key] ?? { total: 0, active: 0 };
                    return (_jsxs("button", { onClick: () => onSelect(key), className: "bg-white border border-gray-200 rounded-xl p-5 text-left hover:border-blue-400 hover:shadow-md transition-all group", children: [_jsxs("div", { className: "flex items-center gap-3 mb-4", children: [_jsx("div", { className: "p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors", children: _jsx(Icon, { size: 18, className: "text-blue-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-800", children: label }), _jsx("p", { className: "text-xs text-gray-400 font-mono", children: ports })] })] }), _jsxs("div", { className: "flex items-baseline gap-1", children: [_jsx("span", { className: "text-2xl font-bold text-gray-900", children: entry.active }), _jsxs("span", { className: "text-sm text-gray-400", children: ["/ ", entry.total, " aktiv"] })] }), _jsx("div", { className: "mt-2", children: _jsx("div", { className: "w-full bg-gray-100 rounded-full h-1.5", children: _jsx("div", { className: "bg-blue-500 h-1.5 rounded-full", style: { width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' } }) }) }), _jsx("p", { className: "text-xs text-blue-600 mt-3 font-medium group-hover:underline", children: "Listener verwalten \u2192" })] }, key));
                }) })), _jsx("div", { className: "mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl", children: _jsxs("p", { className: "text-xs text-blue-700", children: [_jsx("strong", { children: "Hinweis:" }), " \u00C4nderungen (Hinzuf\u00FCgen, Bearbeiten, L\u00F6schen, Toggle) werden sofort wirksam \u2014 die Dienste laden ihre Listener-Konfiguration dynamisch neu ohne Container-Neustart."] }) })] }));
}
// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function ServicesPage() {
    const [view, setView] = useState('overview');
    return (_jsxs("div", { className: "h-full flex bg-gray-50", children: [_jsxs("aside", { className: "w-44 shrink-0 bg-[#1e2433] text-gray-300 flex flex-col", children: [_jsx("div", { className: "px-4 py-3 border-b border-white/10", children: _jsx("p", { className: "text-[10px] font-bold text-gray-400 uppercase tracking-widest", children: "Services" }) }), _jsx("nav", { className: "flex-1 py-1", children: [
                            { key: 'overview', label: 'Übersicht', icon: LayoutGrid },
                            { key: 'SMTP_RECEIVE', label: 'SMTP Inbound', icon: Inbox },
                            { key: 'IMAP', label: 'IMAP', icon: Mail },
                            { key: 'POP3', label: 'POP3', icon: Archive },
                        ].map(({ key, label, icon: Icon }) => (_jsxs("button", { onClick: () => setView(key), className: `w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${view === key ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'}`, children: [_jsx(Icon, { size: 13 }), label] }, key))) })] }), _jsx("div", { className: "flex-1 overflow-y-auto", children: view === 'overview'
                    ? _jsx(Overview, { onSelect: k => setView(k) })
                    : _jsx(ListenersTable, { svcKey: view }) })] }));
}
