import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MessageFilter } from '../api/types.js';
import type { ShortcutSetId } from '../lib/shortcuts.js';
import { DEFAULT_SEND_DELAY_SEC, normalizeSendDelay, type SendDelaySec } from '../lib/send-delay.js';
import type { DraftAttachmentRef } from '../lib/draft-autosave.js';
import { migrateThemeState } from '../lib/branding.js';
import { OWN_MAILBOX, mailboxKey, toggleExpanded, type MailboxRef, type SenderOption } from '../lib/mailboxContext.js';
import {
  NO_COMPOSE, activateTab, closeTab, onMessageSelected, openTab, updateTab,
  type ComposeTab, type ComposeTabsState, type OpenOptions, type TabPatch,
} from '../lib/composeTabs.js';
import { subjectFor, type ComposeMode } from '../lib/composeQuote.js';
import type { Importance } from '../lib/importance.js';
import type { Sensitivity } from '../lib/sensitivity.js';
import type { BackgroundChoice } from '../lib/backgroundPrefs.js';
import { pushRecentFolder } from '../lib/folderLists.js';
import { toggleCollapsedGroup, type DateGroupId } from '../lib/dateGroups.js';

export type { ComposeMode };
/** A local file, or an attachment already stored with the server draft. */
export type ComposeAttachment = File | DraftAttachmentRef;
/**
 * Full compose state: reopens a mail whose send was undone or failed, and a
 * draft brought back from the tab strip (9.4) exactly as it was left.
 */
export interface ComposeSnapshot {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  attachments: ComposeAttachment[];
  showCc?: boolean;
  showBcc?: boolean;
  /** Chosen sender (senderKey) and the sender of a reopened draft. */
  fromKey?: string | null;
  draftSender?: SenderOption | undefined;
  requestReceipt?: boolean;
  /** 9.4: delivery receipt (success DSN) asked for */
  deliveryReceipt?: boolean;
  /** 9.4: Wichtigkeit hoch / normal / niedrig */
  importance?: Importance;
  /** 9.4: Vertraulichkeit (Nachrichtenoptionen) */
  sensitivity?: Sensitivity;
  /** 9.4: Von shown via "Absender anzeigen" */
  showFrom?: boolean;
  plainText?: boolean;
  quoteFolded?: boolean;
  /** Identity whose signature was placed, and the block as placed (undefined = unknown). */
  signature?: { forKey: string | null; inserted: string | null | undefined };
  /** Threading headers of a reopened draft. */
  threading?: { inReplyTo?: string; references?: string };
  /** Left before the body was built (signature / original still loading): build it on reopen. */
  bodyPending?: boolean;
  /** Left before the forwarded original's attachments arrived: load them on reopen. */
  forwardPending?: boolean;
}
export interface ComposeContext {
  mode: ComposeMode;
  restore?: ComposeSnapshot;
  /** Server draft being edited (Drafts folder, undo send, failed send, own window). */
  draftId?: string;
  id?: string;
  subject?: string;
  fromAddr?: string;
  fromName?: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  /** Date of the original (reply / forward header). */
  date?: string;
  bodyHtml?: string;
  bodyText?: string;
  /** 9.3: mailbox the compose was opened in (reply original, From choice); default: the active one */
  mailbox?: MailboxRef;
  /** 10.1: new mail from a template — its body (sanitised) goes before the signature, its Bcc into Bcc. */
  template?: { bodyHtml: string; bcc: string[] };
}
export type ComposeTabEntry = ComposeTab<ComposeContext>;

let composeSeq = 0;

// ── UI state (not persistent) ─────────────────────────────────────────────────
/** Where the current folder was selected — determines which render path
 * shows the selected marker (favorites mirror vs. main tree). */
export type FolderSelectionSource = 'fav' | 'tree';

interface UiState {
  selectedFolderId: string | null;
  selectedFolderSource: FolderSelectionSource;
  selectedMessageId: string | null;
  /** 9.3: mailbox shown in the mail view (own / shared / delegated) */
  activeMailbox: MailboxRef;
  /** 9.4: open drafts (tab strip) and the one shown in the reading pane */
  compose: ComposeTabsState<ComposeContext>;
  sidebarCollapsed: boolean;
  /** Keyboard shortcut help dialog (?) */
  shortcutHelpOpen: boolean;
  setShortcutHelpOpen: (v: boolean) => void;
  /** 10.1: background tile hovered / focused in Settings → Darstellung (live preview), null = none */
  backgroundPreview: BackgroundChoice | null;
  setBackgroundPreview: (v: BackgroundChoice | null) => void;
  /** 10.1: last move targets of this session (ribbon "Verschieben in"), newest first */
  recentMoveTargets: string[];
  noteMoveTarget: (folderId: string) => void;
  /** 10.1: collapsed date groups of the message list per folder (session only) */
  collapsedDateGroups: Record<string, DateGroupId[]>;
  toggleDateGroup: (folderKey: string, group: DateGroupId) => void;

