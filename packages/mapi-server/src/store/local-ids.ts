/**
 * IDs the client assigns itself in cached mode (MS-OXCFXICS 3.3.5.2.1) and
 * the ones the server replaced, shared by every MAPI server instance (Redis):
 *
 *  - `mapi:local-ids:<mailboxId>`: the next GLOBCNT RopGetLocalReplicaIds hands
 *    out. It starts above every UID and is seeded from the clock, so a lost
 *    counter never repeats a range a client still uses.
 *  - `mapi:replaced-ids:<mailboxId>`: client-assigned IDs of objects the client
 *    uploaded and the server stored under its own ID (a new message gets a UID,
 *    a new folder a folder ID). The next download reports them deleted, so the
 *    client swaps its copy for the server's (sorted set, scored by time,
 *    entries older than REPLACED_TTL_MS dropped).
 */
import { LOCAL_ID_BASE } from '../ics/keys.js';
import { DRAFT_COUNTER_BASE } from '../ids.js';

export interface LocalIdStore {
  reserve(mailboxId: string, count: number): Promise<bigint>;
  replaced(mailboxId: string): Promise<Set<bigint>>;
  addReplaced(mailboxId: string, ids: readonly bigint[]): Promise<void>;
}

/** Minimal Redis surface (ioredis compatible). */
export interface LocalIdRedis {
  set(key: string, value: string, mode: 'NX'): Promise<unknown>;
  incrby(key: string, n: number): Promise<number | string>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

/** IDs one RopGetLocalReplicaIds may reserve (a request cannot burn the range). */
export const MAX_LOCAL_IDS_PER_REQUEST = 0x10000;
export const REPLACED_TTL_MS = 90 * 24 * 3600 * 1000;
/** Clock seed: 2^32 + 16 IDs per millisecond since 1970 stays below the session draft range for two centuries. */
const SEED_PER_MS = 16n;

export function localIdSeed(nowMs: number): bigint {
  return LOCAL_ID_BASE + BigInt(nowMs) * SEED_PER_MS;
}

export function createRedisLocalIdStore(redis: () => LocalIdRedis, now: () => number = Date.now): LocalIdStore {
  return {
    async reserve(mailboxId, count) {
      const key = `mapi:local-ids:${mailboxId}`;
      await redis().set(key, localIdSeed(now()).toString(), 'NX');
      const end = BigInt(await redis().incrby(key, count));
      const first = end - BigInt(count);
      if (end > DRAFT_COUNTER_BASE) throw new Error('local replica ID space exhausted');
      return first;
    },
    async replaced(mailboxId) {
      const key = `mapi:replaced-ids:${mailboxId}`;
      await redis().zremrangebyscore(key, '-inf', now() - REPLACED_TTL_MS);
      return new Set((await redis().zrange(key, 0, -1)).map((v) => BigInt(v)));
    },
    async addReplaced(mailboxId, ids) {
      if (ids.length === 0) return;
      const key = `mapi:replaced-ids:${mailboxId}`;
      for (const id of ids) await redis().zadd(key, now(), id.toString());
      await redis().pexpire(key, REPLACED_TTL_MS);
    },
  };
}
