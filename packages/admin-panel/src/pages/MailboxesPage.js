import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Pencil, Trash2, X, KeyRound, ChevronDown, ChevronRight, UserCheck, UserX, Mail, Shield, HardDrive, Loader2, RefreshCw, Folder, } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function formatBytes(b) {
    if (b >= 1e9)
        return `${(b / 1e9).toFixed(2)} GB`;
    if (b >= 1e6)
        return `${(b / 1e6).toFixed(1)} MB`;
    if (b >= 1e3)
        return `${(b / 1e3).toFixed(0)} KB`;
    return `${b} B`;
}
const ROLES = {
    USER: { label: 'Benutzer', color: 'badge-gray' },
    HELP_DESK: { label: 'Helpdesk', color: 'badge-blue' },
    RECIPIENT_MANAGEMENT: { label: 'Empfänger-Mgmt', color: 'badge-blue' },
    COMPLIANCE_MANAGEMENT: { label: 'Compliance', color: 'badge-blue' },
    HYGIENE_MANAGEMENT: { label: 'Schutz', color: 'badge-blue' },
    SERVER_MANAGEMENT: { label: 'Server', color: 'badge-blue' },
    VIEW_ONLY_ORG: { label: 'Nur-Lesen', color: 'badge-gray' },
    ORGANIZATION_MANAGEMENT: { label: 'Administrator', color: 'badge-orange' },
};
const QUOTA_OPTIONS = [
    { label: '1 GB', value: 1_073_741_824 },
    { label: '2 GB', value: 2_147_483_648 },
    { label: '5 GB', value: 5_368_709_120 },
    { label: '10 GB', value: 10_737_418_240 },
    { label: '25 GB', value: 26_843_545_600 },
    { label: '50 GB', value: 53_687_091_200 },
    { label: 'Unbegrenzt', value: 107_374_182_400 },
];
// ── Quota-Balken ─────────────────────────────────────────────────────────────
function QuotaBar({ used, total, showLabel = false }) {
    const pct = Math.min(100, total > 0 ? (used / total) * 100 : 0);
    const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-accent';
    return (_jsxs("div", { className: "space-y-1 w-full", children: [showLabel && (_jsxs("div", { className: "flex justify-between text-xs text-gray-500", children: [_jsx("span", { className: "font-medium", children: formatBytes(used) }), _jsxs("span", { className: "text-gray-400", children: ["von ", formatBytes(total)] })] })), _jsx("div", { className: "h-2 bg-gray-200 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${color}`, style: { width: `${pct}%` } }) }), !showLabel && (_jsxs("div", { className: "flex justify-between text-xs text-gray-400", children: [_jsx("span", { children: formatBytes(used) }), _jsx("span", { children: formatBytes(total) })] }))] }));
}
const EMPTY_FORM = {
    email: '', displayName: '', password: '', domainId: '',
    role: 'USER', quotaBytes: 5_368_709_120,
};
// ── Hauptkomponente ──────────────────────────────────────────────────────────
export function MailboxesPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [domainFilter, setDomainFilter] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [showCreate, setShowCreate] = useState(false);
    const [editUser, setEditUser] = useState(null);
    const [showResetPw, setShowResetPw] = useState(null);
    const [newPassword, setNewPassword] = useState('');
    const [form, setForm] = useState({ ...EMPTY_FORM });
    const [localPart, setLocalPart] = useState('');
    const { data: mailboxes = [], isLoading } = useQuery({
        queryKey: ['admin-mailboxes'],
        queryFn: () => api.get('/admin/mailboxes'),
    });
    const { data: domains = [] } = useQuery({
        queryKey: ['admin-domains'],
        queryFn: () => api.get('/admin/domains?limit=500').then(r => r.domains),
    });
    // Detail-Abfrage für aufgeklappten User (Ordner + Speicher)
    const { data: detail, isFetching: detailLoading } = useQuery({
        queryKey: ['admin-mailbox-detail', expandedId],
        queryFn: () => api.get(`/admin/mailboxes/${expandedId}`),
        enabled: !!expandedId,
    });
    const domainName = (id) => domains.find((d) => d.id === id)?.name ?? id;
    // Erstellen
    const createMutation = useMutation({
        mutationFn: () => api.post('/admin/mailboxes', form),
        onSuccess: () => {
            toast.success(`Postfach ${form.email} erstellt`);
            void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
            setShowCreate(false);
            setForm({ ...EMPTY_FORM });
            setLocalPart('');
        },
        onError: (err) => toast.error(err.message),
    });
    // Bearbeiten
    const updateMutation = useMutation({
        mutationFn: ({ id, data }) => api.put(`/admin/mailboxes/${id}`, data),
        onSuccess: () => {
            toast.success('Gespeichert');
            void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
            setEditUser(null);
        },
        onError: (err) => toast.error(err.message),
    });
    // Status umschalten
    const toggleMutation = useMutation({
        mutationFn: ({ id, active }) => api.put(`/admin/mailboxes/${id}`, { active }),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }),
        onError: (err) => toast.error(err.message),
    });
    // Löschen
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/admin/mailboxes/${id}`),
        onSuccess: () => {
            toast.success('Postfach gelöscht');
            void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
            setExpandedId(null);
        },
        onError: (err) => toast.error(err.message),
    });
    // Passwort-Reset
    const resetPwMutation = useMutation({
        mutationFn: ({ id, password }) => api.put(`/admin/mailboxes/${id}`, { password }),
        onSuccess: () => { toast.success('Passwort geändert'); setShowResetPw(null); setNewPassword(''); },
        onError: (err) => toast.error(err.message),
    });
    // Quota neu berechnen (alle)
    const recalcAllMutation = useMutation({
        mutationFn: () => api.post('/admin/mailboxes/recalculate-all-quotas', {}),
        onSuccess: () => {
            toast.success('Speicherverbrauch aktualisiert');
            void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
            void qc.invalidateQueries({ queryKey: ['admin-mailbox-detail'] });
        },
        onError: (err) => toast.error(err.message),
    });
    // Filter
    const filtered = mailboxes.filter((u) => {
        const q = search.toLowerCase();
        const matchSearch = !search
            || (u.email ?? '').toLowerCase().includes(q)
            || (u.displayName ?? '').toLowerCase().includes(q);
        const matchDomain = !domainFilter || u.domainId === domainFilter;
        return matchSearch && matchDomain;
    });
    // Create-Dialog Helpers
    function selectDomain(domainId) {
        const d = domains.find((x) => x.id === domainId);
        setForm({ ...form, domainId, email: localPart && d ? `${localPart}@${d.name}` : '' });
    }
    function setLocal(val) {
        setLocalPart(val);
        const d = domains.find((x) => x.id === form.domainId);
        setForm({ ...form, email: d ? `${val}@${d.name}` : val });
    }
    function toggleExpand(id) {
        setExpandedId((prev) => (prev === id ? null : id));
    }
    // ── Render ─────────────────────────────────────────────────────────────────
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Benutzerverwaltung" }), _jsxs("p", { className: "text-xs text-gray-400 mt-0.5", children: [mailboxes.length, " Postf\u00E4cher gesamt"] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: () => recalcAllMutation.mutate(), disabled: recalcAllMutation.isPending, className: "btn-secondary flex items-center gap-1.5 text-xs", title: "Speicherverbrauch aller Postf\u00E4cher neu berechnen", children: [_jsx(RefreshCw, { size: 13, className: recalcAllMutation.isPending ? 'animate-spin' : '' }), "Speicher aktualisieren"] }), _jsxs("button", { onClick: () => { setForm({ ...EMPTY_FORM }); setLocalPart(''); setShowCreate(true); }, className: "btn-primary flex items-center gap-1.5", children: [_jsx(Plus, { size: 15 }), " Neuer Benutzer"] })] })] }), _jsxs("div", { className: "flex items-center gap-3 flex-wrap", children: [_jsxs("div", { className: "relative", children: [_jsx(Search, { size: 14, className: "absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { value: search, onChange: (e) => setSearch(e.target.value), className: "input pl-8 w-60", placeholder: "Name oder E-Mail\u2026" })] }), _jsxs("div", { className: "relative", children: [_jsxs("select", { value: domainFilter, onChange: (e) => setDomainFilter(e.target.value), className: "input pr-8 appearance-none cursor-pointer", children: [_jsx("option", { value: "", children: "Alle Domains" }), domains.map((d) => (_jsxs("option", { value: d.id, children: [d.name, " (", mailboxes.filter((u) => u.domainId === d.id).length, ")"] }, d.id)))] }), _jsx(ChevronDown, { size: 14, className: "absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" })] }), (search || domainFilter) && (_jsxs("button", { onClick: () => { setSearch(''); setDomainFilter(''); }, className: "text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1", children: [_jsx(X, { size: 12 }), " Filter l\u00F6schen"] }))] }), _jsx("div", { className: "card p-0 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "w-8 px-2 py-2.5" }), ['Benutzer', 'Domain', 'Rolle', 'Speicherverbrauch', 'Status', 'Aktionen'].map((h) => (_jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: h }, h)))] }) }), _jsxs("tbody", { className: "divide-y divide-gray-100", children: [isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "px-4 py-8 text-center", children: _jsx(Loader2, { size: 20, className: "animate-spin mx-auto text-gray-400" }) }) })), !isLoading && filtered.map((u) => {
                                    const role = ROLES[u.role] ?? { label: u.role, color: 'badge-gray' };
                                    const isExpanded = expandedId === u.id;
                                    const pct = u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
                                    return [
                                        // Hauptzeile
                                        _jsxs("tr", { className: `transition-colors ${!u.active ? 'opacity-60' : ''} ${isExpanded ? 'bg-blue-50/50' : 'hover:bg-gray-50'}`, children: [_jsx("td", { className: "px-2 py-3 text-center", children: _jsx("button", { onClick: () => toggleExpand(u.id), className: "text-gray-400 hover:text-gray-600 transition-colors", children: isExpanded
                                                            ? _jsx(ChevronDown, { size: 15, className: "text-accent" })
                                                            : _jsx(ChevronRight, { size: 15 }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("div", { className: "w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0", children: _jsx("span", { className: "text-sm font-semibold text-accent", children: (u.displayName ?? u.email ?? '?').charAt(0).toUpperCase() }) }), _jsxs("div", { children: [_jsx("p", { className: "font-medium text-gray-800", children: u.displayName ?? u.email }), _jsxs("p", { className: "text-xs text-gray-400 flex items-center gap-1", children: [_jsx(Mail, { size: 10 }), u.email] })] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: "text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded", children: domainName(u.domainId) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("span", { className: `badge text-xs ${role.color} flex items-center gap-1 w-fit`, children: [u.role === 'ORGANIZATION_MANAGEMENT' && _jsx(Shield, { size: 10 }), role.label] }) }), _jsx("td", { className: "px-4 py-3 w-48", children: _jsxs("div", { className: "space-y-1", children: [_jsxs("div", { className: "flex justify-between text-xs", children: [_jsx("span", { className: `font-medium ${pct > 90 ? 'text-red-600' : pct > 70 ? 'text-yellow-600' : 'text-gray-700'}`, children: formatBytes(u.usedBytes) }), _jsx("span", { className: "text-gray-400", children: formatBytes(u.quotaBytes) })] }), _jsx("div", { className: "h-1.5 bg-gray-200 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-accent'}`, style: { width: `${pct}%` } }) }), _jsxs("p", { className: "text-xs text-gray-400", children: [pct.toFixed(1), " % genutzt"] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("button", { onClick: () => toggleMutation.mutate({ id: u.id, active: !u.active }), className: `flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${u.active
                                                            ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100'
                                                            : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'}`, children: u.active ? _jsxs(_Fragment, { children: [_jsx(UserCheck, { size: 11 }), " Aktiv"] }) : _jsxs(_Fragment, { children: [_jsx(UserX, { size: 11 }), " Deaktiviert"] }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setEditUser(u), className: "btn-ghost p-1.5 rounded", title: "Bearbeiten", children: _jsx(Pencil, { size: 13, className: "text-gray-500" }) }), _jsx("button", { onClick: () => { setShowResetPw(u); setNewPassword(''); }, className: "btn-ghost p-1.5 rounded", title: "Passwort zur\u00FCcksetzen", children: _jsx(KeyRound, { size: 13, className: "text-blue-500" }) }), _jsx("button", { onClick: () => { if (confirm(`Postfach "${u.email}" wirklich löschen?`))
                                                                    deleteMutation.mutate(u.id); }, className: "btn-ghost p-1.5 rounded", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13, className: "text-red-500" }) })] }) })] }, u.id),
                                        // ── Aufgeklappte Detail-Zeile ────────────────────────────────
                                        isExpanded && (_jsx("tr", { className: "bg-blue-50/30", children: _jsx("td", { colSpan: 7, className: "px-6 py-4", children: detailLoading && expandedId === u.id ? (_jsxs("div", { className: "flex items-center gap-2 text-gray-500 text-sm", children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), " Lade Postfach-Details\u2026"] })) : detail && detail.id === u.id ? (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "bg-white border border-gray-200 rounded-lg p-4 space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("span", { className: "text-sm font-medium text-gray-700 flex items-center gap-1.5", children: [_jsx(HardDrive, { size: 14, className: "text-accent" }), "Gesamt-Speicher"] }), _jsxs("span", { className: "text-xs text-gray-500", children: [formatBytes(detail.usedBytes), " von ", formatBytes(detail.quotaBytes), " belegt"] })] }), _jsx(QuotaBar, { used: detail.usedBytes, total: detail.quotaBytes, showLabel: true })] }), detail.mailbox?.folders && detail.mailbox.folders.length > 0 && (_jsxs("div", { className: "bg-white border border-gray-200 rounded-lg overflow-hidden", children: [_jsxs("p", { className: "text-xs font-medium text-gray-500 px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-1.5", children: [_jsx(Folder, { size: 12 }), " Ordner"] }), _jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-gray-100", children: [_jsx("th", { className: "text-left px-4 py-1.5 text-gray-400 font-medium", children: "Ordner" }), _jsx("th", { className: "text-right px-4 py-1.5 text-gray-400 font-medium", children: "Nachrichten" }), _jsx("th", { className: "text-right px-4 py-1.5 text-gray-400 font-medium", children: "Ungelesen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-50", children: detail.mailbox.folders.map((f) => (_jsxs("tr", { className: "hover:bg-gray-50", children: [_jsxs("td", { className: "px-4 py-1.5 text-gray-700 flex items-center gap-1.5", children: [_jsx(Folder, { size: 11, className: "text-gray-300" }), f.displayName || f.name] }), _jsx("td", { className: "px-4 py-1.5 text-right text-gray-600", children: f.totalCount }), _jsx("td", { className: "px-4 py-1.5 text-right", children: f.unreadCount > 0
                                                                                            ? _jsx("span", { className: "font-semibold text-accent", children: f.unreadCount })
                                                                                            : _jsx("span", { className: "text-gray-300", children: "\u2014" }) })] }, f.id))) }), _jsx("tfoot", { className: "border-t border-gray-200 bg-gray-50", children: _jsxs("tr", { children: [_jsx("td", { className: "px-4 py-1.5 text-gray-500 font-medium", children: "Gesamt" }), _jsx("td", { className: "px-4 py-1.5 text-right text-gray-600 font-medium", children: detail.mailbox.folders.reduce((s, f) => s + f.totalCount, 0) }), _jsx("td", { className: "px-4 py-1.5 text-right text-accent font-medium", children: detail.mailbox.folders.reduce((s, f) => s + f.unreadCount, 0) || '—' })] }) })] })] })), _jsxs("div", { className: "flex gap-4 text-xs text-gray-400", children: [_jsxs("span", { children: ["ID: ", _jsx("code", { className: "bg-gray-100 px-1 rounded", children: detail.id })] }), _jsxs("span", { children: ["Erstellt: ", new Date(detail.createdAt).toLocaleDateString('de-DE')] })] })] })) : null }) }, `${u.id}-detail`)),
                                    ];
                                }), !isLoading && filtered.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "py-10 text-center text-gray-400 text-sm", children: search || domainFilter ? 'Keine Treffer für diesen Filter' : 'Noch keine Benutzer angelegt' }) }))] })] }) }), showCreate && (_jsxs(Modal, { title: "Neuen Benutzer anlegen", onClose: () => setShowCreate(false), children: [_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsxs("label", { className: "field-label", children: ["Domain ", _jsx("span", { className: "text-red-500", children: "*" })] }), _jsxs("select", { className: "input w-full", value: form.domainId, onChange: (e) => selectDomain(e.target.value), children: [_jsx("option", { value: "", children: "Domain w\u00E4hlen\u2026" }), domains.filter(d => d.active).map((d) => _jsxs("option", { value: d.id, children: ["@", d.name] }, d.id))] }), domains.filter(d => d.active).length === 0 && (_jsx("p", { className: "text-xs text-amber-600 mt-1", children: domains.length === 0
                                            ? 'Keine Domains vorhanden — bitte zuerst eine Domain anlegen.'
                                            : 'Alle Domains sind deaktiviert — bitte zuerst eine Domain aktivieren.' }))] }), _jsxs("div", { children: [_jsxs("label", { className: "field-label", children: ["E-Mail-Adresse ", _jsx("span", { className: "text-red-500", children: "*" })] }), _jsxs("div", { className: "flex", children: [_jsx("input", { className: "input rounded-r-none flex-1", placeholder: "benutzername", value: localPart, onChange: (e) => setLocal(e.target.value) }), _jsxs("span", { className: "px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 text-gray-500 text-sm rounded-r", children: ["@", form.domainId ? domainName(form.domainId) : 'domain.com'] })] }), form.email && _jsxs("p", { className: "text-xs text-gray-400 mt-1", children: ["\u2192 ", form.email] })] }), _jsxs("div", { children: [_jsxs("label", { className: "field-label", children: ["Anzeigename ", _jsx("span", { className: "text-red-500", children: "*" })] }), _jsx("input", { className: "input w-full", placeholder: "Max Mustermann", value: form.displayName, onChange: (e) => setForm({ ...form, displayName: e.target.value }) })] }), _jsxs("div", { children: [_jsxs("label", { className: "field-label", children: ["Passwort ", _jsx("span", { className: "text-red-500", children: "*" })] }), _jsx("input", { type: "password", className: "input w-full", placeholder: "Mindestens 8 Zeichen", value: form.password, onChange: (e) => setForm({ ...form, password: e.target.value }) }), form.password && form.password.length < 8 && (_jsx("p", { className: "text-xs text-red-500 mt-1", children: "Zu kurz (min. 8 Zeichen)" }))] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Rolle" }), _jsx("select", { className: "input w-full", value: form.role, onChange: (e) => setForm({ ...form, role: e.target.value }), children: Object.entries(ROLES).map(([v, { label }]) => _jsx("option", { value: v, children: label }, v)) })] }), _jsxs("div", { children: [_jsxs("label", { className: "field-label flex items-center gap-1", children: [_jsx(HardDrive, { size: 12 }), " Kontingent"] }), _jsx("select", { className: "input w-full", value: form.quotaBytes, onChange: (e) => setForm({ ...form, quotaBytes: parseInt(e.target.value) }), children: QUOTA_OPTIONS.map((q) => _jsx("option", { value: q.value, children: q.label }, q.value)) })] })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-6", children: [_jsx("button", { onClick: () => setShowCreate(false), className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => createMutation.mutate(), disabled: !form.email || !form.password || form.password.length < 8 || !form.domainId || !form.displayName || createMutation.isPending, className: "btn-primary disabled:opacity-50 flex items-center gap-2", children: [createMutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Benutzer erstellen"] })] })] })), editUser && (_jsx(Modal, { title: `${editUser.displayName} bearbeiten`, onClose: () => setEditUser(null), children: _jsx(EditForm, { user: editUser, domains: domains, onSave: (data) => updateMutation.mutate({ id: editUser.id, data }), isPending: updateMutation.isPending }) })), showResetPw && (_jsxs(Modal, { title: `Passwort — ${showResetPw.email}`, onClose: () => setShowResetPw(null), children: [_jsxs("div", { className: "space-y-3", children: [_jsxs("p", { className: "text-sm text-gray-600", children: ["Neues Passwort f\u00FCr ", _jsx("strong", { children: showResetPw.displayName }), ":"] }), _jsx("input", { type: "password", className: "input w-full", placeholder: "Neues Passwort (min. 8 Zeichen)", value: newPassword, onChange: (e) => setNewPassword(e.target.value), autoFocus: true }), newPassword && newPassword.length < 8 && (_jsx("p", { className: "text-xs text-red-500", children: "Zu kurz (min. 8 Zeichen)" }))] }), _jsxs("div", { className: "flex justify-end gap-2 mt-5", children: [_jsx("button", { onClick: () => setShowResetPw(null), className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => resetPwMutation.mutate({ id: showResetPw.id, password: newPassword }), disabled: newPassword.length < 8 || resetPwMutation.isPending, className: "btn-primary disabled:opacity-50 flex items-center gap-2", children: [resetPwMutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Passwort setzen"] })] })] }))] }));
}
// ── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }) {
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-lg", children: [_jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-b border-gray-100", children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: title }), _jsx("button", { onClick: onClose, className: "btn-ghost p-1 rounded", children: _jsx(X, { size: 16, className: "text-gray-500" }) })] }), _jsx("div", { className: "px-6 py-5", children: children })] }) }));
}
// ── Edit-Formular ────────────────────────────────────────────────────────────
function EditForm({ user, domains, onSave, isPending }) {
    const [displayName, setDisplayName] = useState(user.displayName);
    const [role, setRole] = useState(user.role);
    const [quotaBytes, setQuotaBytes] = useState(user.quotaBytes);
    const domainLabel = `@${domains.find((d) => d.id === user.domainId)?.name ?? user.domainId}`;
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "E-Mail" }), _jsx("input", { className: "input w-full bg-gray-50 cursor-not-allowed", value: user.email, disabled: true })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Domain" }), _jsx("input", { className: "input w-full bg-gray-50 cursor-not-allowed", value: domainLabel, disabled: true })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Anzeigename" }), _jsx("input", { className: "input w-full", value: displayName, onChange: (e) => setDisplayName(e.target.value) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Rolle" }), _jsx("select", { className: "input w-full", value: role, onChange: (e) => setRole(e.target.value), children: Object.entries(ROLES).map(([v, { label }]) => _jsx("option", { value: v, children: label }, v)) })] }), _jsxs("div", { children: [_jsxs("label", { className: "field-label flex items-center gap-1", children: [_jsx(HardDrive, { size: 12 }), " Kontingent"] }), _jsx("select", { className: "input w-full", value: quotaBytes, onChange: (e) => setQuotaBytes(parseInt(e.target.value)), children: QUOTA_OPTIONS.map((q) => _jsx("option", { value: q.value, children: q.label }, q.value)) })] })] }), _jsx("div", { className: "flex justify-end pt-1", children: _jsxs("button", { onClick: () => onSave({ displayName, role, quotaBytes }), disabled: !displayName || isPending, className: "btn-primary disabled:opacity-50 flex items-center gap-2", children: [isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Speichern"] }) })] }));
}