  // Multi-selection in the message list
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  filter: MessageFilter;

  /** Selects a folder; `mailbox` = the mailbox it belongs to (default: own). */
  setSelectedFolder: (id: string | null, source?: FolderSelectionSource, mailbox?: MailboxRef) => void;
  /** Switches the mail view to another mailbox (its INBOX is selected once loaded). */
  setActiveMailbox: (ref: MailboxRef) => void;
  setSelectedMessage: (id: string | null) => void;
  /** Opens a draft (shown, or in the strip with `background`); returns its tab key. */
  openCompose: (ctx?: Partial<ComposeContext>, opts?: OpenOptions) => string;
  activateCompose: (key: string) => void;
  closeCompose: (key: string) => void;
  updateComposeTab: (key: string, patch: TabPatch<ComposeContext>) => void;
  toggleSidebar: () => void;

  toggleSelection: (id: string, opts?: { range?: boolean; orderedIds?: string[] }) => void;
  selectOnly: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  setFilter: (f: MessageFilter) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  selectedFolderId: null,
  selectedFolderSource: 'tree',
  selectedMessageId: null,
  activeMailbox: OWN_MAILBOX,
  compose: NO_COMPOSE,
  sidebarCollapsed: false,
  shortcutHelpOpen: false,
  setShortcutHelpOpen: (v) => set({ shortcutHelpOpen: v }),
  backgroundPreview: null,
  setBackgroundPreview: (v) => set({ backgroundPreview: v }),
  recentMoveTargets: [],
  noteMoveTarget: (folderId) => set((s) => ({ recentMoveTargets: pushRecentFolder(s.recentMoveTargets, folderId) })),
  collapsedDateGroups: {},
  toggleDateGroup: (folderKey, group) => set((s) => ({ collapsedDateGroups: toggleCollapsedGroup(s.collapsedDateGroups, folderKey, group) })),
  selectedIds: new Set<string>(),
  lastSelectedId: null,
  filter: 'all',

  setSelectedFolder: (id, source = 'tree', mailbox = OWN_MAILBOX) =>
    set({
      activeMailbox: mailbox,
      selectedFolderId: id,
      selectedFolderSource: source,
      selectedMessageId: null,
      selectedIds: new Set(),
      lastSelectedId: null,
      filter: 'all',
    }),
  setActiveMailbox: (ref) => {
    if (mailboxKey(ref) === mailboxKey(get().activeMailbox)) return;
    set({
      activeMailbox: ref,
      selectedFolderId: null,
      selectedFolderSource: 'tree',
      selectedMessageId: null,
      selectedIds: new Set(),
      lastSelectedId: null,
      filter: 'all',
    });
  },
  // Opening another mail while a draft is shown puts the draft into the tab strip
  setSelectedMessage: (id) => set((s) => ({
    selectedMessageId: id,
    compose: onMessageSelected(s.compose, s.selectedMessageId, id),
  })),
  openCompose: (ctx, opts) => {
    const key = `compose-${++composeSeq}`;
    const full: ComposeContext = { mode: 'new', mailbox: get().activeMailbox, ...ctx };
    const subject = full.restore?.subject ?? subjectFor(full.mode, full.subject);
    const next = openTab(get().compose, key, full, subject, opts);
    set({ compose: next });
    // a draft that already had a tab keeps its key
    return next.tabs.some((t) => t.key === key) ? key : (next.tabs.find((t) => t.draftId === full.draftId)?.key ?? key);
  },
  activateCompose: (key) => set((s) => ({ compose: activateTab(s.compose, key) })),
  closeCompose: (key) => set((s) => ({ compose: closeTab(s.compose, key) })),
  updateComposeTab: (key, patch) => set((s) => ({ compose: updateTab(s.compose, key, patch) })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  toggleSelection: (id, opts) => {
    const s = get();
    const next = new Set(s.selectedIds);

    if (opts?.range && opts.orderedIds && s.lastSelectedId) {
      const a = opts.orderedIds.indexOf(s.lastSelectedId);
      const b = opts.orderedIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(opts.orderedIds[i]!);
        set({ selectedIds: next, lastSelectedId: id });
        return;
      }
    }

    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedIds: next, lastSelectedId: id });
  },
  selectOnly: (id) => set({ selectedIds: new Set([id]), lastSelectedId: id }),
  selectAll: (ids) => set({ selectedIds: new Set(ids), lastSelectedId: ids[ids.length - 1] ?? null }),
  clearSelection: () => set({ selectedIds: new Set(), lastSelectedId: null }),
  setFilter: (f) => set({ filter: f }),
}));

// ── Persistent UI preferences ─────────────────────────────────────────────────
export type Density = 'compact' | 'normal' | 'comfortable';
export type ReadingPane = 'right' | 'bottom' | 'off';

