/**
 * Enablement rules of the mail command bar and the reading-pane "…" menu.
 * The components map the ids to icons and handlers; everything that decides
 * whether a command is offered, enabled or how it is labelled lives here.
 * Unit-tested with `node --test`.
 */
import { READ_ONLY_HINT, OWN_ONLY_HINT } from './mailboxContext.ts';

export const NO_SELECTION_HINT = 'Keine Nachricht ausgewählt';

/** Texts shared by the command bar and the reading-pane "…" menu (one wording per action). */
const TEXT = {
  archive: 'Archivieren',
  delete: 'Löschen',
  junk: 'Als Junk markieren',
  notJunk: 'Kein Junk',
  flag: 'Kennzeichnen',
  unflag: 'Kennzeichnung aufheben',
  markRead: 'Als gelesen markieren',
  markUnread: 'Als ungelesen markieren',
  pin: 'Anheften',
  unpin: 'Lösen',
} as const;

/** Command bar order = overflow priority (the tail goes to "…" first). */
export const MAIL_COMMAND_ORDER = [
  'new', 'delete', 'archive', 'move', 'junk', 'flag', 'read', 'categorize', 'pin', 'undo', 'view',
] as const;
export type MailCommandId = typeof MAIL_COMMAND_ORDER[number];

/** What the command bar knows about the messages it acts on. */
export interface SelectionFacts {
  count: number;
  anyUnread: boolean;
  allFlagged: boolean;
  allPinned: boolean;
}

export interface MessageFacts {
  flags: readonly string[];
  pinnedAt?: string | null;
}

/**
 * Messages the commands act on: the checked ones (multi-select), else the open one —
 * the same rule the keyboard shortcuts use.
 */
export function commandTargets(selectedIds: ReadonlySet<string>, openId: string | null): string[] {
  if (selectedIds.size > 0) return [...selectedIds];
  return openId ? [openId] : [];
}

/**
 * Facts of the targets. `known` = the targets found in the loaded lists; a target
 * that is not loaded counts as read, unflagged and unpinned.
 */
export function summarizeSelection(count: number, known: readonly MessageFacts[]): SelectionFacts {
  const complete = known.length >= count && count > 0;
  return {
    count,
    anyUnread: known.some((m) => !m.flags.includes('\\Seen')),
    allFlagged: complete && known.every((m) => m.flags.includes('\\Flagged')),
    allPinned: complete && known.every((m) => !!m.pinnedAt),
  };
}

export interface MailCommandContext {
  selection: SelectionFacts;
  /** read-only shared/delegated mailbox */
  readOnly: boolean;
  /** shared/delegated mailbox (personal features such as categories are own-only) */
  foreign: boolean;
  isJunkFolder: boolean;
}

export interface CommandState {
  enabled: boolean;
  label: string;
  /** Tooltip: the full action, or why it is disabled. */
  tooltip: string;
}

/** "Gelesen" marks read while any target is unread, else the command marks unread. */
export function readToggle(selection: SelectionFacts): 'read' | 'unread' {
  return selection.anyUnread || selection.count === 0 ? 'read' : 'unread';
}

function state(label: string, tooltip: string, blockedBy: string | null): CommandState {
  return blockedBy ? { enabled: false, label, tooltip: blockedBy } : { enabled: true, label, tooltip };
}

