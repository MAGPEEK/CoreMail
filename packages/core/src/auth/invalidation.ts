/**
 * Credential / session invalidation bus (v7.1.0).
 *
 * Every event that changes whether a user's credentials or sessions are still
 * valid (password change or reset, MFA enabled/disabled/changed, app password
 * created/revoked, user deactivated/deleted/role changed, sessions revoked)
 * publishes an AuthInvalidationEvent on CHANNEL_AUTH_INVALIDATE. Every
 * in-process cache of authentication results subscribes and drops the entries
 * of that user immediately; caches keep a short TTL as a fallback for lost
 * messages (Redis outage).
 *
 *   publish:   await publishAuthInvalidation({ userId, reason }, { redis })
 *   consume:   onAuthInvalidation((e) => cache.invalidateUser(e.userId))
 *   transport: startAuthInvalidationSubscriber()   (once per service, at start)
 *
 * publishAuthInvalidation() dispatches to the local handlers synchronously and
 * then publishes via Redis; the subscriber dispatches remote events to the same
 * handlers. Handlers must therefore be idempotent (events from the own process
 * arrive twice).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getRedisClient } from '../redis/index.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('auth:invalidate');

/** Redis pub/sub channel for credential/session invalidation events. */
export const CHANNEL_AUTH_INVALIDATE = 'auth:invalidate';

export type AuthInvalidationReason =
  | 'password-change' | 'password-reset' | 'admin-password-reset'
  | 'mfa-change' | 'app-password-created' | 'app-password-revoked'
  | 'deactivated' | 'deleted' | 'role-change' | 'sessions-revoked'
  | (string & {});

export interface AuthInvalidationEvent {
  userId: string;
  reason: AuthInvalidationReason;
  /** Sessions whose access tokens are revoked (session revocation). */
  sessionIds?: string[];
  /**
   * "Access tokens issued before `before` (s) are revoked, except those of
   * session `except`" — mirrors revokeAllSessions() in other processes.
   */
  revokeBefore?: { before: number; except: string | null; expires: number };
  /** app-password-revoked: the revoked app password (live connections using it end). */
  appPasswordId?: string;
  /** All app passwords of the user were deleted together with the sessions. */
  appPasswordsRevoked?: boolean;
}

export type AuthInvalidationHandler = (event: AuthInvalidationEvent) => void;

/** Minimal publishing surface (ioredis compatible). */
export interface AuthInvalidationPublisher {
  publish?: (channel: string, message: string) => Promise<unknown>;
}

/** Minimal subscribing surface (ioredis compatible). */
export interface AuthInvalidationSubscriber {
  subscribe(channel: string): Promise<unknown> | unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  unsubscribe?(channel: string): Promise<unknown> | unknown;
  removeListener?(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

const handlers = new Set<AuthInvalidationHandler>();

/** Registers a handler (local + remote events). Returns an unregister function. */
export function onAuthInvalidation(handler: AuthInvalidationHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/** Delivers an event to all local handlers. A failing handler never stops the others. */
export function dispatchAuthInvalidation(event: AuthInvalidationEvent): void {
  for (const h of handlers) {
    try {
      h(event);
    } catch (err) {
      log.error({ err, userId: event.userId }, 'auth invalidation handler failed');
    }
  }
}

/** Validates an incoming message; null for anything that is not a well-formed event. */
export function parseAuthInvalidationEvent(message: string): AuthInvalidationEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['userId'] !== 'string' || !r['userId']) return null;
  const event: AuthInvalidationEvent = {
    userId: r['userId'],
    reason: typeof r['reason'] === 'string' ? r['reason'] : 'unknown',
  };
  if (Array.isArray(r['sessionIds'])) {
    const ids = r['sessionIds'].filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length > 0) event.sessionIds = ids;
  }
  const rb = r['revokeBefore'] as Record<string, unknown> | undefined;
  if (rb && typeof rb === 'object' && typeof rb['before'] === 'number' && typeof rb['expires'] === 'number') {
    event.revokeBefore = {
      before: rb['before'],
      except: typeof rb['except'] === 'string' ? rb['except'] : null,
      expires: rb['expires'],
    };
  }
  if (typeof r['appPasswordId'] === 'string' && r['appPasswordId']) event.appPasswordId = r['appPasswordId'];
  if (r['appPasswordsRevoked'] === true) event.appPasswordsRevoked = true;
  return event;
}

declare global {
  // eslint-disable-next-line no-var
  var __authInvalidationRedis: AuthInvalidationPublisher | null | undefined;
}

/**
 * Publishes an invalidation event: local handlers first (synchronously), then
 * Redis. Never throws — a Redis failure is logged; remote caches then fall
 * back to their TTL. `opts.redis` = the publishing client (default:
 * globalThis.__authInvalidationRedis, then the shared Redis client). A client
 * without `publish` (in-memory test fakes) only dispatches locally.
 */
