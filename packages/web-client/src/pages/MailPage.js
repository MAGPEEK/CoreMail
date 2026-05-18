import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import toast from 'react-hot-toast';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { BulkToolbar } from '../components/BulkToolbar.js';
import { useUiStore } from '../store/ui.js';
import { api } from '../api/client.js';
import { showUndoToast } from '../components/UndoToast.js';
export function MailPage() {
    const qc = useQueryClient();
    const { selectedFolderId, selectedMessageId, selectedIds, setSelectedFolder, openCompose, clearSelection } = useUiStore();
    const { data: folders } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
    });
    // Auto-select INBOX on first load
    useEffect(() => {
        if (!selectedFolderId && folders?.length) {
            const inbox = folders.find((f) => f.name === 'INBOX');
            if (inbox)
                setSelectedFolder(inbox.id);
        }
    }, [folders, selectedFolderId, setSelectedFolder]);
    const bulkMutation = useMutation({
        mutationFn: (body) => api.post('/mail/messages/bulk', body),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['messages'] });
            qc.invalidateQueries({ queryKey: ['folders'] });
        },
    });
    const reparentFolder = useMutation({
        mutationFn: ({ id, parentId }) => api.patch(`/mail/folders/${id}`, { parentId }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
        onError: (e) => toast.error(e.message || 'Ordner konnte nicht verschoben werden'),
    });
    // 5px Bewegung nötig bevor Drag startet — sonst Klicks/Selektion kaputt
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    // Hilfsfunktion: prüft ob targetId Descendant von rootId ist (Cycle-Check beim Reparent)
    const isDescendant = (rootId, targetId, all) => {
        const stack = [rootId];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === targetId)
                return true;
            for (const f of all) {
                if (f.parentId === cur)
                    stack.push(f.id);
            }
        }
        return false;
    };
    const handleDragEnd = (e) => {
        const overData = e.over?.data?.current;
        const activeData = e.active.data?.current;
        if (!overData || overData.kind !== 'folder' || !overData.folderId)
            return;
        if (!activeData)
            return;
        // Folder auf Folder = Reparent
        if (activeData.kind === 'folder-source' && activeData.folderId) {
            const sourceId = activeData.folderId;
            const targetId = overData.folderId;
            if (sourceId === targetId)
                return;
            const allFolders = folders ?? [];
            // Aktueller Parent unverändert?
            const src = allFolders.find((f) => f.id === sourceId);
            if (src?.parentId === targetId)
                return;
            if (isDescendant(sourceId, targetId, allFolders)) {
                toast.error('Ordner kann nicht in seinen eigenen Unterordner verschoben werden');
                return;
            }
            reparentFolder.mutate({ id: sourceId, parentId: targetId });
            return;
        }
        // Mail auf Folder = Move
        if (activeData.kind === 'message' && activeData.messageId) {
            const draggedId = activeData.messageId;
            const ids = selectedIds.has(draggedId) ? Array.from(selectedIds) : [draggedId];
            const sourceFolderId = selectedFolderId;
            bulkMutation.mutate({ ids, action: 'move', folderId: overData.folderId });
            if (sourceFolderId) {
                showUndoToast({
                    message: ids.length === 1 ? 'Nachricht verschoben' : `${ids.length} Nachrichten verschoben`,
                    onUndo: () => bulkMutation.mutateAsync({ ids, action: 'move', folderId: sourceFolderId }),
                });
            }
            clearSelection();
        }
    };
    return (_jsx(DndContext, { sensors: sensors, onDragEnd: handleDragEnd, children: _jsxs("div", { className: "flex flex-1 overflow-hidden relative", children: [_jsx(FolderTree, { onNewMail: () => openCompose() }), selectedFolderId ? (_jsxs(_Fragment, { children: [_jsx(MessageList, { folderId: selectedFolderId }), selectedIds.size > 0 && _jsx(BulkToolbar, { currentFolderId: selectedFolderId }), selectedMessageId && selectedIds.size === 0 ? (_jsx(MessageReader, { messageId: selectedMessageId })) : (_jsx("div", { className: "flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900 text-gray-400 text-sm", children: selectedIds.size > 0 ? `${selectedIds.size} Nachrichten ausgewählt` : 'Nachricht auswählen' }))] })) : (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Ordner ausw\u00E4hlen" }))] }) }));
}
