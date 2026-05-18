import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
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

const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'] as const;

const DISPLAY_NAME: Record<string, string> = {
  INBOX:   'Posteingang',
  Drafts:  'Entwürfe',
  Sent:    'Gesendete Elemente',
  Trash:   'Gelöschte Elemente',
  Junk:    'Junk-E-Mail',
  Archive: 'Archiv',
};

const ICON_MAP: Record<string, React.ElementType> = {
  INBOX:   Inbox,
  Drafts:  FileText,
  Sent:    Send,
  Trash:   Trash2,
  Junk:    AlertTriangle,
  Archive: Archive,
};

const SYSTEM_SET = new Set(SYSTEM_ORDER as readonly string[]);

interface Props { onNewMail: () => void }

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

function FolderItem({
  folder,
  selected,
  onSelect,
  onContextMenu,
  indent = 0,
}: {
  folder: FolderType;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  indent?: number;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `folder:${folder.id}`,
    data: { kind: 'folder', folderId: folder.id, folderName: folder.name },
  });
  const Icon = ICON_MAP[folder.name] ?? Folder;
  const label = DISPLAY_NAME[folder.name] ?? folder.displayName ?? folder.name;

  return (
    <button
      ref={setNodeRef}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 12 + indent * 12 }}
      className={`w-full flex items-center gap-2 pr-3 py-1.5 text-sm rounded-sm transition-colors ${
        selected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
      } ${isOver ? 'ring-2 ring-accent/60 bg-accent/15' : ''}`}
    >
      <Icon size={15} className="shrink-0" style={folder.color ? { color: folder.color } : undefined} />
      <span className="flex-1 text-left truncate">{label}</span>
      {folder.unreadCount > 0 && (
        <span className="text-xs font-bold text-accent">{folder.unreadCount}</span>
      )}
    </button>
  );
}

