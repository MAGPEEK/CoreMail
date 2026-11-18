import { useState, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Star, Pencil, FolderPlus, FolderMinus,
  CheckCheck, Eraser, Tag, PaintBucket, RefreshCw, Clock, Check, RotateCcw,
} from 'lucide-react';
import { RecoverDeletedItemsDialog } from './RecoverDeletedItems.js';
import { QuotaIndicator } from './QuotaIndicator.js';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Folder as FolderType, RetentionTag } from '../api/types.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import {
  FolderItem, SectionHeader, SYSTEM_SET, SYSTEM_LABEL_KEY, HIDDEN_FOLDER_NAMES, buildFolderChildren, systemFoldersOf,
} from './FolderItem.js';
import { SharedMailboxTree } from './SharedMailboxTree.js';
import { confirmFolderDelete } from './folderDeleteConfirm.js';
import { isStaleSubfolderRefusal } from '../lib/folderDelete.js';
import { useT } from '../i18n/useT.js';
import { useLanguageStore } from '../store/language.js';
import { SAFETY_REFETCH_MS } from '../lib/realtimeEvents.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';

type DialogState =
  | { kind: 'createRoot' }
  | { kind: 'createChild'; parentId: string; parentLabel: string }
  | { kind: 'rename'; folder: FolderType }
  | null;

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function FolderTree() {
  const qc = useQueryClient();
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { selectedFolderId, selectedFolderSource, setSelectedFolder, activeMailbox } = useUiStore();
  const ownActive = activeMailbox.kind === 'own';
  const { favoritesCollapsed, folderTreeCollapsed, toggleFavorites, toggleFolderTree } = useUiPrefs();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [recoverOpen, setRecoverOpen] = useState(false);
  // 9.4 webmail policy: shared mailboxes and "recover deleted items" can be switched off
  const { features } = useWebmailFeatures();
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<FolderType[]>('/mail/folders'),
    refetchInterval: SAFETY_REFETCH_MS, // 9.4: live via mailbox events (hooks/useRealtime.ts)
  });

  // Available PERSONAL retention tags (configured by the admin)
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
    mutationFn: ({ id, query }: { id: string; query: string }) => api.delete(`/mail/folders/${id}${query}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
      toast.success(t('folder_deleted'));
    },
    onError: (e: Error) => {
      if (isStaleSubfolderRefusal(e)) {
        qc.invalidateQueries({ queryKey: ['folders'] });
        toast.error(t('folder_delete_changed'));
        return;
      }
      toast.error(e.message || 'Ordner konnte nicht gelöscht werden');
    },
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

  // Filter out Tasks/Notes — these are rendered as standalone pages,
  // not as mail folders in the sidebar.
  const all = (folders ?? []).filter((f) => !HIDDEN_FOLDER_NAMES.has(f.name));

  // ── Build hierarchy ────────────────────────────────────────────────────────
  // Custom folders without parentId are virtually attached under INBOX, so that
  // no separate "My folders" section is needed anymore and old folders stay visible.
  const childrenOf = useMemo(() => buildFolderChildren(all), [all]);

  const favorites = all.filter((f) => f.isFavorite);
  const systemFolders = systemFoldersOf(all);

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
        icon: <Star size={14} className={folder.isFavorite ? 'fill-warning-fg text-warning-fg' : ''} />,
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
            { label: '—',     icon: <Tag size={14} className="text-fg-subtle" />,   onClick: () => patchFolder.mutate({ id: folder.id, body: { color: null } }) },
            { label: 'Blau',  icon: <Tag size={14} style={{ color: '#3B82F6' }} />,   onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#3B82F6' } }) },
            { label: 'Grün',  icon: <Tag size={14} style={{ color: '#10B981' }} />,  onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#10B981' } }) },
            { label: 'Rot',   icon: <Tag size={14} style={{ color: '#EF4444' }} />,    onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#EF4444' } }) },
            { label: 'Orange',icon: <Tag size={14} style={{ color: '#F97316' }} />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#F97316' } }) },
            { label: 'Lila',  icon: <Tag size={14} style={{ color: '#8B5CF6' }} />, onClick: () => patchFolder.mutate({ id: folder.id, body: { color: '#8B5CF6' } }) },
          ],
        },
      );
    }

    // Assign retention policy — also available for system folders
    // (personal tags can be attached to any folder)
    const tagChildren: ContextMenuItem[] = (retentionTags ?? []).map((tg) => {
      const isCurrent = folder.retentionTagId === tg.id;
      return {
        label: `${tg.name} · ${tg.retentionDays} ${t('retention_days')}`,
        icon: isCurrent ? <Check size={14} className="text-accent-fg" /> : <Clock size={14} />,
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
          const query = confirmFolderDelete(t, folderLabel(folder), folder.id, folders ?? []);
          if (query !== null) deleteFolder.mutate({ id: folder.id, query });
        },
      });
    }

    if (isTrashOrJunk) {
      items.push(
        { type: 'divider' },
        // v8.1: "Recover deleted items" — from the Trash folder
        ...(folder.name === 'Trash' && features.recoverItems ? [{
          label: t('recover_title'),
          icon: <RotateCcw size={14} />,
          onClick: () => setRecoverOpen(true),
        }] : []),
        {
          label: t('empty_folder'),
          icon: <Eraser size={14} />,
          danger: true,
          onClick: () => {
            // v8.1: emptied items stay recoverable (Recover deleted items)
            if (!window.confirm(`${t('empty_folder')}?`)) return;
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

  // Recursive rendering of a folder tree
  const renderFolderTree = (folder: FolderType, indent: number, contextKey = 'tree'): ReactNode => {
    const isSystem = folder.isSystem ?? SYSTEM_SET.has(folder.name);
    const children = childrenOf.get(folder.id) ?? [];
    const hasChildren = children.length > 0;
    const expanded = !collapsedNodes.has(folder.id);

    return (
      <div key={`${contextKey}|${folder.id}`}>
        <FolderItem
          folder={folder}
          // Tree marker only when the selection was made in the tree context.
          // Prevents double highlighting in favorites + main tree.
          selected={ownActive && selectedFolderSource !== 'fav' && folder.id === selectedFolderId}
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

  // Make sure useT re-renders on language change
  void lang;

  return (
    <aside className="w-full h-full bg-surface-2 border-r border-line flex flex-col overflow-hidden">
      {/* "Neue E-Mail" lives only in the mail command bar (split button) and on `n`/`c` */}
      <div className="p-3 flex items-center gap-2">
        <button
          onClick={() => {
            void qc.refetchQueries({ queryKey: ['folders'] });
            void qc.refetchQueries({ queryKey: ['messages'] });
            toast.success(t('refresh_done'), { duration: 1500 });
          }}
          title={t('refresh_folders')}
          aria-label={t('refresh_folders')}
          className="shrink-0 p-2 rounded border border-line text-fg-subtle hover:bg-surface-2 active:scale-95 transition-all"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-1 pb-3">
        {/* Favorites */}
        {favorites.length > 0 && (
          <>
            <SectionHeader label={t('favorites')} collapsed={favoritesCollapsed} onToggle={toggleFavorites} />
            {!favoritesCollapsed && (
              <div className="space-y-0.5">
                {favorites.map((f) => (
                  <FolderItem
                    key={`fav-${f.id}`}
                    folder={f}
                    // selected only when the selection was made IN the favorites section
                    selected={ownActive && selectedFolderSource === 'fav' && f.id === selectedFolderId}
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

        {/* System folders + hierarchy */}
        <SectionHeader
          label={t('folders')}
          collapsed={folderTreeCollapsed}
          onToggle={toggleFolderTree}
          action={
            <button aria-label="Neuer Ordner"
              onClick={() => setDialog({ kind: 'createRoot' })}
              className="text-fg-subtle hover:text-fg-muted"
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
        {/* Public folders completely removed in v3.18.31 */}

        {/* 9.3: shared + delegated mailboxes (OWA "add shared folder"); 9.4: module switch */}
        {features.sharedMailboxes && <SharedMailboxTree />}
      </nav>

      {/* v8.1: mailbox usage / quota level */}
      <QuotaIndicator />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {recoverOpen && <RecoverDeletedItemsDialog onClose={() => setRecoverOpen(false)} />}

      {dialog?.kind === 'createRoot' && (
        <PromptDialog
          title="Neuer Ordner"
          label="Name"
          placeholder="z. B. Wichtige Mails"
          confirmText="Erstellen"
          onCancel={() => setDialog(null)}
          validate={(v) => /[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null}
          onConfirm={async (name) => {
            // Default: new folders are created as subfolders of the inbox
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
