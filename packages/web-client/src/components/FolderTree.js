import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
import { Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus, Star, ChevronRight, ChevronDown, Pencil, FolderPlus, FolderMinus, CheckCheck, Eraser, Tag, PaintBucket, } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { ContextMenu } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'];
const DISPLAY_NAME = {
    INBOX: 'Posteingang',
    Drafts: 'Entwürfe',
    Sent: 'Gesendete Elemente',
    Trash: 'Gelöschte Elemente',
    Junk: 'Junk-E-Mail',
    Archive: 'Archiv',
};
const ICON_MAP = {
    INBOX: Inbox,
    Drafts: FileText,
    Sent: Send,
    Trash: Trash2,
    Junk: AlertTriangle,
    Archive: Archive,
};
const SYSTEM_SET = new Set(SYSTEM_ORDER);
function FolderItem({ folder, selected, onSelect, onContextMenu, indent = 0, }) {
    const { isOver, setNodeRef } = useDroppable({
        id: `folder:${folder.id}`,
        data: { kind: 'folder', folderId: folder.id, folderName: folder.name },
    });
    const Icon = ICON_MAP[folder.name] ?? Folder;
    const label = DISPLAY_NAME[folder.name] ?? folder.displayName ?? folder.name;
    return (_jsxs("button", { ref: setNodeRef, onClick: onSelect, onContextMenu: onContextMenu, style: { paddingLeft: 12 + indent * 12 }, className: `w-full flex items-center gap-2 pr-3 py-1.5 text-sm rounded-sm transition-colors ${selected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'} ${isOver ? 'ring-2 ring-accent/60 bg-accent/15' : ''}`, children: [_jsx(Icon, { size: 15, className: "shrink-0", style: folder.color ? { color: folder.color } : undefined }), _jsx("span", { className: "flex-1 text-left truncate", children: label }), folder.unreadCount > 0 && (_jsx("span", { className: "text-xs font-bold text-accent", children: folder.unreadCount }))] }));
}
export function FolderTree({ onNewMail }) {
    const qc = useQueryClient();
    const { selectedFolderId, setSelectedFolder } = useUiStore();
    const { favoritesCollapsed, folderTreeCollapsed, toggleFavorites, toggleFolderTree } = useUiPrefs();
    const [menu, setMenu] = useState(null);
    const [dialog, setDialog] = useState(null);
    const { data: folders } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
        refetchInterval: 60_000,
    });
    const patchFolder = useMutation({
        mutationFn: ({ id, body }) => api.patch(`/mail/folders/${id}`, body),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
        onError: (e) => toast.error(e.message || 'Aktion fehlgeschlagen'),
    });
    const createFolder = useMutation({
        mutationFn: (body) => api.post('/mail/folders', body),
        onSuccess: (folder) => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            toast.success(`Ordner „${folder.displayName ?? folder.name}" angelegt`);
        },
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht angelegt werden'),
    });
    const deleteFolder = useMutation({
        mutationFn: (id) => api.delete(`/mail/folders/${id}?force=true`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
            toast.success('Ordner gelöscht');
        },
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht gelöscht werden'),
    });
    const emptyFolder = useMutation({
        mutationFn: (id) => api.post(`/mail/folders/${id}/empty`, {}),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
            toast.success('Ordner geleert');
        },
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht geleert werden'),
    });
    const markAllRead = useMutation({
        mutationFn: async (folderId) => {
            const list = await api.get(`/mail/folders/${folderId}/messages?limit=500`);
            const unread = list.messages.filter((m) => !m.flags.includes('\\Seen')).map((m) => m.id);
            if (!unread.length)
                return { affected: 0 };
            return api.post('/mail/messages/bulk', { ids: unread, action: 'read' });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
        },
    });
    const all = folders ?? [];
    const favorites = all.filter((f) => f.isFavorite);
    const systemFolders = SYSTEM_ORDER
        .map((name) => all.find((f) => f.name === name))
        .filter((f) => f !== undefined);
    const customFolders = all.filter((f) => !SYSTEM_SET.has(f.name));
    const buildFolderMenu = (folder) => {
        const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
        const isTrashOrJunk = folder.name === 'Trash' || folder.name === 'Junk';
        const items = [
            {
                label: 'Ordner öffnen',
                icon: _jsx(Folder, { size: 14 }),
                onClick: () => setSelectedFolder(folder.id),
            },
            {
                label: 'Alle als gelesen markieren',
                icon: _jsx(CheckCheck, { size: 14 }),
                disabled: folder.unreadCount === 0,
                onClick: () => {
                    toast.promise(markAllRead.mutateAsync(folder.id), {
                        loading: 'Markiere…',
                        success: 'Alle als gelesen markiert',
                        error: 'Fehler beim Markieren',
                    });
                },
            },
            { type: 'divider' },
            {
                label: folder.isFavorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen',
                icon: _jsx(Star, { size: 14, className: folder.isFavorite ? 'fill-yellow-400 text-yellow-500' : '' }),
                onClick: () => patchFolder.mutate({ id: folder.id, body: { isFavorite: !folder.isFavorite } }),
            },
            {
                label: 'Neuer Unterordner …',
                icon: _jsx(FolderPlus, { size: 14 }),
                onClick: () => setDialog({
                    kind: 'createChild',
                    parentId: folder.id,
                    parentLabel: folder.displayName ?? folder.name,
                }),
            },
        ];
        if (!isSystem) {
            items.push({
                label: 'Umbenennen',
                icon: _jsx(Pencil, { size: 14 }),
                onClick: () => setDialog({ kind: 'rename', folder }),
            }, {
                label: 'Farbe ändern',
                icon: _jsx(PaintBucket, { size: 14 }),
                children: [
                    { label: 'Keine', icon: _jsx(Tag, { size: 14, className: "text-gray-300" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: null } }) },
                    { label: 'Blau', icon: _jsx(Tag, { size: 14, className: "text-blue-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#3B82F6' } }) },
                    { label: 'Grün', icon: _jsx(Tag, { size: 14, className: "text-green-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#10B981' } }) },
                    { label: 'Rot', icon: _jsx(Tag, { size: 14, className: "text-red-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#EF4444' } }) },
                    { label: 'Orange', icon: _jsx(Tag, { size: 14, className: "text-orange-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#F97316' } }) },
                    { label: 'Lila', icon: _jsx(Tag, { size: 14, className: "text-purple-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#8B5CF6' } }) },
                ],
            }, {
                label: 'Löschen',
                icon: _jsx(FolderMinus, { size: 14 }),
                danger: true,
                onClick: () => {
                    const total = folder.totalCount ?? 0;
                    const msg = total > 0
                        ? `Ordner „${folder.displayName ?? folder.name}" mit ${total} Nachricht(en) wirklich löschen?`
                        : `Ordner „${folder.displayName ?? folder.name}" löschen?`;
                    if (!window.confirm(msg))
                        return;
                    deleteFolder.mutate(folder.id);
                },
            });
        }
        if (isTrashOrJunk) {
            items.push({ type: 'divider' }, {
                label: folder.name === 'Trash' ? 'Papierkorb leeren' : 'Junk-Ordner leeren',
                icon: _jsx(Eraser, { size: 14 }),
                danger: true,
                onClick: () => {
                    if (!window.confirm('Alle Nachrichten in diesem Ordner werden unwiderruflich gelöscht. Fortfahren?'))
                        return;
                    emptyFolder.mutate(folder.id);
                },
            });
        }
        return items;
    };
    const handleContextMenu = (folder) => (e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: buildFolderMenu(folder) });
    };
    const SectionHeader = ({ label, collapsed, onToggle, action }) => (_jsxs("div", { className: "flex items-center gap-1 mt-3 mb-1 px-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide", children: [_jsxs("button", { onClick: onToggle, className: "flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 flex-1", children: [collapsed ? _jsx(ChevronRight, { size: 12 }) : _jsx(ChevronDown, { size: 12 }), label] }), action] }));
    return (_jsxs("aside", { className: "w-52 shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col h-full", children: [_jsx("div", { className: "p-3", children: _jsxs("button", { onClick: onNewMail, className: "btn-primary w-full justify-center", children: [_jsx(Plus, { size: 15 }), "Neue E-Mail"] }) }), _jsxs("nav", { className: "flex-1 overflow-y-auto px-1 pb-3", children: [favorites.length > 0 && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { label: "Favoriten", collapsed: favoritesCollapsed, onToggle: toggleFavorites }), !favoritesCollapsed && (_jsx("div", { className: "space-y-0.5", children: favorites.map((f) => (_jsx(FolderItem, { folder: f, selected: f.id === selectedFolderId, onSelect: () => setSelectedFolder(f.id), onContextMenu: handleContextMenu(f) }, `fav-${f.id}`))) }))] })), _jsx(SectionHeader, { label: "Ordner", collapsed: folderTreeCollapsed, onToggle: toggleFolderTree, action: _jsx("button", { onClick: () => setDialog({ kind: 'createRoot' }), className: "text-gray-400 hover:text-gray-700 dark:hover:text-gray-200", title: "Neuer Ordner", children: _jsx(Plus, { size: 12 }) }) }), !folderTreeCollapsed && (_jsxs("div", { className: "space-y-0.5", children: [systemFolders.map((f) => (_jsx(FolderItem, { folder: f, selected: f.id === selectedFolderId, onSelect: () => setSelectedFolder(f.id), onContextMenu: handleContextMenu(f) }, f.id))), customFolders.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mt-2 mb-0.5 px-3 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide", children: "Meine Ordner" }), customFolders.map((f) => (_jsx(FolderItem, { folder: f, selected: f.id === selectedFolderId, onSelect: () => setSelectedFolder(f.id), onContextMenu: handleContextMenu(f) }, f.id)))] }))] }))] }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) }), dialog?.kind === 'createRoot' && (_jsx(PromptDialog, { title: "Neuer Ordner", label: "Name", placeholder: "z. B. Wichtige Mails", confirmText: "Erstellen", onCancel: () => setDialog(null), validate: (v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null, onConfirm: async (name) => {
                    await createFolder.mutateAsync({ name });
                    setDialog(null);
                } })), dialog?.kind === 'createChild' && (_jsx(PromptDialog, { title: "Neuer Unterordner", label: `Unterhalb von „${dialog.parentLabel}"`, placeholder: "Name", confirmText: "Erstellen", onCancel: () => setDialog(null), validate: (v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null, onConfirm: async (name) => {
                    await createFolder.mutateAsync({ name, parentId: dialog.parentId });
                    setDialog(null);
                } })), dialog?.kind === 'rename' && (_jsx(PromptDialog, { title: "Ordner umbenennen", label: "Neuer Name", initialValue: dialog.folder.displayName ?? dialog.folder.name, confirmText: "Speichern", onCancel: () => setDialog(null), validate: (v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null, onConfirm: async (name) => {
                    if (name === dialog.folder.name) {
                        setDialog(null);
                        return;
                    }
                    await patchFolder.mutateAsync({ id: dialog.folder.id, body: { name } });
                    setDialog(null);
                } }))] }));
}
