import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MessageFilter } from '../api/types.js';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';
export interface ComposeContext {
  mode: ComposeMode;
  id?: string;
  subject?: string;
  fromAddr?: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  bodyHtml?: string;
  bodyText?: string;
}

// ── UI-Zustand (nicht persistent) ─────────────────────────────────────────────
interface UiState {
  selectedFolderId: string | null;
  selectedMessageId: string | null;
  composeOpen: boolean;
  composeCtx: ComposeContext | null;
  sidebarCollapsed: boolean;

  // Mehrfachauswahl in der Nachrichtenliste
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  filter: MessageFilter;

  setSelectedFolder: (id: string | null) => void;
  setSelectedMessage: (id: string | null) => void;
  openCompose: (ctx?: Partial<ComposeContext>) => void;
  closeCompose: () => void;
  toggleSidebar: () => void;

  toggleSelection: (id: string, opts?: { range?: boolean; orderedIds?: string[] }) => void;
  selectOnly: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  setFilter: (f: MessageFilter) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  selectedFolderId: null,
  selectedMessageId: null,
  composeOpen: false,
  composeCtx: null,
  sidebarCollapsed: false,
  selectedIds: new Set<string>(),
  lastSelectedId: null,
  filter: 'all',

  setSelectedFolder: (id) =>
    set({ selectedFolderId: id, selectedMessageId: null, selectedIds: new Set(), lastSelectedId: null, filter: 'all' }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  openCompose: (ctx) => set({ composeOpen: true, composeCtx: { mode: 'new', ...ctx } }),
  closeCompose: () => set({ composeOpen: false, composeCtx: null }),
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

// ── Persistente UI-Präferenzen ────────────────────────────────────────────────
export type Density = 'compact' | 'normal' | 'comfortable';

interface UiPrefs {
  density: Density;
  favoritesCollapsed: boolean;
  folderTreeCollapsed: boolean;
  calendarShowWeekNumbers: boolean;
  hiddenCalendarIds: string[];
  setDensity: (d: Density) => void;
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
      favoritesCollapsed: false,
      folderTreeCollapsed: false,
      calendarShowWeekNumbers: true,
      hiddenCalendarIds: [],
      setDensity: (d) => set({ density: d }),
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

// ── Theme-Zustand (persistent via localStorage) ───────────────────────────────
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
  accentRgb:   string;   // e.g. "0 120 212"
  setTheme:    (theme: ThemeMode) => void;
  setAccent:   (rgb: string) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme:     'system',
      accentRgb: '0 120 212',
      setTheme:  (theme) => set({ theme }),
      setAccent: (rgb)   => set({ accentRgb: rgb }),
    }),
    { name: 'coremail-theme' },
  ),
);

/** Berechnet ob Dark-Mode aktiv sein soll */
export function resolveIsDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
