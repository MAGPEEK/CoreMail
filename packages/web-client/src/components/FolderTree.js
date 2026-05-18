import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus, Star, ChevronRight, ChevronDown, Pencil, FolderPlus, FolderMinus, CheckCheck, Eraser, Tag, PaintBucket, } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { ContextMenu } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import { useT } from '../i18n/useT.js';
import { useLanguageStore } from '../store/language.js';
const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'];
const ICON_MAP = {
    INBOX: Inbox,
    Drafts: FileText,
    Sent: Send,
    Trash: Trash2,
    Junk: AlertTriangle,
    Archive: Archive,
};
const SYSTEM_SET = new Set(SYSTEM_ORDER);
const SYSTEM_LABEL_KEY = {
    INBOX: 'inbox',
    Drafts: 'drafts',
    Sent: 'sent',
    Trash: 'trash',
    Junk: 'junk',
    Archive: 'archive',
};
function FolderItem({ folder, selected, isSystem, hasChildren, expanded, onToggleExpand, onSelect, onContextMenu, label, indent, }) {
    const { isOver, setNodeRef: setDropRef } = useDroppable({
        id: `folder-drop:${folder.id}`,
        data: { kind: 'folder', folderId: folder.id, folderName: folder.name },
    });
    // Nur Custom-Folder sind draggable (System nicht reparent-bar)
    const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
        id: `folder-drag:${folder.id}`,
        data: { kind: 'folder-source', folderId: folder.id, folderName: folder.name },
        disabled: isSystem,
    });
    const Icon = ICON_MAP[folder.name] ?? Folder;
    const setRef = (el) => {
        setDropRef(el);
        setDragRef(el);
    };
    return (_jsxs("div", { ref: setRef, ...(isSystem ? {} : attributes), ...(isSystem ? {} : listeners), onClick: onSelect, onContextMenu: onContextMenu, style: { paddingLeft: 6 + indent * 14 }, className: `group w-full flex items-center gap-1.5 pr-3 py-1.5 text-sm rounded-sm transition-colors cursor-pointer ${selected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'} ${isOver ? 'ring-2 ring-accent/60 bg-accent/15' : ''} ${isDragging ? 'opacity-40' : ''}`, role: "button", tabIndex: 0, children: [hasChildren ? (_jsx("button", { onClick: (e) => { e.stopPropagation(); onToggleExpand(); }, className: "w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0", children: expanded ? _jsx(ChevronDown, { size: 12 }) : _jsx(ChevronRight, { size: 12 }) })) : (_jsx("span", { className: "w-4 h-4 shrink-0" })), _jsx(Icon, { size: 15, className: "shrink-0", style: folder.color ? { color: folder.color } : undefined }), _jsx("span", { className: "flex-1 text-left truncate", children: label }), folder.unreadCount > 0 && (_jsx("span", { className: "text-xs font-bold text-accent", children: folder.unreadCount }))] }));
}
export function FolderTree({ onNewMail }) {
    const qc = useQueryClient();
    const t = useT();
    const lang = useLanguageStore((s) => s.lang);
    const { selectedFolderId, setSelectedFolder } = useUiStore();
    const { favoritesCollapsed, folderTreeCollapsed, toggleFavorites, toggleFolderTree } = useUiPrefs();
    const [menu, setMenu] = useState(null);
    const [dialog, setDialog] = useState(null);
    const [collapsedNodes, setCollapsedNodes] = useState(new Set());
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
            toast.success(`${t('folder_created')}: ${folder.displayName ?? folder.name}`);
        },
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht angelegt werden'),
    });
    const deleteFolder = useMutation({
        mutationFn: (id) => api.delete(`/mail/folders/${id}?force=true`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
            toast.success(t('folder_deleted'));
        },
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht gelöscht werden'),
    });
    const emptyFolder = useMutation({
        mutationFn: (id) => api.post(`/mail/folders/${id}/empty`, {}),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['messages'] });
            toast.success(t('folder_emptied'));
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
    // ── Hierarchie aufbauen ────────────────────────────────────────────────────
    const { childrenOf, rootCustomFolders } = useMemo(() => {
        const byParent = new Map();
        for (const f of all) {
            const key = f.parentId ?? '__root__';
            const arr = byParent.get(key) ?? [];
            arr.push(f);
            byParent.set(key, arr);
        }
        // Sortiere Kinder nach sortOrder, dann Name
        for (const list of byParent.values()) {
            list.sort((a, b) => {
                const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
                if (so !== 0)
                    return so;
                return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
            });
        }
        // Custom-Folder ohne parentId → root-level „Meine Ordner"
        const rootCustom = (byParent.get('__root__') ?? []).filter((f) => !SYSTEM_SET.has(f.name));
        return { childrenOf: byParent, rootCustomFolders: rootCustom };
    }, [all]);
    const favorites = all.filter((f) => f.isFavorite);
    const systemFolders = SYSTEM_ORDER
        .map((name) => all.find((f) => f.name === name))
        .filter((f) => f !== undefined);
    const folderLabel = (folder) => {
        const sysKey = SYSTEM_LABEL_KEY[folder.name];
        if (sysKey)
            return t(sysKey);
        return folder.displayName ?? folder.name;
    };
    const toggleExpand = (id) => {
        setCollapsedNodes((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
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
                label: t('mark_all_read'),
                icon: _jsx(CheckCheck, { size: 14 }),
                disabled: folder.unreadCount === 0,
                onClick: () => {
                    toast.promise(markAllRead.mutateAsync(folder.id), {
                        loading: '…',
                        success: t('mark_all_read'),
                        error: 'Fehler',
                    });
                },
            },
            { type: 'divider' },
            {
                label: folder.isFavorite ? t('remove_favorite') : t('add_favorite'),
                icon: _jsx(Star, { size: 14, className: folder.isFavorite ? 'fill-yellow-400 text-yellow-500' : '' }),
                onClick: () => patchFolder.mutate({ id: folder.id, body: { isFavorite: !folder.isFavorite } }),
            },
            {
                label: t('new_subfolder'),
                icon: _jsx(FolderPlus, { size: 14 }),
                onClick: () => setDialog({
                    kind: 'createChild',
                    parentId: folder.id,
                    parentLabel: folderLabel(folder),
                }),
            },
        ];
        if (!isSystem) {
            items.push({
                label: t('rename'),
                icon: _jsx(Pencil, { size: 14 }),
                onClick: () => setDialog({ kind: 'rename', folder }),
            }, {
                label: t('folder_color'),
                icon: _jsx(PaintBucket, { size: 14 }),
                children: [
                    { label: '—', icon: _jsx(Tag, { size: 14, className: "text-gray-300" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: null } }) },
                    { label: 'Blau', icon: _jsx(Tag, { size: 14, className: "text-blue-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#3B82F6' } }) },
                    { label: 'Grün', icon: _jsx(Tag, { size: 14, className: "text-green-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#10B981' } }) },
                    { label: 'Rot', icon: _jsx(Tag, { size: 14, className: "text-red-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#EF4444' } }) },
                    { label: 'Orange', icon: _jsx(Tag, { size: 14, className: "text-orange-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#F97316' } }) },
                    { label: 'Lila', icon: _jsx(Tag, { size: 14, className: "text-purple-500" }), onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#8B5CF6' } }) },
                ],
            }, {
                label: t('delete'),
                icon: _jsx(FolderMinus, { size: 14 }),
                danger: true,
                onClick: () => {
                    const total = folder.totalCount ?? 0;
                    const msg = total > 0
                        ? `Ordner „${folderLabel(folder)}" mit ${total} Nachricht(en) wirklich löschen?`
                        : `Ordner „${folderLabel(folder)}" löschen?`;
                    if (!window.confirm(msg))
                        return;
                    deleteFolder.mutate(folder.id);
                },
            });
        }
        if (isTrashOrJunk) {
            items.push({ type: 'divider' }, {
                label: t('empty_folder'),
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
    // Rekursives Rendering eines Ordnerbaums
    const renderFolderTree = (folder, indent, keyPrefix = '') => {
        const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
        const children = childrenOf.get(folder.id) ?? [];
        const hasChildren = children.length > 0;
        const expanded = !collapsedNodes.has(folder.id);
        return (_jsxs("div", { children: [_jsx(FolderItem, { folder: folder, selected: folder.id === selectedFolderId, isSystem: isSystem, hasChildren: hasChildren, expanded: expanded, onToggleExpand: () => toggleExpand(folder.id), onSelect: () => setSelectedFolder(folder.id), onContextMenu: handleContextMenu(folder), label: folderLabel(folder), indent: indent }), hasChildren && expanded && (_jsx("div", { children: children.map((c) => renderFolderTree(c, indent + 1, keyPrefix)) }))] }, `${keyPrefix}${folder.id}`));
    };
    const SectionHeader = ({ label, collapsed, onToggle, action }) => (_jsxs("div", { className: "flex items-center gap-1 mt-3 mb-1 px-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide", children: [_jsxs("button", { onClick: onToggle, className: "flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 flex-1", children: [collapsed ? _jsx(ChevronRight, { size: 12 }) : _jsx(ChevronDown, { size: 12 }), label] }), action] }));
    // Stelle sicher dass useT bei Sprachwechsel re-rendert
    void lang;
    return (_jsxs("aside", { className: "w-52 shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col h-full", children: [_jsx("div", { className: "p-3", children: _jsxs("button", { onClick: onNewMail, className: "btn-primary w-full justify-center", children: [_jsx(Plus, { size: 15 }), t('new_mail')] }) }), _jsxs("nav", { className: "flex-1 overflow-y-auto px-1 pb-3", children: [favorites.length > 0 && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { label: t('favorites'), collapsed: favoritesCollapsed, onToggle: toggleFavorites }), !favoritesCollapsed && (_jsx("div", { className: "space-y-0.5", children: favorites.map((f) => (_jsx(FolderItem, { folder: f, selected: f.id === selectedFolderId, isSystem: SYSTEM_SET.has(f.name), hasChildren: false, expanded: false, onToggleExpand: () => { }, onSelect: () => setSelectedFolder(f.id), onContextMenu: handleContextMenu(f), label: folderLabel(f), indent: 0 }, `fav-${f.id}`))) }))] })), _jsx(SectionHeader, { label: t('folders'), collapsed: folderTreeCollapsed, onToggle: toggleFolderTree, action: _jsx("button", { onClick: () => setDialog({ kind: 'createRoot' }), className: "text-gray-400 hover:text-gray-700 dark:hover:text-gray-200", title: "Neuer Ordner", children: _jsx(Plus, { size: 12 }) }) }), !folderTreeCollapsed && (_jsxs("div", { className: "space-y-0.5", children: [systemFolders.map((f) => renderFolderTree(f, 0)), rootCustomFolders.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mt-2 mb-0.5 px-3 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide", children: t('my_folders') }), rootCustomFolders.map((f) => renderFolderTree(f, 0, 'root-'))] }))] }))] }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) }), dialog?.kind === 'createRoot' && (_jsx(PromptDialog, { title: "Neuer Ordner", label: "Name", placeholder: "z. B. Wichtige Mails", confirmText: "Erstellen", onCancel: () => setDialog(null), validate: (v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null, onConfirm: async (name) => {
                    // Default: neue Ordner werden als Sub-Ordner des Posteingangs angelegt
                    const inbox = all.find((f) => f.name === 'INBOX');
                    await createFolder.mutateAsync({ name, parentId: inbox?.id ?? null });
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
