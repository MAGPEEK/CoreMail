import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  theme:     ThemeMode;
  accentRgb: string;
  setTheme:  (theme: ThemeMode) => void;
  setAccent: (rgb: string) => void;
}

// Geteilter localStorage-Key mit OWA — Theme-Änderungen in einem Tab
// werden durch den StorageEvent-Listener in ThemeApplier auch im anderen Tab übernommen.
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

export function resolveIsDark(theme: ThemeMode): boolean {
  if (theme === 'dark')  return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
