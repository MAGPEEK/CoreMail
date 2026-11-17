/**
 * Enablement rules of the mail command bar and the reading-pane "…" menu.
 * The components map the ids to icons and handlers; everything that decides
 * whether a command is offered, enabled or how it is labelled lives here.
 * Texts come from the i18n table through the caller's translate function (useT);
 * the command bar and the reading-pane "…" menu share one key per action.
 * Unit-tested with `node --test`.
 */
import type { TranslationKey } from '../i18n/translations.ts';

/** Translate function of the active language (useT() in components). */
export type Translate = (key: TranslationKey) => string;

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
export function mailCommandStates(ctx: MailCommandContext, t: Translate): Record<MailCommandId, CommandState> {
  const { selection, readOnly, foreign, isJunkFolder } = ctx;
  const none = selection.count === 0 ? t('mail_hint_no_selection') : null;
  // A write needs write access first (stable reason), then something to act on
  const write = readOnly ? t('mail_hint_read_only') : none;
  const personal = foreign ? t('mail_hint_own_only') : none;
  return {
    new: state(t('mail_cmd_new'), t('mail_cmd_new_tip'), null),
    delete: state(t('mail_cmd_delete'), t('mail_cmd_delete_tip'), write),
    archive: state(t('mail_cmd_archive'), t('mail_cmd_archive_tip'), write),
    move: state(t('mail_cmd_move'), t('mail_cmd_move_tip'), write),
    junk: isJunkFolder
      ? state(t('mail_cmd_not_junk'), t('mail_cmd_not_junk_tip'), write)
      : state(t('mail_cmd_junk'), t('mail_cmd_mark_junk'), write),
    flag: selection.allFlagged
      ? state(t('mail_cmd_unflag'), t('mail_cmd_unflag'), write)
      : state(t('mail_cmd_flag'), t('mail_cmd_flag_tip'), write),
    read: readToggle(selection) === 'read'
      ? state(t('mail_cmd_read'), t('mail_cmd_mark_read'), write)
      : state(t('mail_cmd_unread'), t('mail_cmd_mark_unread'), write),
    categorize: state(t('mail_cmd_categorize'), t('mail_cmd_categorize_tip'), personal),
    pin: selection.allPinned
      ? state(t('mail_cmd_unpin'), t('mail_cmd_unpin_tip'), write)
      : state(t('mail_cmd_pin'), t('mail_cmd_pin_tip'), write),
    undo: state(t('mail_cmd_undo'), t('mail_cmd_undo_tip'), null),
    view: state(t('mail_cmd_view'), t('mail_cmd_view_tip'), null),
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
export function readerOverflowActions(ctx: ReaderActionContext, t: Translate): ReaderAction[] {
  const w = (a: ReaderAction): ReaderAction => (ctx.readOnly ? { ...a, enabled: false, tooltip: t('mail_hint_read_only') } : a);
  const own = (a: ReaderAction): ReaderAction[] => (ctx.foreign ? [] : [a]);
  return [
    { id: 'print', label: t('reader_print'), enabled: true },
    { id: 'source', label: t('reader_source'), enabled: true },
    { id: 'eml', label: t('reader_eml'), enabled: true },
    ...own({ id: 'rule', label: t('reader_rule'), enabled: true }),
    w({ id: 'read', label: t(ctx.isRead ? 'mail_cmd_mark_unread' : 'mail_cmd_mark_read'), enabled: true, groupStart: true }),
    w({ id: 'flag', label: t(ctx.isFlagged ? 'mail_cmd_unflag' : 'mail_cmd_flag'), enabled: true }),
    w({ id: 'pin', label: t(ctx.isPinned ? 'mail_cmd_unpin' : 'mail_cmd_pin'), enabled: true }),
    ...own({ id: 'snooze', label: t('reader_snooze'), enabled: true }),
    w({ id: 'move', label: t('reader_move'), enabled: true, groupStart: true }),
    w({ id: 'archive', label: t('mail_cmd_archive'), enabled: true }),
    w({ id: 'junk', label: t(ctx.isJunkFolder ? 'mail_cmd_not_junk' : 'mail_cmd_mark_junk'), enabled: true }),
    w({ id: 'delete', label: t('mail_cmd_delete'), enabled: true, danger: true }),
  ];
}
