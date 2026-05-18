import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Archive, Trash2, Mail, MailOpen, Flag, FolderInput, AlertOctagon, X, Pin,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import { AnimatedCounter } from './AnimatedCounter.js';
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

  // BulkToolbar liegt absolut über der MessageList (FolderTree-Breite 208 px = left-52)
  // und endet bei der MessageList-Breite (320 px + 208 = 528 px = w-[20rem] + left-52).
  // Damit überdeckt die Bar nur die Filter-Tab-Zeile der MessageList, nicht den Reader.

  const IconBtn = ({
    icon, onClick, title,
  }: {
    icon: React.ReactNode; onClick: () => void; title: string;
  }) => (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-sm text-gray-600 dark:text-gray-300 hover:bg-accent/10 hover:text-accent transition-all duration-150 active:scale-90"
    >
      {icon}
    </button>
  );

  return (
    <div
      className="absolute top-0 left-52 w-80 z-20 bg-white dark:bg-gray-800 border-b-2 border-accent flex items-center gap-1 px-2 py-1.5 shadow-sm animate-slide-down"
    >
      <button
        onClick={clearSelection}
        className="p-1 rounded text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-150 active:scale-90"
        title="Auswahl aufheben"
      >
        <X size={16} />
      </button>
      <span className="text-xs font-semibold text-accent">
        <AnimatedCounter value={count} /> ausgewählt
      </span>

      <div className="flex-1" />

      <IconBtn
        icon={<Archive size={15} />}
        title="Archivieren"
        onClick={() => run('archive', { undoMsg: `${count} archiviert`, undoFolderId: currentFolderId })}
      />
      <IconBtn
        icon={<Trash2 size={15} />}
        title="Löschen"
        onClick={() => run('delete', { undoMsg: `${count} gelöscht`, undoFolderId: currentFolderId })}
      />
      <IconBtn
        icon={<FolderInput size={15} />}
        title="Verschieben"
        onClick={() => {
          /* Sub-Menü öffnen via DOM-Anker — Trick: dummy-Button-Ref */
          setMoveMenu({ x: 0, y: 0 });
        }}
      />
      <IconBtn icon={<MailOpen size={15} />} title="Als gelesen markieren"   onClick={() => run('read')} />
      <IconBtn icon={<Mail size={15} />}     title="Als ungelesen markieren" onClick={() => run('unread')} />
      <IconBtn icon={<Flag size={15} />}     title="Kennzeichnen"            onClick={() => run('flag')} />
      <IconBtn icon={<Pin size={15} />}      title="Anheften"                onClick={() => run('pin')} />
      <IconBtn icon={<AlertOctagon size={15} />} title="Als Junk markieren"  onClick={() => run('spam')} />

      {/* unsichtbarer Anchor für das Verschieben-Menü (Position direkt unter der Bar) */}
      {moveMenu && (
        <MoveMenu
          items={moveItems}
          onClose={() => setMoveMenu(null)}
        />
      )}

    </div>
  );
}

// Kleiner Wrapper, der das ContextMenu positionsrelativ zum Toolbar-Container öffnet
function MoveMenu({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  // Ankerpunkt: rechts unten unterhalb der Toolbar (in der Nähe des Verschieben-Buttons)
  // Wir berechnen das einfach relativ zum Viewport, da BulkToolbar fix sitzt.
  // Die Toolbar ist links-52 (208 px), w-80 (320 px), Höhe ~36 px.
  return (
    <ContextMenu
      x={208 + 320 - 220}
      y={42}
      items={items}
      onClose={onClose}
    />
  );
}
