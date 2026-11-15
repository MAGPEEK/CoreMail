/**
 * v8.1: enforcement of the limits the session object advertises (RFC 8620 §2)
 * plus an upload quota.
 *
 *  - maxConcurrentRequests: concurrent API requests per user (HTTP /jmap/api
 *    and WebSocket "Request" messages) → request-level error "limit".
 *  - maxConcurrentUpload: concurrent uploads per user (POST /jmap/upload),
 *    checked before the body is read → "limit".
 *  - Upload quota per account (JMAP_UPLOAD_QUOTA_MB, default 500; <= 0 off):
 *    live jmap-upload blobs (7 d lifetime) are tracked in a Redis sorted set
 *    `jmap:upload:usage:<accountId>` (member "<blobId>:<size>", score = expiry).
 *    At most JMAP_UPLOAD_MAX_BLOBS (default 10000) live uploads per account.
 *  - Uploads into a read-only account (READ_ONLY delegation / shared mailbox)
 *    are refused (403 forbidden, Blob/upload: accountReadOnly).
 */
import type express from 'express';
import { envLimit } from '@coremail/core';
import { RequestError } from './errors.js';
import type { AccountContext, JmapUser } from './types.js';

/** In-memory counter of concurrent operations per key (one process). */
export class ConcurrencyGate {
  private readonly active = new Map<string, number>();

  count(key: string): number {
    return this.active.get(key) ?? 0;
  }

  /** Returns a release function, or null when `max` operations are already running. */
  tryAcquire(key: string, max: number): (() => void) | null {
    const n = this.count(key);
    if (max > 0 && n >= max) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.count(key) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
}

export const apiRequestGate = new ConcurrencyGate();
export const uploadGate = new ConcurrencyGate();

export function limitError(limit: string): RequestError {
  return new RequestError('limit', 400, `Too many concurrent requests (${limit})`, { limit });
}

/**
 * Express middleware (after authentication): at most `max()` concurrent
 * requests per user through this gate; the slot is freed when the response
 * finished or the connection closed.
 */
export function concurrencyLimit(gate: ConcurrencyGate, max: () => number, limit: string): express.RequestHandler {
  return (req, res, next) => {
    const user = (req as express.Request & { jmapUser?: JmapUser }).jmapUser;
    if (!user) { next(); return; }
    const release = gate.tryAcquire(user.userId, max());
    if (!release) {
      const err = limitError(limit);
      res.status(err.status).type('application/problem+json').send(JSON.stringify(err.toJson()));
      return;
    }
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

// ─── Upload quota ────────────────────────────────────────────────────────────

const UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000;

export function uploadQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = envLimit('JMAP_UPLOAD_QUOTA_MB', 500, env);
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

export function uploadMaxBlobs(env: NodeJS.ProcessEnv = process.env): number {
  return envLimit('JMAP_UPLOAD_MAX_BLOBS', 10_000, env);
}

/** Minimal Redis surface (ioredis compatible). */
export interface QuotaRedis {
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

export class UploadQuotaError extends Error {
  constructor(public readonly used: number, public readonly quota: number, public readonly blobs: boolean) {
    super(blobs ? 'Too many live uploads for this account' : 'Upload quota exceeded');
  }
}

export class UploadReadOnlyError extends Error {
  constructor() { super('Account is read-only'); }
}

const usageKey = (accountId: string): string => `jmap:upload:usage:${accountId}`;

/** Read-only accounts get no uploads (RFC 8620: the user may not write there). */
export function assertUploadWritable(account: AccountContext): void {
  if (account.readOnly) throw new UploadReadOnlyError();
}

/**
 * Reserves `size` bytes of the account's upload quota for `blobId` (before the
 * bytes are stored). Throws UploadQuotaError when the quota or the blob count
 * would be exceeded; returns a function that frees the reservation (store failed).
 */
export async function reserveUploadQuota(
  redis: QuotaRedis,
  accountId: string,
  blobId: string,
  size: number,
  opts: { quotaBytes?: number; maxBlobs?: number; now?: number } = {},
): Promise<() => Promise<void>> {
  const quota = opts.quotaBytes ?? uploadQuotaBytes();
  const maxBlobs = opts.maxBlobs ?? uploadMaxBlobs();
  if (quota <= 0 && maxBlobs <= 0) return async () => undefined;
  const now = opts.now ?? Date.now();
  const key = usageKey(accountId);
  const member = `${blobId}:${size}`;
  await redis.zremrangebyscore(key, '-inf', now);
  await redis.zadd(key, now + UPLOAD_TTL_MS, member);
  await redis.pexpire(key, UPLOAD_TTL_MS);
  const members = await redis.zrange(key, 0, -1);
  let used = 0;
  for (const m of members) used += Number(m.slice(m.lastIndexOf(':') + 1)) || 0;
  const tooMany = maxBlobs > 0 && members.length > maxBlobs;
  if ((quota > 0 && used > quota) || tooMany) {
    await redis.zrem(key, member);
    throw new UploadQuotaError(used - size, quota, tooMany);
  }
  return async () => { await redis.zrem(key, member); };
}
