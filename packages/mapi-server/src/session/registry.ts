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
 *  - At most MAX_SESSIONS_PER_USER sessions per account (the oldest goes).
 */
import { createLogger, type LiveConnectionRegistry } from '@coremail/core';
import { cookieDigest, MapiSession, newCookieValue, type SessionAuth } from './session.js';

const log = createLogger('mapi:sessions');

export const MAX_SESSIONS_PER_USER = 16;
const KEY_PREFIX = 'mapi:ctx:';

/** Minimal Redis surface (ioredis compatible). */
export interface SessionRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  del(key: string): Promise<number>;
}

export interface RegistryDeps {
  redis: SessionRedis;
  live: LiveConnectionRegistry;
  idleMs: number;
  /** Byte budget per session (default DEFAULT_SESSION_MEMORY_BYTES). */
  memoryLimitBytes?: number;
  now?: () => number;
}

interface Entry { session: MapiSession; unregister: () => void }

export class SessionRegistry {
  private readonly byDigest = new Map<string, Entry>();
  private readonly deps: RegistryDeps;
  private readonly now: () => number;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get size(): number { return this.byDigest.size; }

  /** New session; returns it with the two cookie values to send. */
  async create(auth: SessionAuth, authStartedAt: number): Promise<{ session: MapiSession; context: string; sequence: string }> {
    this.evictOldest(auth.user.userId);
    const context = newCookieValue();
    const sequence = newCookieValue();
    const digest = cookieDigest(context);
    const session = new MapiSession(digest, auth, sequence, this.now(), this.deps.memoryLimitBytes);
    await this.deps.redis.set(KEY_PREFIX + digest, JSON.stringify({ userId: auth.user.userId, createdAt: session.createdAt }), 'PX', this.deps.idleMs);
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
    this.byDigest.set(digest, { session, unregister });
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
    return entry.session;
  }

  /** Ends a session: objects released, record deleted, no longer a live connection. */
  async end(session: MapiSession): Promise<void> {
    const entry = this.byDigest.get(session.id);
    session.closed = true;
    session.notificationWait?.abort();
    this.byDigest.delete(session.id);
    entry?.unregister();
    await this.deps.redis.del(KEY_PREFIX + session.id).catch((err: unknown) => log.warn({ err }, 'MAPI context record not deleted'));
  }

  /** Ends sessions idle for longer than the timeout. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.deps.idleMs;
    const idle = [...this.byDigest.values()].filter((e) => e.session.lastUsed < cutoff && !e.session.busy);
    for (const e of idle) await this.end(e.session);
    return idle.length;
  }

  private evictOldest(userId: string): void {
    const own = [...this.byDigest.values()].filter((e) => e.session.user.userId === userId);
    if (own.length < MAX_SESSIONS_PER_USER) return;
    const oldest = own.sort((a, b) => a.session.lastUsed - b.session.lastUsed)[0]!;
    void this.end(oldest.session);
  }
}
