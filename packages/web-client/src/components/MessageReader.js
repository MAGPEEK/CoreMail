import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
// DOMPurify may not be installed — inline a simple sanitizer fallback
function sanitize(html) {
    if (typeof window !== 'undefined' && 'DOMPurify' in window) {
        return window.DOMPurify.sanitize(html);
    }
    // Strip script tags as minimal fallback
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
}
export function MessageReader({ messageId }) {
    const qc = useQueryClient();
    const { openCompose, setSelectedMessage } = useUiStore();
    const { data: msg, isLoading } = useQuery({
        queryKey: ['message', messageId],
        queryFn: () => api.get(`/mail/messages/${messageId}`),
    });
    const deleteMutation = useMutation({
        mutationFn: () => api.delete(`/mail/messages/${messageId}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['messages'] });
            qc.invalidateQueries({ queryKey: ['folders'] });
            setSelectedMessage(null);
        },
    });
    if (isLoading) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Lade Nachricht..." }));
    }
    if (!msg)
        return null;
    return (_jsxs("div", { className: "flex-1 flex flex-col bg-white overflow-hidden", children: [_jsxs("div", { className: "flex items-center gap-1 px-4 py-2 border-b border-gray-100 shrink-0", children: [_jsxs("button", { onClick: () => openCompose({ id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr }), className: "btn-secondary text-xs", children: [_jsx(Reply, { size: 14 }), " Antworten"] }), _jsxs("button", { className: "btn-secondary text-xs", children: [_jsx(ReplyAll, { size: 14 }), " Allen antworten"] }), _jsxs("button", { className: "btn-secondary text-xs", children: [_jsx(Forward, { size: 14 }), " Weiterleiten"] }), _jsx("div", { className: "flex-1" }), _jsxs("button", { className: "btn-ghost text-xs", children: [_jsx(Archive, { size: 14 }), " Archivieren"] }), _jsxs("button", { onClick: () => deleteMutation.mutate(), className: "btn-ghost text-xs text-red-600 hover:bg-red-50", children: [_jsx(Trash2, { size: 14 }), " L\u00F6schen"] })] }), _jsxs("div", { className: "px-6 py-4 border-b border-gray-100 shrink-0", children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900 mb-3", children: msg.subject || '(kein Betreff)' }), _jsxs("div", { className: "space-y-1 text-sm text-gray-600", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "font-medium text-gray-400 w-12", children: "Von:" }), _jsx("span", { children: msg.fromAddr })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "font-medium text-gray-400 w-12", children: "An:" }), _jsx("span", { children: msg.toAddrs.join(', ') })] }), msg.ccAddrs?.length > 0 && (_jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "font-medium text-gray-400 w-12", children: "CC:" }), _jsx("span", { children: msg.ccAddrs.join(', ') })] })), _jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "font-medium text-gray-400 w-12", children: "Datum:" }), _jsx("span", { children: format(new Date(msg.date), 'dd.MM.yyyy HH:mm') })] })] })] }), msg.attachments?.length > 0 && (_jsx("div", { className: "px-6 py-2 border-b border-gray-100 flex flex-wrap gap-2 shrink-0", children: msg.attachments.map((att) => (_jsxs("a", { href: `/api/v1/mail/attachments/${att.id}`, download: att.filename, className: "flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 hover:bg-gray-100 transition-colors", children: [_jsx(Paperclip, { size: 12 }), att.filename, _jsxs("span", { className: "text-gray-400", children: ["(", Math.round(att.size / 1024), " KB)"] }), _jsx(Download, { size: 11, className: "text-gray-400" })] }, att.id))) })), _jsx("div", { className: "flex-1 overflow-y-auto px-6 py-4", children: msg.bodyHtml ? (_jsx("div", { className: "prose prose-sm max-w-none", dangerouslySetInnerHTML: { __html: sanitize(msg.bodyHtml) } })) : (_jsx("pre", { className: "text-sm text-gray-700 whitespace-pre-wrap font-sans", children: msg.bodyText })) })] }));
}
