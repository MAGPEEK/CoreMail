import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDraggable } from '@dnd-kit/core';
import { Paperclip, Pin, Archive, Trash2, Mail, MailOpen, Flag, FlagOff, Forward, Reply, ReplyAll, AlertOctagon, Clock, FolderInput, ShieldOff, Download, Code, } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { api } from '../api/client.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { ContextMenu } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { MessageListSkeleton, EmptyInbox, EmptySearch } from './Skeleton.js';
function formatDate(iso) {
    const d = new Date(iso);
    if (isToday(d))
        return format(d, 'HH:mm');
    if (isYesterday(d))
        return 'Gestern';
    return format(d, 'dd.MM.yyyy');
}
function MessageRow({ msg, selected, checked, onClick, onToggleCheck, onContextMenu, onQuickAction, density, folders, }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `msg:${msg.id}`,
        data: { kind: 'message', messageId: msg.id, folderId: msg.id /* fallback */ },
    });
    const avatarRef = useRef(null);
    const [showCard, setShowCard] = useState(false);
    const hoverTimer = useRef(null);
    const isUnread = !msg.flags.includes('\\Seen');
    const isFlagged = msg.flags.includes('\\Flagged');
    const hasAttachments = msg.attachments.length > 0;
    const isPinned = !!msg.pinnedAt;
    const isSnoozed = msg.snoozeUntil && new Date(msg.snoozeUntil) > new Date();
    const py = density === 'compact' ? 'py-1.5' : density === 'comfortable' ? 'py-3.5' : 'py-2.5';
    return (_jsxs("div", { ref: setNodeRef, ...attributes, ...listeners, onClick: onClick, onContextMenu: onContextMenu, className: `w-full text-left px-3 ${py} border-b border-gray-100 dark:border-gray-700 transition-all duration-150 relative group cursor-pointer ${selected
            ? 'bg-accent/10 shadow-sm'
            : checked
                ? 'bg-accent/5'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800 hover:shadow-sm'} ${isUnread ? 'border-l-2 border-l-accent' : 'border-l-2 border-l-transparent'} ${isDragging ? 'opacity-30' : ''}`, role: "button", tabIndex: 0, children: [_jsxs("div", { className: "flex items-center gap-2.5", children: [_jsx("button", { onClick: onToggleCheck, className: `w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${checked
                            ? 'bg-accent border-accent text-white scale-100'
                            : 'border-gray-300 dark:border-gray-600 opacity-0 group-hover:opacity-100 hover:border-accent hover:scale-110'}`, "aria-label": "Ausw\u00E4hlen", children: checked && _jsx("span", { className: "text-[10px] leading-none", children: "\u2713" }) }), _jsx("button", { onClick: (e) => { e.stopPropagation(); onQuickAction('flag'); }, className: "shrink-0 transition-transform duration-150 hover:scale-125 active:scale-95", "aria-label": "Kennzeichnen", children: isFlagged
                            ? _jsx(Flag, { size: 14, className: "fill-red-500 text-red-500" })
                            : _jsx(Flag, { size: 14, className: "text-gray-300 dark:text-gray-600 hover:text-red-400 transition-colors" }) }), _jsx("div", { ref: avatarRef, onMouseEnter: () => { if (hoverTimer.current)
                            clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setShowCard(true), 350); }, onMouseLeave: () => { if (hoverTimer.current)
                            clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setShowCard(false), 200); }, onClick: (e) => e.stopPropagation(), className: "shrink-0 cursor-default", children: _jsx(Avatar, { seed: msg.fromAddr, size: "sm", className: "transition-transform duration-150 group-hover:scale-105" }) }), showCard && (_jsx(ContactHoverCard, { email: msg.fromAddr, anchorRef: avatarRef, onClose: () => setShowCard(false) })), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsxs("span", { className: `text-sm truncate flex items-center gap-1 ${isUnread ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`, children: [isUnread && (_jsx("span", { className: "inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0" })), isPinned && _jsx(Pin, { size: 11, className: "text-accent shrink-0" }), _jsx("span", { className: "truncate", children: msg.fromAddr })] }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [hasAttachments && _jsx(Paperclip, { size: 12, className: "text-gray-400" }), isSnoozed && _jsx(Clock, { size: 12, className: "text-amber-500" }), _jsx("span", { className: "text-xs text-gray-400 transition-opacity duration-150 group-hover:opacity-0", children: formatDate(msg.date) })] })] }), _jsx("p", { className: `text-sm truncate mt-0.5 transition-colors duration-150 ${isUnread ? 'font-medium text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'} group-hover:text-accent`, children: msg.subject || '(kein Betreff)' })] }), _jsxs("div", { className: "absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-md opacity-0 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150 pointer-events-none group-hover:pointer-events-auto", children: [_jsx("button", { onClick: (e) => { e.stopPropagation(); onQuickAction('archive'); }, className: "p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors active:scale-90", title: "Archivieren", children: _jsx(Archive, { size: 13 }) }), _jsx("button", { onClick: (e) => { e.stopPropagation(); onQuickAction('delete'); }, className: "p-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-gray-600 dark:text-gray-300 hover:text-red-600 transition-colors active:scale-90", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) }), _jsx("button", { onClick: (e) => { e.stopPropagation(); onQuickAction('read'); }, className: "p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors active:scale-90", title: isUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren', children: isUnread ? _jsx(MailOpen, { size: 13 }) : _jsx(Mail, { size: 13 }) })] })] }), _jsx("span", { className: "hidden", children: folders.length })] }));
}
export function MessageList({ folderId }) {
    const qc = useQueryClient();
    const { selectedMessageId, setSelectedMessage, selectedIds, toggleSelection, selectAll, clearSelection, filter, setFilter, openCompose } = useUiStore();
    const { density } = useUiPrefs();
    const [menu, setMenu] = useState(null);
    const { data, isLoading } = useQuery({
        queryKey: ['messages', folderId],
        queryFn: () => api.get(`/mail/folders/${folderId}/messages?limit=100`),
        enabled: !!folderId,
    });
    const { data: folders = [] } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
    });
    const currentFolder = folders.find((f) => f.id === folderId);
    const isJunkFolder = currentFolder?.name === 'Junk';
    const isTrashFolder = currentFolder?.name === 'Trash';
    // Filter anwenden
    const filtered = useMemo(() => {
        const list = data?.messages ?? [];
        if (filter === 'unread')
            return list.filter((m) => !m.flags.includes('\\Seen'));
        if (filter === 'flagged')
            return list.filter((m) => m.flags.includes('\\Flagged'));
        if (filter === 'attachments')
            return list.filter((m) => m.attachments.length > 0);
        return list;
    }, [data, filter]);
    const orderedIds = useMemo(() => filtered.map((m) => m.id), [filtered]);
    const allChecked = orderedIds.length > 0 && orderedIds.every((id) => selectedIds.has(id));
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['messages'] });
        qc.invalidateQueries({ queryKey: ['folders'] });
    };
    const bulkMutation = useMutation({
        mutationFn: (body) => api.post('/mail/messages/bulk', body),
        onSuccess: invalidate,
    });
    const patchMutation = useMutation({
        mutationFn: ({ id, body }) => api.patch(`/mail/messages/${id}`, body),
        onSuccess: invalidate,
    });
    const quickAction = (msg, action) => {
        const isUnread = !msg.flags.includes('\\Seen');
        const isFlagged = msg.flags.includes('\\Flagged');
        const prevFolderId = folderId;
        if (action === 'archive') {
            bulkMutation.mutate({ ids: [msg.id], action: 'archive' });
            showUndoToast({
                message: 'Nachricht archiviert',
                onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: prevFolderId }),
            });
            if (msg.id === selectedMessageId)
                setSelectedMessage(null);
        }
        else if (action === 'delete') {
            bulkMutation.mutate({ ids: [msg.id], action: 'delete' });
            const trash = folders.find((f) => f.name === 'Trash');
            if (!isTrashFolder && trash) {
                showUndoToast({
                    message: 'Nachricht in den Papierkorb verschoben',
                    onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: prevFolderId }),
                });
            }
            if (msg.id === selectedMessageId)
                setSelectedMessage(null);
        }
        else if (action === 'read') {
            patchMutation.mutate({ id: msg.id, body: { read: isUnread } });
        }
        else if (action === 'flag') {
            patchMutation.mutate({ id: msg.id, body: { flagged: !isFlagged } });
        }
    };
    const buildMessageMenu = (msg) => {
        const isUnread = !msg.flags.includes('\\Seen');
        const isFlagged = msg.flags.includes('\\Flagged');
        const isPinned = !!msg.pinnedAt;
        const isSnoozed = !!(msg.snoozeUntil && new Date(msg.snoozeUntil) > new Date());
        const moveTargets = folders
            .filter((f) => f.id !== folderId)
            .map((f) => ({
            label: f.displayName ?? f.name,
            icon: _jsx(FolderInput, { size: 14, style: f.color ? { color: f.color } : undefined }),
            onClick: () => {
                bulkMutation.mutate({ ids: [msg.id], action: 'move', folderId: f.id });
                if (msg.id === selectedMessageId)
                    setSelectedMessage(null);
            },
        }));
        const snoozeOptions = () => {
            const now = new Date();
            const inHours = (h) => { const d = new Date(now); d.setHours(d.getHours() + h); return d; };
            const tomorrow8 = () => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; };
            const nextMonday = () => {
                const d = new Date(now);
                d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));
                d.setHours(8, 0, 0, 0);
                return d;
            };
            const snooze = (until) => api.post(`/mail/messages/${msg.id}/snooze`, { until: until.toISOString() }).then(invalidate);
            return [
                { label: 'In 1 Stunde', onClick: () => void snooze(inHours(1)) },
                { label: 'In 3 Stunden', onClick: () => void snooze(inHours(3)) },
                { label: 'Morgen 8:00', onClick: () => void snooze(tomorrow8()) },
                { label: 'Nächsten Montag', onClick: () => void snooze(nextMonday()) },
            ];
        };
        return [
            { label: 'Öffnen', icon: _jsx(Mail, { size: 14 }), onClick: () => setSelectedMessage(msg.id) },
            { type: 'divider' },
            { label: 'Antworten', icon: _jsx(Reply, { size: 14 }), onClick: () => openCompose({ mode: 'reply', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr }) },
            { label: 'Allen antworten', icon: _jsx(ReplyAll, { size: 14 }), onClick: () => openCompose({ mode: 'replyAll', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, toAddrs: msg.toAddrs }) },
            { label: 'Weiterleiten', icon: _jsx(Forward, { size: 14 }), onClick: () => openCompose({ mode: 'forward', id: msg.id, subject: msg.subject }) },
            { type: 'divider' },
            { label: isUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren',
                icon: isUnread ? _jsx(MailOpen, { size: 14 }) : _jsx(Mail, { size: 14 }),
                onClick: () => patchMutation.mutate({ id: msg.id, body: { read: isUnread } }) },
            { label: isFlagged ? 'Kennzeichnung aufheben' : 'Kennzeichnen',
                icon: isFlagged ? _jsx(FlagOff, { size: 14 }) : _jsx(Flag, { size: 14 }),
                onClick: () => patchMutation.mutate({ id: msg.id, body: { flagged: !isFlagged } }) },
            { label: isPinned ? 'Lösen' : 'Anheften',
                icon: _jsx(Pin, { size: 14 }),
                onClick: () => bulkMutation.mutate({ ids: [msg.id], action: isPinned ? 'unpin' : 'pin' }) },
            { label: isSnoozed ? 'Schlummer aufheben' : 'Schlummern bis …',
                icon: _jsx(Clock, { size: 14 }),
                ...(isSnoozed
                    ? { onClick: () => api.delete(`/mail/messages/${msg.id}/snooze`).then(invalidate).catch(() => undefined) }
                    : { children: snoozeOptions() }), },
            { type: 'divider' },
            { label: 'Archivieren', icon: _jsx(Archive, { size: 14 }), onClick: () => quickAction(msg, 'archive') },
            { label: 'Verschieben nach …', icon: _jsx(FolderInput, { size: 14 }), children: moveTargets },
            isJunkFolder
                ? { label: 'Kein Junk', icon: _jsx(ShieldOff, { size: 14 }), onClick: () => bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }) }
                : { label: 'Als Junk markieren', icon: _jsx(AlertOctagon, { size: 14 }), onClick: () => bulkMutation.mutate({ ids: [msg.id], action: 'spam' }) },
            { label: 'Löschen', icon: _jsx(Trash2, { size: 14 }), danger: true, onClick: () => quickAction(msg, 'delete') },
            { type: 'divider' },
            { label: 'Quelltext anzeigen', icon: _jsx(Code, { size: 14 }),
                onClick: () => window.open(`/api/v1/mail/messages/${msg.id}/raw`, '_blank') },
            { label: 'Als EML herunterladen', icon: _jsx(Download, { size: 14 }),
                onClick: () => {
                    const a = document.createElement('a');
                    a.href = `/api/v1/mail/messages/${msg.id}/raw`;
                    a.download = `${msg.subject || 'message'}.eml`;
                    a.click();
                } },
        ];
    };
    const handleRowClick = (msg) => (e) => {
        // Shift = Bereichsauswahl, Ctrl/Cmd = einzeln toggle, sonst öffnen
        if (e.shiftKey) {
            toggleSelection(msg.id, { range: true, orderedIds });
            return;
        }
        if (e.metaKey || e.ctrlKey) {
            toggleSelection(msg.id);
            return;
        }
        clearSelection();
        setSelectedMessage(msg.id);
    };
    const handleContextMenu = (msg) => (e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: buildMessageMenu(msg) });
    };
    if (isLoading) {
        return (_jsxs("div", { className: "w-80 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col h-full", children: [_jsx("div", { className: "px-3 py-2 border-b border-gray-100 dark:border-gray-700 h-9" }), _jsx(MessageListSkeleton, { rows: 8 })] }));
    }
    const FilterTab = ({ value, label }) => (_jsx("button", { onClick: () => setFilter(value), className: `px-3 py-1 text-xs rounded-full transition-colors ${filter === value
            ? 'bg-accent text-white'
            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`, children: label }));
    return (_jsxs("div", { className: "w-80 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col h-full", children: [_jsxs("div", { className: "px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2", children: [_jsx("input", { type: "checkbox", checked: allChecked, onChange: () => (allChecked ? clearSelection() : selectAll(orderedIds)), className: "rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent", title: "Alle ausw\u00E4hlen" }), _jsx(FilterTab, { value: "all", label: "Alle" }), _jsx(FilterTab, { value: "unread", label: "Ungelesen" }), _jsx(FilterTab, { value: "flagged", label: "Markiert" }), _jsx(FilterTab, { value: "attachments", label: "Anhang" }), _jsx("span", { className: "ml-auto text-xs text-gray-500", children: filtered.length })] }), _jsx("div", { className: "flex-1 overflow-y-auto", children: filtered.length === 0 ? (filter === 'all' ? _jsx(EmptyInbox, {}) : _jsx(EmptySearch, {})) : (filtered.map((msg) => (_jsx(MessageRow, { msg: msg, selected: msg.id === selectedMessageId && selectedIds.size === 0, checked: selectedIds.has(msg.id), onClick: handleRowClick(msg), onToggleCheck: (e) => { e.stopPropagation(); toggleSelection(msg.id); }, onContextMenu: handleContextMenu(msg), onQuickAction: (a) => quickAction(msg, a), density: density, folders: folders }, msg.id)))) }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) })] }));
}
