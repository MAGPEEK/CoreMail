/**
 * 9.5: which addresses have a profile photo — batched lookups against
 * POST /api/v1/users/photos/lookup (pure logic, unit-tested; the React side is
 * hooks/useUserPhoto.ts, which caches the answers with TanStack Query).
 *
 * Every address asked for within BATCH_DELAY_MS goes out in one request (at
 * most MAX_BATCH per request), so a message list asks once for all its rows
 * instead of once per row. External senders simply come back without an entry.
 */

/** Same limit as the server (lib/profile-photo/directory.ts). */
export const MAX_BATCH = 100;
export const BATCH_DELAY_MS = 25;

export interface PhotoEntry { userId: string; version: string }
export type LookupFn = (addresses: string[]) => Promise<Record<string, PhotoEntry>>;

/** TanStack Query keys (lib/realtimeEvents.ts invalidates both on `settings` / `profile`). */
export const PHOTO_LOOKUP_KEY = 'user-photo-lookup';
export const PHOTO_IMAGE_KEY = 'user-photo';

/** Lower-case address, or null when it is not one (pure). */
export function normalizeAddress(raw: string | null | undefined): string | null {
  const a = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(a) ? a : null;
}

/** API path of a user's photo; the version only makes cache keys and URLs change with the photo. */
export function photoPath(entry: PhotoEntry): string {
  return `/api/v1/users/${encodeURIComponent(entry.userId)}/photo?v=${encodeURIComponent(entry.version)}`;
}

/** Splits a list into chunks of at most `size` (pure). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface Waiter { resolve: (e: PhotoEntry | null) => void }

/**
 * Collects lookups and sends them in batches. A failed request answers its
 * addresses with null (no photo — initials stay), the next lookup asks again.
 */
export class PhotoLookupBatcher {
  private readonly lookup: LookupFn;
  private readonly delayMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private pending = new Map<string, Waiter[]>();
  private timer: unknown = null;

  constructor(lookup: LookupFn, opts: { delayMs?: number; schedule?: (fn: () => void, ms: number) => unknown } = {}) {
    this.lookup = lookup;
    this.delayMs = opts.delayMs ?? BATCH_DELAY_MS;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** The photo of `address`, or null (no photo, external, invalid address or failed lookup). */
  get(address: string): Promise<PhotoEntry | null> {
    const key = normalizeAddress(address);
    if (!key) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiters = this.pending.get(key) ?? [];
      waiters.push({ resolve });
      this.pending.set(key, waiters);
      if (this.timer === null) this.timer = this.schedule(() => { void this.flush(); }, this.delayMs);
    });
  }

  /** Sends everything collected so far. */
  async flush(): Promise<void> {
    this.timer = null;
    const batch = this.pending;
    this.pending = new Map();
    await Promise.all(chunk([...batch.keys()], MAX_BATCH).map(async (addresses) => {
      let found: Record<string, PhotoEntry> = {};
      try {
        found = await this.lookup(addresses);
      } catch {
        found = {};
      }
      for (const a of addresses) for (const w of batch.get(a) ?? []) w.resolve(found[a] ?? null);
    }));
  }
}
