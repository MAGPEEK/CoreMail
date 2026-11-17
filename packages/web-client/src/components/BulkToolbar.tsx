import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Archive, Trash2, Mail, MailOpen, Flag, FolderInput, AlertOctagon, X, Pin,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import type { Folder } from '../api/types.js';
import { useActiveMailbox } from '../hooks/useActiveMailbox.js';
import { READ_ONLY_HINT } from '../lib/mailboxContext.js';

// Module-level (never define components inside components — remounts on every render)
function IconBtn({ icon, onClick, title, disabled = false }: { icon: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? READ_ONLY_HINT : title}
      aria-label={title}
      className="p-1.5 rounded-sm text-fg-muted hover:bg-accent/10 hover:text-accent-fg transition-all duration-150 active:scale-90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      {icon}
    </button>
  );
}
export function BulkToolbar({ currentFolderId }: { currentFolderId: string }) {
  const qc = useQueryClient();
  const { selectedIds, clearSelection, setSelectedMessage } = useUiStore();
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null);
  const { runWithUndo, locateIds } = useMailActions();
  // 9.3: own, shared or delegated mailbox (read-only → every action disabled)
  const { base, foldersKey, readOnly } = useActiveMailbox();

  const { data: folders = [] } = useQuery({
    queryKey: foldersKey,
    queryFn: () => api.get<Folder[]>(`${base}/folders`),
  });

  const count = selectedIds.size;
  const ids = Array.from(selectedIds);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
  };

  // Errors are reported by the global MutationCache handler (main.tsx)
  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post(`${base}/messages/bulk`, body),
    onSettled: () => { invalidate(); },
  });

  if (count === 0) return null;

  const run = (action: string) => {
    if (readOnly) return;
    bulkMutation.mutate({ ids, action });
    setSelectedMessage(null);
    clearSelection();
  };

  /**
   * Delete / archive / junk / move: undo toast (8 s, also `z`) once the server
   * confirmed — every message goes back to the folder it came from (bulk
   * selections from a mailbox-wide search can span several folders).
   */
  const runUndoable = (action: 'delete' | 'archive' | 'spam' | 'move', folderId?: string) => {
    const items = locateIds(ids, currentFolderId);
    void runWithUndo(action, items, folderId).then((done) => {
      if (!done) return;
      setSelectedMessage(null);
      clearSelection();
    });
  };

  const moveItems: ContextMenuItem[] = folders
    .filter((f) => f.id !== currentFolderId)
    .map((f) => ({
      label: f.displayName ?? f.name,
      icon: <FolderInput size={14} style={f.color ? { color: f.color } : undefined} />,
      onClick: () => runUndoable('move', f.id),
    }));

  // BulkToolbar is positioned absolutely over the MessageList (FolderTree width 208 px = left-52)
  // and ends at the MessageList width (320 px + 208 = 528 px = w-[20rem] + left-52).
  // This way the bar only covers the filter tab row of the MessageList, not the reader.

  return (
    <div
      className="absolute top-0 left-52 w-80 z-20 bg-surface border-b-2 border-accent-fg flex items-center gap-1 px-2 py-1.5 shadow-sm animate-slide-down"
    >
      <button aria-label="Auswahl aufheben"
        onClick={clearSelection}
        className="p-1 rounded text-fg-subtle hover:bg-surface-2 transition-all duration-150 active:scale-90"
        title="Auswahl aufheben"
      >
        <X size={16} />
      </button>
      <span className="text-xs font-semibold text-accent-fg">
        <AnimatedCounter value={count} /> ausgewählt
      </span>

      <div className="flex-1" />

      <IconBtn
        icon={<Archive size={15} />}
        title="Archivieren"
        disabled={readOnly}
        onClick={() => runUndoable('archive')}
      />
      <IconBtn
        icon={<Trash2 size={15} />}
        title="Löschen"
        disabled={readOnly}
        onClick={() => runUndoable('delete')}
      />
      <IconBtn
        icon={<FolderInput size={15} />}
        title="Verschieben"
        disabled={readOnly}
        onClick={() => {
          /* Open submenu via DOM anchor — trick: dummy button ref */
          setMoveMenu({ x: 0, y: 0 });
        }}
      />
      <IconBtn icon={<MailOpen size={15} />} title="Als gelesen markieren"   disabled={readOnly} onClick={() => run('read')} />
      <IconBtn icon={<Mail size={15} />}     title="Als ungelesen markieren" disabled={readOnly} onClick={() => run('unread')} />
      <IconBtn icon={<Flag size={15} />}     title="Kennzeichnen"            disabled={readOnly} onClick={() => run('flag')} />
      <IconBtn icon={<Pin size={15} />}      title="Anheften"                disabled={readOnly} onClick={() => run('pin')} />
      <IconBtn icon={<AlertOctagon size={15} />} title="Als Junk markieren"  disabled={readOnly} onClick={() => runUndoable('spam')} />

      {/* invisible anchor for the move menu (positioned directly below the bar) */}
      {moveMenu && (
        <MoveMenu
          items={moveItems}
          onClose={() => setMoveMenu(null)}
        />
      )}

    </div>
  );
}

// Small wrapper that opens the ContextMenu relative to the toolbar container
function MoveMenu({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  // Anchor point: bottom right below the toolbar (near the move button)
  // We simply compute this relative to the viewport since BulkToolbar is fixed.
  // The toolbar is left-52 (208 px), w-80 (320 px), height ~36 px.
  return (
    <ContextMenu
      x={208 + 320 - 220}
      y={42}
      items={items}
      onClose={onClose}
    />
  );
}
