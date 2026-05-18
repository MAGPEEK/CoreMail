import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Archive, Trash2, Mail, MailOpen, Flag, FolderInput, AlertOctagon, X, Pin,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import type { Folder } from '../api/types.js';

export function BulkToolbar({ currentFolderId }: { currentFolderId: string }) {
  const qc = useQueryClient();
  const { selectedIds, clearSelection, setSelectedMessage } = useUiStore();
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null);

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  const count = selectedIds.size;
  const ids = Array.from(selectedIds);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
  };

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSuccess: () => { invalidate(); },
  });

  if (count === 0) return null;

  const run = (action: string, opts?: { folderId?: string; undoMsg?: string; undoFolderId?: string }) => {
    const body = opts?.folderId
      ? { ids, action, folderId: opts.folderId }
      : { ids, action };
    bulkMutation.mutate(body);
    if (opts?.undoMsg && opts.undoFolderId) {
      showUndoToast({
        message: opts.undoMsg,
        onUndo: () => bulkMutation.mutateAsync({ ids, action: 'move', folderId: opts.undoFolderId! }),
      });
    }
    setSelectedMessage(null);
    clearSelection();
  };

  const moveItems: ContextMenuItem[] = folders
    .filter((f) => f.id !== currentFolderId)
    .map((f) => ({
      label: f.displayName ?? f.name,
      icon: <FolderInput size={14} style={f.color ? { color: f.color } : undefined} />,
      onClick: () => run('move', { folderId: f.id }),
    }));

  return (
    <div className="absolute top-0 left-80 right-0 z-20 bg-accent text-white border-b border-accent/50 flex items-center gap-1 px-3 py-2 shadow-md">
      <button onClick={clearSelection} className="p-1 hover:bg-white/10 rounded" title="Auswahl aufheben">
        <X size={16} />
      </button>
      <span className="text-sm font-medium ml-1">{count} ausgewählt</span>
      <div className="flex-1" />

      <button onClick={() => run('archive', { undoMsg: `${count} archiviert`, undoFolderId: currentFolderId })}
        className="px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm" title="Archivieren">
        <Archive size={14} /> Archivieren
      </button>
      <button onClick={() => run('delete', { undoMsg: `${count} gelöscht`, undoFolderId: currentFolderId })}
        className="px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm" title="Löschen">
        <Trash2 size={14} /> Löschen
      </button>
      <button onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMoveMenu({ x: r.left, y: r.bottom }); }}
        className="px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm" title="Verschieben">
        <FolderInput size={14} /> Verschieben
      </button>
      <button onClick={() => run('read')}
        className="p-1.5 hover:bg-white/10 rounded" title="Als gelesen markieren">
        <MailOpen size={14} />
      </button>
      <button onClick={() => run('unread')}
        className="p-1.5 hover:bg-white/10 rounded" title="Als ungelesen markieren">
        <Mail size={14} />
      </button>
      <button onClick={() => run('flag')}
        className="p-1.5 hover:bg-white/10 rounded" title="Kennzeichnen">
        <Flag size={14} />
      </button>
      <button onClick={() => run('pin')}
        className="p-1.5 hover:bg-white/10 rounded" title="Anheften">
        <Pin size={14} />
      </button>
      <button onClick={() => run('spam')}
        className="p-1.5 hover:bg-white/10 rounded" title="Als Junk markieren">
        <AlertOctagon size={14} />
      </button>

      {moveMenu && (
        <ContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          items={moveItems}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  );
}
