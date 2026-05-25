import { useState, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import {
  Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus,
  Star, ChevronRight, ChevronDown, Pencil, FolderPlus, FolderMinus,
  CheckCheck, Eraser, Tag, PaintBucket, RefreshCw, Clock, Check,
  FolderTree as FolderTreeIcon, X, Mail as MailIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Folder as FolderType, RetentionTag } from '../api/types.js';
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
        {folder.retentionTag && (
          <span
            title={`${folder.retentionTag.name} (${folder.retentionTag.retentionDays}d)`}
            className="shrink-0 inline-flex items-center text-[10px] text-gray-400 dark:text-gray-500"
          >
            <Clock size={11} />
          </span>
        )}
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

  // Verfügbare PERSONAL-Aufbewahrungstags (vom Admin konfiguriert)
  const { data: retentionTags } = useQuery({
    queryKey: ['retention-tags'],
    queryFn: () => api.get<RetentionTag[]>('/retention-tags'),
    staleTime: 5 * 60_000,
  });

  const assignRetentionTag = useMutation({
    mutationFn: ({ folderId, tagId }: { folderId: string; tagId: string | null }) =>
      api.patch(`/mail/folders/${folderId}/retention-tag`, { tagId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      if (vars.tagId) {
        const name = retentionTags?.find((tg) => tg.id === vars.tagId)?.name ?? '';
        toast.success(name ? `${t('retention_assigned_toast')}: ${name}` : t('retention_assigned_toast'));
      } else {
        toast.success(t('retention_removed_toast'));
      }
    },
    onError: (e: Error) => toast.error(e.message || 'Aktion fehlgeschlagen'),
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
      );
    }

    // Aufbewahrungsrichtlinie zuweisen — auch für System-Ordner verfügbar
    // (Exchange-Verhalten: Personal Tags können an jeden Ordner gehängt werden)
    const tagChildren: ContextMenuItem[] = (retentionTags ?? []).map((tg) => {
      const isCurrent = folder.retentionTagId === tg.id;
      return {
        label: `${tg.name} · ${tg.retentionDays} ${t('retention_days')}`,
        icon: isCurrent ? <Check size={14} className="text-accent" /> : <Clock size={14} />,
        onClick: () => assignRetentionTag.mutate({ folderId: folder.id, tagId: tg.id }),
      };
    });
    if (folder.retentionTagId) {
      tagChildren.push(
        { type: 'divider' },
        {
          label: t('retention_remove'),
          icon: <Eraser size={14} />,
          danger: true,
          onClick: () => assignRetentionTag.mutate({ folderId: folder.id, tagId: null }),
        },
      );
    }
    items.push({
      label: t('retention_assign'),
      icon: <Clock size={14} />,
      disabled: !retentionTags || retentionTags.length === 0,
      children: tagChildren.length > 0 ? tagChildren : [{
        label: t('retention_no_tags'),
        disabled: true,
      }],
    });

    if (!isSystem) {
      items.push({
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
      });
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
      <div className="p-3 flex items-center gap-2">
        <button
          onClick={onNewMail}
          className="btn-primary flex-1 justify-center group/newmail animate-halo"
        >
          <Plus size={15} className="transition-transform duration-200 group-hover/newmail:rotate-90" />
          {t('new_mail')}
        </button>
        <button
          onClick={() => {
            void qc.refetchQueries({ queryKey: ['folders'] });
            void qc.refetchQueries({ queryKey: ['messages'] });
            toast.success(t('refresh_done'), { duration: 1500 });
          }}
          title={t('refresh_folders')}
          aria-label={t('refresh_folders')}
          className="shrink-0 p-2 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 active:scale-95 transition-all"
        >
          <RefreshCw size={15} />
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

        {/* Öffentliche Ordner (Exchange-Style) — Lese-/Schreibrechte vom Admin verwaltet */}
        <PublicFoldersSection />
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

// ─────────────────────────────────────────────────────────────────────────────
// PublicFoldersSection — Exchange-Style „Öffentliche Ordner" im FolderTree
// Wird unter den persönlichen Ordnern angezeigt. Jeder Ordner mit ACL für den
// aktuellen User taucht auf. Klick auf einen Ordner navigiert zum
// PublicFolderViewer (Browse-Modus, Read-Only oder Write je nach Permission).
// ─────────────────────────────────────────────────────────────────────────────

interface PublicFolderItem {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  email?: string | null;
  totalCount?: number;
  permission?: 'READ' | 'WRITE' | 'FULL';
}

function PublicFoldersSection() {
  const [collapsed, setCollapsed] = useState(false);
  const [openFolder, setOpenFolder] = useState<PublicFolderItem | null>(null);
  // `isSuccess` + `data` — `folders` ist immer ein Array, aber wir wollen die
  // Section ERST nach erstem erfolgreichen Fetch zeigen (sonst flackert sie auf
  // wenn der Cache vom letzten Login noch User-Daten enthält).
  const { data: folders, isSuccess } = useQuery<PublicFolderItem[]>({
    queryKey: ['mwa-public-folders'],
    queryFn: () => api.get<PublicFolderItem[]>('/public-folders'),
    // Polling alle 30s für schnellen Sync — Admin könnte ACL gerade entzogen haben
    refetchInterval: 30_000,
    // Refetch wenn User Tab/Fenster fokussiert (typisches Szenario:
    // Admin entzieht Zugriff → User wechselt Tab → sieht es sofort)
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  // KRITISCH: Section komplett unsichtbar wenn keine Berechtigungen vorhanden
  // — nicht nur „leere Liste". Section erscheint NUR wenn isSuccess && folders > 0,
  // verschwindet wieder sobald Backend leere Liste zurückgibt (Admin hat ACL entzogen).
  if (!isSuccess || !folders || folders.length === 0) return null;

  return (
    <>
      <div className="mt-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          <span className="flex items-center gap-1.5">
            <FolderTreeIcon size={11} /> Öffentliche Ordner
          </span>
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        {!collapsed && (
          <div className="space-y-0.5 mt-1">
            {folders.map((f) => (
              <button
                key={f.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
                title={f.description || (f.email ? `E-Mail: ${f.email}` : f.displayName)}
                onClick={() => setOpenFolder(f)}
              >
                <Folder size={13} className="text-amber-500 shrink-0 fill-amber-100 dark:fill-amber-900/40" />
                <span className="flex-1 truncate text-left">{f.displayName}</span>
                {f.email && (
                  <span title="Mail-aktiviert" className="text-[9px] text-amber-500 font-mono">@</span>
                )}
                {f.totalCount !== undefined && f.totalCount > 0 && (
                  <span className="text-xs text-gray-400">{f.totalCount}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {openFolder && (
        <PublicFolderViewerModal folder={openFolder} onClose={() => setOpenFolder(null)} />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PublicFolderViewerModal — Browse-Modus für einen Public Folder
// Zeigt die Nachrichten als Liste; Klick auf Nachricht öffnet inline-Detail.
// Read-Only (Posten kommt in eigenem Patch).
// ─────────────────────────────────────────────────────────────────────────────

interface PublicFolderMessage {
  id: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  date: string;
  bodyText: string;
  bodyHtml?: string;
}
interface PublicFolderMessagesResponse { total: number; messages: PublicFolderMessage[] }

function PublicFolderViewerModal({ folder, onClose }: { folder: PublicFolderItem; onClose: () => void }) {
  const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);
  const { data, isLoading } = useQuery<PublicFolderMessagesResponse>({
    queryKey: ['public-folder-messages', folder.id],
    queryFn: () => api.get<PublicFolderMessagesResponse>(`/public-folders/${folder.id}/messages?limit=200`),
    refetchInterval: 30_000,
  });
  const messages = data?.messages ?? [];
  const selectedMsg = messages.find((m) => m.id === selectedMsgId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-5xl h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2.5">
            <Folder size={18} className="text-amber-500 fill-amber-100 dark:fill-amber-900/40" />
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{folder.displayName}</h2>
              {folder.description && <p className="text-xs text-gray-500 dark:text-gray-400">{folder.description}</p>}
            </div>
            {folder.email && (
              <span className="ml-2 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px] rounded-full font-mono">
                {folder.email}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1">
            <X size={18} />
          </button>
        </div>

        {/* Body: Liste + Detail */}
        <div className="flex-1 flex overflow-hidden">
          {/* Liste */}
          <div className="w-1/3 border-r border-gray-200 dark:border-gray-700 overflow-y-auto">
            {isLoading ? (
              <div className="p-8 text-center text-sm text-gray-400">Laden…</div>
            ) : messages.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">
                <MailIcon size={28} className="mx-auto mb-2 text-gray-300" />
                Keine Nachrichten
              </div>
            ) : messages.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedMsgId(m.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                  selectedMsgId === m.id ? 'bg-amber-50 dark:bg-amber-900/20' : ''
                }`}
              >
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{m.subject || '(kein Betreff)'}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{m.fromName || m.fromAddr}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">{new Date(m.date).toLocaleString('de-DE')}</p>
              </button>
            ))}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto">
            {selectedMsg ? (
              <div className="p-5">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{selectedMsg.subject || '(kein Betreff)'}</h3>
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                  <p><strong className="text-gray-700 dark:text-gray-200">Von:</strong> {selectedMsg.fromName ? `${selectedMsg.fromName} <${selectedMsg.fromAddr}>` : selectedMsg.fromAddr}</p>
                  <p><strong className="text-gray-700 dark:text-gray-200">Datum:</strong> {new Date(selectedMsg.date).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })}</p>
                </div>
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  {selectedMsg.bodyHtml ? (
                    <div dangerouslySetInnerHTML={{ __html: selectedMsg.bodyHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') }} />
                  ) : (
                    <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans">{selectedMsg.bodyText}</pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-gray-400">
                <div className="text-center">
                  <MailIcon size={40} className="mx-auto mb-2 text-gray-300" />
                  Wähle eine Nachricht aus
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer mit Counter */}
        <div className="px-5 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 shrink-0">
          {data && `${data.total} Nachricht${data.total === 1 ? '' : 'en'}`}
        </div>
      </div>
    </div>
  );
}
