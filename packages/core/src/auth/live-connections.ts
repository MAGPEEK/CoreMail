/**
 * Live (long-lived) authenticated connections and credential invalidation
 * (v7.0.1).
 *
 * Protocol servers keep authenticated connections open for a long time (IMAP
 * IDLE, POP3, SMTP submission, ActiveSync Ping, JMAP WebSocket/EventSource).
 * A credential change must not leave such a connection authenticated. Each
 * service registers its authenticated connections in a LiveConnectionRegistry
 * (per-connection user id + which credential was used) and attaches the
 * registry to the auth invalidation bus (onAuthInvalidation). On an event,
 * connectionAffected() decides which connections are terminated; terminate()
 * is protocol specific (IMAP BYE, POP3 -ERR, SMTP 421, EAS 401, WS close).
 */
import { onAuthInvalidation, type AuthInvalidationEvent } from './invalidation.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('auth:live');

/**
 * How a connection authenticated:
 *  - password      the account password (local hash)
 *  - app_password  an app password (`appPasswordId` when known)
 *  - external      a directory password (LDAP …)
 *  - token         a web session access token (`sessionId`, `issuedAt`)
 *  - unknown       not known — treated like the strictest case
 */
export type LiveCredential = 'password' | 'app_password' | 'external' | 'token' | 'unknown';

export interface LiveConnection {
  userId: string;
  credential?: LiveCredential;
  appPasswordId?: string;
  /** Web session of a token-authenticated connection. */
  sessionId?: string;
  /** `iat` (seconds) of the access token of a token-authenticated connection. */
  issuedAt?: number;
  /** Ends the connection (protocol specific). Called at most once. */
  terminate(event: AuthInvalidationEvent): void;
}

/** Reasons after which the account password (not app passwords) is no longer valid. */
const PASSWORD_REASONS = new Set([
  'password-change', 'password-reset', 'admin-password-reset', 'password-reset-by-mail',
]);

/** Reasons that do not invalidate any existing credential. */
const NEUTRAL_REASONS = new Set(['app-password-created', 'reactivated']);

/** The account itself is gone or disabled — every connection ends. */
const ACCOUNT_REASONS = new Set(['deactivated', 'deleted']);

/**
 * Decides whether an invalidation event ends a live connection.
 *
 * - token connections end when their web session is revoked (session id in
 *   `sessionIds`, or a "revoke all" mark that does not exempt their session)
 *   or the account is deactivated/deleted;
 * - app-password-revoked ends connections that used THAT app password
 *   (connections whose app password id is unknown end as well);
 * - mfa-change ends connections that used the account password
 *   (MFA accounts may only use app passwords on the mail protocols);
 * - password change/reset ends password connections; app-password
 *   connections only when the app passwords were deleted as well;
 * - single web-session revocations, role changes, app password creation and
 *   reactivation do not affect protocol connections;
 * - every other "revoke all sessions" reason (deactivation, deletion, LDAP
 *   sync, admin revoke, unknown reasons) ends every connection of the user.
 */
export function connectionAffected(event: AuthInvalidationEvent, conn: LiveConnection): boolean {
  if (event.userId !== conn.userId) return false;
  const reason = String(event.reason);
  const credential = conn.credential ?? 'unknown';

  if (credential === 'token') {
    if (conn.sessionId && event.sessionIds?.includes(conn.sessionId)) return true;
    if (event.revokeBefore) {
      if (event.revokeBefore.except && conn.sessionId === event.revokeBefore.except) return false;
      return conn.issuedAt === undefined || conn.issuedAt < event.revokeBefore.before;
    }
    return ACCOUNT_REASONS.has(reason);
  }

  if (NEUTRAL_REASONS.has(reason) || reason === 'role-change') return false;
  if (reason === 'sessions-revoked' && !event.revokeBefore) return false; // single web sessions
  if (reason === 'app-password-revoked') {
    if (credential === 'password' || credential === 'external') return false;
    if (credential === 'unknown' || !event.appPasswordId || !conn.appPasswordId) return true;
    return conn.appPasswordId === event.appPasswordId;
  }
  if (reason === 'mfa-change') return credential !== 'app_password';
  if (PASSWORD_REASONS.has(reason)) return credential !== 'app_password' || event.appPasswordsRevoked === true;
  return true;
}

