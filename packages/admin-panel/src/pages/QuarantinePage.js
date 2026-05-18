import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldAlert, CheckCircle, Trash2, Loader2, Bug, AlertTriangle, FileWarning, X, Search, RefreshCw, Mail, Calendar, User, ArrowRight, Eye, ChevronLeft, ChevronRight, Info, Clock, Download, } from 'lucide-react';
import { api } from '../api/client.js';
// ── Reason badge ──────────────────────────────────────────────────────────────
function ReasonBadge({ reason, size = 'sm' }) {
    const cfg = {
        VIRUS: { icon: Bug, cls: 'bg-red-100 text-red-700 border-red-200', label: 'Virus' },
        SPAM: { icon: AlertTriangle, cls: 'bg-amber-100 text-amber-700 border-amber-200', label: 'Spam' },
        POLICY: { icon: FileWarning, cls: 'bg-blue-100 text-blue-700 border-blue-200', label: 'Richtlinie' },
    }[reason];
    const Icon = cfg.icon;
    const px = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
    return (_jsxs("span", { className: `inline-flex items-center gap-1 rounded-full border font-medium ${px} ${cfg.cls}`, children: [_jsx(Icon, { size: size === 'lg' ? 13 : 10 }), cfg.label] }));
}
// ── Detail Slide-Over ─────────────────────────────────────────────────────────
function DetailPanel({ id, onClose, onRelease, onDelete }) {
    const { data, isLoading } = useQuery({
        queryKey: ['quarantine-detail', id],
        queryFn: () => api.get(`/admin/quarantine/${id}`),
        enabled: !!id,
    });
    const hdrs = data?.preview?.headers ?? {};
    const body = data?.preview?.bodyText ?? '';
    const INTERESTING_HEADERS = [
        'From', 'To', 'Subject', 'Date', 'Message-ID', 'X-Spam-Score',
        'X-Spam-Status', 'X-Virus-Scanned', 'Received', 'DKIM-Signature',
        'Authentication-Results', 'Return-Path', 'Reply-To',
    ];
    const filteredHdrs = INTERESTING_HEADERS
        .filter(h => hdrs[h])
        .map(h => [h, hdrs[h]]);
    return (_jsxs("div", { className: "fixed inset-0 z-50 flex", children: [_jsx("div", { className: "flex-1 bg-black/30", onClick: onClose }), _jsxs("div", { className: "w-[600px] bg-white h-full shadow-2xl flex flex-col overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Eye, { size: 16, className: "text-gray-500" }), _jsx("span", { className: "font-semibold text-gray-900 text-sm", children: "Nachricht pr\u00FCfen" })] }), _jsx("button", { onClick: onClose, className: "p-1 hover:bg-gray-200 rounded", children: _jsx(X, { size: 16 }) })] }), isLoading && (_jsxs("div", { className: "flex-1 flex items-center justify-center text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade Details\u2026"] })), data && (_jsxs("div", { className: "flex-1 overflow-y-auto", children: [_jsxs("div", { className: "px-5 py-4 space-y-4 border-b border-gray-100", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsx("div", { className: "flex-1 min-w-0", children: _jsx("h2", { className: "font-semibold text-gray-900 text-base leading-tight truncate", children: data.subject || '(kein Betreff)' }) }), _jsx(ReasonBadge, { reason: data.reason, size: "lg" })] }), _jsx("div", { className: "grid grid-cols-1 gap-2", children: [
                                            { icon: User, label: 'Von', val: data.fromAddr },
                                            { icon: ArrowRight, label: 'An', val: data.toAddr },
                                            { icon: Clock, label: 'Empfangen', val: new Date(data.createdAt).toLocaleString('de-DE') },
                                            ...(data.messageId ? [{ icon: Mail, label: 'Message-ID', val: data.messageId }] : []),
                                        ].map(({ icon: Icon, label, val }) => (_jsxs("div", { className: "flex items-start gap-2 text-sm", children: [_jsx(Icon, { size: 13, className: "text-gray-400 mt-0.5 shrink-0" }), _jsxs("span", { className: "text-gray-500 w-20 shrink-0", children: [label, ":"] }), _jsx("span", { className: "text-gray-800 break-all", children: val })] }, label))) }), data.released ? (_jsxs("div", { className: "flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700", children: [_jsx(CheckCircle, { size: 13 }), "Freigegeben am ", data.releasedAt ? new Date(data.releasedAt).toLocaleString('de-DE') : '—', data.releasedBy && ` · ${data.releasedBy}`] })) : (_jsxs("div", { className: "flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700", children: [_jsx(Clock, { size: 13 }), "Ausstehend \u2014 noch nicht freigegeben"] }))] }), Object.keys(data.details).length > 0 && (_jsxs("div", { className: "px-5 py-4 border-b border-gray-100", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "Filter-Details" }), _jsx("div", { className: "space-y-1.5", children: Object.entries(data.details).map(([k, v]) => (_jsxs("div", { className: "flex gap-2 text-xs", children: [_jsxs("span", { className: "text-gray-400 font-mono w-28 shrink-0", children: [k, ":"] }), _jsx("span", { className: "text-gray-700 break-all", children: String(v) })] }, k))) })] })), filteredHdrs.length > 0 && (_jsxs("div", { className: "px-5 py-4 border-b border-gray-100", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "E-Mail-Header" }), _jsx("div", { className: "bg-gray-50 rounded-lg p-3 space-y-1 text-xs font-mono max-h-52 overflow-y-auto", children: filteredHdrs.map(([h, v]) => (_jsxs("div", { className: "flex gap-2", children: [_jsxs("span", { className: "text-blue-600 shrink-0 w-36", children: [h, ":"] }), _jsx("span", { className: "text-gray-700 break-all", children: v })] }, h))) })] })), body && (_jsxs("div", { className: "px-5 py-4 border-b border-gray-100", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "Nachrichteninhalt (Vorschau)" }), _jsx("div", { className: "bg-gray-50 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed", children: body }), body.length >= 2000 && (_jsxs("p", { className: "text-xs text-gray-400 mt-1 flex items-center gap-1", children: [_jsx(Info, { size: 10 }), " Vorschau auf 2000 Zeichen begrenzt"] }))] })), !data.preview && (_jsx("div", { className: "px-5 py-4", children: _jsxs("div", { className: "bg-gray-50 rounded-lg p-4 text-xs text-gray-400 text-center flex items-center justify-center gap-2", children: [_jsx(Download, { size: 13 }), "Keine Vorschau verf\u00FCgbar \u2014 Nachricht befindet sich im Objektspeicher"] }) }))] })), data && (_jsxs("div", { className: "px-5 py-4 border-t border-gray-200 bg-gray-50 flex items-center gap-2 shrink-0", children: [!data.released && data.reason !== 'VIRUS' && (_jsxs("button", { onClick: () => { onRelease(data.id); onClose(); }, className: "btn-primary text-sm gap-1.5 flex-1 justify-center", children: [_jsx(CheckCircle, { size: 14 }), " Freigeben & Zustellen"] })), data.reason === 'VIRUS' && !data.released && (_jsxs("div", { className: "flex-1 text-xs text-red-600 flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-3 py-2", children: [_jsx(Bug, { size: 13 }), " Virus-Nachrichten k\u00F6nnen nicht freigegeben werden"] })), _jsxs("button", { onClick: () => { onDelete(data.id); onClose(); }, className: "btn-secondary text-sm gap-1.5 text-red-600 border-red-200 hover:bg-red-50", children: [_jsx(Trash2, { size: 14 }), " L\u00F6schen"] })] }))] })] }));
}
// ── Bulk Cleanup Modal ────────────────────────────────────────────────────────
function CleanupModal({ onClose, onConfirm }) {
    const [days, setDays] = useState(30);
    const [onlyReleased, setOnlyReleased] = useState(true);
    return (_jsxs("div", { className: "fixed inset-0 z-50 flex items-center justify-center", children: [_jsx("div", { className: "absolute inset-0 bg-black/40", onClick: onClose }), _jsxs("div", { className: "relative bg-white rounded-xl shadow-2xl w-[400px] p-6 space-y-5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Trash2, { size: 18, className: "text-red-500" }), _jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Quarant\u00E4ne bereinigen" })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1.5", children: "Eintr\u00E4ge \u00E4lter als" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", min: 1, max: 365, value: days, onChange: e => setDays(parseInt(e.target.value, 10) || 1), className: "w-24 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), _jsx("span", { className: "text-sm text-gray-600", children: "Tage" })] })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: onlyReleased, onChange: e => setOnlyReleased(e.target.checked), className: "rounded border-gray-300 text-accent" }), _jsx("span", { className: "text-sm text-gray-700", children: "Nur bereits freigegebene Eintr\u00E4ge" })] }), _jsxs("div", { className: "bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-start gap-1.5", children: [_jsx(AlertTriangle, { size: 12, className: "shrink-0 mt-0.5" }), _jsxs("span", { children: [onlyReleased
                                                ? `Freigegebene Quarantäne-Einträge älter als ${days} Tage werden endgültig gelöscht.`
                                                : `ALLE Quarantäne-Einträge älter als ${days} Tage werden endgültig gelöscht.`, ' ', "Diese Aktion kann nicht r\u00FCckg\u00E4ngig gemacht werden."] })] })] }), _jsxs("div", { className: "flex gap-2 pt-1", children: [_jsx("button", { onClick: onClose, className: "btn-secondary text-sm flex-1 justify-center", children: "Abbrechen" }), _jsxs("button", { onClick: () => { onConfirm(days, onlyReleased); onClose(); }, className: "flex-1 justify-center btn-primary text-sm bg-red-600 hover:bg-red-700 border-red-600", children: [_jsx(Trash2, { size: 13 }), " Bereinigen"] })] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// QuarantinePage
// ═════════════════════════════════════════════════════════════════════════════
export function QuarantinePage() {
    const qc = useQueryClient();
    // Filter state
    const [search, setSearch] = useState('');
    const [reason, setReason] = useState('');
    const [released, setReleased] = useState('false');
    const [page, setPage] = useState(1);
    const LIMIT = 50;
    // UI state
    const [selectedId, setSelectedId] = useState(null);
    const [selectedRows, setSelectedRows] = useState(new Set());
    const [showCleanup, setShowCleanup] = useState(false);
    // ── Queries ──────────────────────────────────────────────────────────────
    const { data: stats, isLoading: statsLoading } = useQuery({
        queryKey: ['quarantine-stats'],
        queryFn: () => api.get('/admin/quarantine/stats'),
        refetchInterval: 30_000,
    });
    const { data, isLoading, isFetching } = useQuery({
        queryKey: ['quarantine', search, reason, released, page],
        queryFn: () => api.get(`/admin/quarantine?search=${encodeURIComponent(search)}&reason=${reason}&released=${released}&page=${page}&limit=${LIMIT}`),
    });
    const items = data?.items ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / LIMIT));
    function invalidate() {
        void qc.invalidateQueries({ queryKey: ['quarantine'] });
        void qc.invalidateQueries({ queryKey: ['quarantine-stats'] });
    }
    // ── Mutations ────────────────────────────────────────────────────────────
    const releaseMut = useMutation({
        mutationFn: (id) => api.post(`/admin/quarantine/${id}/release`, {}),
        onSuccess: () => { invalidate(); toast.success('Freigegeben und zugestellt'); },
        onError: () => toast.error('Fehler bei Freigabe'),
    });
    const deleteMut = useMutation({
        mutationFn: (id) => api.delete(`/admin/quarantine/${id}`),
        onSuccess: () => { invalidate(); setSelectedRows(new Set()); toast.success('Gelöscht'); },
        onError: () => toast.error('Löschen fehlgeschlagen'),
    });
    const bulkDeleteMut = useMutation({
        mutationFn: (ids) => Promise.all(ids.map(id => api.delete(`/admin/quarantine/${id}`))),
        onSuccess: () => { invalidate(); setSelectedRows(new Set()); toast.success(`${selectedRows.size} Einträge gelöscht`); },
        onError: () => toast.error('Fehler beim Löschen'),
    });
    const cleanupMut = useMutation({
        mutationFn: ({ days, onlyReleased }) => api.deleteWithBody('/admin/quarantine', { olderThanDays: days, onlyReleased }),
        onSuccess: (res) => { invalidate(); toast.success(`${res.deleted} Einträge bereinigt`); },
        onError: () => toast.error('Bereinigung fehlgeschlagen'),
    });
    // ── Selection helpers ────────────────────────────────────────────────────
    function toggleRow(id) {
        setSelectedRows(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }
    function toggleAll() {
        if (selectedRows.size === items.length) {
            setSelectedRows(new Set());
        }
        else {
            setSelectedRows(new Set(items.map(i => i.id)));
        }
    }
    function resetFilters() {
        setSearch('');
        setReason('');
        setReleased('false');
        setPage(1);
        setSelectedRows(new Set());
    }
    // ── Stat cards config ────────────────────────────────────────────────────
    const STAT_CARDS = [
        { label: 'Ausstehend', value: stats?.pending ?? '—', color: 'text-amber-600', bg: 'bg-amber-50', icon: Clock },
        { label: 'Virus', value: stats?.virus ?? '—', color: 'text-red-600', bg: 'bg-red-50', icon: Bug },
        { label: 'Spam', value: stats?.spam ?? '—', color: 'text-yellow-600', bg: 'bg-yellow-50', icon: AlertTriangle },
        { label: 'Richtlinie', value: stats?.policy ?? '—', color: 'text-blue-600', bg: 'bg-blue-50', icon: FileWarning },
        { label: 'Freigegeben', value: stats?.released ?? '—', color: 'text-green-600', bg: 'bg-green-50', icon: CheckCircle },
        { label: 'Gesamt', value: stats?.total ?? '—', color: 'text-gray-700', bg: 'bg-gray-50', icon: ShieldAlert },
    ];
    return (_jsxs("div", { className: "flex flex-col h-full bg-gray-50", children: [_jsxs("div", { className: "px-6 py-4 bg-white border-b border-gray-200 shrink-0", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("div", { className: "w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center", children: _jsx(ShieldAlert, { size: 18, className: "text-amber-600" }) }), _jsxs("div", { children: [_jsx("h1", { className: "text-lg font-bold text-gray-900", children: "Quarant\u00E4ne" }), _jsx("p", { className: "text-xs text-gray-400", children: statsLoading ? '…' : `${stats?.pending ?? 0} ausstehend · ${stats?.total ?? 0} gesamt` })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: () => setShowCleanup(true), className: "btn-secondary text-xs gap-1.5", children: [_jsx(Trash2, { size: 13 }), " Bereinigen"] }), _jsxs("button", { onClick: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['quarantine-stats'] }); }, className: "btn-ghost text-xs gap-1", children: [_jsx(RefreshCw, { size: 13, className: isFetching ? 'animate-spin' : '' }), " Aktualisieren"] })] })] }), _jsx("div", { className: "grid grid-cols-6 gap-2.5", children: STAT_CARDS.map(({ label, value, color, bg, icon: Icon }) => (_jsxs("button", { onClick: () => {
                                if (label === 'Virus') {
                                    setReason('VIRUS');
                                    setReleased('false');
                                    setPage(1);
                                }
                                else if (label === 'Spam') {
                                    setReason('SPAM');
                                    setReleased('false');
                                    setPage(1);
                                }
                                else if (label === 'Richtlinie') {
                                    setReason('POLICY');
                                    setReleased('false');
                                    setPage(1);
                                }
                                else if (label === 'Freigegeben') {
                                    setReleased('true');
                                    setReason('');
                                    setPage(1);
                                }
                                else if (label === 'Ausstehend') {
                                    setReleased('false');
                                    setReason('');
                                    setPage(1);
                                }
                                else
                                    resetFilters();
                            }, className: `${bg} rounded-xl p-3 text-left border border-transparent hover:border-gray-200 transition-colors`, children: [_jsxs("div", { className: "flex items-center gap-1.5 mb-1", children: [_jsx(Icon, { size: 12, className: color }), _jsx("span", { className: "text-xs text-gray-500", children: label })] }), _jsx("p", { className: `text-xl font-bold ${color}`, children: value })] }, label))) })] }), _jsxs("div", { className: "px-6 py-2.5 bg-white border-b border-gray-200 flex items-center gap-3 shrink-0", children: [_jsxs("div", { className: "relative flex-1 max-w-xs", children: [_jsx(Search, { size: 13, className: "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { value: search, onChange: e => { setSearch(e.target.value); setPage(1); setSelectedRows(new Set()); }, placeholder: "Suche: Von, An, Betreff\u2026", className: "w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-accent" }), search && (_jsx("button", { onClick: () => { setSearch(''); setPage(1); }, className: "absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 12 }) }))] }), _jsxs("select", { value: reason, onChange: e => { setReason(e.target.value); setPage(1); setSelectedRows(new Set()); }, className: "border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "", children: "Alle Gr\u00FCnde" }), _jsx("option", { value: "VIRUS", children: "Virus" }), _jsx("option", { value: "SPAM", children: "Spam" }), _jsx("option", { value: "POLICY", children: "Richtlinie" })] }), _jsx("div", { className: "flex rounded-lg border border-gray-300 overflow-hidden text-sm", children: [['false', 'Ausstehend'], ['true', 'Freigegeben'], ['', 'Alle']].map(([val, label]) => (_jsx("button", { onClick: () => { setReleased(val); setPage(1); setSelectedRows(new Set()); }, className: `px-3 py-1.5 transition-colors ${released === val ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`, children: label }, val))) }), (search || reason || released !== 'false') && (_jsxs("button", { onClick: resetFilters, className: "text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1", children: [_jsx(X, { size: 12 }), " Zur\u00FCcksetzen"] })), _jsxs("span", { className: "ml-auto text-xs text-gray-400", children: [total, " Eintr\u00E4ge"] })] }), selectedRows.size > 0 && (_jsxs("div", { className: "px-6 py-2 bg-accent/10 border-b border-accent/20 flex items-center gap-3 shrink-0", children: [_jsxs("span", { className: "text-sm font-medium text-accent", children: [selectedRows.size, " ausgew\u00E4hlt"] }), _jsxs("button", { onClick: () => bulkDeleteMut.mutate([...selectedRows]), disabled: bulkDeleteMut.isPending, className: "btn-secondary text-xs text-red-600 border-red-200 hover:bg-red-50 gap-1", children: [_jsx(Trash2, { size: 12 }), " Alle l\u00F6schen"] }), _jsx("button", { onClick: () => setSelectedRows(new Set()), className: "text-xs text-gray-500 hover:text-gray-700 ml-auto", children: "Auswahl aufheben" })] })), _jsx("div", { className: "flex-1 overflow-auto", children: isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-24 text-gray-400", children: [_jsx(Loader2, { size: 22, className: "animate-spin mr-2" }), " Lade Quarant\u00E4ne\u2026"] })) : items.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center justify-center py-24 text-gray-400 gap-3", children: [_jsx(ShieldAlert, { size: 36, className: "text-gray-200" }), _jsx("p", { className: "text-sm", children: "Keine Eintr\u00E4ge gefunden" }), (search || reason) && (_jsx("button", { onClick: resetFilters, className: "text-xs text-accent hover:underline", children: "Filter zur\u00FCcksetzen" }))] })) : (_jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-white border-b border-gray-200 sticky top-0 z-10", children: _jsxs("tr", { children: [_jsx("th", { className: "w-8 px-4 py-3", children: _jsx("input", { type: "checkbox", checked: selectedRows.size === items.length && items.length > 0, onChange: toggleAll, className: "rounded border-gray-300 text-accent focus:ring-accent" }) }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Von / An" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Betreff" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Grund" }), _jsxs("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: [_jsx(Calendar, { size: 11, className: "inline mr-1" }), "Datum"] }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "bg-white divide-y divide-gray-100", children: items.map(item => {
                                const isSelected = selectedRows.has(item.id);
                                const isActive = selectedId === item.id;
                                return (_jsxs("tr", { className: `transition-colors hover:bg-gray-50 cursor-pointer ${item.released ? 'opacity-60' : ''} ${isActive ? 'bg-accent/5' : ''} ${isSelected ? 'bg-blue-50/60' : ''}`, onClick: () => setSelectedId(item.id === selectedId ? null : item.id), children: [_jsx("td", { className: "px-4 py-3", onClick: e => e.stopPropagation(), children: _jsx("input", { type: "checkbox", checked: isSelected, onChange: () => toggleRow(item.id), className: "rounded border-gray-300 text-accent focus:ring-accent" }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-800 truncate max-w-[170px]", children: item.fromAddr }), _jsxs("p", { className: "text-xs text-gray-400 flex items-center gap-0.5 truncate max-w-[170px]", children: [_jsx(ArrowRight, { size: 9 }), " ", item.toAddr] })] }), _jsx("td", { className: "px-4 py-3", children: _jsx("p", { className: "text-gray-700 truncate max-w-[220px]", children: item.subject || _jsx("span", { className: "italic text-gray-400", children: "(kein Betreff)" }) }) }), _jsx("td", { className: "px-4 py-3", children: _jsx(ReasonBadge, { reason: item.reason }) }), _jsxs("td", { className: "px-4 py-3 text-xs text-gray-500 whitespace-nowrap", children: [new Date(item.createdAt).toLocaleDateString('de-DE'), _jsx("br", {}), _jsx("span", { className: "text-gray-400", children: new Date(item.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) })] }), _jsx("td", { className: "px-4 py-3", children: item.released ? (_jsxs("span", { className: "inline-flex items-center gap-1 text-xs text-green-600", children: [_jsx(CheckCircle, { size: 11 }), " Freigegeben"] })) : (_jsxs("span", { className: "inline-flex items-center gap-1 text-xs text-amber-600", children: [_jsx(Clock, { size: 11 }), " Ausstehend"] })) }), _jsx("td", { className: "px-4 py-3", onClick: e => e.stopPropagation(), children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => setSelectedId(item.id === selectedId ? null : item.id), title: "Vorschau", className: `p-1.5 rounded transition-colors ${isActive ? 'bg-accent/10 text-accent' : 'text-gray-400 hover:text-accent hover:bg-accent/10'}`, children: _jsx(Eye, { size: 14 }) }), !item.released && item.reason !== 'VIRUS' && (_jsx("button", { onClick: () => releaseMut.mutate(item.id), title: "Freigeben", className: "p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors", children: _jsx(CheckCircle, { size: 14 }) })), _jsx("button", { onClick: () => { if (window.confirm('Eintrag endgültig löschen?'))
                                                            deleteMut.mutate(item.id); }, title: "L\u00F6schen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, item.id));
                            }) })] })) }), pages > 1 && (_jsxs("div", { className: "px-6 py-3 bg-white border-t border-gray-200 flex items-center justify-between text-sm text-gray-500 shrink-0", children: [_jsxs("span", { children: [total, " Eintr\u00E4ge \u00B7 Seite ", page, " von ", pages] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setPage(1), disabled: page === 1, className: "p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors", children: "\u00AB" }), _jsx("button", { onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1, className: "p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors", children: _jsx(ChevronLeft, { size: 14 }) }), Array.from({ length: Math.min(5, pages) }, (_, i) => {
                                const p = Math.max(1, Math.min(pages - 4, page - 2)) + i;
                                return (_jsx("button", { onClick: () => setPage(p), className: `min-w-[32px] px-2 py-1 rounded border text-xs transition-colors ${p === page ? 'bg-accent text-white border-accent' : 'hover:bg-gray-50'}`, children: p }, p));
                            }), _jsx("button", { onClick: () => setPage(p => Math.min(pages, p + 1)), disabled: page === pages, className: "p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors", children: _jsx(ChevronRight, { size: 14 }) }), _jsx("button", { onClick: () => setPage(pages), disabled: page === pages, className: "p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors", children: "\u00BB" })] })] })), selectedId && (_jsx(DetailPanel, { id: selectedId, onClose: () => setSelectedId(null), onRelease: id => releaseMut.mutate(id), onDelete: id => { if (window.confirm('Eintrag endgültig löschen?'))
                    deleteMut.mutate(id); } })), showCleanup && (_jsx(CleanupModal, { onClose: () => setShowCleanup(false), onConfirm: (days, onlyReleased) => cleanupMut.mutate({ days, onlyReleased }) }))] }));
}
