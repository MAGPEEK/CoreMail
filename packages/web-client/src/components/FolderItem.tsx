/**
 * One folder row of the folder pane (own mailbox and, 9.3, shared / delegated
 * mailboxes) plus the shared hierarchy helpers. Module level — never define
 * components inside components (remount on every render).
 */
import type { ReactNode } from 'react';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import {
  Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, ChevronRight, ChevronDown, Clock,
} from 'lucide-react';
import type { Folder as FolderType } from '../api/types.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { ROOT_KEY } from '../lib/folderTree.js';

export const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'] as const;
export const SYSTEM_SET = new Set(SYSTEM_ORDER as readonly string[]);

// Folder names that should not be shown as mail folders —
// Tasks and Notes are standalone pages with their own data models.
export const HIDDEN_FOLDER_NAMES = new Set(['Tasks', 'Notes']);

export const ICON_MAP: Record<string, React.ElementType> = {
  INBOX:   Inbox,
  Drafts:  FileText,
  Sent:    Send,
  Trash:   Trash2,
  Junk:    AlertTriangle,
  Archive: Archive,
};

/** w3: tooltip / screen-reader hint of a folder that is only shown as part of a path. */
export const NO_SELECT_HINT = 'Kein Lesezugriff auf diesen Ordner';

export const SYSTEM_LABEL_KEY: Record<string, 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive'> = {
  INBOX:   'inbox',
  Drafts:  'drafts',
  Sent:    'sent',
  Trash:   'trash',
  Junk:    'junk',
  Archive: 'archive',
};

/**
 * Children per parent id. Custom folders without parentId hang virtually under
 * INBOX (no separate "My folders" section); system folders sit at ROOT_KEY.
 */
export function buildFolderChildren(all: FolderType[]): Map<string, FolderType[]> {
  const byParent = new Map<string, FolderType[]>();
  const inbox = all.find((f) => f.name === 'INBOX');
  for (const f of all) {
    const key = f.parentId ? f.parentId : (!SYSTEM_SET.has(f.name) && inbox) ? inbox.id : ROOT_KEY;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => {
      const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (so !== 0) return so;
      return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
    });
  }
  return byParent;
}

/** System folders in their fixed order. */
export function systemFoldersOf(all: FolderType[]): FolderType[] {
  return SYSTEM_ORDER
    .map((name) => all.find((f) => f.name === name))
    .filter((f): f is FolderType => f !== undefined);
}

