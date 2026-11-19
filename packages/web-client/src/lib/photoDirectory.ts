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

/** The [userId, version] of a PHOTO_IMAGE_KEY query key, or null for any other key (pure). */
export function photoImageKeyParts(queryKey: readonly unknown[]): [string, string] | null {
  const [kind, userId, version] = queryKey;
  return kind === PHOTO_IMAGE_KEY && typeof userId === 'string' && typeof version === 'string' && userId && version
    ? [userId, version] : null;
}

/**
 * blob: URLs of loaded photos, one per user AND version. A URL stays valid as
 * long as its image query is cached — an avatar that still shows an older
 * version (e.g. a lookup of an alias not refreshed yet) never ends up with a
 * revoked URL. `release` is called when the query cache drops the entry.
 */
export class PhotoUrlRegistry {
  private readonly urls = new Map<string, string>();
  private readonly create: (blob: Blob) => string;
  private readonly revoke: (url: string) => void;

  constructor(
    create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
    revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {
    this.create = create;
    this.revoke = revoke;
  }

  private static id(userId: string, version: string): string { return `${userId}\n${version}`; }

  get(userId: string, version: string): string | null {
    return this.urls.get(PhotoUrlRegistry.id(userId, version)) ?? null;
  }

  /** URL of this version's blob (the existing one when it was loaded before). */
  add(userId: string, version: string, blob: Blob): string {
    const id = PhotoUrlRegistry.id(userId, version);
    const known = this.urls.get(id);
    if (known) return known;
    const url = this.create(blob);
    this.urls.set(id, url);
    return url;
  }

  release(userId: string, version: string): void {
    const id = PhotoUrlRegistry.id(userId, version);
    const url = this.urls.get(id);
    if (!url) return;
    this.urls.delete(id);
    this.revoke(url);
  }

  get size(): number { return this.urls.size; }
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
