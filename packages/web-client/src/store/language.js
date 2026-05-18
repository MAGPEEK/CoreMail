import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const useLanguageStore = create()(persist((set, get) => ({
    lang: 'de',
    pending: 'de',
    setPending: (pending) => set({ pending }),
    applyPending: () => set({ lang: get().pending }),
}), { name: 'coremail-owa-lang' }));
