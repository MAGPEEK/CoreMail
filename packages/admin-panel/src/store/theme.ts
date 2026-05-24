import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

// ECP-Akzentfarbe ist immer Microsoft-Blau — nicht vom OWA-Theme beeinflussbar
export const ECP_ACCENT_RGB = '0 120 212';

interface ThemeState {
  theme:    ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

// Eigener localStorage-Key — unabhängig von OWA (coremail-theme)
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme:    'system',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'coremail-bcp-theme' },
  ),
);

export function resolveIsDark(theme: ThemeMode): boolean {
  if (theme === 'dark')  return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
