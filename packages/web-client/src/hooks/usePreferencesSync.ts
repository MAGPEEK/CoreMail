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
 *  A live `settings` event (section `preferences`, hooks/useRealtime.ts) re-reads
 *  the server copy as well — another tab or device changed it.
 *  Server unreachable at start: the cached copy is used, step 1 is retried
 *  (every 30 s and when the tab becomes visible) and changes made meanwhile
 *  wait in the queue — they are sent after the server copy was loaded (and
 *  re-applied on top of it), so the one-time import still runs first.
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
  applyPatch, bridgedDiff, bridgedFromPrefs, isEmptyPatch, jwtSubject, localToPatch, normalizePreferences,
  type BridgedValues, type PreferencesPatch, type UserPreferences,
} from '../lib/preferences.js';
import type { Lang } from '../i18n/translations.js';

interface PreferencesResponse { preferences: unknown }

const PATCH_DELAY_MS = 800;
const RETRY_MS = 30_000;

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

/** Re-read of the running sync (null while signed out). */
let remoteRefresh: (() => void) | null = null;

/**
 * 9.4 realtime: another tab or device changed the preferences — re-read the
 * server copy unless local changes are still waiting to be sent (they win and
 * reach the server next). No-op while the first load has not finished.
 */
export function refreshPreferencesFromServer(): void {
  remoteRefresh?.();
}

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
  /** The server copy was loaded once (import done) — only then changes are sent. */
  let loaded = false;
  let loading = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const queue = new PatchQueue({
    delayMs: PATCH_DELAY_MS,
    retryMs: RETRY_MS,
    isReady: () => loaded,
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
    // also before the first load: queued, sent once the server copy is known
    if (!applyingRemote) {
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

  const refresh = async () => {
    if (loading) return;
    loading = true;
    const initial = !loaded;
    try {
      const prefs = initial ? await loadInitial(ownerId) : normalizePreferences((await api.get<PreferencesResponse>('/user/preferences')).preferences);
      if (stopped || (!initial && queue.hasPending)) return;
      // changes made before the first load stay visible (and are sent next)
      const pending = queue.pendingPatch;
      applyRemote(isEmptyPatch(pending) ? prefs : applyPatch(prefs, pending), ownerId);
      last = currentBridged();
      if (initial) {
        loaded = true;
        void queue.flush();
      }
    } catch {
      // offline / server busy: keep working with the cached copy; the first load is retried
      if (initial && !stopped) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void refresh(); }, RETRY_MS);
      }
    } finally {
      loading = false;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void queue.flush();
    else if (!loaded || !queue.hasPending) void refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);
  setPreferencesSink((patch) => queue.push(patch));
  remoteRefresh = () => { if (loaded && !queue.hasPending) void refresh(); };
  // logout waits for pending changes like for open drafts (lib/compose-flush.ts)
  const unregisterFlush = registerComposeFlush(() => queue.flush());
  void refresh();

  return () => {
    stopped = true;
    remoteRefresh = null;
    if (retryTimer) clearTimeout(retryTimer);
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
  const ownerId = jwtSubject(token);
  useEffect(() => {
    if (!ownerId) return;
    return startSync(ownerId);
  }, [ownerId]);
}
