/**
 * Logout with pending compose drafts (8.1).
 *
 * An open compose window saves its last edits when it unmounts — but on logout
 * the token is gone by then and the save fails. Compose windows register a
 * flush here; `logoutWithDraftFlush()` awaits them (capped, default 3 s)
 * BEFORE the session ends, then clears the query cache so the next user of
 * this tab never sees the previous user's data.
 * Framework-free (no React import) so it can be unit-tested with node --test.
 */

export const LOGOUT_FLUSH_TIMEOUT_MS = 3000;

type Flush = () => Promise<unknown>;
const flushers = new Set<Flush>();

/** Registers a compose window's flush; returns the unregister function. */
export function registerComposeFlush(fn: Flush): () => void {
  flushers.add(fn);
  return () => { flushers.delete(fn); };
}

/** Saves every open compose window; resolves after all settled or the timeout. */
export async function flushOpenComposes(timeoutMs = LOGOUT_FLUSH_TIMEOUT_MS): Promise<void> {
  if (flushers.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.allSettled([...flushers].map((f) => {
    try { return f(); } catch (err) { return Promise.reject(err); }
  }));
  await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

/** Flush drafts (capped) → end the session → clear the cached server data. */
export async function logoutWithDraftFlush(opts: {
  logout: () => Promise<void>;
  clearCache: () => void;
  timeoutMs?: number;
}): Promise<void> {
  await flushOpenComposes(opts.timeoutMs);
  try {
    await opts.logout();
  } finally {
    opts.clearCache();
  }
}