interface UiPrefs {
  density: Density;
  readingPane: ReadingPane;
  groupByConversation: boolean;
  favoritesCollapsed: boolean;
  folderTreeCollapsed: boolean;
  calendarShowWeekNumbers: boolean;
  hiddenCalendarIds: string[];
  /** 9.3: expanded shared/delegated mailbox roots in the folder pane (mailbox keys) */
  expandedMailboxes: string[];
  setMailboxExpanded: (key: string, open?: boolean) => void;
  /** Keyboard shortcuts on/off + set (Settings → View) */
  shortcutsEnabled: boolean;
  shortcutSet: ShortcutSetId;
  /** Undo send: hold outgoing mails this many seconds (0 = off) */
  sendDelaySec: SendDelaySec;
  setShortcutsEnabled: (v: boolean) => void;
  setShortcutSet: (s: ShortcutSetId) => void;
  setSendDelaySec: (s: number) => void;
  setDensity: (d: Density) => void;
  setReadingPane: (p: ReadingPane) => void;
  setGroupByConversation: (v: boolean) => void;
  toggleFavorites: () => void;
  toggleFolderTree: () => void;
  setCalendarShowWeekNumbers: (v: boolean) => void;
  toggleCalendar: (id: string) => void;
  showOnlyCalendar: (id: string, allIds: string[]) => void;
}

export const useUiPrefs = create<UiPrefs>()(
  persist(
    (set, get) => ({
      density: 'normal',
      readingPane: 'right',
      groupByConversation: false,
      favoritesCollapsed: false,
      folderTreeCollapsed: false,
      calendarShowWeekNumbers: true,
      hiddenCalendarIds: [],
      expandedMailboxes: [],
      setMailboxExpanded: (key, open) => set((s) => ({ expandedMailboxes: toggleExpanded(s.expandedMailboxes ?? [], key, open) })),
      shortcutsEnabled: true,
      shortcutSet: 'coremail',
      sendDelaySec: DEFAULT_SEND_DELAY_SEC,
      setShortcutsEnabled: (v) => set({ shortcutsEnabled: v }),
      setShortcutSet: (s) => set({ shortcutSet: s === 'gmail' ? 'gmail' : 'coremail' }),
      setSendDelaySec: (s) => set({ sendDelaySec: normalizeSendDelay(s) }),
      setDensity: (d) => set({ density: d }),
      setReadingPane: (p) => set({ readingPane: p }),
      setGroupByConversation: (v) => set({ groupByConversation: v }),
      toggleFavorites: () => set((s) => ({ favoritesCollapsed: !s.favoritesCollapsed })),
      toggleFolderTree: () => set((s) => ({ folderTreeCollapsed: !s.folderTreeCollapsed })),
      setCalendarShowWeekNumbers: (v) => set({ calendarShowWeekNumbers: v }),
      toggleCalendar: (id) => {
        const cur = get().hiddenCalendarIds;
        set({ hiddenCalendarIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      },
      showOnlyCalendar: (id, allIds) => {
        set({ hiddenCalendarIds: allIds.filter((cid) => cid !== id) });
      },
    }),
    { name: 'coremail-ui-prefs' },
  ),
);

// ── Theme state (persistent via localStorage) ─────────────────────────────────
export type ThemeMode = 'light' | 'dark' | 'system';

export const ACCENT_COLORS = [
  { name: 'Microsoft Blau', hex: '#0078D4', rgb: '0 120 212'   },
  { name: 'Teams Lila',     hex: '#6264A7', rgb: '98 100 167'  },
  { name: 'Grün',           hex: '#107C10', rgb: '16 124 16'   },
  { name: 'Orange',         hex: '#D83B01', rgb: '216 59 1'    },
  { name: 'Türkis',         hex: '#008575', rgb: '0 133 117'   },
  { name: 'Pink',           hex: '#B4009E', rgb: '180 0 158'   },
] as const;

interface ThemeState {
  theme:       ThemeMode;
  /**
   * The user's explicit accent choice ("r g b"), or null = never chose → the
   * brand primary colour. Only honoured while the branding allows user accents
   * (lib/branding.ts resolveAccentChannels).
   */
  accentRgb:   string | null;
  setTheme:    (theme: ThemeMode) => void;
  setAccent:   (rgb: string | null) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme:     'system',
      accentRgb: null,
      setTheme:  (theme) => set({ theme }),
      setAccent: (rgb)   => set({ accentRgb: rgb }),
    }),
    {
      name: 'coremail-theme',
      // 9.3: version 0 stored "0 120 212" for everyone who never picked a colour
      // → migrated to null so those users follow the brand colour.
      version: 1,
      migrate: (persisted, version) => migrateThemeState(persisted, version) as unknown as ThemeState,
    },
  ),
);

/** Computes whether dark mode should be active */
export function resolveIsDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