export async function publishAuthInvalidation(
  event: AuthInvalidationEvent,
  opts: { redis?: AuthInvalidationPublisher | null } = {},
): Promise<void> {
  dispatchAuthInvalidation(event);
  let client: AuthInvalidationPublisher | null | undefined = opts.redis;
  if (client === undefined) {
    client = globalThis.__authInvalidationRedis !== undefined
      ? globalThis.__authInvalidationRedis
      : (getRedisClient() as unknown as AuthInvalidationPublisher);
  }
  if (!client || typeof client.publish !== 'function') return;
  try {
    await client.publish(CHANNEL_AUTH_INVALIDATE, JSON.stringify(event));
  } catch (err) {
    log.warn({ err, userId: event.userId, reason: event.reason },
      'Could not publish the auth invalidation event — remote caches fall back to their TTL');
  }
}

let activeSubscriber: { stop: () => void } | null = null;

/**
 * Subscribes to CHANNEL_AUTH_INVALIDATE and dispatches remote events to the
 * local handlers. Idempotent per process (a second call returns the first
 * subscription's stop function). Default transport: a duplicate of the shared
 * Redis client (a subscribed connection cannot run other commands).
 */
export function startAuthInvalidationSubscriber(
  opts: { subscriber?: AuthInvalidationSubscriber } = {},
): () => void {
  if (activeSubscriber) return activeSubscriber.stop;
  const sub: AuthInvalidationSubscriber = opts.subscriber
    ?? (getRedisClient().duplicate() as unknown as AuthInvalidationSubscriber);
  const listener = (channel: string, message: string): void => {
    if (channel !== CHANNEL_AUTH_INVALIDATE) return;
    const event = parseAuthInvalidationEvent(message);
    if (event) dispatchAuthInvalidation(event);
    else log.warn('Ignoring malformed auth invalidation message');
  };
  sub.on('message', listener);
  void Promise.resolve(sub.subscribe(CHANNEL_AUTH_INVALIDATE)).catch((err: unknown) => {
    log.error({ err }, 'Could not subscribe to auth invalidation events — caches rely on their TTL');
  });
  const stop = (): void => {
    sub.removeListener?.('message', listener);
    void Promise.resolve(sub.unsubscribe?.(CHANNEL_AUTH_INVALIDATE)).catch(() => undefined);
    activeSubscriber = null;
  };
  activeSubscriber = { stop };
  return stop;
}

// ── Credential cache ──────────────────────────────────────────────────────────

export interface CredentialCacheOptions {
  /** Fallback lifetime of an entry (ms). Default 60 s. */
  ttlMs?: number;
  /** Maximum number of entries (oldest are evicted). Default 5000. */
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry<T> { userId: string; value: T; expires: number }

/**
 * In-memory cache of successful credential checks (login + secret → user).
 *
 * - Keys are HMAC-SHA256(login, secret) under a random per-process key: neither
 *   the plaintext secret nor an unkeyed (offline-crackable) hash is kept.
 * - invalidateUser() drops every entry of a user; a lookup that started before
 *   the invalidation cannot re-insert a stale result afterwards (set() is
 *   given the lookup's start time).
 * - Entries expire after `ttlMs` as a fallback for missed invalidation events.
 */
export class CredentialCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly invalidatedAt = new Map<string, number>();
  private readonly hmacKey = randomBytes(32);
  readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: CredentialCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Cache key for (login, secret) — never contains the secret. */
  key(login: string, secret: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(login.trim().toLowerCase()).update('\u0000').update(secret)
      .digest('hex');
  }

  get(login: string, secret: string): T | undefined {
    const k = this.key(login, secret);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.remove(k); return undefined; }
    return e.value;
  }

  /**
   * Stores a successful check. `startedAt` = time the check began; the result
   * is discarded when the user was invalidated meanwhile.
   */
  set(login: string, secret: string, userId: string, value: T, startedAt: number = this.now()): void {
    const inv = this.invalidatedAt.get(userId);
    if (inv !== undefined && inv >= startedAt) return;
    const k = this.key(login, secret);
    this.remove(k);
    if (this.entries.size >= this.maxEntries) this.evict();
    this.entries.set(k, { userId, value, expires: this.now() + this.ttlMs });
    let set = this.byUser.get(userId);
    if (!set) { set = new Set(); this.byUser.set(userId, set); }
    set.add(k);
  }

  /** Drops all entries of a user. Returns the number of dropped entries. */
  invalidateUser(userId: string): number {
    const now = this.now();
    this.invalidatedAt.set(userId, now);
    if (this.invalidatedAt.size > this.maxEntries) {
      for (const [u, t] of this.invalidatedAt) if (t + this.ttlMs < now) this.invalidatedAt.delete(u);
    }
    const keys = this.byUser.get(userId);
    if (!keys) return 0;
    for (const k of keys) this.entries.delete(k);
    this.byUser.delete(userId);
    return keys.size;
  }

  clear(): void {
    this.entries.clear();
    this.byUser.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Internal keys (tests: verify that no plaintext is stored). */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Subscribes this cache to invalidation events. Returns an unregister function. */
  attachInvalidation(): () => void {
    return onAuthInvalidation((e) => { this.invalidateUser(e.userId); });
  }

  private remove(k: string): void {
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    const set = this.byUser.get(e.userId);
    if (set) {
      set.delete(k);
      if (set.size === 0) this.byUser.delete(e.userId);
    }
  }

  private evict(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expires <= now) this.remove(k);
    // Still full: drop the oldest insertions (Map keeps insertion order).
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.remove(k);
    }
  }
}
