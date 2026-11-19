/**
 * Session contexts (MS-OXCMAPIHTTP 3.2.1): created by Connect, addressed by
 * the MapiContext cookie, ended by Disconnect, idle expiry or a credential /
 * protocol-switch change.
 *
 *  - The context record lives in Redis (`mapi:ctx:<sha256(cookie)>`, TTL =
 *    idle timeout, refreshed per request); the server objects of the session
 *    live in this process. A request needs both — after a restart the client
 *    gets "Context Not Found" and connects again.
 *  - Each session is a live connection (LiveConnectionRegistry, protocol
 *    `mapi`): a password/app-password/MFA change, deactivation or the MAPI
 *    switch turned off ends it at once.
 *  - At most MAX_SESSIONS_PER_USER sessions per account across every MAPI
 *    server instance: the account's sessions are indexed in Redis
 *    (`mapi:user-ctx:<userId>`, sorted set scored by last use); a new session
 *    beyond the cap ends the least recently used one — its context record is
 *    deleted, so the instance holding it ends it on its next request.
 */
import { createLogger, type LiveConnectionRegistry } from '@coremail/core';
import { cookieDigest, MapiSession, newCookieValue, type SessionAuth } from './session.js';
import type { Endpoint } from '../http/envelope.js';

const log = createLogger('mapi:sessions');

export const MAX_SESSIONS_PER_USER = 16;
const KEY_PREFIX = 'mapi:ctx:';
const USER_KEY_PREFIX = 'mapi:user-ctx:';
/** How often a session's last-use score in the account index is refreshed. */
export const INDEX_REFRESH_MS = 60_000;

/** Minimal Redis surface (ioredis compatible). */
export interface SessionRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  del(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  /** Members by ascending score. */
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
}

export interface RegistryDeps {
  redis: SessionRedis;
  live: LiveConnectionRegistry;
  idleMs: number;
  /** Byte budget per session (default DEFAULT_SESSION_MEMORY_BYTES). */
  memoryLimitBytes?: number;
  now?: () => number;
}

interface Entry { session: MapiSession; unregister: () => void; indexedAt: number }

export class SessionRegistry {
  private readonly byDigest = new Map<string, Entry>();
  private readonly deps: RegistryDeps;
  private readonly now: () => number;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get size(): number { return this.byDigest.size; }

  /** Live sessions of one endpoint (the notification bus routes mailbox changes to them). */
  sessionsOf(endpoint: Endpoint): MapiSession[] {
    return [...this.byDigest.values()].map((e) => e.session).filter((s) => !s.closed && s.endpoint === endpoint);
  }

  /** New session of an endpoint (Connect: emsmdb, Bind: nspi); returns it with the two cookie values to send. */
  async create(auth: SessionAuth, authStartedAt: number, endpoint: Endpoint = 'emsmdb'): Promise<{ session: MapiSession; context: string; sequence: string }> {
    const context = newCookieValue();
    const sequence = newCookieValue();
    const digest = cookieDigest(context);
    const session = new MapiSession(digest, auth, sequence, this.now(), this.deps.memoryLimitBytes, endpoint);
    await this.deps.redis.set(KEY_PREFIX + digest, JSON.stringify({ userId: auth.user.userId, createdAt: session.createdAt, endpoint }), 'PX', this.deps.idleMs);
    const unregister = this.deps.live.register({
      userId: auth.user.userId,
      credential: auth.credential,
      ...(auth.appPasswordId ? { appPasswordId: auth.appPasswordId } : {}),
      protocol: 'mapi',
      terminate: (event) => {
        log.info({ userId: auth.user.userId, reason: event.reason }, 'MAPI session ended by a credential change');
        void this.end(session);
      },
    }, authStartedAt);
    this.byDigest.set(digest, { session, unregister, indexedAt: this.now() });
    await this.claimSlot(auth.user.userId, digest);
    return { session, context, sequence };
  }

  /**
   * The live session of a context cookie (refreshes its idle timer), or null.
   * `accept` decides whether the caller may use it (same account/credentials);
   * a session it refuses is returned as null and not refreshed.
   */
  async lookup(contextCookie: string, accept: (s: MapiSession) => boolean = () => true): Promise<MapiSession | null> {
    const digest = cookieDigest(contextCookie);
    const entry = this.byDigest.get(digest);
    if (!entry || entry.session.closed || !accept(entry.session)) return null;
    if (this.now() - entry.session.lastUsed > this.deps.idleMs) { await this.end(entry.session); return null; }
    const alive = await this.deps.redis.pexpire(KEY_PREFIX + digest, this.deps.idleMs);
    if (alive !== 1) { await this.end(entry.session); return null; }
    entry.session.lastUsed = this.now();
    if (entry.session.lastUsed - entry.indexedAt >= INDEX_REFRESH_MS) {
      entry.indexedAt = entry.session.lastUsed;
      await this.index(entry.session.user.userId, digest, entry.indexedAt);
    }
    return entry.session;
  }

  /** Ends a session: objects released, records deleted, no longer a live connection. */
  async end(session: MapiSession): Promise<void> {
    const entry = this.byDigest.get(session.id);
    session.closed = true;
    session.notificationWait?.abort();
    this.byDigest.delete(session.id);
    entry?.unregister();
    await Promise.all([
      this.deps.redis.del(KEY_PREFIX + session.id),
      this.deps.redis.zrem(USER_KEY_PREFIX + session.user.userId, session.id),
    ]).catch((err: unknown) => log.warn({ err }, 'MAPI context record not deleted'));
  }

  /** Ends sessions idle for longer than the timeout. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.deps.idleMs;
    const idle = [...this.byDigest.values()].filter((e) => e.session.lastUsed < cutoff && !e.session.busy);
    for (const e of idle) await this.end(e.session);
    return idle.length;
  }

  /** The live sessions of an account in this process. */
  sessionsOfUser(userId: string): MapiSession[] {
    return [...this.byDigest.values()].map((e) => e.session).filter((s) => !s.closed && s.user.userId === userId);
  }

  private async index(userId: string, digest: string, at: number): Promise<void> {
    const key = USER_KEY_PREFIX + userId;
    await this.deps.redis.zadd(key, at, digest);
    await this.deps.redis.pexpire(key, this.deps.idleMs + INDEX_REFRESH_MS);
  }

  /** Enters the session in the account index and ends the least recently used ones beyond the cap. */
  private async claimSlot(userId: string, digest: string): Promise<void> {
    const key = USER_KEY_PREFIX + userId;
    const now = this.now();
    // Members whose context expired (their instance stopped, or they idled out).
    await this.deps.redis.zremrangebyscore(key, '-inf', now - this.deps.idleMs - INDEX_REFRESH_MS);
    await this.index(userId, digest, now);
    const others = (await this.deps.redis.zrange(key, 0, -1)).filter((d) => d !== digest);
    const excess = others.length + 1 - MAX_SESSIONS_PER_USER;
    for (const old of others.slice(0, Math.max(0, excess))) await this.evict(userId, old);
  }

  private async evict(userId: string, digest: string): Promise<void> {
    const local = this.byDigest.get(digest);
    if (local) { await this.end(local.session); return; }
    await this.deps.redis.zrem(USER_KEY_PREFIX + userId, digest);
    await this.deps.redis.del(KEY_PREFIX + digest);
    log.info({ userId }, 'MAPI session of another instance ended: session limit of the account reached');
  }
}
