import { useEffect, useState, useRef, useCallback } from 'react';
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
import { MailCommandBar } from '../components/MailCommandBar.js';
import { PageShell } from '../components/PageShell.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { api } from '../api/client.js';
import type { Folder } from '../api/types.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { EmptyReader } from '../components/Skeleton.js';
import { useActiveMailbox, ACCESSIBLE_MAILBOXES_KEY } from '../hooks/useActiveMailbox.js';
import { useMailDeepLink } from '../hooks/useMailDeepLink.js';
import {
  mailApiBase, foldersQueryKey, parseMailboxKey, isReadOnlyMailbox, READ_ONLY_HINT,
  type AccessibleMailboxEntry,
} from '../lib/mailboxContext.js';
import { MAIL_VIEW_ROOT_CLASS } from '../lib/mailLayout.js';

// ── Persistent panel widths ───────────────────────────────────────────────────
const PANEL_STORAGE_KEY = 'coremail:panel-widths';
const DEFAULT_FOLDER_W  = 208; // w-52
const DEFAULT_LIST_W    = 320; // w-80
const MIN_FOLDER_W      = 140;
const MAX_FOLDER_W      = 360;
const MIN_LIST_W        = 220;
const MAX_LIST_W        = 520;

function loadPanelWidths(): { folderW: number; listW: number } {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as { folderW: number; listW: number };
  } catch { /* ignore */ }
  return { folderW: DEFAULT_FOLDER_W, listW: DEFAULT_LIST_W };
}

// ── Resize-Handle ─────────────────────────────────────────────────────────────
function ResizeHandle({
  onResize,
}: {
  onResize: (delta: number) => void;
}) {
  const dragging = useRef(false);
  const startX   = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current   = e.clientX;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      startX.current = ev.clientX;
      onResize(delta);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 active:bg-accent/50 transition-colors group relative z-10"
      title="Breite anpassen"
    >
      <div className="absolute inset-y-0 -left-0.5 -right-0.5 group-hover:bg-accent/20 rounded transition-colors" />
    </div>
  );
}

interface ActiveDrag {
  kind: 'message' | 'folder-source';
  label: string;
  count?: number;
}

