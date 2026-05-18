import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Cable, Plus, Trash2, Pencil, X, Loader2, ToggleLeft, ToggleRight, ArrowUpRight, ArrowDownLeft, LayoutGrid, Mail, Inbox, Archive, Lock, } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
const SVC_SLUG = {
    SMTP_RECEIVE: 'smtp-receive',
    IMAP: 'imap',
    POP3: 'pop3',
};
// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTORS
// ═══════════════════════════════════════════════════════════════════════════════
function ConnectorTable({ items, type, onEdit, onAdd, }) {
    const qc = useQueryClient();
    const toggleMutation = useMutation({
        mutationFn: (id) => api.patch(`/api/v1/admin/connectors/${id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-connectors'] }),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/connectors/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-connectors'] }); toast.success('Gelöscht'); },
        onError: () => toast.error('Löschen fehlgeschlagen'),
    });
    return (_jsxs("div", { className: "mb-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [type === 'SEND'
                                ? _jsx(ArrowUpRight, { size: 16, className: "text-blue-500" })
                                : _jsx(ArrowDownLeft, { size: 16, className: "text-green-500" }), _jsx("h2", { className: "font-semibold text-gray-800", children: type === 'SEND' ? 'Sendeconnectors' : 'Empfangsconnectors' }), _jsxs("span", { className: "text-xs text-gray-400", children: ["(", items.length, ")"] })] }), _jsxs("button", { onClick: () => onAdd(type), className: "flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors", children: [_jsx(Plus, { size: 12 }), " Neuer ", type === 'SEND' ? 'Sendeconnector' : 'Empfangsconnector'] })] }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: items.length === 0 ? (_jsxs("p", { className: "text-center py-8 text-sm text-gray-400", children: ["Keine ", type === 'SEND' ? 'Sende' : 'Empfangs', "connectoren"] })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Priorit\u00E4t" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Name" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: type === 'SEND' ? 'Ziel-Host' : 'Quell-IPs' }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Domains" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "TLS" }), _jsx("th", { className: "text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: [...items].sort((a, b) => a.priority - b.priority).map(c => (_jsxs("tr", { className: `hover:bg-gray-50 transition-colors ${!c.enabled ? 'opacity-50' : ''}`, children: [_jsx("td", { className: "px-4 py-3 text-xs font-mono text-gray-500", children: c.priority }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "text-sm font-medium text-gray-900", children: c.name }), c.description && _jsx("p", { className: "text-xs text-gray-400", children: c.description })] }), _jsx("td", { className: "px-4 py-3 text-sm text-gray-700", children: type === 'SEND'
                                            ? `${c.host}:${c.port}`
                                            : c.sourceIps.length ? c.sourceIps.slice(0, 2).join(', ') + (c.sourceIps.length > 2 ? ` +${c.sourceIps.length - 2}` : '') : 'Alle' }), _jsx("td", { className: "px-4 py-3", children: c.targetDomains.length === 0
                                            ? _jsx("span", { className: "text-xs text-gray-400", children: "Alle" })
                                            : _jsxs("span", { className: "text-xs text-gray-700", children: [c.targetDomains.slice(0, 2).join(', '), c.targetDomains.length > 2 ? ` +${c.targetDomains.length - 2}` : ''] }) }), _jsx("td", { className: "px-4 py-3", children: c.tls
                                            ? _jsx("span", { className: "badge badge-green text-xs", children: "TLS" })
                                            : _jsx("span", { className: "badge badge-gray text-xs", children: "Kein TLS" }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => toggleMutation.mutate(c.id), title: c.enabled ? 'Deaktivieren' : 'Aktivieren', className: `p-1.5 rounded transition-colors ${c.enabled ? 'text-green-500 hover:text-green-700' : 'text-gray-400 hover:text-gray-600'}`, children: c.enabled ? _jsx(ToggleRight, { size: 16 }) : _jsx(ToggleLeft, { size: 16 }) }), _jsx("button", { onClick: () => onEdit(c), title: "Bearbeiten", className: "p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (window.confirm(`"${c.name}" löschen?`))
                                                        deleteMutation.mutate(c.id); }, title: "L\u00F6schen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, c.id))) })] })) })] }));
}
function ConnectorModal({ type, connector, onClose }) {
    const qc = useQueryClient();
    const isSend = type === 'SEND';
    const [name, setName] = useState(connector?.name ?? '');
    const [description, setDesc] = useState(connector?.description ?? '');
    const [host, setHost] = useState(connector?.host ?? '');
    const [port, setPort] = useState(connector?.port ?? 25);
    const [tls, setTls] = useState(connector?.tls ?? false);
    const [requireTls, setReqTls] = useState(connector?.requireTls ?? false);
    const [priority, setPriority] = useState(connector?.priority ?? 0);
    const [sourceIps, setSourceIps] = useState(connector?.sourceIps.join('\n') ?? '');
    const [targetDomains, setTgtDom] = useState(connector?.targetDomains.join('\n') ?? '');
    const [username, setUsername] = useState(connector?.username ?? '');
    const [password, setPassword] = useState('');
    const mutation = useMutation({
        mutationFn: () => {
            const body = {
                name, description, type, host, port, tls, requireTls, priority,
                sourceIps: sourceIps.split('\n').map(s => s.trim()).filter(Boolean),
                targetDomains: targetDomains.split('\n').map(s => s.trim()).filter(Boolean),
                ...(username ? { username } : {}),
                ...(password ? { password } : {}),
            };
            return connector
                ? api.put(`/api/v1/admin/connectors/${connector.id}`, body)
                : api.post('/api/v1/admin/connectors', body);
        },
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-connectors'] });
            toast.success(connector ? 'Gespeichert' : 'Erstellt');
            onClose();
        },
        onError: () => toast.error('Fehler'),
    });
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: connector ? 'Connector bearbeiten' : `Neuer ${isSend ? 'Sende' : 'Empfangs'}connector` }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Name" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Beschreibung" }), _jsx("input", { value: description, onChange: e => setDesc(e.target.value), className: "input" })] }), _jsx("div", { className: "grid grid-cols-2 gap-3", children: _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Priorit\u00E4t" }), _jsx("input", { type: "number", value: priority, onChange: e => setPriority(Number(e.target.value)), className: "input", min: 0, max: 9999 })] }) }), isSend && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-3 gap-3", children: [_jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "field-label", children: "Ziel-Host" }), _jsx("input", { value: host, onChange: e => setHost(e.target.value), className: "input", placeholder: "smtp.relay.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Port" }), _jsx("input", { type: "number", value: port, onChange: e => setPort(Number(e.target.value)), className: "input", min: 1, max: 65535 })] })] }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: tls, onChange: e => setTls(e.target.checked), className: "rounded" }), "TLS"] }), _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: requireTls, onChange: e => setReqTls(e.target.checked), className: "rounded" }), "TLS erzwingen"] })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Benutzername (optional)" }), _jsx("input", { value: username, onChange: e => setUsername(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Passwort (optional, leer = unver\u00E4ndert)" }), _jsx("input", { type: "password", value: password, onChange: e => setPassword(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Ziel-Domains (eine pro Zeile, leer = Fallback f\u00FCr alle)" }), _jsx("textarea", { value: targetDomains, onChange: e => setTgtDom(e.target.value), rows: 3, className: "input font-mono text-sm", placeholder: "external-domain.com" })] })] })), !isSend && (_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Erlaubte Quell-IPs/CIDR (eine pro Zeile, leer = alle)" }), _jsx("textarea", { value: sourceIps, onChange: e => setSourceIps(e.target.value), rows: 4, className: "input font-mono text-sm", placeholder: "10.0.0.0/8\n192.168.1.100" })] })), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), connector ? 'Speichern' : 'Erstellen'] })] })] })] }) }));
}
function ConnectorsView() {
    const [typeFilter, setTypeFilter] = useState('');
    const [editItem, setEditItem] = useState(null);
    const [createType, setCreateType] = useState(null);
    const { data: connectors = [], isLoading } = useQuery({
        queryKey: ['admin-connectors', typeFilter],
        queryFn: () => api.get(`/api/v1/admin/connectors?type=${typeFilter}`),
    });
    const send = connectors.filter(c => c.type === 'SEND');
    const receive = connectors.filter(c => c.type === 'RECEIVE');
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Cable, { size: 20, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-lg font-bold text-gray-900", children: "Connectors" }), _jsx("p", { className: "text-sm text-gray-500", children: "Sende- und Empfangsconnectors f\u00FCr den Mailfluss" })] })] }), _jsx("div", { className: "flex gap-2", children: ['', 'SEND', 'RECEIVE'].map(t => (_jsx("button", { onClick: () => setTypeFilter(t), className: `px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${typeFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`, children: t === '' ? 'Alle' : t === 'SEND' ? 'Senden' : 'Empfangen' }, t))) })] }), isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade\u2026"] })) : (_jsxs(_Fragment, { children: [(typeFilter === '' || typeFilter === 'SEND') && (_jsx(ConnectorTable, { items: send, type: "SEND", onEdit: setEditItem, onAdd: setCreateType })), (typeFilter === '' || typeFilter === 'RECEIVE') && (_jsx(ConnectorTable, { items: receive, type: "RECEIVE", onEdit: setEditItem, onAdd: setCreateType }))] })), (createType || editItem) && (_jsx(ConnectorModal, { type: editItem?.type ?? createType, connector: editItem ?? undefined, onClose: () => { setEditItem(null); setCreateType(null); } }))] }));
}
function ListenerModal({ initial, onSave, onClose }) {
    const [form, setForm] = useState({
        address: initial?.address ?? '0.0.0.0',
        port: initial?.port ?? '',
        ssl: initial?.ssl ?? false,
        active: initial?.active ?? true,
    });
    const handle = (field, val) => setForm(f => ({ ...f, [field]: val }));
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40", children: _jsxs("div", { className: "bg-white rounded-lg shadow-xl w-full max-w-md p-6", children: [_jsx("h3", { className: "text-base font-semibold text-gray-800 mb-4", children: initial ? 'Listener bearbeiten' : 'Listener hinzufügen' }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "IP-Adresse" }), _jsx("input", { type: "text", value: form.address, onChange: e => handle('address', e.target.value), placeholder: "0.0.0.0", className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Port" }), _jsx("input", { type: "number", value: form.port, onChange: e => handle('port', e.target.value), placeholder: "25", min: 1, max: 65535, className: "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-xs font-medium text-gray-600", children: "SSL/TLS" }), _jsx(Toggle, { active: form.ssl, onToggle: () => handle('ssl', !form.ssl) })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-xs font-medium text-gray-600", children: "Aktiv" }), _jsx(Toggle, { active: form.active, onToggle: () => handle('active', !form.active) })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-6", children: [_jsx("button", { onClick: onClose, className: "px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors", children: "Abbrechen" }), _jsx("button", { onClick: () => {
                                if (!form.port || isNaN(Number(form.port))) {
                                    toast.error('Bitte einen gültigen Port eingeben');
                                    return;
                                }
                                onSave(form);
                            }, className: "px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors", children: "Speichern" })] })] }) }));
}
function ListenersTable({ svcKey, svcSlug }) {
    const qc = useQueryClient();
    const [modal, setModal] = useState(null);
    const { data: listeners = [], isLoading } = useQuery({
        queryKey: ['service-listeners', svcKey],
        queryFn: () => api.get(`/admin/services/listeners/${svcSlug}`),
    });
    const editingListener = modal && modal !== 'add' ? listeners.find(l => l.id === modal) : null;
    const addMutation = useMutation({
        mutationFn: (data) => api.post(`/admin/services/listeners/${svcSlug}`, { address: data.address, port: Number(data.port), ssl: data.ssl, active: data.active }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); void qc.invalidateQueries({ queryKey: ['services-overview'] }); setModal(null); toast.success('Listener hinzugefügt'); },
        onError: () => toast.error('Fehler beim Hinzufügen'),
    });
    const editMutation = useMutation({
        mutationFn: ({ id, data }) => api.put(`/admin/services/listeners/${id}`, { address: data.address, port: Number(data.port), ssl: data.ssl, active: data.active }),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); setModal(null); toast.success('Listener aktualisiert'); },
        onError: () => toast.error('Fehler beim Aktualisieren'),
    });
    const toggleMutation = useMutation({
        mutationFn: (id) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }),
        onError: () => toast.error('Fehler beim Umschalten'),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/admin/services/listeners/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); void qc.invalidateQueries({ queryKey: ['services-overview'] }); toast.success('Listener gelöscht'); },
        onError: () => toast.error('Fehler beim Löschen'),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-5", children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Listeners" }), _jsxs("button", { onClick: () => setModal('add'), className: "flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Listener hinzuf\u00FCgen"] })] }), isLoading ? (_jsx("div", { className: "flex justify-center py-16 text-gray-400 text-sm", children: "Lade\u2026" })) : listeners.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center py-16 text-gray-400", children: [_jsx("p", { className: "text-sm", children: "Keine Listener konfiguriert" }), _jsx("button", { onClick: () => setModal('add'), className: "mt-3 text-blue-600 text-sm hover:underline", children: "Ersten Listener hinzuf\u00FCgen" })] })) : (_jsx("div", { className: "bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "bg-gray-50 border-b border-gray-200", children: [_jsx("th", { className: "text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-12", children: "#" }), _jsx("th", { className: "text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Address:Port" }), _jsx("th", { className: "text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: listeners.map((l, i) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-6 py-4 text-gray-500 font-mono text-xs", children: i + 1 }), _jsx("td", { className: "px-6 py-4", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "font-mono font-medium text-gray-800", children: [l.address, ":", l.port] }), l.ssl && (_jsxs("span", { className: "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200", children: [_jsx(Lock, { size: 10 }), " SSL"] }))] }) }), _jsx("td", { className: "px-6 py-4 text-right", children: _jsx(Toggle, { active: l.active, onToggle: () => toggleMutation.mutate(l.id) }) }), _jsx("td", { className: "px-6 py-4", children: _jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx("button", { onClick: () => setModal(l.id), className: "p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors border border-gray-200", title: "Bearbeiten", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (confirm(`Listener ${l.address}:${l.port} wirklich löschen?`))
                                                        deleteMutation.mutate(l.id); }, className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors border border-gray-200", title: "L\u00F6schen", children: _jsx(Trash2, { size: 14 }) })] }) })] }, l.id))) })] }) })), modal === 'add' && _jsx(ListenerModal, { onSave: data => addMutation.mutate(data), onClose: () => setModal(null) }), modal && modal !== 'add' && editingListener && (_jsx(ListenerModal, { initial: { address: editingListener.address, port: String(editingListener.port), ssl: editingListener.ssl, active: editingListener.active }, onSave: data => editMutation.mutate({ id: modal, data }), onClose: () => setModal(null) }))] }));
}
function ServicesOverview({ onSelect }) {
    const { data: overview, isLoading } = useQuery({
        queryKey: ['services-overview'],
        queryFn: () => api.get('/admin/services/overview'),
    });
    const CARDS = [
        { key: 'SMTP_RECEIVE', label: 'SMTP Inbound', icon: Inbox, ports: '25 · 465 · 587' },
        { key: 'IMAP', label: 'IMAP', icon: Mail, ports: '143 · 993' },
        { key: 'POP3', label: 'POP3', icon: Archive, ports: '110 · 995' },
    ];
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "mb-5", children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900", children: "Services Management" }), _jsx("p", { className: "text-sm text-gray-500 mt-0.5", children: "\u00DCbersicht aller konfigurierten Protokoll-Services und Listener" })] }), isLoading ? (_jsx("div", { className: "flex justify-center py-16 text-gray-400 text-sm", children: "Lade\u2026" })) : (_jsx("div", { className: "grid grid-cols-3 gap-4 max-w-2xl", children: CARDS.map(({ key, label, icon: Icon, ports }) => {
                    const entry = overview?.[key] ?? { total: 0, active: 0 };
                    return (_jsxs("button", { onClick: () => onSelect(key), className: "bg-white border border-gray-200 rounded-lg p-5 text-left hover:border-blue-400 hover:shadow-md transition-all group", children: [_jsxs("div", { className: "flex items-center gap-3 mb-3", children: [_jsx("div", { className: "p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors", children: _jsx(Icon, { size: 18, className: "text-blue-600" }) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-800", children: label }), _jsx("p", { className: "text-xs text-gray-400", children: ports })] })] }), _jsxs("div", { className: "flex items-baseline gap-1", children: [_jsx("span", { className: "text-2xl font-bold text-gray-900", children: entry.active }), _jsxs("span", { className: "text-sm text-gray-400", children: ["/ ", entry.total, " Listener"] })] }), _jsx("div", { className: "mt-2", children: _jsx("div", { className: "w-full bg-gray-100 rounded-full h-1.5", children: _jsx("div", { className: "bg-blue-500 h-1.5 rounded-full transition-all", style: { width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' } }) }) }), _jsx("p", { className: "text-xs text-blue-600 mt-3 font-medium group-hover:underline", children: "Listener verwalten \u2192" })] }, key));
                }) })), _jsx("div", { className: "mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl", children: _jsxs("p", { className: "text-xs text-blue-700", children: [_jsx("strong", { children: "Hinweis:" }), " Listener-\u00C4nderungen werden in der Datenbank gespeichert. Die tats\u00E4chlich lauschenden Ports werden durch die Dienst-Konfiguration (supervisord / Docker) bestimmt."] }) })] }));
}
// ═══════════════════════════════════════════════════════════════════════════════
// HAUPT-KOMPONENTE
// ═══════════════════════════════════════════════════════════════════════════════
export function ConnectorsPage() {
    const [view, setView] = useState('conn-all');
    const NAV_SECTIONS = [
        {
            heading: 'Connectors',
            items: [
                { key: 'conn-all', label: 'Alle Connectors', icon: Cable },
                { key: 'conn-send', label: 'Sendeconnectors', icon: ArrowUpRight },
                { key: 'conn-receive', label: 'Empfangsconnectors', icon: ArrowDownLeft },
            ],
        },
        {
            heading: 'Services',
            items: [
                { key: 'svc-overview', label: 'Übersicht', icon: LayoutGrid },
                { key: 'SMTP_RECEIVE', label: 'SMTP Inbound', icon: Inbox },
                { key: 'IMAP', label: 'IMAP', icon: Mail },
                { key: 'POP3', label: 'POP3', icon: Archive },
            ],
        },
    ];
    function renderContent() {
        if (view === 'conn-all')
            return _jsx(ConnectorsView, {});
        if (view === 'conn-send')
            return _jsx(ConnectorsFilteredView, { filter: "SEND" });
        if (view === 'conn-receive')
            return _jsx(ConnectorsFilteredView, { filter: "RECEIVE" });
        if (view === 'svc-overview')
            return _jsx(ServicesOverview, { onSelect: k => setView(k) });
        // ServiceKey views
        return _jsx(ListenersTable, { svcKey: view, svcSlug: SVC_SLUG[view] });
    }
    return (_jsxs("div", { className: "h-full flex bg-gray-50", children: [_jsxs("aside", { className: "w-48 shrink-0 bg-[#1e2433] text-gray-300 flex flex-col", children: [_jsx("div", { className: "px-4 py-3 border-b border-white/10", children: _jsx("p", { className: "text-xs font-bold text-gray-400 uppercase tracking-widest", children: "Nachrichtenfluss" }) }), _jsx("nav", { className: "flex-1 py-1 overflow-y-auto", children: NAV_SECTIONS.map(section => (_jsxs("div", { children: [_jsx("p", { className: "px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-500", children: section.heading }), section.items.map(({ key, label, icon: Icon }) => (_jsxs("button", { onClick: () => setView(key), className: `w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left ${view === key ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'}`, children: [_jsx(Icon, { size: 13 }), label] }, key)))] }, section.heading))) })] }), _jsx("div", { className: "flex-1 overflow-y-auto", children: renderContent() })] }));
}
// Gefilterte Connector-Ansicht (nur SEND oder nur RECEIVE)
function ConnectorsFilteredView({ filter }) {
    const [editItem, setEditItem] = useState(null);
    const [createType, setCreateType] = useState(null);
    const { data: connectors = [], isLoading } = useQuery({
        queryKey: ['admin-connectors', filter],
        queryFn: () => api.get(`/api/v1/admin/connectors?type=${filter}`),
    });
    if (isLoading)
        return (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400 p-6", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade\u2026"] }));
    return (_jsxs("div", { className: "p-6", children: [_jsx(ConnectorTable, { items: connectors, type: filter, onEdit: setEditItem, onAdd: setCreateType }), (createType || editItem) && (_jsx(ConnectorModal, { type: editItem?.type ?? createType, connector: editItem ?? undefined, onClose: () => { setEditItem(null); setCreateType(null); } }))] }));
}
