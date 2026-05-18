import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Download, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../api/client.js';
function StatusBadge({ status }) {
    const base = 'px-2 py-0.5 rounded text-xs font-medium';
    if (status === 'ACCEPTED')
        return _jsx("span", { className: `${base} bg-blue-100 text-blue-700`, children: "Angenommen" });
    if (status === 'DELIVERED')
        return _jsx("span", { className: `${base} bg-green-100 text-green-700`, children: "Zugestellt" });
    if (status === 'REJECTED')
        return _jsx("span", { className: `${base} bg-red-100 text-red-700`, children: "Abgelehnt" });
    if (status === 'DEFERRED')
        return _jsx("span", { className: `${base} bg-amber-100 text-amber-700`, children: "Zur\u00FCckgestellt" });
    if (status === 'QUARANTINE')
        return _jsx("span", { className: `${base} bg-orange-100 text-orange-700`, children: "Quarant\u00E4ne" });
    return _jsx("span", { className: `${base} bg-gray-100 text-gray-600`, children: status || '–' });
}
export function MessageTracePage() {
    const [sender, setSender] = useState('');
    const [recipient, setRecipient] = useState('');
    const [subject, setSubject] = useState('');
    const [status, setStatus] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [page, setPage] = useState(1);
    const [limit] = useState(100);
    const [triggered, setTriggered] = useState(false);
    const { data, isLoading, isFetching } = useQuery({
        queryKey: ['message-trace', sender, recipient, subject, status, fromDate, toDate, page],
        queryFn: () => api.get(`/api/v1/admin/message-trace?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&subject=${encodeURIComponent(subject)}&status=${status}&from=${fromDate}&to=${toDate}&page=${page}&limit=${limit}`),
        enabled: triggered,
    });
    function handleSearch() { setPage(1); setTriggered(true); }
    const items = data?.items ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    function exportCsv() {
        const url = `/api/v1/admin/message-trace/export?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&from=${fromDate}&to=${toDate}`;
        window.open(url, '_blank');
    }
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(Search, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "Nachrichtenablaufverfolgung" }), _jsx("p", { className: "text-sm text-gray-500", children: "E-Mail-Zustellungspfade nachverfolgen" })] })] }), _jsxs("div", { className: "bg-white rounded-xl border border-gray-200 p-4 mb-4", children: [_jsxs("div", { className: "grid grid-cols-3 gap-3 mb-3", children: [_jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Absender" }), _jsx("input", { value: sender, onChange: e => setSender(e.target.value), onKeyDown: e => e.key === 'Enter' && handleSearch(), className: "input", placeholder: "user@domain.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Empf\u00E4nger" }), _jsx("input", { value: recipient, onChange: e => setRecipient(e.target.value), onKeyDown: e => e.key === 'Enter' && handleSearch(), className: "input", placeholder: "user@domain.com" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Betreff (enth\u00E4lt)" }), _jsx("input", { value: subject, onChange: e => setSubject(e.target.value), onKeyDown: e => e.key === 'Enter' && handleSearch(), className: "input", placeholder: "Re: Meeting" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Status" }), _jsxs("select", { value: status, onChange: e => setStatus(e.target.value), className: "input", children: [_jsx("option", { value: "", children: "Alle" }), _jsx("option", { value: "ACCEPTED", children: "Angenommen" }), _jsx("option", { value: "DELIVERED", children: "Zugestellt" }), _jsx("option", { value: "REJECTED", children: "Abgelehnt" }), _jsx("option", { value: "DEFERRED", children: "Zur\u00FCckgestellt" }), _jsx("option", { value: "QUARANTINE", children: "Quarant\u00E4ne" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Von Datum" }), _jsx("input", { type: "datetime-local", value: fromDate, onChange: e => setFromDate(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Bis Datum" }), _jsx("input", { type: "datetime-local", value: toDate, onChange: e => setToDate(e.target.value), className: "input" })] })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsxs("button", { onClick: exportCsv, className: "btn-secondary flex items-center gap-1.5 text-xs", children: [_jsx(Download, { size: 13 }), " CSV exportieren"] }), _jsxs("button", { onClick: handleSearch, disabled: isLoading || isFetching, className: "btn-primary flex items-center gap-1.5", children: [(isLoading || isFetching) ? _jsx(Loader2, { size: 14, className: "animate-spin" }) : _jsx(Search, { size: 14 }), "Suchen"] })] })] }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: !triggered ? (_jsxs("div", { className: "text-center py-12 text-gray-400 text-sm", children: [_jsx(Search, { size: 28, className: "mx-auto mb-2 opacity-30" }), "Filter ausf\u00FCllen und Suchen klicken"] })) : isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Suche l\u00E4uft\u2026"] })) : items.length === 0 ? (_jsx("div", { className: "text-center py-12 text-gray-400 text-sm", children: "Keine Nachrichten gefunden" })) : (_jsxs(_Fragment, { children: [_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Zeitstempel" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Von \u2192 An" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Betreff" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Details" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: items.map(item => {
                                        const m = item.metadata ?? {};
                                        return (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-3 text-xs text-gray-500 whitespace-nowrap", children: new Date(item.timestamp).toLocaleString('de-DE') }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-center gap-1 text-sm", children: [_jsx("span", { className: "text-gray-700", children: m['sender'] || '–' }), _jsx(ArrowRight, { size: 12, className: "text-gray-400 shrink-0" }), _jsx("span", { className: "text-gray-700", children: m['recipient'] || '–' })] }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "text-sm text-gray-700 truncate max-w-[200px]", children: m['subject'] || '(kein Betreff)' }), m['messageId'] && _jsx("p", { className: "text-xs text-gray-400 font-mono", children: m['messageId'].slice(0, 30) })] }), _jsx("td", { className: "px-4 py-3", children: _jsx(StatusBadge, { status: m['status'] ?? '' }) }), _jsxs("td", { className: "px-4 py-3 text-xs text-gray-500", children: [m['reason'] && _jsx("span", { className: "text-red-600", children: m['reason'] }), m['spamScore'] && _jsxs("span", { children: [" Spam: ", m['spamScore']] }), m['size'] && _jsxs("span", { children: [" ", Math.round(parseInt(m['size']) / 1024), " KB"] })] })] }, item.id));
                                    }) })] }), pages > 1 && (_jsxs("div", { className: "flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500", children: [_jsxs("span", { children: [total, " Eintr\u00E4ge"] }), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => setPage(p => Math.max(1, p - 1)), disabled: page === 1, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u2039" }), _jsxs("span", { className: "px-3 py-1", children: ["Seite ", page, " / ", pages] }), _jsx("button", { onClick: () => setPage(p => Math.min(pages, p + 1)), disabled: page === pages, className: "px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40", children: "\u203A" })] })] }))] })) })] }));
}
