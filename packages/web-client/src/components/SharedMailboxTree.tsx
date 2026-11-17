/**
 * 9.3: "Freigegebene Postfächer" in the folder pane (OWA "add shared folder").
 * Every shared / delegated mailbox the user may read is an expandable root with
 * its own folder tree; selecting a folder switches the mail view to that mailbox.
 * Users hide / show roots (stored server-side, PATCH /user/accessible-mailboxes/:ref);
 * which roots are expanded is remembered per browser (useUiPrefs.expandedMailboxes).
 * Read-only access: write actions stay visible but disabled with a tooltip.
 */
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Users, User, ChevronRight, ChevronDown, EyeOff, CheckCheck, FolderPlus, Pencil,
  FolderMinus, Eraser, RotateCcw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Folder as FolderType } from '../api/types.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { useT } from '../i18n/useT.js';
import { toastError } from '../lib/errors.js';
import {
  OWN_MAILBOX, mailApiBase, foldersQueryKey, mailboxKey, mailboxTitle, permissionSummary,
  READ_ONLY_HINT, type AccessibleMailboxEntry, type MailboxRef,
} from '../lib/mailboxContext.js';
import { useAccessibleMailboxes, ACCESSIBLE_MAILBOXES_KEY } from '../hooks/useActiveMailbox.js';
import {
  FolderItem, SYSTEM_SET, SYSTEM_LABEL_KEY, HIDDEN_FOLDER_NAMES, buildFolderChildren, systemFoldersOf,
} from './FolderItem.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import { RecoverDeletedItemsDialog } from './RecoverDeletedItems.js';
import { QuotaIndicator } from './QuotaIndicator.js';
import { OpenSharedMailboxModal } from './OpenSharedMailboxModal.js';

type DialogState =
  | { kind: 'create'; parentId: string | null; parentLabel: string }
  | { kind: 'rename'; folder: FolderType }
  | null;

const refOf = (e: AccessibleMailboxEntry): MailboxRef => ({ kind: e.kind, id: e.id });
const validateName = (v: string) => (/[/\\]/.test(v) ? 'Keine / oder \\ erlaubt' : null);

/** Write item of a context menu: disabled with the read-only tooltip when needed. */
function writeItem(readOnly: boolean, item: ContextMenuItem): ContextMenuItem {
  return readOnly ? { ...item, disabled: true, title: READ_ONLY_HINT } : item;
}

export function SharedMailboxTree() {
  const qc = useQueryClient();
  const { data: entries } = useAccessibleMailboxes();
  const activeMailbox = useUiStore((s) => s.activeMailbox);
  const setActiveMailbox = useUiStore((s) => s.setActiveMailbox);
  const { expandedMailboxes, setMailboxExpanded } = useUiPrefs();
  const [addOpen, setAddOpen] = useState(false);
  const activeKey = mailboxKey(activeMailbox);

  if (!entries || entries.length === 0) return null;
  // A hidden mailbox that is open right now (link / profile menu) stays visible
  const list = entries.filter((e) => !e.hidden || e.ref === activeKey);

  const hide = async (e: AccessibleMailboxEntry) => {
    try {
      await api.patch(`/user/accessible-mailboxes/${encodeURIComponent(e.ref)}`, { hidden: true });
      if (e.ref === activeKey) setActiveMailbox(OWN_MAILBOX);
      toast.success(`„${mailboxTitle(e)}" ausgeblendet`, { duration: 2500 });
    } catch (err) {
      toastError(err);
    } finally {
      void qc.invalidateQueries({ queryKey: ACCESSIBLE_MAILBOXES_KEY });
    }
  };

  return (
    <section aria-labelledby="shared-mailboxes-heading" className="mt-3">
      <div className="flex items-center gap-1 mb-1 px-2 text-xs font-semibold text-fg-subtle uppercase tracking-wide">
        <h2 id="shared-mailboxes-heading" className="flex-1">Freigegebene Postfächer</h2>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label="Postfach hinzufügen"
          title="Postfach hinzufügen"
          className="p-0.5 rounded text-fg-subtle hover:text-fg-muted"
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      </div>
      {list.length === 0 ? (
        <p className="px-3 py-1 text-xs text-fg-subtle">Alle Postfächer ausgeblendet – über „+" wieder hinzufügen.</p>
      ) : (
        <ul className="space-y-0.5">
          {list.map((e) => (
            <li key={e.ref}>
              <ForeignMailboxNode
                entry={e}
                expanded={expandedMailboxes.includes(e.ref)}
                onToggle={(open) => setMailboxExpanded(e.ref, open)}
                onHide={() => void hide(e)}
              />
            </li>
          ))}
        </ul>
      )}
      {addOpen && <OpenSharedMailboxModal onClose={() => setAddOpen(false)} />}
    </section>
  );
}

