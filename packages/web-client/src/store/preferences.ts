import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PREFERENCES, applyPatch, normalizePreferences, type PreferencesPatch, type UserPreferences,
} from '../lib/preferences.js';

/**
 * 9.4: roaming preferences (server: /user/preferences). The persisted copy is
 * only the offline cache — lib/preferencesSync.ts replaces it with the server
 * copy after login and sends every `update()` (debounced) to the server.
 */
interface PreferencesState {
  prefs: UserPreferences;
  /** Account the cached copy belongs to (JWT subject), null = not known yet. */
  ownerId: string | null;
  /** true once the server copy was loaded in this tab. */
  synced: boolean;
  replace: (prefs: UserPreferences, ownerId: string) => void;
  /** Applies a change locally right away and queues it for the server. */
  update: (patch: PreferencesPatch) => void;
}

type PatchSink = (patch: PreferencesPatch) => void;
let sink: PatchSink | null = null;

/** lib/preferencesSync.ts registers where local changes go (null = not signed in). */
export function setPreferencesSink(next: PatchSink | null): void {
  sink = next;
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set, get) => ({
      prefs: DEFAULT_PREFERENCES,
      ownerId: null,
      synced: false,
      replace: (prefs, ownerId) => set({ prefs, ownerId, synced: true }),
      update: (patch) => {
        set({ prefs: applyPatch(get().prefs, patch) });
        sink?.(patch);
      },
    }),
    {
      name: 'coremail-preferences',
      partialize: (s) => ({ prefs: s.prefs, ownerId: s.ownerId }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { prefs?: unknown; ownerId?: unknown };
        return {
          ...current,
          prefs: normalizePreferences(p.prefs),
          ownerId: typeof p.ownerId === 'string' ? p.ownerId : null,
        };
      },
    },
  ),
);

/** Regional settings for lib/regionalFormat.ts (time zone, date/time format, language). */
export function useRegional(): UserPreferences['regional'] {
  return usePreferences((s) => s.prefs.regional);
}

/** Current preferences outside React (event handlers, helpers). */
export function currentPreferences(): UserPreferences {
  return usePreferences.getState().prefs;
}
