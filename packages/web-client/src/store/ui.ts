import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── UI-Zustand (nicht persistent) ─────────────────────────────────────────────
interface UiState {
  selectedFolderId: string | null;
  selectedMessageId: string | null;
  composeOpen: boolean;
  composeReplyTo: { id: string; subject: string; fromAddr: string } | null;
  sidebarCollapsed: boolean;
  setSelectedFolder: (id: string | null) => void;
  setSelectedMessage: (id: string | null) => void;
  openCompose: (replyTo?: { id: string; subject: string; fromAddr: string }) => void;
  closeCompose: () => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedFolderId: null,
  selectedMessageId: null,
  composeOpen: false,
  composeReplyTo: null,
  sidebarCollapsed: false,
  setSelectedFolder: (id) => set({ selectedFolderId: id, selectedMessageId: null }),
  setSelectedMessage: (id) => set({ selectedMessageId: id }),
  openCompose: (replyTo) => set({ composeOpen: true, composeReplyTo: replyTo ?? null }),
  closeCompose: () => set({ composeOpen: false, composeReplyTo: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));

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
