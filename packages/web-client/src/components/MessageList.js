import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
function formatDate(iso) {
    const d = new Date(iso);
    if (isToday(d))
        return format(d, 'HH:mm');
    if (isYesterday(d))
        return 'Gestern';
    return format(d, 'dd.MM.yyyy');
}
function MessageRow({ msg, selected, onClick }) {
    const isUnread = !msg.flags.includes('\\Seen');
    const hasAttachments = msg.attachments.length > 0;
    return (_jsxs("button", { onClick: onClick, className: `w-full text-left px-4 py-2.5 border-b border-gray-100 transition-colors relative group ${selected ? 'bg-accent/10' : 'hover:bg-gray-50'}`, children: [isUnread && (_jsx("span", { className: "absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent" })), _jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("span", { className: `text-sm truncate ${isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`, children: msg.fromAddr }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [hasAttachments && _jsx(Paperclip, { size: 12, className: "text-gray-400" }), _jsx("span", { className: "text-xs text-gray-400", children: formatDate(msg.date) })] })] }), _jsx("p", { className: `text-sm truncate mt-0.5 ${isUnread ? 'font-medium text-gray-800' : 'text-gray-600'}`, children: msg.subject || '(kein Betreff)' })] }));
}
export function MessageList({ folderId }) {
    const { selectedMessageId, setSelectedMessage } = useUiStore();
    const { data, isLoading } = useQuery({
        queryKey: ['messages', folderId],
        queryFn: () => api.get(`/mail/folders/${folderId}/messages?limit=100`),
        enabled: !!folderId,
    });
    if (isLoading) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Lade Nachrichten..." }));
    }
    if (!data?.messages.length) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Keine Nachrichten" }));
    }
    return (_jsxs("div", { className: "w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full", children: [_jsx("div", { className: "px-4 py-2 border-b border-gray-100 flex items-center justify-between", children: _jsxs("span", { className: "text-xs text-gray-500", children: [data.total, " Nachrichten"] }) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: data.messages.map((msg) => (_jsx(MessageRow, { msg: msg, selected: msg.id === selectedMessageId, onClick: () => setSelectedMessage(msg.id) }, msg.id))) })] }));
}
