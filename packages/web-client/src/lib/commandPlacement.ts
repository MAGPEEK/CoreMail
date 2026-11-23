/**
 * 10.7 (three-column webmail): where every command of the former ribbons and
 * the former top bar lives now. Rule of the redesign: no user-facing function
 * disappears — each former command has at least one visible place (plus its
 * shortcut / context menu as before).
 *
 * `COMMAND_GROUPS` are the command lists of the new places, built from the same
 * constants the components render from (lib/mailCommands.ts, lib/mailList.ts,
 * lib/composeToolbar.ts, lib/calendarToolbar.ts, lib/contactsCommands.ts,
 * lib/shellMenus.ts). `LEGACY_COMMANDS` is the inventory of the removed
 * surfaces (MailRibbon Start / Ansicht / Hilfe, the narrow MailCommandBar,
 * compose/composeRibbonTabs, lib/calendarRibbon, lib/contactsRibbon, TopBar),
 * each with its new place. commandPlacement.test.ts checks that every legacy
 * command is in the group it names. Pure — unit-tested with `node --test`.
 */
import {
  NEW_MENU_ALL, READER_ICONS, READER_PRIMARY, SELECTION_BAR, SELECTION_BAR_MENUS, readerOverflowActions,
} from './mailCommands.ts';
import { LIST_HEADER, LIST_SEARCH, LIST_STATUS, VIEW_MENU } from './mailList.ts';
import { FORMAT_BAR, SEND_MENU, formatFlyout, headerCommands, moreMenuCommands } from './composeToolbar.ts';
import { CALENDAR_NAV, CALENDAR_SIDEBAR, CALENDAR_TOOLBAR } from './calendarToolbar.ts';
import { NEW_MENU, commandsIn } from './contactsCommands.ts';
import { PROFILE_MENU_ALL, RAIL_BOTTOM, RAIL_TOP } from './shellMenus.ts';
import type { TranslationKey } from '../i18n/translations.ts';

export type Place =
  | 'rail.top' | 'rail.bottom' | 'rail.profileMenu'
  | 'mail.folderCard' | 'mail.folderRow' | 'mail.listHeader' | 'mail.viewMenu' | 'mail.search'
  | 'mail.selectionBar' | 'mail.statusLine' | 'mail.readerActions' | 'mail.readerMore'
  | 'compose.header' | 'compose.sendMenu' | 'compose.moreMenu' | 'compose.formatBar' | 'compose.formatFlyout'
  | 'compose.optionsDialog'
  | 'calendar.sidebar' | 'calendar.nav' | 'calendar.toolbar'
  | 'contacts.sidebar' | 'contacts.listHeader' | 'contacts.detailActions';

const key = (k: TranslationKey) => k;
const allFlyout = formatFlyout({
  inTable: true, inLink: true, align: 'left', direction: 'ltr', superscript: false, subscript: false, strike: false, quote: false, code: false,
}).flat().map((e) => e.id);

/** Entries of the compose "Nachrichtenoptionen" dialog (Senden menu → Nachrichtenoptionen). */
export const COMPOSE_OPTIONS_DIALOG = ['sensitivity', 'receipt', 'deliveryReceipt'] as const;

/** The command lists of every new place. */
export const COMMAND_GROUPS: Readonly<Record<Place, readonly string[]>> = {
  'rail.top': RAIL_TOP,
  'rail.bottom': RAIL_BOTTOM,
  // the menu header shows the name and the address of the signed-in user
  'rail.profileMenu': ['identity', ...PROFILE_MENU_ALL],
  'mail.folderCard': ['new', ...NEW_MENU_ALL],
  // the "…" of a folder row opens the folder context menu (also: right click, context menu key)
  'mail.folderRow': ['folderMenu', 'markAllRead'],
  'mail.listHeader': LIST_HEADER,
  'mail.viewMenu': VIEW_MENU,
  'mail.search': LIST_SEARCH,
  'mail.selectionBar': [...SELECTION_BAR, ...Object.values(SELECTION_BAR_MENUS).flat(), 'clearSelection'],
  'mail.statusLine': LIST_STATUS,
  'mail.readerActions': [...READER_PRIMARY, ...READER_ICONS],
  'mail.readerMore': readerOverflowActions(
    { readOnly: false, foreign: false, isJunkFolder: false, isRead: true, isFlagged: false, isPinned: false }, key,
  ).map((a) => a.id),
  'compose.header': ['send', ...headerCommands(false, true), 'popOut', 'discard', 'close'],
  'compose.sendMenu': SEND_MENU,
  'compose.moreMenu': [...new Set([...moreMenuCommands(false), ...moreMenuCommands(true)])],
  'compose.formatBar': FORMAT_BAR,
  'compose.formatFlyout': allFlyout,
  'compose.optionsDialog': COMPOSE_OPTIONS_DIALOG,
  'calendar.sidebar': CALENDAR_SIDEBAR,
  'calendar.nav': CALENDAR_NAV,
  'calendar.toolbar': CALENDAR_TOOLBAR.map((c) => c.id),
  'contacts.sidebar': ['new', ...NEW_MENU.map((m) => m.action)],
  'contacts.listHeader': ['search', ...commandsIn('list').map((c) => c.id)],
  'contacts.detailActions': commandsIn('detail').map((c) => c.id),
};

