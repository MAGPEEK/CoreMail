import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { BulkToolbar } from '../components/BulkToolbar.js';
import { useUiStore } from '../store/ui.js';
import { api } from '../api/client.js';
import type { Folder } from '../api/types.js';
import { showUndoToast } from '../components/UndoToast.js';

export function MailPage() {
  const qc = useQueryClient();
  const { selectedFolderId, selectedMessageId, selectedIds, setSelectedFolder, openCompose, clearSelection } = useUiStore();

  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  // Auto-select INBOX on first load
  useEffect(() => {
    if (!selectedFolderId && folders?.length) {
      const inbox = folders.find((f) => f.name === 'INBOX');
      if (inbox) setSelectedFolder(inbox.id);
    }
  }, [folders, selectedFolderId, setSelectedFolder]);

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
    },
  });

  // 5px Bewegung nötig bevor Drag startet — sonst Klicks/Selektion kaputt
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (e: DragEndEvent) => {
    const overData = e.over?.data?.current as { kind?: string; folderId?: string } | undefined;
    const activeData = e.active.data?.current as { kind?: string; messageId?: string } | undefined;
    if (!overData || overData.kind !== 'folder' || !overData.folderId) return;
    if (!activeData || activeData.kind !== 'message') return;

    // Wenn die gedraggte Mail Teil der Selektion ist, alle ausgewählten mitbewegen
    const draggedId = activeData.messageId!;
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

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex flex-1 overflow-hidden relative">
        <FolderTree onNewMail={() => openCompose()} />

        {selectedFolderId ? (
          <>
            <MessageList folderId={selectedFolderId} />
            {selectedIds.size > 0 && <BulkToolbar currentFolderId={selectedFolderId} />}
            {selectedMessageId && selectedIds.size === 0 ? (
              <MessageReader messageId={selectedMessageId} />
            ) : (
              <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900 text-gray-400 text-sm">
                {selectedIds.size > 0 ? `${selectedIds.size} Nachrichten ausgewählt` : 'Nachricht auswählen'}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Ordner auswählen
          </div>
        )}
      </div>
    </DndContext>
  );
}
