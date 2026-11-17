/**
 * Serialises branding asset changes (9.3): upload, delete, reset — each one
 * stores / references objects and then deletes the objects the new row no
 * longer references. Without serialisation request A could store `branding/X`
 * while request B (which read the row before A referenced X) deletes X as
 * unreferenced, leaving A's slot pointing at a missing object.
 *
 * Two layers:
 *  - an in-process queue (requests of this gateway instance run one by one);
 *  - a Redis lock `branding:assets:lock` (SET NX PX with an owner token,
 *    compare-and-delete release — same pattern as `storage:migrate:lock`) across
 *    gateway instances. A Redis error falls back to the in-process queue (logged);
 *    a lock held elsewhere longer than the wait time → {@link BrandingBusyError}.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, getRedisClient } from '@coremail/core';

const log = createLogger('branding');

export const BRANDING_ASSET_LOCK_KEY = 'branding:assets:lock';

/** Minimal ioredis surface — tests install `globalThis.__brandingLockRedis`. */
export interface AssetLockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class BrandingBusyError extends Error {
  readonly code = 'BUSY';
  constructor() {
    super('Another branding change is in progress — please try again');
    this.name = 'BrandingBusyError';
  }
}

const timing = { ttlMs: 60_000, waitMs: 10_000, retryMs: 100 };

/** Test hook: shorter wait / retry times. */
export function setAssetLockTiming(t: Partial<typeof timing>): void {
  Object.assign(timing, t);
}

function redis(): AssetLockRedis {
  const seam = (globalThis as { __brandingLockRedis?: AssetLockRedis }).__brandingLockRedis;
  return seam ?? (getRedisClient() as unknown as AssetLockRedis);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRedisLock<T>(fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + timing.waitMs;
  let r: AssetLockRedis;
  try {
    r = redis();
  } catch (err) {
    log.warn({ err }, 'Branding asset lock: Redis unavailable — serialised in this instance only');
    return fn();
  }
  for (;;) {
    let got: 'OK' | null;
    try {
      got = await r.set(BRANDING_ASSET_LOCK_KEY, token, 'PX', timing.ttlMs, 'NX');
    } catch (err) {
      log.warn({ err }, 'Branding asset lock: Redis unavailable — serialised in this instance only');
      return fn();
    }
    if (got === 'OK') break;
    if (Date.now() >= deadline) throw new BrandingBusyError();
    await sleep(timing.retryMs);
  }
  try {
    return await fn();
  } finally {
    await r.eval(RELEASE_SCRIPT, 1, BRANDING_ASSET_LOCK_KEY, token).catch((err: unknown) => {
      log.warn({ err }, 'Branding asset lock not released (expires on its own)');
    });
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` while no other branding asset change runs (this instance and, via Redis, all others). */
export function withBrandingAssetLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => withRedisLock(fn), () => withRedisLock(fn));
  queue = run.catch(() => undefined);
  return run;
}