export function MailPage() {
  const qc = useQueryClient();
  const { selectedFolderId, selectedMessageId, selectedIds, setSelectedFolder, clearSelection } = useUiStore();
  const mailbox = useActiveMailbox();
  const { readingPane } = useUiPrefs();
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  // ── Panel widths (resizable) ─────────────────────────────────────────────────
  const [folderW, setFolderW] = useState(() => loadPanelWidths().folderW);
  const [listW,   setListW]   = useState(() => loadPanelWidths().listW);

  // Persist widths on change (debounced via ref)
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ folderW, listW }));
    }, 300);
  }, [folderW, listW]);

  const resizeFolder = useCallback((delta: number) => {
    setFolderW((w) => Math.max(MIN_FOLDER_W, Math.min(MAX_FOLDER_W, w + delta)));
  }, []);

  const resizeList = useCallback((delta: number) => {
    setListW((w) => Math.max(MIN_LIST_W, Math.min(MAX_LIST_W, w + delta)));
  }, []);

  // 9.4: the URL holds mailbox / folder / message (/mail/<mailbox>/<folderId>/<messageId>)
  useMailDeepLink();

  const { data: folders } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });

  // Auto-select INBOX on first load / after switching the mailbox. Reads the store:
  // a deep link (useMailDeepLink, same commit) may just have selected a folder.
  useEffect(() => {
    if (!useUiStore.getState().selectedFolderId && folders?.length) {
      const inbox = folders.find((f) => f.name === 'INBOX');
      if (inbox) setSelectedFolder(inbox.id, 'tree', useUiStore.getState().activeMailbox);
    }
  }, [folders, selectedFolderId, setSelectedFolder]);

  const { runWithUndo, locateIds } = useMailActions();

  const reparentFolder = useMutation({
    mutationFn: ({ id, parentId, mailboxKey: key }: { id: string; parentId: string | null; mailboxKey: string }) =>
      api.patch(`${mailApiBase(parseMailboxKey(key))}/folders/${id}`, { parentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
    onError: (e: Error) => toast.error(e.message || 'Ordner konnte nicht verschoben werden'),
  });

  // 5px movement required before drag starts — otherwise clicks/selection break
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Helper: checks whether targetId is a descendant of rootId (cycle check on reparent)
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
    const overData = e.over?.data?.current as { kind?: string; folderId?: string; mailbox?: string } | undefined;
    const activeData = e.active.data?.current as { kind?: string; messageId?: string; folderId?: string; mailbox?: string } | undefined;
    if (!overData || overData.kind !== 'folder' || !overData.folderId) return;
    if (!activeData) return;
    // 9.3: messages / folders move only inside their own mailbox, and only with write access
    const sourceKey = activeData.kind === 'message' ? mailbox.key : (activeData.mailbox ?? 'own');
    const targetKey = overData.mailbox ?? 'own';
    if (sourceKey !== targetKey) {
      toast.error('Verschieben ist nur innerhalb desselben Postfachs möglich');
      return;
    }
    if (isReadOnlyMailbox(parseMailboxKey(targetKey), qc.getQueryData<AccessibleMailboxEntry[]>(ACCESSIBLE_MAILBOXES_KEY))) {
      toast.error(READ_ONLY_HINT);
      return;
    }

    // Folder onto folder = reparent
    if (activeData.kind === 'folder-source' && activeData.folderId) {
      const sourceId = activeData.folderId;
      const targetId = overData.folderId;
      if (sourceId === targetId) return;
      const allFolders = qc.getQueryData<Folder[]>(foldersQueryKey(parseMailboxKey(targetKey))) ?? [];
      // Current parent unchanged?
      const src = allFolders.find((f) => f.id === sourceId);
      if (src?.parentId === targetId) return;
      if (isDescendant(sourceId, targetId, allFolders)) {
        toast.error('Ordner kann nicht in seinen eigenen Unterordner verschoben werden');
        return;
      }
      reparentFolder.mutate({ id: sourceId, parentId: targetId, mailboxKey: targetKey });
      return;
    }

    // Mail onto folder = move
    if (activeData.kind === 'message' && activeData.messageId) {
      const draggedId = activeData.messageId;
      const ids = selectedIds.has(draggedId) ? Array.from(selectedIds) : [draggedId];
      // Undo (8 s, also `z`) moves each mail back to the folder it came from
      void runWithUndo('move', locateIds(ids, selectedFolderId ?? ''), overData.folderId);
      clearSelection();
    }
  };

  // ── Reader-Panel ─────────────────────────────────────────────────────────────
  const readerPanel = selectedMessageId && selectedIds.size === 0 ? (
    <div key={selectedMessageId} className="flex-1 animate-page-in flex flex-col overflow-hidden min-w-0 min-h-0">
      <MessageReader messageId={selectedMessageId} />
    </div>
  ) : (
    <div className="flex-1 bg-surface-2 flex min-w-0 min-h-0">
      {selectedIds.size > 0
        ? <div className="flex-1 flex items-center justify-center text-fg-subtle text-sm">{selectedIds.size} Nachrichten ausgewählt</div>
        : readingPane !== 'off' ? <EmptyReader /> : null}
    </div>
  );

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDrag(null)}>
      <PageShell title="Mail" commandBar={<MailCommandBar />}>
        <div className={MAIL_VIEW_ROOT_CLASS}>

          {/* ── Folder tree ─────────────────────────────────────────────────── */}
          <div style={{ width: folderW, flexShrink: 0 }} className="h-full">
            <FolderTree />
          </div>

          <ResizeHandle onResize={resizeFolder} />

          {/* ── Message list + reader ────────────────────────────────────────── */}
          {selectedFolderId ? (
            readingPane === 'bottom' ? (
              /* Reading pane at the bottom: list on top, reader below */
              <div className="flex flex-col flex-1 overflow-hidden min-w-0">
                <div style={{ width: '100%', height: '50%', flexShrink: 0 }} className="overflow-hidden relative">
                  <MessageList folderId={selectedFolderId} />
                </div>
                <div className="h-px bg-line shrink-0 cursor-row-resize" />
                {readerPanel}
              </div>
            ) : (
              /* Reading pane on the right (default) or off */
              <>
                <div style={{ width: listW, flexShrink: 0 }} className="h-full overflow-hidden relative">
                  <MessageList folderId={selectedFolderId} />
                </div>
                {readingPane !== 'off' && (
                  <>
                    <ResizeHandle onResize={resizeList} />
                    {readerPanel}
                  </>
                )}
              </>
            )
          ) : (
            <div className="flex-1 flex items-center justify-center text-fg-subtle text-sm">
              Ordner auswählen
            </div>
          )}
        </div>
      </PageShell>

      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
        {activeDrag ? (
          <div className="bg-surface border-2 border-accent-fg shadow-2xl rounded-md px-3 py-2 flex items-center gap-2 text-sm font-medium text-fg cursor-grabbing">
            {activeDrag.kind === 'message'
              ? <MailIcon size={14} className="text-accent-fg" />
              : <FolderIcon size={14} className="text-accent-fg" />}
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
