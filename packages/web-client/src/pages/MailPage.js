import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
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
    // 5px Bewegung nötig bevor Drag startet — sonst Klicks/Selektion kaputt
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
    const handleDragEnd = (e) => {
        const overData = e.over?.data?.current;
        const activeData = e.active.data?.current;
        if (!overData || overData.kind !== 'folder' || !overData.folderId)
            return;
        if (!activeData || activeData.kind !== 'message')
            return;
        // Wenn die gedraggte Mail Teil der Selektion ist, alle ausgewählten mitbewegen
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
    };
    return (_jsx(DndContext, { sensors: sensors, onDragEnd: handleDragEnd, children: _jsxs("div", { className: "flex flex-1 overflow-hidden relative", children: [_jsx(FolderTree, { onNewMail: () => openCompose() }), selectedFolderId ? (_jsxs(_Fragment, { children: [_jsx(MessageList, { folderId: selectedFolderId }), selectedIds.size > 0 && _jsx(BulkToolbar, { currentFolderId: selectedFolderId }), selectedMessageId && selectedIds.size === 0 ? (_jsx(MessageReader, { messageId: selectedMessageId })) : (_jsx("div", { className: "flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900 text-gray-400 text-sm", children: selectedIds.size > 0 ? `${selectedIds.size} Nachrichten ausgewählt` : 'Nachricht auswählen' }))] })) : (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Ordner ausw\u00E4hlen" }))] }) }));
}