export interface LegacyCommand {
  /** Former surface (file / tab). */
  source: string;
  /** Command id there. */
  id: string;
  /** New places (at least one). */
  places: readonly Place[];
  /** Id in the new place when it differs. */
  as?: string;
}

const L = (source: string, id: string, places: readonly Place[], as?: string): LegacyCommand =>
  (as ? { source, id, places, as } : { source, id, places });

const START = 'MailRibbon: Start';
const VIEW = 'MailRibbon: Ansicht';
const HELP = 'MailRibbon: Hilfe';
const NARROW = 'MailCommandBar (narrow)';
const C_MSG = 'composeRibbonTabs: Nachricht';
const C_INS = 'composeRibbonTabs: Einfügen';
const C_FMT = 'composeRibbonTabs: Text formatieren';
const C_OPT = 'composeRibbonTabs: Optionen';
const CAL = 'calendarRibbon';
const CON = 'contactsRibbon';
const TOP = 'TopBar';

/** Inventory of the removed ribbons and the top bar (10.6), with the new place of each command. */
export const LEGACY_COMMANDS: readonly LegacyCommand[] = [
  // ── Mail ribbon, Start ──
  L(START, 'new', ['mail.folderCard']),
  L(START, 'new:mail', ['mail.folderCard'], 'mail'),
  L(START, 'new:template', ['mail.folderCard'], 'template'),
  L(START, 'new:event', ['mail.folderCard'], 'event'),
  L(START, 'new:ownMail', ['mail.folderCard'], 'ownMail'),
  L(START, 'delete', ['mail.selectionBar', 'mail.readerActions']),
  L(START, 'deletePermanent', ['mail.selectionBar']),
  L(START, 'archive', ['mail.selectionBar', 'mail.readerActions']),
  L(START, 'move', ['mail.selectionBar', 'mail.readerActions']),
  L(START, 'move:recent', ['mail.selectionBar'], 'recentFolders'),
  L(START, 'move:other', ['mail.selectionBar'], 'moveOther'),
  L(START, 'junk', ['mail.selectionBar', 'mail.readerMore']),
  L(START, 'reply', ['mail.readerActions']),
  L(START, 'replyAll', ['mail.readerActions']),
  L(START, 'forward', ['mail.readerActions']),
  L(START, 'markAllRead', ['mail.viewMenu', 'mail.folderRow']),
  L(START, 'read', ['mail.selectionBar', 'mail.readerMore']),
  L(START, 'categorize', ['mail.selectionBar', 'mail.readerActions']),
  L(START, 'categorize:manage', ['mail.selectionBar'], 'manageCategories'),
  L(START, 'flag', ['mail.selectionBar', 'mail.readerActions']),
  L(START, 'flag:followUp', ['mail.selectionBar'], 'followUp'),
  L(START, 'print', ['mail.readerMore']),
  L(START, 'undo', ['mail.selectionBar', 'mail.readerMore']),
  L(START, 'selection-info', ['mail.selectionBar'], 'clearSelection'),
  // ── Mail ribbon, Ansicht ──
  L(VIEW, 'view-settings', ['mail.viewMenu'], 'viewSettings'),
  L(VIEW, 'conversations', ['mail.viewMenu']),
  L(VIEW, 'sort', ['mail.viewMenu', 'mail.statusLine']),
  L(VIEW, 'reading-pane', ['mail.viewMenu'], 'readingPane'),
  L(VIEW, 'density', ['mail.viewMenu']),
  L(VIEW, 'sync', ['mail.listHeader']),
  // ── Mail ribbon, Hilfe ──
  L(HELP, 'shortcuts', ['rail.profileMenu']),
  L(HELP, 'about', ['rail.profileMenu']),
  // ── Narrow mail command bar (< 768 px) ──
  L(NARROW, 'new', ['mail.folderCard']),
  L(NARROW, 'delete', ['mail.selectionBar', 'mail.readerActions']),
  L(NARROW, 'archive', ['mail.selectionBar', 'mail.readerActions']),
  L(NARROW, 'move', ['mail.selectionBar', 'mail.readerActions']),
  L(NARROW, 'junk', ['mail.selectionBar', 'mail.readerMore']),
  L(NARROW, 'flag', ['mail.selectionBar', 'mail.readerActions']),
  L(NARROW, 'read', ['mail.selectionBar', 'mail.readerMore']),
  L(NARROW, 'categorize', ['mail.selectionBar', 'mail.readerActions']),
  L(NARROW, 'pin', ['mail.selectionBar', 'mail.readerMore']),
  L(NARROW, 'undo', ['mail.selectionBar', 'mail.readerMore']),
  L(NARROW, 'view', ['mail.listHeader']),
  // ── Compose ribbon tabs (the compose card has every command itself) ──
  L(C_MSG, 'fmt-undo', ['compose.formatFlyout'], 'undo'),
  L(C_MSG, 'fmt-redo', ['compose.formatFlyout'], 'redo'),
  L(C_MSG, 'fmt-font', ['compose.formatFlyout'], 'font'),
  L(C_MSG, 'fmt-size', ['compose.formatFlyout'], 'size'),
  L(C_MSG, 'bold', ['compose.formatBar']),
  L(C_MSG, 'italic', ['compose.formatBar']),
  L(C_MSG, 'underline', ['compose.formatBar']),
  L(C_MSG, 'fmt-strike', ['compose.formatFlyout'], 'strike'),
  L(C_MSG, 'attach', ['compose.header']),
  L(C_MSG, 'link', ['compose.formatBar', 'compose.formatFlyout']),
  L(C_MSG, 'signature', ['compose.header']),
  L(C_MSG, 'inline-image', ['compose.header'], 'inlineImage'),
  L(C_MSG, 'emoji', ['compose.formatBar', 'compose.moreMenu']),
  L(C_MSG, 'schedule', ['compose.sendMenu']),
  L(C_MSG, 'save', ['compose.moreMenu']),
  L(C_MSG, 'save-template', ['compose.moreMenu'], 'saveTemplate'),
  L(C_INS, 'attach', ['compose.header']),
  L(C_INS, 'inline-image', ['compose.header'], 'inlineImage'),
  L(C_INS, 'link', ['compose.formatBar']),
  L(C_INS, 'emoji', ['compose.formatBar', 'compose.moreMenu']),
  L(C_INS, 'signature', ['compose.header']),
  L(C_INS, 'insert-template', ['compose.moreMenu'], 'insertTemplate'),
  L(C_INS, 'fmt-rule', ['compose.formatFlyout'], 'rule'),
  L(C_INS, 'fmt-table', ['compose.formatFlyout'], 'table'),
  L(C_INS, 'datetime', ['compose.moreMenu']),
  L(C_FMT, 'fmt-font', ['compose.formatFlyout'], 'font'),
  L(C_FMT, 'fmt-size', ['compose.formatFlyout'], 'size'),
  L(C_FMT, 'grow', ['compose.formatBar']),
  L(C_FMT, 'shrink', ['compose.formatBar']),
  L(C_FMT, 'bold', ['compose.formatBar']),
  L(C_FMT, 'italic', ['compose.formatBar']),
  L(C_FMT, 'underline', ['compose.formatBar']),
  L(C_FMT, 'fmt-strike', ['compose.formatFlyout'], 'strike'),
  L(C_FMT, 'highlight', ['compose.formatBar']),
  L(C_FMT, 'color', ['compose.formatBar']),
  L(C_FMT, 'fmt-superscript', ['compose.formatFlyout'], 'superscript'),
  L(C_FMT, 'fmt-subscript', ['compose.formatFlyout'], 'subscript'),
  L(C_FMT, 'fmt-code', ['compose.formatFlyout'], 'code'),
  L(C_FMT, 'bullets', ['compose.formatBar']),
  L(C_FMT, 'numbering', ['compose.formatBar']),
  L(C_FMT, 'fmt-outdent', ['compose.formatFlyout'], 'outdent'),
  L(C_FMT, 'fmt-indent', ['compose.formatBar', 'compose.formatFlyout'], 'indent'),
  L(C_FMT, 'fmt-align', ['compose.formatFlyout'], 'align'),
  L(C_FMT, 'fmt-direction', ['compose.formatFlyout'], 'direction'),
  L(C_FMT, 'fmt-quote', ['compose.formatFlyout'], 'quote'),
  L(C_FMT, 'fmt-style', ['compose.formatFlyout'], 'style'),
  L(C_FMT, 'fmt-clear', ['compose.formatFlyout'], 'clear'),
  L(C_FMT, 'format', ['compose.moreMenu']),
  L(C_FMT, 'format-bar', ['compose.moreMenu', 'compose.header'], 'formatBar'),
  L(C_OPT, 'importance', ['compose.sendMenu']),
  L(C_OPT, 'receipt', ['compose.optionsDialog']),
  L(C_OPT, 'options', ['compose.sendMenu']),
  L(C_OPT, 'show-from', ['compose.moreMenu'], 'showFrom'),
  L(C_OPT, 'check-names', ['compose.moreMenu'], 'checkNames'),
  L(C_OPT, 'a11y', ['compose.moreMenu']),
  L(C_OPT, 'format', ['compose.moreMenu']),
  // ── Calendar ribbon ──
  L(CAL, 'new', ['calendar.sidebar', 'calendar.toolbar']),
  L(CAL, 'today', ['calendar.nav']),
  L(CAL, 'view-timeGridDay', ['calendar.toolbar']),
  L(CAL, 'view-workWeek', ['calendar.toolbar']),
  L(CAL, 'view-timeGridWeek', ['calendar.toolbar']),
  L(CAL, 'view-dayGridMonth', ['calendar.toolbar']),
  L(CAL, 'filter', ['calendar.toolbar']),
  L(CAL, 'share', ['calendar.toolbar']),
  L(CAL, 'print', ['calendar.toolbar']),
  L(CAL, 'time-scale', ['calendar.toolbar']),
  L(CAL, 'agenda', ['calendar.toolbar']),
  L(CAL, 'calendar-settings', ['calendar.toolbar']),
  L(CAL, 'shortcuts', ['rail.profileMenu']),
  L(CAL, 'about', ['rail.profileMenu']),
  // ── Contacts ribbon ──
  L(CON, 'new', ['contacts.sidebar']),
  L(CON, 'new:contact', ['contacts.sidebar'], 'newContact'),
  L(CON, 'new:group', ['contacts.sidebar'], 'newGroup'),
  L(CON, 'edit', ['contacts.detailActions']),
  L(CON, 'delete', ['contacts.detailActions']),
  L(CON, 'mail', ['contacts.detailActions']),
  L(CON, 'call', ['contacts.detailActions']),
  L(CON, 'categorize', ['contacts.detailActions']),
  L(CON, 'sort-given', ['contacts.listHeader']),
  L(CON, 'sort-family', ['contacts.listHeader']),
  L(CON, 'shortcuts', ['rail.profileMenu']),
  L(CON, 'about', ['rail.profileMenu']),
  // ── Top bar ──
  L(TOP, 'brand', ['rail.top']),
  L(TOP, 'search', ['mail.search']),
  L(TOP, 'search-suggestions', ['mail.search'], 'searchSuggestions'),
  L(TOP, 'search-operators', ['mail.search'], 'searchOperators'),
  L(TOP, 'notifications', ['rail.bottom', 'rail.profileMenu']),
  L(TOP, 'settings', ['rail.bottom', 'rail.profileMenu']),
  L(TOP, 'profile', ['rail.bottom']),
  L(TOP, 'profile:identity', ['rail.profileMenu'], 'identity'),
  L(TOP, 'open-mailbox', ['rail.profileMenu'], 'openMailbox'),
  L(TOP, 'sign-out', ['rail.profileMenu'], 'signOut'),
];

/**
 * Former controls that existed only to operate the removed ribbon itself and
 * have no counterpart because there is no ribbon (documented, not lost).
 */
export const RETIRED_CHROME: readonly { source: string; id: string; reason: string }[] = [
  { source: 'Ribbon', id: 'collapse', reason: 'No ribbon to collapse; the roaming preference ribbon.collapsed is read tolerantly and deprecated.' },
  { source: 'Ribbon', id: 'tabs', reason: 'Tab row of the ribbon; its commands are listed above with their new places.' },
];

/** Legacy commands whose places do not list them (empty = every former command has a place). */
export function missingPlacements(legacy: readonly LegacyCommand[] = LEGACY_COMMANDS): string[] {
  return legacy.flatMap((c) => c.places
    .filter((p) => !COMMAND_GROUPS[p].includes(c.as ?? c.id))
    .map((p) => `${c.source} ${c.id} → ${p}:${c.as ?? c.id}`));
}
