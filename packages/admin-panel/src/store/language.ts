import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'de' | 'en';

interface LanguageStore {
  lang:         Lang;
  pending:      Lang;
  setPending:   (l: Lang) => void;
  applyPending: () => void;
}

export const useLanguageStore = create<LanguageStore>()(
  persist(
    (set, get) => ({
      lang:         'de',
      pending:      'de',
      setPending:   (pending) => set({ pending }),
      applyPending: () => set({ lang: get().pending }),
    }),
    { name: 'coremail-lang' },
  ),
);
