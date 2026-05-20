import { useState, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import {
  Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus,
  Star, ChevronRight, ChevronDown, Pencil, FolderPlus, FolderMinus,
  CheckCheck, Eraser, Tag, PaintBucket,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Folder as FolderType } from '../api/types.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { useT } from '../i18n/useT.js';
import { useLanguageStore } from '../store/language.js';

type DialogState =
  | { kind: 'createRoot' }
  | { kind: 'createChild'; parentId: string; parentLabel: string }
  | { kind: 'rename'; folder: FolderType }
  | null;

const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'] as const;

// Ordner-Namen die nicht als Mail-Ordner angezeigt werden sollen —
// Tasks und Notes sind eigenständige Pages mit eigenen Datenmodellen.
const HIDDEN_FOLDER_NAMES = new Set(['Tasks', 'Notes']);

const ICON_MAP: Record<string, React.ElementType> = {
  INBOX:   Inbox,
  Drafts:  FileText,
  Sent:    Send,
  Trash:   Trash2,
  Junk:    AlertTriangle,
  Archive: Archive,
};

const SYSTEM_SET = new Set(SYSTEM_ORDER as readonly string[]);

const SYSTEM_LABEL_KEY: Record<string, 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive'> = {
  INBOX:   'inbox',
  Drafts:  'drafts',
  Sent:    'sent',
  Trash:   'trash',
  Junk:    'junk',
  Archive: 'archive',
};

interface Props { onNewMail: () => void }

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

function FolderItem({
  folder,
  selected,
  isSystem,
  hasChildren,
  expanded,
  onToggleExpand,
  onSelect,
  onContextMenu,
  label,
  indent,
  isDragDisabled,
  contextKey = '',
}: {
  folder: FolderType;
  selected: boolean;
  isSystem: boolean;
  hasChildren: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  label: string;
  indent: number;
  isDragDisabled?: boolean;
  contextKey?: string;
}) {
  // dnd-kit verlangt eindeutige IDs — Context-Key sorgt dafür dass Favoriten
  // und Haupt-Render nicht kollidieren
  const dndId = contextKey ? `${contextKey}|${folder.id}` : folder.id;
  // Outer = Drop-Target (jeder Folder kann Ziel sein)
  const { isOver, setNodeRef: setDropRef } = useDroppable({
    id: `folder-drop:${dndId}`,
    data: { kind: 'folder', folderId: folder.id, folderName: folder.name },
  });

  // Inner = Drag-Source (nur Custom-Folder + nicht im Favoriten-Mirror)
  const dragDisabled = isSystem || !!isDragDisabled;
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `folder-drag:${dndId}`,
    data: { kind: 'folder-source', folderId: folder.id, folderName: folder.name },
    disabled: dragDisabled,
  });

  const Icon = ICON_MAP[folder.name] ?? Folder;

  return (
    <div
      ref={setDropRef}
      className={`relative rounded-sm transition-all duration-150 ${
        isOver ? 'ring-2 ring-accent ring-inset bg-accent/15 scale-[1.02] animate-drop-pulse' : ''
      }`}
    >
      {/* Animierter Akzentbalken links bei aktivem Ordner */}
      {selected && (
        <span className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent rounded-r animate-slide-in-left" aria-hidden />
      )}
      <div
        ref={setDragRef}
        {...(dragDisabled ? {} : attributes)}
        {...(dragDisabled ? {} : listeners)}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        style={{ paddingLeft: 6 + indent * 14 }}
        className={`group w-full flex items-center gap-1.5 pr-3 py-1.5 text-sm rounded-sm transition-all duration-150 ${
          dragDisabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
        } ${
          selected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 hover:translate-x-0.5'
        } ${isDragging ? 'opacity-40' : ''}`}
        role="button"
        tabIndex={0}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <Icon size={15} className="shrink-0 transition-transform duration-150 group-hover:scale-110" style={folder.color ? { color: folder.color } : undefined} />
        {folder.color && (
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: folder.color }}
            aria-hidden
          />
        )}
        <span className="flex-1 text-left truncate">{label}</span>
        {folder.unreadCount > 0 && (
          <AnimatedCounter value={folder.unreadCount} className="text-xs font-bold text-accent" />
        )}
      </div>
    </div>
  );
}