/**
 * Registry of a service's live authenticated connections, indexed by user.
 * register() returns the unregister function (call it when the connection
 * closes). attachInvalidation() subscribes the registry to the bus; events
 * from the own process arrive twice (local + Redis) — a terminated connection
 * is removed on the first one.
 */
export class LiveConnectionRegistry {
  private readonly byUser = new Map<string, Set<LiveConnection>>();
  /** Recent events per user — a login that was checked before an event but registers after it. */
  private readonly recent = new Map<string, Array<{ at: number; event: AuthInvalidationEvent }>>();
  private readonly now: () => number;
  /** How long events are remembered for late registrations (ms). */
  private readonly recentMs: number;

  constructor(private readonly name = 'live', opts: { now?: () => number; recentMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.recentMs = opts.recentMs ?? 120_000;
  }

  /**
   * Registers an authenticated connection. `authStartedAt` = when the
   * credential check began: an affecting event that arrived since then (the
   * check may have read the old credentials) terminates the connection right
   * away (asynchronously, after the caller has finished its reply).
   */
  register(conn: LiveConnection, authStartedAt?: number): () => void {
    if (authStartedAt !== undefined) {
      const cutoff = Math.max(authStartedAt, this.now() - this.recentMs);
      const missed = (this.recent.get(conn.userId) ?? [])
        .find((r) => r.at >= cutoff && connectionAffected(r.event, conn));
      if (missed) {
        queueMicrotask(() => {
          try { conn.terminate(missed.event); } catch (err) {
            log.error({ err, registry: this.name, userId: conn.userId }, 'terminating a live connection failed');
          }
        });
        return () => undefined;
      }
    }
    let set = this.byUser.get(conn.userId);
    if (!set) { set = new Set(); this.byUser.set(conn.userId, set); }
    set.add(conn);
    return () => this.remove(conn);
  }

  /** Terminates and removes the connections affected by `event`. Returns their number. */
  terminateAffected(event: AuthInvalidationEvent): number {
    this.remember(event);
    const set = this.byUser.get(event.userId);
    if (!set) return 0;
    let n = 0;
    for (const conn of [...set]) {
      if (!connectionAffected(event, conn)) continue;
      this.remove(conn);
      n++;
      try {
        conn.terminate(event);
      } catch (err) {
        log.error({ err, registry: this.name, userId: event.userId }, 'terminating a live connection failed');
      }
    }
    if (n > 0) log.info({ registry: this.name, userId: event.userId, reason: event.reason, connections: n }, 'Live connections terminated after a credential change');
    return n;
  }

  /** Number of registered connections (of one user, or in total). */
  count(userId?: string): number {
    if (userId !== undefined) return this.byUser.get(userId)?.size ?? 0;
    let n = 0;
    for (const s of this.byUser.values()) n += s.size;
    return n;
  }

  /** Subscribes to invalidation events. Returns an unregister function. */
  attachInvalidation(): () => void {
    return onAuthInvalidation((e) => { this.terminateAffected(e); });
  }

  private remember(event: AuthInvalidationEvent): void {
    const now = this.now();
    const cutoff = now - this.recentMs;
    if (this.recent.size > 10_000) {
      for (const [u, list] of this.recent) if ((list[list.length - 1]?.at ?? 0) < cutoff) this.recent.delete(u);
    }
    const list = (this.recent.get(event.userId) ?? []).filter((r) => r.at >= cutoff);
    list.push({ at: now, event });
    this.recent.set(event.userId, list.slice(-20));
  }

  private remove(conn: LiveConnection): void {
    const set = this.byUser.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byUser.delete(conn.userId);
  }
}
