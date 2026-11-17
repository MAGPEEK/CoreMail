/**
 * Cluster-wide coordination for the backup scheduler and the retention worker
 * (v7.1.0). Every app instance runs the backup-service with the same cron
 * schedules, so without coordination a scheduled backup or a retention run
 * executed once per instance. Same pattern as cert renewal / LDAP sync:
 *
 *  - claimSlot(): one instance wins a cron fire (`SET NX` on <key>:<minute>);
 *  - withLock(): a run lock with an owner token, renewed while the work runs
 *    (backups and retention can outlive any fixed TTL), released by
 *    compare-and-delete so an expired-and-retaken lock is never deleted by the
 *    old owner.
 */
import { randomUUID } from 'node:crypto';

/** Minimal ioredis surface — injectable for tests. */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
export const EXTEND_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

export const LOCK_KEYS = {
  retentionRun: 'backup:retention:run',
  retentionSlot: 'backup:retention:slot',
  scheduleRun: (scheduleId: string) => `backup:schedule:run:${scheduleId}`,
  scheduleSlot: (scheduleId: string) => `backup:schedule:slot:${scheduleId}`,
  /** 9.3: one restore per target mailbox at a time (held until the restore job ended). */
  restore: (mailboxId: string) => `backup:restore:${mailboxId}`,
} as const;

/** Cron fires at second 0; rounding to the nearest minute tolerates ±30 s clock skew between instances. */
export function fireSlot(now: number = Date.now()): number {
  return Math.round(now / 60_000);
}

/** True when this instance won the cron fire `slot` for `key`. */
export async function claimSlot(r: LockRedis, key: string, slot: number = fireSlot(), ttlMs = 60 * 60_000): Promise<boolean> {
  return (await r.set(`${key}:${slot}`, randomUUID(), 'PX', ttlMs, 'NX')) === 'OK';
}

export interface LockOptions {
  /** Lock TTL; renewed every ttlMs/3 while `fn` runs. */
  ttlMs?: number;
  onRenewError?: (err: unknown) => void;
}

/** The lock was lost (taken over / expired) or could not be renewed in time. */
export class LockLostError extends Error {
  constructor(readonly key: string, reason: string) { super(`lock ${key} lost: ${reason}`); this.name = 'LockLostError'; }
}

export type LockResult<T> = { ran: true; value: T } | { ran: false };

/**
 * Runs `fn` while holding `key`; `{ ran: false }` when another owner holds it.
 * 9.3 review: `fn` receives an AbortSignal that fires when the lock is lost
 * (the renewal finds another owner / no key) or when renewals keep failing
 * for half the TTL (before it could expire) — work that must not run without
 * the lock (restore writes) stops cleanly instead of continuing unprotected.
 */
export async function withLock<T>(r: LockRedis, key: string, fn: (signal: AbortSignal) => Promise<T>, opts: LockOptions = {}): Promise<LockResult<T>> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const token = randomUUID();
  if ((await r.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') return { ran: false };
  const ac = new AbortController();
  let lastOk = Date.now();
  const renew = setInterval(() => {
    r.eval(EXTEND_SCRIPT, 1, key, token, String(ttlMs)).then((res) => {
      if (Number(res) === 1) { lastOk = Date.now(); return; }
      if (!ac.signal.aborted) ac.abort(new LockLostError(key, 'held by another owner or expired'));
    }, (err: unknown) => {
      opts.onRenewError?.(err);
      if (Date.now() - lastOk >= ttlMs / 2 && !ac.signal.aborted) ac.abort(new LockLostError(key, 'renewal failed'));
    });
  }, Math.max(1_000, Math.floor(ttlMs / 3)));
  renew.unref?.();
  try {
    return { ran: true, value: await fn(ac.signal) };
  } finally {
    clearInterval(renew);
    await r.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
  }
}