export function FolderTree({ onNewMail }: Props) {
  const qc = useQueryClient();
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { selectedFolderId, selectedFolderSource, setSelectedFolder } = useUiStore();
  const { favoritesCollapsed, folderTreeCollapsed, toggleFavorites, toggleFolderTree } = useUiPrefs();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<FolderType[]>('/mail/folders'),
    refetchInterval: 60_000,
  });

  const patchFolder = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/mail/folders/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
    onError: (e: Error) => toast.error(e.message || 'Aktion fehlgeschlagen'),
  });

  const createFolder = useMutation({
    mutationFn: (body: { name: string; parentId?: string | null }) =>
      api.post<FolderType>('/mail/folders', body),
    onSuccess: (folder) => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      toast.success(`${t('folder_created')}: ${folder.displayName ?? folder.name}`);
    },
    onError: (e: Error) => toast.error(e.message || 'Ordner konnte nicht angelegt werden'),
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => api.delete(`/mail/folders/${id}?force=true`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(t('folder_deleted'));
    },
    onError: (e: Error) => toast.error(e.message || 'Ordner konnte nicht gelöscht werden'),
  });

  const emptyFolder = useMutation({
    mutationFn: (id: string) => api.post(`/mail/folders/${id}/empty`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(t('folder_emptied'));
    },
    onError: (e: Error) => toast.error(e.message || 'Ordner konnte nicht geleert werden'),
  });

  const markAllRead = useMutation({
    mutationFn: async (folderId: string) => {
      const list = await api.get<{ messages: { id: string; flags: string[] }[] }>(
        `/mail/folders/${folderId}/messages?limit=500`,
      );
      const unread = list.messages.filter((m) => !m.flags.includes('\\Seen')).map((m) => m.id);
      if (!unread.length) return { affected: 0 };
      return api.post<{ affected: number }>('/mail/messages/bulk', { ids: unread, action: 'read' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  // Tasks/Notes herausfiltern — diese werden als eigenständige Pages gerendert,
  // nicht als Mail-Ordner in der Sidebar.
  const all = (folders ?? []).filter((f) => !HIDDEN_FOLDER_NAMES.has(f.name));

  // ── Hierarchie aufbauen ────────────────────────────────────────────────────
  // Custom-Folder ohne parentId werden virtuell unter INBOX gehängt, damit es
  // keine separate „Meine Ordner"-Sektion mehr braucht und alte Ordner sichtbar bleiben.
  const childrenOf = useMemo(() => {
    const byParent = new Map<string, FolderType[]>();
    const inbox = all.find((f) => f.name === 'INBOX');
    for (const f of all) {
      let key: string;
      if (f.parentId) {
        key = f.parentId;
      } else if (!SYSTEM_SET.has(f.name) && inbox) {
        // Custom-Folder ohne Parent → virtuell unter INBOX
        key = inbox.id;
      } else {
        key = '__root__';
      }
      const arr = byParent.get(key) ?? [];
      arr.push(f);
      byParent.set(key, arr);
    }
    // Sortiere Kinder nach sortOrder, dann Name
    for (const list of byParent.values()) {
      list.sort((a, b) => {
        const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (so !== 0) return so;
        return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
      });
    }
    return byParent;
  }, [all]);

  const favorites = all.filter((f) => f.isFavorite);
  const systemFolders = SYSTEM_ORDER
    .map((name) => all.find((f) => f.name === name))
    .filter((f): f is FolderType => f !== undefined);

  const folderLabel = (folder: FolderType): string => {
    const sysKey = SYSTEM_LABEL_KEY[folder.name];
    if (sysKey) return t(sysKey);
    return folder.displayName ?? folder.name;
  };

  const toggleExpand = (id: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buildFolderMenu = (folder: FolderType): ContextMenuItem[] => {
    const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
    const isTrashOrJunk = folder.name === 'Trash' || folder.name === 'Junk';

    const items: ContextMenuItem[] = [
      {
        label: t('mark_all_read'),
        icon: <CheckCheck size={14} />,
        disabled: folder.unreadCount === 0,
        onClick: () => {
          toast.promise(markAllRead.mutateAsync(folder.id), {
            loading: '…',
            success: t('mark_all_read'),
            error:   'Fehler',
          });
        },
      },
      { type: 'divider' },
      {
        label: folder.isFavorite ? t('remove_favorite') : t('add_favorite'),
        icon: <Star size={14} className={folder.isFavorite ? 'fill-yellow-400 text-yellow-500' : ''} />,
        onClick: () => patchFolder.mutate({ id: folder.id, body: { isFavorite: !folder.isFavorite } }),
      },
      {
        label: t('new_subfolder'),
        icon: <FolderPlus size={14} />,
        onClick: () => setDialog({
          kind: 'createChild',
          parentId: folder.id,
          parentLabel: folderLabel(folder),
        }),
      },
    ];

    if (!isSystem) {
      items.push(
        {
          label: t('rename'),
          icon: <Pencil size={14} />,
          onClick: () => setDialog({ kind: 'rename', folder }),
        },
        {
          label: t('folder_color'),
          icon: <PaintBucket size={14} />,
          children: [
            { label: '—',     icon: <Tag size={14} className="text-gray-300" />,   onClick: () => patchFolder.mutate({ id: folder.id, body: { color: null } }) },
            { label: 'Blau',  icon: <Tag size={14} className="text-blue-500" />,   onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#3B82F6' } }) },
            { label: 'Grün',  icon: <Tag size={14} className="text-green-500" />,  onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#10B981' } }) },
            { label: 'Rot',   icon: <Tag size={14} className="text-red-500" />,    onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#EF4444' } }) },
            { label: 'Orange',icon: <Tag size={14} className="text-orange-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#F97316' } }) },
            { label: 'Lila',  icon: <Tag size={14} className="text-purple-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#8B5CF6' } }) },
          ],
        },
        {
          label: t('delete'),
          icon: <FolderMinus size={14} />,
          danger: true,
          onClick: () => {
            const total = folder.totalCount ?? 0;
            const msg = total > 0
              ? `Ordner „${folderLabel(folder)}" mit ${total} Nachricht(en) wirklich löschen?`
              : `Ordner „${folderLabel(folder)}" löschen?`;
            if (!window.confirm(msg)) return;
            deleteFolder.mutate(folder.id);
          },
        },
      );
    }

    if (isTrashOrJunk) {
      items.push(
        { type: 'divider' },
        {
          label: t('empty_folder'),
          icon: <Eraser size={14} />,
          danger: true,
          onClick: () => {
            if (!window.confirm('Alle Nachrichten in diesem Ordner werden unwiderruflich gelöscht. Fortfahren?')) return;
            emptyFolder.mutate(folder.id);
          },
        },
      );
    }

    return items;
  };

  const handleContextMenu = (folder: FolderType) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: buildFolderMenu(folder) });
  };

  // Rekursives Rendering eines Ordnerbaums
  const renderFolderTree = (folder: FolderType, indent: number, contextKey = 'tree'): ReactNode => {
    const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
    const children = childrenOf.get(folder.id) ?? [];
    const hasChildren = children.length > 0;
    const expanded = !collapsedNodes.has(folder.id);

    return (
      <div key={`${contextKey}|${folder.id}`}>
        <FolderItem
          folder={folder}
          // Tree-Marker nur dann, wenn die Auswahl auch im Tree-Kontext getätigt wurde.
          // Verhindert doppelte Markierung in Favoriten + Haupt-Tree.
          selected={selectedFolderSource !== 'fav' && folder.id === selectedFolderId}
          isSystem={isSystem}
          hasChildren={hasChildren}
          expanded={expanded}
          onToggleExpand={() => toggleExpand(folder.id)}
          onSelect={() => setSelectedFolder(folder.id, 'tree')}
          onContextMenu={handleContextMenu(folder)}
          label={folderLabel(folder)}
          indent={indent}
          contextKey={contextKey}
        />
        {hasChildren && expanded && (
          <div>
            {children.map((c) => renderFolderTree(c, indent + 1, contextKey))}
          </div>
        )}
      </div>
    );
  };

  const SectionHeader = ({ label, collapsed, onToggle, action }: {
    label: string; collapsed: boolean; onToggle: () => void; action?: ReactNode;
  }) => (
    <div className="flex items-center gap-1 mt-3 mb-1 px-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
      <button onClick={onToggle} className="flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 flex-1">
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        {label}
      </button>
      {action}
    </div>
  );

  // Stelle sicher dass useT bei Sprachwechsel re-rendert
  void lang;

  return (
    <aside className="w-full h-full bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
      <div className="p-3">
        <button
          onClick={onNewMail}
          className="btn-primary w-full justify-center group/newmail animate-halo"
        >
          <Plus size={15} className="transition-transform duration-200 group-hover/newmail:rotate-90" />
          {t('new_mail')}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-1 pb-3">
        {/* Favoriten */}
        {favorites.length > 0 && (
          <>
            <SectionHeader label={t('favorites')} collapsed={favoritesCollapsed} onToggle={toggleFavorites} />
            {!favoritesCollapsed && (
              <div className="space-y-0.5">
                {favorites.map((f) => (
                  <FolderItem
                    key={`fav-${f.id}`}
                    folder={f}
                    // selected nur, wenn die Auswahl IM Favoriten-Bereich getätigt wurde
                    selected={selectedFolderSource === 'fav' && f.id === selectedFolderId}
                    isSystem={SYSTEM_SET.has(f.name)}
                    hasChildren={false}
                    expanded={false}
                    onToggleExpand={() => {}}
                    onSelect={() => setSelectedFolder(f.id, 'fav')}
                    onContextMenu={handleContextMenu(f)}
                    label={folderLabel(f)}
                    indent={0}
                    contextKey="fav"
                    isDragDisabled
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* System-Ordner + Hierarchie */}
        <SectionHeader
          label={t('folders')}
          collapsed={folderTreeCollapsed}
          onToggle={toggleFolderTree}
          action={
            <button
              onClick={() => setDialog({ kind: 'createRoot' })}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              title="Neuer Ordner"
            >
              <Plus size={12} />
            </button>
          }
        />
        {!folderTreeCollapsed && (
          <div className="space-y-0.5">
            {systemFolders.map((f) => renderFolderTree(f, 0))}
          </div>
        )}
      </nav>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'createRoot' && (
        <PromptDialog
          title="Neuer Ordner"
          label="Name"
          placeholder="z. B. Wichtige Mails"
          confirmText="Erstellen"
          onCancel={() => setDialog(null)}
          validate={(v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null}
          onConfirm={async (name) => {
            // Default: neue Ordner werden als Sub-Ordner des Posteingangs angelegt
            const inbox = all.find((f) => f.name === 'INBOX');
            await createFolder.mutateAsync({ name, parentId: inbox?.id ?? null });
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === 'createChild' && (
        <PromptDialog
          title="Neuer Unterordner"
          label={`Unterhalb von „${dialog.parentLabel}"`}
          placeholder="Name"
          confirmText="Erstellen"
          onCancel={() => setDialog(null)}
          validate={(v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null}
          onConfirm={async (name) => {
            await createFolder.mutateAsync({ name, parentId: dialog.parentId });
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <PromptDialog
          title="Ordner umbenennen"
          label="Neuer Name"
          initialValue={dialog.folder.displayName ?? dialog.folder.name}
          confirmText="Speichern"
          onCancel={() => setDialog(null)}
          validate={(v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null}
          onConfirm={async (name) => {
            if (name === dialog.folder.name) { setDialog(null); return; }
            await patchFolder.mutateAsync({ id: dialog.folder.id, body: { name } });
            setDialog(null);
          }}
        />
      )}
    </aside>
  );
}