export function FolderTree({ onNewMail }: Props) {
  const qc = useQueryClient();
  const { selectedFolderId, setSelectedFolder } = useUiStore();
  const { favoritesCollapsed, folderTreeCollapsed, toggleFavorites, toggleFolderTree } = useUiPrefs();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<FolderType[]>('/mail/folders'),
    refetchInterval: 60_000,
  });

  const patchFolder = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/mail/folders/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const createFolder = useMutation({
    mutationFn: (body: { name: string; parentId?: string | null }) =>
      api.post<FolderType>('/mail/folders', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => api.delete(`/mail/folders/${id}?force=true`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const emptyFolder = useMutation({
    mutationFn: (id: string) => api.post(`/mail/folders/${id}/empty`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
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

  const all = folders ?? [];

  const favorites = all.filter((f) => f.isFavorite);
  const systemFolders = SYSTEM_ORDER
    .map((name) => all.find((f) => f.name === name))
    .filter((f): f is FolderType => f !== undefined);
  const customFolders = all.filter((f) => !SYSTEM_SET.has(f.name));

  const buildFolderMenu = (folder: FolderType): ContextMenuItem[] => {
    const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
    const isTrashOrJunk = folder.name === 'Trash' || folder.name === 'Junk';

    const items: ContextMenuItem[] = [
      {
        label: 'Ordner öffnen',
        icon: <Folder size={14} />,
        onClick: () => setSelectedFolder(folder.id),
      },
      {
        label: 'Alle als gelesen markieren',
        icon: <CheckCheck size={14} />,
        disabled: folder.unreadCount === 0,
        onClick: () => {
          toast.promise(markAllRead.mutateAsync(folder.id), {
            loading: 'Markiere…',
            success: 'Alle als gelesen markiert',
            error:   'Fehler beim Markieren',
          });
        },
      },
      { type: 'divider' },
      {
        label: folder.isFavorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen',
        icon: <Star size={14} className={folder.isFavorite ? 'fill-yellow-400 text-yellow-500' : ''} />,
        onClick: () => patchFolder.mutate({ id: folder.id, body: { isFavorite: !folder.isFavorite } }),
      },
      {
        label: 'Neuer Unterordner …',
        icon: <FolderPlus size={14} />,
        onClick: () => {
          const name = window.prompt('Name des neuen Ordners:');
          if (!name?.trim()) return;
          createFolder.mutate({ name: name.trim(), parentId: folder.id });
        },
      },
    ];

    if (!isSystem) {
      items.push(
        {
          label: 'Umbenennen',
          icon: <Pencil size={14} />,
          onClick: () => {
            const name = window.prompt('Neuer Name:', folder.displayName ?? folder.name);
            if (!name?.trim() || name === folder.name) return;
            patchFolder.mutate({ id: folder.id, body: { name: name.trim() } });
          },
        },
        {
          label: 'Farbe ändern',
          icon: <PaintBucket size={14} />,
          children: [
            { label: 'Keine', icon: <Tag size={14} className="text-gray-300" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: null } }) },
            { label: 'Blau',  icon: <Tag size={14} className="text-blue-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#3B82F6' } }) },
            { label: 'Grün',  icon: <Tag size={14} className="text-green-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#10B981' } }) },
            { label: 'Rot',   icon: <Tag size={14} className="text-red-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#EF4444' } }) },
            { label: 'Orange',icon: <Tag size={14} className="text-orange-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#F97316' } }) },
            { label: 'Lila',  icon: <Tag size={14} className="text-purple-500" />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#8B5CF6' } }) },
          ],
        },
        {
          label: 'Löschen',
          icon: <FolderMinus size={14} />,
          danger: true,
          onClick: () => {
            const total = folder.totalCount ?? 0;
            const msg = total > 0
              ? `Ordner „${folder.displayName ?? folder.name}" mit ${total} Nachricht(en) wirklich löschen?`
              : `Ordner „${folder.displayName ?? folder.name}" löschen?`;
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
          label: folder.name === 'Trash' ? 'Papierkorb leeren' : 'Junk-Ordner leeren',
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

  return (
    <aside className="w-52 shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col h-full">
      <div className="p-3">
        <button onClick={onNewMail} className="btn-primary w-full justify-center">
          <Plus size={15} />
          Neue E-Mail
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-1 pb-3">
        {/* Favoriten */}
        {favorites.length > 0 && (
          <>
            <SectionHeader label="Favoriten" collapsed={favoritesCollapsed} onToggle={toggleFavorites} />
            {!favoritesCollapsed && (
              <div className="space-y-0.5">
                {favorites.map((f) => (
                  <FolderItem
                    key={`fav-${f.id}`}
                    folder={f}
                    selected={f.id === selectedFolderId}
                    onSelect={() => setSelectedFolder(f.id)}
                    onContextMenu={handleContextMenu(f)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Systemordner */}
        <SectionHeader
          label="Ordner"
          collapsed={folderTreeCollapsed}
          onToggle={toggleFolderTree}
          action={
            <button
              onClick={() => {
                const name = window.prompt('Name des neuen Ordners:');
                if (!name?.trim()) return;
                createFolder.mutate({ name: name.trim() });
              }}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              title="Neuer Ordner"
            >
              <Plus size={12} />
            </button>
          }
        />
        {!folderTreeCollapsed && (
          <div className="space-y-0.5">
            {systemFolders.map((f) => (
              <FolderItem
                key={f.id}
                folder={f}
                selected={f.id === selectedFolderId}
                onSelect={() => setSelectedFolder(f.id)}
                onContextMenu={handleContextMenu(f)}
              />
            ))}

            {customFolders.length > 0 && (
              <>
                <div className="mt-2 mb-0.5 px-3 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                  Meine Ordner
                </div>
                {customFolders.map((f) => (
                  <FolderItem
                    key={f.id}
                    folder={f}
                    selected={f.id === selectedFolderId}
                    onSelect={() => setSelectedFolder(f.id)}
                    onContextMenu={handleContextMenu(f)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </nav>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