export function FolderItem({
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
  mailboxKey = 'own',
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
  /** 9.3: mailbox of the folder (drop targets of another mailbox are rejected) */
  mailboxKey?: string;
}) {
  // dnd-kit requires unique IDs — the context key ensures that favorites
  // and the main render do not collide
  const dndId = contextKey ? `${contextKey}|${folder.id}` : folder.id;
  // Outer = drop target (every folder can be a target)
  // w3: a path folder of a folder-scoped mailbox (visible, but no read right) —
  // shown muted, not selectable, no counts, no drop target; still expandable.
  const noSelect = folder.noSelect === true;
  const { isOver, setNodeRef: setDropRef } = useDroppable({
    id: `folder-drop:${dndId}`,
    data: { kind: 'folder', folderId: folder.id, folderName: folder.name, mailbox: mailboxKey },
    disabled: noSelect,
  });

  // Inner = drag source (custom folders only + not in the favorites mirror)
  const dragDisabled = isSystem || !!isDragDisabled || noSelect;
  const select = noSelect ? () => {} : onSelect;
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `folder-drag:${dndId}`,
    data: { kind: 'folder-source', folderId: folder.id, folderName: folder.name, mailbox: mailboxKey },
    disabled: dragDisabled,
  });

  const Icon = ICON_MAP[folder.name] ?? Folder;

  return (
    <div
      ref={setDropRef}
      className={`relative rounded-sm transition-all duration-150 ${
        isOver ? 'ring-2 ring-accent-fg ring-inset bg-accent/15 scale-[1.02] animate-drop-pulse' : ''
      }`}
    >
      {/* Animated accent bar on the left for the active folder */}
      {selected && (
        <span className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent rounded-r animate-slide-in-left" aria-hidden />
      )}
      <div
        ref={setDragRef}
        {...(dragDisabled ? {} : attributes)}
        {...(dragDisabled ? {} : listeners)}
        onClick={select}
        onKeyDown={(e) => {
          // role="button": Enter / Space select like a click; arrows open/close subfolders
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
          else if (hasChildren && e.key === 'ArrowRight' && !expanded) { e.preventDefault(); onToggleExpand(); }
          else if (hasChildren && e.key === 'ArrowLeft' && expanded) { e.preventDefault(); onToggleExpand(); }
        }}
        onContextMenu={onContextMenu}
        style={{ paddingLeft: 6 + indent * 14 }}
        className={`group w-full flex items-center gap-1.5 pr-3 py-1.5 text-sm rounded-sm transition-all duration-150 ${
          noSelect ? 'cursor-default' : dragDisabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
        } ${
          noSelect ? 'text-fg-subtle italic'
            : selected ? 'bg-accent/10 text-accent-fg font-medium' : 'text-fg-muted hover:bg-surface-2 hover:translate-x-0.5'
        } ${isDragging ? 'opacity-40' : ''}`}
        // the undefined props drop the button semantics dnd-kit's `attributes` add;
        // aria-disabled stays only for a non-selectable path parent
        role="treeitem"
        aria-level={indent + 1}
        aria-selected={selected && !noSelect}
        aria-roledescription={undefined}
        aria-pressed={undefined}
        aria-disabled={noSelect ? true : undefined}
        // roving tabindex: hooks/useRovingFocus.ts makes one item of the tree tabbable
        tabIndex={-1}
        {...(noSelect ? { title: NO_SELECT_HINT } : {})}
        {...(hasChildren ? { 'aria-expanded': expanded } : {})}
      >
        {hasChildren ? (
          // Pointer affordance only: the arrow keys open/close (a treeitem has no nested controls)
          <span
            aria-hidden="true"
            data-folder-toggle=""
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-6 h-6 -my-1 -ml-1 flex items-center justify-center text-fg-subtle hover:text-fg-muted shrink-0"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" aria-hidden="true" />
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
        {noSelect && <span className="sr-only">{`, ${NO_SELECT_HINT}`}</span>}
        {folder.retentionTag && (
          <span
            title={`${folder.retentionTag.name} (${folder.retentionTag.retentionDays}d)`}
            className="shrink-0 inline-flex items-center text-[10px] text-fg-subtle"
          >
            <Clock size={11} />
          </span>
        )}
        {!noSelect && folder.unreadCount > 0 && (
          <span className="ml-auto pl-1 shrink-0 tabular-nums" title={`${folder.unreadCount} ungelesen`}>
            <AnimatedCounter value={folder.unreadCount} className="text-xs font-bold text-accent-fg" />
          </span>
        )}
      </div>
    </div>
  );
}

// Module-level (never define components inside components — remounts on every render)
export function SectionHeader({ label, collapsed, onToggle, action, plain = false }: {
  label: string; collapsed: boolean; onToggle: () => void; action?: ReactNode;
  /** 10.1: a label as written (the mailbox address) instead of upper-case caps. */
  plain?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1 mt-3 mb-1 px-2 text-xs font-semibold text-fg-subtle ${plain ? '' : 'uppercase tracking-wide'}`}>
      <button onClick={onToggle} aria-expanded={!collapsed} className="flex items-center gap-1 hover:text-fg-muted flex-1 min-w-0">
        {collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
        <span className="truncate" title={plain ? label : undefined}>{label}</span>
      </button>
      {action}
    </div>
  );
}
