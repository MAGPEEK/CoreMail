import { useEffect, useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { Mail as MailIcon, Folder as FolderIcon, ChevronLeft, PanelLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { MailRibbon } from '../components/MailRibbon.js';
import { PageShell } from '../components/PageShell.js';
import { ComposePane } from '../components/compose/ComposePane.js';
import { DraftTabStrip } from '../components/compose/DraftTabStrip.js';
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
import { MAIL_VIEW_COLUMN_CLASS, MAIL_VIEW_ROOT_CLASS } from '../lib/mailLayout.js';
import { FOLDER_PANE_CLASS, PANE_CARD_CLASS } from '../lib/paneLayout.js';
import { defaultFolderOf } from '../lib/folderTree.js';
import { backTarget, visibleMailPanes } from '../lib/layoutMode.js';
import { useLayoutMode } from '../hooks/useLayoutMode.js';

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
    // 10.1: the handle is the 8 px gap between two cards; a thin bar shows on hover / drag
    <div
      onMouseDown={onMouseDown}
      className="w-2 shrink-0 cursor-col-resize bg-transparent group relative z-10 flex justify-center"
      title="Breite anpassen"
    >
      <div className="w-1 h-full rounded-full bg-transparent group-hover:bg-accent/30 group-active:bg-accent/50 transition-colors" />
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
  const { selectedFolderId, selectedMessageId, selectedIds, setSelectedFolder, setSelectedMessage, clearSelection } = useUiStore();
  const mode = useLayoutMode();
  const [foldersShown, setFoldersShown] = useState(false);
  const mailbox = useActiveMailbox();
  const { readingPane } = useUiPrefs();
  const composeKey = useUiStore((s) => s.compose.activeKey);
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

  // 9.4: the URL holds mailbox / folder / message (/mail/<mailbox>/<folderId>/<messageId>);
  // a notification click (/mail?folder=…&message=…) is turned into that form
  useMailDeepLink();

  const { data: folders } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${mailbox.base}/folders`),
  });

  // Auto-select INBOX on first load / after switching the mailbox. Reads the store:
  // a deep link (useMailDeepLink, same commit) may just have selected a folder.
  // w3: a folder-scoped mailbox may show INBOX only as a path entry (lib/folderTree.ts).
  useEffect(() => {
    if (!useUiStore.getState().selectedFolderId && folders?.length) {
      const first = defaultFolderOf(folders);
      if (first) setSelectedFolder(first.id, 'tree', useUiStore.getState().activeMailbox);
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

  // ── Reader-Panel (9.4: or the compose area of the shown draft) ────────────────
  const composePanel = composeKey ? <ComposePane key={composeKey} tabKey={composeKey} variant="inline" /> : null;
  // 10.1: the reading pane is a card of the floating layout (the compose card is its own)
  const readerPanel = composePanel ?? (selectedMessageId && selectedIds.size === 0 ? (
    <div key={selectedMessageId} className={`flex-1 animate-page-in flex flex-col min-w-0 min-h-0 ${PANE_CARD_CLASS}`}>
      <MessageReader messageId={selectedMessageId} />
    </div>
  ) : (
    <div className={`flex-1 flex min-w-0 min-h-0 ${PANE_CARD_CLASS}`}>
      {selectedIds.size > 0
        ? <div className="flex-1 flex items-center justify-center text-fg-subtle text-sm">{selectedIds.size} Nachrichten ausgewählt</div>
        : readingPane !== 'off' ? <EmptyReader /> : null}
    </div>
  ));

  // ── 9.5: single / two pane layout below 1100 px ──────────────────────────────
  const hasMessage = !!selectedMessageId && selectedIds.size === 0;
  const panes = visibleMailPanes({
    mode, hasFolder: !!selectedFolderId, hasMessage, composeOpen: !!composeKey, foldersShown, readingPane,
  });
  const pane = panes[0] ?? 'list';
  const narrowReaderRef = useRef<HTMLDivElement>(null);
  const lastOpenedRef = useRef<string | null>(null);
  if (selectedMessageId) lastOpenedRef.current = selectedMessageId;

  // A chosen folder leads on to its message list
  useEffect(() => { setFoldersShown(false); }, [selectedFolderId]);
  // Leaving the narrow layouts resets the drawer / folder step
  useEffect(() => { if (mode === 'three') setFoldersShown(false); }, [mode]);

  // Focus follows the single-pane step: into the opened message, back onto its row in the list
  const previousPane = useRef(pane);
  useEffect(() => {
    const from = previousPane.current;
    previousPane.current = pane;
    if (mode !== 'single' || from === pane) return;
    if (pane === 'reader') {
      // the message loads after this step: the reader region takes focus, its subject follows in reading order
      narrowReaderRef.current?.focus();
    } else if (pane === 'list' && from === 'reader' && lastOpenedRef.current) {
      document.getElementById(`msg-row-${lastOpenedRef.current}`)?.focus();
    }
  }, [pane, mode]);

  // Two panes: the folder drawer takes focus when it opens and gives it back to its button
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (mode !== 'two') return;
    if (foldersShown) {
      document.querySelector<HTMLElement>('#mail-folder-drawer [role="treeitem"][tabindex="0"]')?.focus();
    } else if (drawerWasOpen.current) {
      document.getElementById('mail-folder-toggle')?.focus();
    }
    drawerWasOpen.current = foldersShown;
  }, [foldersShown, mode]);

  const goBack = () => {
    if (pane === 'reader') { setSelectedMessage(null); clearSelection(); }
    else if (pane === 'list') setFoldersShown(true);
  };
  const backLabel = pane === 'reader' ? 'Zurück zur Nachrichtenliste' : 'Zurück zu den Ordnern';
  const showFolderDrawerButton = mode === 'two';
  const showBackButton = mode === 'single' && backTarget(pane) !== null;

  const narrowBar = (showBackButton || showFolderDrawerButton) ? (
    <div className={`shrink-0 flex items-center gap-2 px-2 py-1 max-md:border-b ${PANE_CARD_CLASS} coremail-no-print`}>
      {showBackButton ? (
        <button type="button" onClick={goBack} aria-label={backLabel}
          className="inline-flex items-center gap-1 min-h-[2rem] pr-3 pl-1 rounded text-sm font-medium text-accent-fg hover:bg-surface-2">
          <ChevronLeft size={18} aria-hidden="true" />
          {pane === 'reader' ? 'Nachrichten' : 'Ordner'}
        </button>
      ) : (
        <button type="button" id="mail-folder-toggle" onClick={() => setFoldersShown((v) => !v)} aria-expanded={foldersShown}
          aria-controls="mail-folder-drawer"
          className="inline-flex items-center gap-1.5 min-h-[2rem] px-2 rounded text-sm font-medium text-accent-fg hover:bg-surface-2">
          <PanelLeft size={16} aria-hidden="true" />
          Ordner
        </button>
      )}
    </div>
  ) : null;

  // Choosing a folder (also the one already open) leads on to its message list
  const pickProps = {
    onClickCapture: (e: React.MouseEvent) => {
      const target = e.target as Element;
      // the expand arrow of a folder only opens its subfolders
      if (target.closest('[role="treeitem"]') && !target.closest('[data-folder-toggle]')) setFoldersShown(false);
    },
    onKeyDownCapture: (e: React.KeyboardEvent) => {
      const onItem = (e.target as Element).getAttribute('role') === 'treeitem';
      if (onItem && (e.key === 'Enter' || e.key === ' ')) setFoldersShown(false);
    },
  };

  const narrowBody = (
    <>
      {pane === 'folders' && <div {...pickProps} className={`flex-1 min-w-0 h-full ${FOLDER_PANE_CLASS}`}><FolderTree /></div>}
      {pane === 'list' && selectedFolderId && mode === 'single' && (
        <div className={`flex-1 min-w-0 h-full relative ${PANE_CARD_CLASS}`}><MessageList folderId={selectedFolderId} /></div>
      )}
      {pane === 'reader' && mode === 'single' && <div ref={narrowReaderRef} role="region" aria-label="Nachricht" tabIndex={-1} className="flex flex-1 min-w-0 min-h-0 outline-none">{readerPanel}</div>}
      {pane === 'compose' && mode === 'single' && composePanel}
      {mode === 'two' && selectedFolderId && (
        <>
          <div style={{ width: Math.min(listW, 320) }} className={`h-full shrink-0 relative ${PANE_CARD_CLASS}`}>
            <MessageList folderId={selectedFolderId} />
          </div>
          {(panes.includes('reader') || panes.includes('compose')) && <div className="w-2 shrink-0" aria-hidden="true" />}
          {panes.includes('reader') && readerPanel}
          {panes.includes('compose') && composePanel}
        </>
      )}
      {mode === 'two' && !selectedFolderId && (panes.includes('compose')
        ? composePanel
        : <div className={`flex-1 flex items-center justify-center text-fg-subtle text-sm ${PANE_CARD_CLASS}`}>Ordner auswählen</div>)}
      {mode === 'two' && foldersShown && (
        <>
          <div className="absolute inset-0 z-20 bg-scrim/40" onClick={() => setFoldersShown(false)} aria-hidden="true" />
          <div id="mail-folder-drawer" {...pickProps} className="absolute inset-y-0 left-0 z-30 w-72 max-w-[85%] shadow-xl bg-surface rounded-r-xl overflow-hidden"
            onKeyDown={(e) => { if (e.key === 'Escape') setFoldersShown(false); }}>
            <FolderTree />
          </div>
        </>
      )}
    </>
  );

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDrag(null)}>
      {/* 10.1: the ribbon (tab row + commands) is the command card; below 768 px the compact command bar */}
      <PageShell title="Mail" ribbon={mode !== 'single'} commandBar={<MailRibbon />} bodyCard={false}>
        <div className={MAIL_VIEW_COLUMN_CLASS}>
        {narrowBar}
        <div className={MAIL_VIEW_ROOT_CLASS}>
          {mode !== 'three' ? narrowBody : <>

          {/* ── Folder pane (on the canvas; a translucent card over a picture) ── */}
          <div style={{ width: folderW, flexShrink: 0 }} className={`h-full ${FOLDER_PANE_CLASS}`}>
            <FolderTree />
          </div>

          <ResizeHandle onResize={resizeFolder} />

          {/* ── Message list + reader cards (a draft without reading pane / folder: the whole area) ── */}
          {composePanel && (readingPane === 'off' || !selectedFolderId) ? composePanel : selectedFolderId ? (
            readingPane === 'bottom' ? (
              /* Reading pane at the bottom: list on top, reader below, 8 px apart */
              <div className="flex flex-col flex-1 min-w-0 gap-2">
                <div style={{ width: '100%', height: '50%', flexShrink: 0 }} className={`relative ${PANE_CARD_CLASS}`}>
                  <MessageList folderId={selectedFolderId} />
                </div>
                {readerPanel}
              </div>
            ) : (
              /* Reading pane on the right (default) or off */
              <>
                <div style={{ width: readingPane === 'off' ? undefined : listW, flexShrink: 0 }}
                  className={`h-full relative ${readingPane === 'off' ? 'flex-1 min-w-0' : ''} ${PANE_CARD_CLASS}`}>
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
            <div className={`flex-1 flex items-center justify-center text-fg-subtle text-sm ${PANE_CARD_CLASS}`}>
              Ordner auswählen
            </div>
          )}
          </>}
        </div>
        <DraftTabStrip />
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
