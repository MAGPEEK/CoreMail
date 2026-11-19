/**
 * IDs the client assigns itself in cached mode (MS-OXCFXICS 3.3.5.2.1) and
 * the ones the server replaced, shared by every MAPI server instance (Redis):
 *
 *  - `mapi:local-ids:<mailboxId>`: the next GLOBCNT RopGetLocalReplicaIds hands
 *    out. It starts above every UID and above every client ID the mailbox's
 *    objects keep (the database MapiObject rows: the `floor` of a reservation),
 *    and is seeded from the clock, so a lost counter never repeats a range a
 *    client still uses. Objects the client creates keep these IDs
 *    (store bindMapiObject).
 *  - `mapi:replaced-ids:<mailboxId>`: client-assigned IDs the server could not
 *    keep (an ID outside the reserved ranges or already taken, a new folder
 *    whose name exists): the object was stored under a server ID and the next
 *    download reports the client's ID deleted, so the client swaps its copy for
 *    the server's (sorted set, scored by time, entries older than
 *    REPLACED_TTL_MS dropped, at most MAX_REPLACED_IDS — the oldest go first, so
 *    a client cannot grow it without limit).
 */
import { LOCAL_ID_BASE } from '../ics/keys.js';
import { DRAFT_COUNTER_BASE } from '../ids.js';

export interface LocalIdStore {
  /** Reserves `count` IDs, never below `floor`; returns the first. */
  reserve(mailboxId: string, count: number, floor: bigint): Promise<bigint>;
  /** The first ID not handed out yet (null: no counter, e.g. after a Redis loss). */
  handedOutBelow(mailboxId: string): Promise<bigint | null>;
  replaced(mailboxId: string): Promise<Set<bigint>>;
  addReplaced(mailboxId: string, ids: readonly bigint[]): Promise<void>;
}

/** Minimal Redis surface (ioredis compatible). */
export interface LocalIdRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'NX'): Promise<unknown>;
  incrby(key: string, n: number): Promise<number | string>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  /** Removes members by rank (ascending score; negative ranks count from the end). */
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

/**
 * IDs one RopGetLocalReplicaIds may reserve (a request cannot burn the range;
 * MS-OXCFXICS 3.2.5.9.4.7: at least the recommended batch of 0x10000).
 */
export const MAX_LOCAL_IDS_PER_REQUEST = 0x10000;
/** IDs one session may reserve in all (256 maximal batches). */
export const MAX_LOCAL_IDS_PER_SESSION = 256 * MAX_LOCAL_IDS_PER_REQUEST;
export const REPLACED_TTL_MS = 90 * 24 * 3600 * 1000;
/** Replaced client IDs kept per mailbox (the newest; a download needs only those since the last one). */
export const MAX_REPLACED_IDS = 100_000;
/** Clock seed: 2^32 + 16 IDs per millisecond since 1970 stays below the session draft range for two centuries. */
const SEED_PER_MS = 16n;

export function localIdSeed(nowMs: number): bigint {
  return LOCAL_ID_BASE + BigInt(nowMs) * SEED_PER_MS;
}

export function createRedisLocalIdStore(redis: () => LocalIdRedis, now: () => number = Date.now): LocalIdStore {
  const counterKey = (mailboxId: string): string => `mapi:local-ids:${mailboxId}`;
  return {
    async reserve(mailboxId, count, floor) {
      const key = counterKey(mailboxId);
      const seed = localIdSeed(now());
      await redis().set(key, (seed > floor ? seed : floor).toString(), 'NX');
      const end = BigInt(await redis().incrby(key, count));
      const first = end - BigInt(count);
      if (end > DRAFT_COUNTER_BASE) throw new Error('local replica ID space exhausted');
      return first;
    },
    async handedOutBelow(mailboxId) {
      const v = await redis().get(counterKey(mailboxId));
      return v === null ? null : BigInt(v);
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
      await redis().zremrangebyrank(key, 0, -(MAX_REPLACED_IDS + 1));
      await redis().pexpire(key, REPLACED_TTL_MS);
    },
  };
}
