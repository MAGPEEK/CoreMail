/**
 * 9.4: keeps the roaming preferences in sync with the server while signed in.
 *
 *  1. GET /user/preferences.
 *  2. Never written on the server → imports this browser's pre-9.4 values once
 *     (PATCH { migrateFromLocal }) — unless the cache belongs to another account.
 *  3. The server copy replaces the cache and is mirrored into the older stores
 *     (view/theme/language), which many components still read.
 *  4. Changes — through usePreferences.update() or the older stores' setters —
 *     go to the server debounced (lib/patchQueue.ts); when the tab becomes
 *     visible again without pending changes, the server copy is re-read (other
 *     devices).
 */
import { useEffect } from 'react';
import { api, apiFetch } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { useUiPrefs, useThemeStore } from '../store/ui.js';
import { useLanguageStore } from '../store/language.js';
import { usePreferences, setPreferencesSink } from '../store/preferences.js';
import { PatchQueue } from '../lib/patchQueue.js';
import { registerComposeFlush } from '../lib/compose-flush.js';
import {
  bridgedDiff, bridgedFromPrefs, localToPatch, normalizePreferences,
  type BridgedValues, type PreferencesPatch, type UserPreferences,
} from '../lib/preferences.js';
import type { Lang } from '../i18n/translations.js';

interface PreferencesResponse { preferences: unknown }

const PATCH_DELAY_MS = 800;
const RETRY_MS = 30_000;

/** JWT subject without verifying (only to tell accounts apart in this browser). */
function tokenSubject(token: string | null): string | null {
  try {
    const sub = (JSON.parse(atob(token?.split('.')[1] ?? '')) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

function currentBridged(): BridgedValues {
  const ui = useUiPrefs.getState();
  const theme = useThemeStore.getState();
  return {
    density: ui.density,
    readingPane: ui.readingPane,
    groupByConversation: ui.groupByConversation,
    shortcutsEnabled: ui.shortcutsEnabled,
    shortcutSet: ui.shortcutSet,
    sendDelaySec: ui.sendDelaySec,
    calendarShowWeekNumbers: ui.calendarShowWeekNumbers,
    hiddenCalendarIds: ui.hiddenCalendarIds,
    theme: theme.theme,
    accentRgb: theme.accentRgb,
    lang: useLanguageStore.getState().lang as BridgedValues['lang'],
  };
}

let applyingRemote = false;

/** Mirrors the server copy into the older stores without echoing it back. */
function applyRemote(prefs: UserPreferences, ownerId: string): void {
  applyingRemote = true;
  try {
    usePreferences.getState().replace(prefs, ownerId);
    const b = bridgedFromPrefs(prefs);
    useUiPrefs.setState({
      density: b.density, readingPane: b.readingPane, groupByConversation: b.groupByConversation,
      shortcutsEnabled: b.shortcutsEnabled, shortcutSet: b.shortcutSet, sendDelaySec: b.sendDelaySec,
      calendarShowWeekNumbers: b.calendarShowWeekNumbers, hiddenCalendarIds: b.hiddenCalendarIds,
    });
    useThemeStore.setState({ theme: b.theme, accentRgb: b.accentRgb });
    useLanguageStore.setState({ lang: b.lang as Lang, pending: b.lang as Lang });
  } finally {
    applyingRemote = false;
  }
}

async function loadInitial(ownerId: string): Promise<UserPreferences> {
  const res = await api.get<PreferencesResponse>('/user/preferences');
  const prefs = normalizePreferences(res.preferences);
  if (prefs.migratedAt) return prefs;
  const cacheOwner = usePreferences.getState().ownerId;
  const ui = useUiPrefs.getState() as unknown as Record<string, unknown>;
  const theme = useThemeStore.getState() as unknown as Record<string, unknown>;
  const lang = useLanguageStore.getState() as unknown as Record<string, unknown>;
  // values of another account in this browser are never imported
  const preferences: PreferencesPatch = cacheOwner && cacheOwner !== ownerId ? {} : localToPatch(ui, { theme: theme['theme'], accentRgb: theme['accentRgb'] }, lang);
  const migrated = await api.patch<PreferencesResponse>('/user/preferences', { migrateFromLocal: true, preferences });
  return normalizePreferences(migrated.preferences);
}

function startSync(ownerId: string): () => void {
  let stopped = false;
  const queue = new PatchQueue({
    delayMs: PATCH_DELAY_MS,
    retryMs: RETRY_MS,
    send: async (patch) => {
      const res = await apiFetch('/user/preferences', { method: 'PATCH', body: JSON.stringify({ preferences: patch }), keepalive: true }, 'application/json');
      if (res.ok) return;
      // refused for good (validation): drop it; temporary failures are retried
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return;
      throw new Error(`HTTP ${res.status}`);
    },
  });
  let last = currentBridged();
  const onLocalChange = () => {
    const next = currentBridged();
    if (!applyingRemote && usePreferences.getState().synced) {
      const patch = bridgedDiff(last, next);
      if (Object.keys(patch).length > 0) usePreferences.getState().update(patch);
    }
    last = next;
  };
  const unsubscribers = [
    useUiPrefs.subscribe(onLocalChange),
    useThemeStore.subscribe(onLocalChange),
    useLanguageStore.subscribe(onLocalChange),
  ];

  const refresh = async (initial: boolean) => {
    try {
      const prefs = initial ? await loadInitial(ownerId) : normalizePreferences((await api.get<PreferencesResponse>('/user/preferences')).preferences);
      if (stopped || (!initial && queue.hasPending)) return;
      applyRemote(prefs, ownerId);
      last = currentBridged();
    } catch {
      // offline / server busy: keep working with the cached copy
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void queue.flush();
    else if (!queue.hasPending) void refresh(false);
  };
  document.addEventListener('visibilitychange', onVisibility);
  setPreferencesSink((patch) => queue.push(patch));
  // logout waits for pending changes like for open drafts (lib/compose-flush.ts)
  const unregisterFlush = registerComposeFlush(() => queue.flush());
  void refresh(true);

  return () => {
    stopped = true;
    queue.stop();
    unregisterFlush();
    setPreferencesSink(null);
    usePreferences.setState({ synced: false });
    for (const u of unsubscribers) u();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Runs the sync while a session exists (mounted once in the signed-in layout). */
export function usePreferencesSync(): void {
  const token = useAuthStore((s) => s.accessToken);
  const ownerId = tokenSubject(token);
  useEffect(() => {
    if (!ownerId) return;
    return startSync(ownerId);
  }, [ownerId]);
}
