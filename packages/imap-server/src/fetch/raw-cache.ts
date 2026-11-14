/**
 * Per-session cache of raw messages and their MIME trees. Clients typically fetch
 * BODYSTRUCTURE first and then individual parts (BODY[1], BODY[2], …) in separate
 * commands; the cache avoids a new object-storage download for each of them.
 */
import { loadRawMessage, parseMimeTree, type MimeNode, type RawSourceMessage } from '@coremail/storage';

export interface CachedRaw {
  raw: Buffer;
  tree(): MimeNode;
}

const MAX_ENTRIES = 32;
const MAX_BYTES = 64 * 1024 * 1024;

interface Cache { entries: Map<string, CachedRaw>; bytes: number }
const caches = new WeakMap<object, Cache>();

function cacheOf(session: object): Cache {
  let c = caches.get(session);
  if (!c) { c = { entries: new Map(), bytes: 0 }; caches.set(session, c); }
  return c;
}

function entry(raw: Buffer): CachedRaw {
  let tree: MimeNode | null = null;
  return { raw, tree: () => (tree ??= parseMimeTree(raw)) };
}

/** Raw message of `msg` (cached per session; key = message id + object key). */
export async function getRaw(session: object, msg: RawSourceMessage): Promise<CachedRaw> {
  const cache = cacheOf(session);
  const key = `${msg.id}:${msg.storagePath ?? ''}`;
  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key);
    cache.entries.set(key, hit); // LRU: move to the end
    return hit;
  }
  const raw = await loadRawMessage(msg);
  const e = entry(raw);
  if (raw.length <= MAX_BYTES / 2) {
    cache.entries.set(key, e);
    cache.bytes += raw.length;
    while (cache.entries.size > MAX_ENTRIES || cache.bytes > MAX_BYTES) {
      const oldest = cache.entries.keys().next();
      if (oldest.done) break;
      const old = cache.entries.get(oldest.value);
      cache.entries.delete(oldest.value);
      cache.bytes -= old?.raw.length ?? 0;
    }
  }
  return e;
}