function ForeignMailboxNode({ entry, expanded, onToggle, onHide }: {
  entry: AccessibleMailboxEntry;
  expanded: boolean;
  onToggle: (open?: boolean) => void;
  onHide: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const ref = useMemo(() => refOf(entry), [entry]);
  const base = mailApiBase(ref);
  const { selectedFolderId, activeMailbox, setSelectedFolder } = useUiStore();
  const isActive = mailboxKey(activeMailbox) === entry.ref;
  const readOnly = entry.readOnly;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());

  const { data: folders, isLoading, isError } = useQuery({
    queryKey: foldersQueryKey(ref),
    queryFn: () => api.get<FolderType[]>(`${base}/folders`),
    enabled: expanded || isActive,
    refetchInterval: expanded ? 60_000 : false,
  });
  const all = useMemo(() => (folders ?? []).filter((f) => !HIDDEN_FOLDER_NAMES.has(f.name)), [folders]);
  const childrenOf = useMemo(() => buildFolderChildren(all), [all]);
  const inbox = all.find((f) => f.name === 'INBOX');

  const label = (f: FolderType) => {
    const key = SYSTEM_LABEL_KEY[f.name];
    return key ? t(key) : (f.displayName ?? f.name);
  };
  const title = mailboxTitle(entry);

  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast.success(ok, { duration: 2000 });
    } catch (err) {
      toastError(err);
    } finally {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
    }
  };

  const markAllRead = async (folderId: string) => {
    const list = await api.get<{ messages: { id: string; flags: string[] }[] }>(`${base}/folders/${folderId}/messages?limit=200`);
    const unread = list.messages.filter((m) => !m.flags.includes('\\Seen')).map((m) => m.id);
    if (unread.length) await api.post(`${base}/messages/bulk`, { ids: unread, action: 'read' });
  };

  const recoverItem = (): ContextMenuItem => writeItem(readOnly, {
    label: t('recover_title'), icon: <RotateCcw size={14} />, onClick: () => setRecoverOpen(true),
  });

  const rootMenu = (): ContextMenuItem[] => [
    writeItem(readOnly, {
      label: 'Neuer Ordner', icon: <FolderPlus size={14} />,
      onClick: () => setDialog({ kind: 'create', parentId: inbox?.id ?? null, parentLabel: title }),
    }),
    recoverItem(),
    { type: 'divider' },
    { label: 'Ausblenden', icon: <EyeOff size={14} />, onClick: onHide },
  ];

  const folderMenu = (f: FolderType): ContextMenuItem[] => {
    const isSystem = f.isSystem ?? SYSTEM_SET.has(f.name);
    const items: ContextMenuItem[] = [
      writeItem(readOnly, {
        label: t('mark_all_read'), icon: <CheckCheck size={14} />, disabled: f.unreadCount === 0,
        onClick: () => void run(markAllRead(f.id)),
      }),
      { type: 'divider' },
      writeItem(readOnly, {
        label: t('new_subfolder'), icon: <FolderPlus size={14} />,
        onClick: () => setDialog({ kind: 'create', parentId: f.id, parentLabel: label(f) }),
      }),
    ];
    if (!isSystem) {
      items.push(
        writeItem(readOnly, { label: t('rename'), icon: <Pencil size={14} />, onClick: () => setDialog({ kind: 'rename', folder: f }) }),
        writeItem(readOnly, {
          label: t('delete'), icon: <FolderMinus size={14} />, danger: true,
          onClick: () => {
            const total = f.totalCount ?? 0;
            const msg = total > 0
              ? `Ordner „${label(f)}" mit ${total} Nachricht(en) in „${title}" wirklich löschen?`
              : `Ordner „${label(f)}" in „${title}" löschen?`;
            if (!window.confirm(msg)) return;
            void run(api.delete(`${base}/folders/${f.id}?force=true`), t('folder_deleted'));
          },
        }),
      );
    }
    if (f.name === 'Trash' || f.name === 'Junk') {
      items.push({ type: 'divider' });
      if (f.name === 'Trash') items.push(recoverItem());
      items.push(writeItem(readOnly, {
        label: t('empty_folder'), icon: <Eraser size={14} />, danger: true,
        onClick: () => {
          if (!window.confirm(`${t('empty_folder')}?`)) return;
          void run(api.post(`${base}/folders/${f.id}/empty`, {}), t('folder_emptied'));
        },
      }));
    }
    return items;
  };

  const openMenu = (items: ContextMenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const toggleNode = (id: string) => setCollapsedNodes((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderFolder = (f: FolderType, indent: number): React.ReactNode => {
    const children = childrenOf.get(f.id) ?? [];
    const open = !collapsedNodes.has(f.id);
    const isSystem = f.isSystem ?? SYSTEM_SET.has(f.name);
    return (
      <div key={f.id}>
        <FolderItem
          folder={f}
          selected={isActive && f.id === selectedFolderId}
          isSystem={isSystem}
          hasChildren={children.length > 0}
          expanded={open}
          onToggleExpand={() => toggleNode(f.id)}
          onSelect={() => setSelectedFolder(f.id, 'tree', ref)}
          onContextMenu={openMenu(folderMenu(f))}
          label={label(f)}
          indent={indent}
          contextKey={entry.ref}
          mailboxKey={entry.ref}
          isDragDisabled={readOnly}
        />
        {children.length > 0 && open && children.map((c) => renderFolder(c, indent + 1))}
      </div>
    );
  };

  const Icon = entry.kind === 'shared' ? Users : User;
  const kindLabel = entry.kind === 'shared' ? 'Freigegebenes Postfach' : 'Delegiertes Postfach';

  return (
    <div>
      <div className="group flex items-center gap-0.5 pr-1 rounded-sm hover:bg-surface-2" onContextMenu={openMenu(rootMenu())}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggle()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && !expanded) { e.preventDefault(); onToggle(true); }
            else if (e.key === 'ArrowLeft' && expanded) { e.preventDefault(); onToggle(false); }
          }}
          title={`${kindLabel}: ${entry.email} · ${permissionSummary(entry.permissions)}`}
          className={`flex-1 min-w-0 flex items-center gap-1.5 pl-1.5 py-1.5 text-sm rounded-sm text-left ${isActive ? 'text-accent-fg font-medium' : 'text-fg'}`}
        >
          {expanded ? <ChevronDown size={12} className="shrink-0 text-fg-subtle" aria-hidden="true" /> : <ChevronRight size={12} className="shrink-0 text-fg-subtle" aria-hidden="true" />}
          <Icon size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{title}</span>
          <span className="sr-only">{`, ${kindLabel}, ${permissionSummary(entry.permissions)}`}</span>
          {readOnly && <span className="shrink-0 ml-auto text-[10px] text-fg-subtle" aria-hidden="true">Nur lesen</span>}
        </button>
        <button
          type="button"
          onClick={onHide}
          aria-label={`${title} ausblenden`}
          title="Ausblenden"
          className="shrink-0 p-1 rounded text-fg-subtle hover:text-fg-muted opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <EyeOff size={12} aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-0.5" role="group" aria-label={title}>
          {isLoading && <p className="pl-8 py-1 text-xs text-fg-subtle">Lade Ordner…</p>}
          {isError && <p role="alert" className="pl-8 py-1 text-xs text-danger-fg">Ordner konnten nicht geladen werden.</p>}
          {systemFoldersOf(all).map((f) => renderFolder(f, 1))}
          {entry.kind === 'shared' && (
            <QuotaIndicator sharedMailboxId={entry.id} className="pl-8 pr-3 py-1" />
          )}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {recoverOpen && (
        <RecoverDeletedItemsDialog
          target={ref.kind === 'own' ? { kind: 'own' } : { kind: ref.kind, id: ref.id }}
          subtitle={entry.displayName ? `${entry.displayName} <${entry.email}>` : entry.email}
          onClose={() => setRecoverOpen(false)}
        />
      )}
      {dialog?.kind === 'create' && (
        <PromptDialog
          title="Neuer Ordner"
          label={`In „${dialog.parentLabel}"`}
          placeholder="Name"
          confirmText="Erstellen"
          onCancel={() => setDialog(null)}
          validate={validateName}
          onConfirm={async (name) => {
            await run(api.post(`${base}/folders`, { name, parentId: dialog.parentId }), t('folder_created'));
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
          validate={validateName}
          onConfirm={async (name) => {
            if (name !== dialog.folder.name) await run(api.patch(`${base}/folders/${dialog.folder.id}`, { name }));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
