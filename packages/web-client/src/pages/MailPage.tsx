import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { Mail as MailIcon, Folder as FolderIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { BulkToolbar } from '../components/BulkToolbar.js';
import { useUiStore } from '../store/ui.js';
import { api } from '../api/client.js';
import type { Folder } from '../api/types.js';
import { showUndoToast } from '../components/UndoToast.js';
import { EmptyReader } from '../components/Skeleton.js';

interface ActiveDrag {
  kind: 'message' | 'folder-source';
  label: string;
  count?: number;
}

export function MailPage() {
  const qc = useQueryClient();
  const { selectedFolderId, selectedMessageId, selectedIds, setSelectedFolder, openCompose, clearSelection } = useUiStore();
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

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

  const reparentFolder = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      api.patch(`/mail/folders/${id}`, { parentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
    onError: (e: Error) => toast.error(e.message || 'Ordner konnte nicht verschoben werden'),
  });

  // 5px Bewegung nötig bevor Drag startet — sonst Klicks/Selektion kaputt
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Hilfsfunktion: prüft ob targetId Descendant von rootId ist (Cycle-Check beim Reparent)
  const isDescendant = (rootId: string, targetId: string, all: Folder[]): boolean => {
    const stack = [rootId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === targetId) return true;
      for (const f of all) {
        if (f.parentId === cur) stack.push(f.id);
      }
    }
    return false;
  };

  const handleDragStart = (e: DragStartEvent) => {
    const d = e.active.data?.current as { kind?: string; messageId?: string; folderId?: string; folderName?: string } | undefined;
    if (!d) return;
    if (d.kind === 'message' && d.messageId) {
      const count = selectedIds.has(d.messageId) ? selectedIds.size : 1;
      setActiveDrag({ kind: 'message', label: count === 1 ? '1 Nachricht' : `${count} Nachrichten`, count });
    } else if (d.kind === 'folder-source' && d.folderName) {
      setActiveDrag({ kind: 'folder-source', label: d.folderName });
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const overData = e.over?.data?.current as { kind?: string; folderId?: string } | undefined;
    const activeData = e.active.data?.current as { kind?: string; messageId?: string; folderId?: string } | undefined;
    if (!overData || overData.kind !== 'folder' || !overData.folderId) return;
    if (!activeData) return;

    // Folder auf Folder = Reparent
    if (activeData.kind === 'folder-source' && activeData.folderId) {
      const sourceId = activeData.folderId;
      const targetId = overData.folderId;
      if (sourceId === targetId) return;
      const allFolders = folders ?? [];
      // Aktueller Parent unverändert?
      const src = allFolders.find((f) => f.id === sourceId);
      if (src?.parentId === targetId) return;
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

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDrag(null)}>
      <div className="flex flex-1 overflow-hidden relative">
        <FolderTree onNewMail={() => openCompose()} />

        {selectedFolderId ? (
          <>
            <MessageList folderId={selectedFolderId} />
            {selectedIds.size > 0 && <BulkToolbar currentFolderId={selectedFolderId} />}
            {selectedMessageId && selectedIds.size === 0 ? (
              <div key={selectedMessageId} className="flex-1 animate-page-in flex flex-col overflow-hidden">
                <MessageReader messageId={selectedMessageId} />
              </div>
            ) : (
              <div className="flex-1 bg-gray-50 dark:bg-gray-900 flex">
                {selectedIds.size > 0
                  ? <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">{selectedIds.size} Nachrichten ausgewählt</div>
                  : <EmptyReader />}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Ordner auswählen
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
        {activeDrag ? (
          <div className="bg-white dark:bg-gray-800 border-2 border-accent shadow-2xl rounded-md px-3 py-2 flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100 cursor-grabbing">
            {activeDrag.kind === 'message'
              ? <MailIcon size={14} className="text-accent" />
              : <FolderIcon size={14} className="text-accent" />}
            <span>{activeDrag.label}</span>
            {activeDrag.kind === 'message' && (activeDrag.count ?? 0) > 1 && (
              <span className="ml-1 bg-accent text-white text-xs px-1.5 py-0.5 rounded-full">{activeDrag.count}</span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
