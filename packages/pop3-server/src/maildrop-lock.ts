/**
 * Exclusive-access lock on a POP3 maildrop (RFC 1939 §4, RFC 2449 §8.1.1 [IN-USE]).
 *
 * Two layers:
 *  - an in-process set (always): one session per maildrop in this process, even
 *    while Redis is unavailable;
 *  - a Redis lock `pop3:lock:<userId>` (SET NX PX with an owner token, renewed
 *    while the session lives, released by compare-and-delete) so sessions on
 *    other app instances see it too. A user has exactly one mailbox (1:1), so the
 *    user id identifies the maildrop.
 *
 * When Redis cannot be reached the lock is NOT granted ('error'): RFC 1939 §4
 * says to answer -ERR when the lock cannot be acquired.
 *
 * Test seam: `globalThis.__pop3LockRedis` — a LockRedis fake, or `null` for the
 * in-process layer only.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core/logger';
import { getRedisClient } from '@coremail/core/redis';

const log = createLogger('pop3-lock');

/** Minimal ioredis surface. */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __pop3LockRedis: LockRedis | null | undefined;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const EXTEND_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** Lock TTL; renewed every third of it, so a crashed instance frees the maildrop within a minute. */
export const MAILDROP_LOCK_TTL_MS = 60_000;

export const maildropLockKey = (userId: string): string => `pop3:lock:${userId}`;

export type AcquireResult =
  | { status: 'ok'; release: () => Promise<void> }
  | { status: 'busy' }
  | { status: 'error' };

const localHolders = new Set<string>();

function resolveRedis(): LockRedis | null {
  if (globalThis.__pop3LockRedis !== undefined) return globalThis.__pop3LockRedis;
  return getRedisClient() as unknown as LockRedis;
}

/** Takes the maildrop lock of `userId`; `release` is idempotent. */
export async function acquireMaildropLock(userId: string, ttlMs = MAILDROP_LOCK_TTL_MS): Promise<AcquireResult> {
  if (localHolders.has(userId)) return { status: 'busy' };
  localHolders.add(userId);

  const redis = resolveRedis();
  const key = maildropLockKey(userId);
  const token = randomUUID();
  if (redis) {
    let got: 'OK' | null;
    try {
      got = await redis.set(key, token, 'PX', ttlMs, 'NX');
    } catch (err) {
      localHolders.delete(userId);
      log.error({ err, userId }, 'POP3 maildrop lock: Redis unavailable');
      return { status: 'error' };
    }
    if (got !== 'OK') {
      localHolders.delete(userId);
      return { status: 'busy' };
    }
  }

  const renew = redis
    ? setInterval(() => {
      redis.eval(EXTEND_SCRIPT, 1, key, token, String(ttlMs))
        .then((n) => { if (n === 0) log.warn({ userId }, 'POP3 maildrop lock expired while the session was active'); })
        .catch((err: unknown) => log.warn({ err, userId }, 'POP3 maildrop lock renewal failed'));
    }, Math.max(1_000, Math.floor(ttlMs / 3)))
    : null;
  renew?.unref?.();

  let released = false;
  return {
    status: 'ok',
    release: async () => {
      if (released) return;
      released = true;
      if (renew) clearInterval(renew);
      localHolders.delete(userId);
      if (redis) await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    },
  };
}