/** Label, tooltip and enablement of every command for the current selection and mailbox. */
export function mailCommandStates(ctx: MailCommandContext): Record<MailCommandId, CommandState> {
  const { selection, readOnly, foreign, isJunkFolder } = ctx;
  // A write needs write access first (stable reason), then something to act on
  const write = readOnly ? READ_ONLY_HINT : selection.count === 0 ? NO_SELECTION_HINT : null;
  const personal = foreign ? OWN_ONLY_HINT : selection.count === 0 ? NO_SELECTION_HINT : null;
  return {
    new: state('Neue E-Mail', 'Neue E-Mail verfassen', null),
    delete: state(TEXT.delete, 'In den Papierkorb verschieben', write),
    archive: state(TEXT.archive, 'In das Archiv verschieben', write),
    move: state('Verschieben', 'In einen Ordner verschieben …', write),
    junk: isJunkFolder
      ? state(TEXT.notJunk, `${TEXT.notJunk} – zurück in den Posteingang`, write)
      : state('Junk', TEXT.junk, write),
    flag: selection.allFlagged
      ? state(TEXT.unflag, TEXT.unflag, write)
      : state(TEXT.flag, 'Zur Nachverfolgung kennzeichnen', write),
    read: readToggle(selection) === 'read'
      ? state('Gelesen', TEXT.markRead, write)
      : state('Ungelesen', TEXT.markUnread, write),
    categorize: state('Kategorisieren', 'Kategorie zuweisen', personal),
    pin: selection.allPinned
      ? state(TEXT.unpin, 'Anheften aufheben', write)
      : state(TEXT.pin, 'Oben in der Liste anheften', write),
    undo: state('Rückgängig', 'Letzte Aktion rückgängig machen', null),
    view: state('Ansicht', 'Lesebereich, Dichte und Unterhaltungen', null),
  };
}

// ── Categories (multi-select) ───────────────────────────────────────────────
/** Does every / some / no target carry the category? */
export function categoryCoverage(perMessage: readonly (readonly string[])[], categoryId: string): 'all' | 'some' | 'none' {
  const n = perMessage.filter((ids) => ids.includes(categoryId)).length;
  if (n === 0) return 'none';
  return n === perMessage.length ? 'all' : 'some';
}

/**
 * New category ids of one message when the category is toggled for the whole
 * selection: removed when every target had it, else added (no duplicates).
 */
export function nextCategoryIds(current: readonly string[], categoryId: string, removeFromAll: boolean): string[] {
  if (removeFromAll) return current.filter((id) => id !== categoryId);
  return current.includes(categoryId) ? [...current] : [...current, categoryId];
}

// ── Reading pane "…" menu ───────────────────────────────────────────────────
export type ReaderActionId =
  | 'print' | 'source' | 'eml' | 'rule' | 'read' | 'flag' | 'pin' | 'snooze'
  | 'move' | 'archive' | 'junk' | 'delete';

export interface ReaderActionContext {
  readOnly: boolean;
  foreign: boolean;
  isJunkFolder: boolean;
  isRead: boolean;
  isFlagged: boolean;
  isPinned: boolean;
}

export interface ReaderAction {
  id: ReaderActionId;
  label: string;
  enabled: boolean;
  tooltip?: string;
  danger?: boolean;
  /** draw a divider above the entry */
  groupStart?: boolean;
}

/**
 * Entries of the reading-pane "…" menu (Antworten / Allen antworten / Weiterleiten
 * stay as buttons). Own-only entries (rules, snooze) are left out in foreign
 * mailboxes, write entries are disabled with the read-only reason.
 */
export function readerOverflowActions(ctx: ReaderActionContext): ReaderAction[] {
  const w = (a: ReaderAction): ReaderAction => (ctx.readOnly ? { ...a, enabled: false, tooltip: READ_ONLY_HINT } : a);
  const own = (a: ReaderAction): ReaderAction[] => (ctx.foreign ? [] : [a]);
  return [
    { id: 'print', label: 'Drucken', enabled: true },
    { id: 'source', label: 'Quelltext anzeigen', enabled: true },
    { id: 'eml', label: 'Als EML herunterladen', enabled: true },
    ...own({ id: 'rule', label: 'Regel erstellen …', enabled: true }),
    w({ id: 'read', label: ctx.isRead ? TEXT.markUnread : TEXT.markRead, enabled: true, groupStart: true }),
    w({ id: 'flag', label: ctx.isFlagged ? TEXT.unflag : TEXT.flag, enabled: true }),
    w({ id: 'pin', label: ctx.isPinned ? TEXT.unpin : TEXT.pin, enabled: true }),
    ...own({ id: 'snooze', label: 'Schlummern bis …', enabled: true }),
    w({ id: 'move', label: 'Verschieben …', enabled: true, groupStart: true }),
    w({ id: 'archive', label: TEXT.archive, enabled: true }),
    w({ id: 'junk', label: ctx.isJunkFolder ? TEXT.notJunk : TEXT.junk, enabled: true }),
    w({ id: 'delete', label: TEXT.delete, enabled: true, danger: true }),
  ];
}
