import { create } from 'zustand';
import { persist } from 'zustand/middleware';
// ECP-Akzentfarbe ist immer Microsoft-Blau — nicht vom OWA-Theme beeinflussbar
export const ECP_ACCENT_RGB = '0 120 212';
// Eigener localStorage-Key — unabhängig von OWA (coremail-theme)
export const useThemeStore = create()(persist((set) => ({
    theme: 'system',
    setTheme: (theme) => set({ theme }),
}), { name: 'coremail-bcp-theme' }));
export function resolveIsDark(theme) {
    if (theme === 'dark')
        return true;
    if (theme === 'light')
        return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
