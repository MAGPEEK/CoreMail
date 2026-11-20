/**
 * Authentication of MAPI over HTTP requests: HTTP Basic with the shared
 * mail-protocol check (verifyMailCredentials, protocol `mapi`: MFA accounts
 * need an app password, shared lockout, LDAP verifier, protocol switch after
 * the password). Every request carries credentials; successful checks are
 * cached (HMAC-keyed CredentialCache, dropped on every credential/switch
 * change of the user). Basic over a connection the gateway verified as plain
 * HTTP is refused unless MAPI_ALLOW_PLAIN_HTTP=true (test setups).
 * A locked account (shared lockout) and a temporary failure are answered
 * 503 + Retry-After — never 401, which would make the client ask for the
 * password again (MS-OXCMAPIHTTP 2.2.2.2: 5xx for exceptional conditions).
 *
 * 9.5 review: a cached check is also dropped when the account got a
 * "revoke all" mark after it (deactivation, deletion, password reset … —
 * the Redis mark revokeAllSessions sets, shared by every instance), so a
 * deactivated account loses MAPI access at once even when this instance
 * missed the invalidation message; the credentials are then checked again.
 */
import { CredentialCache, createLogger } from '@coremail/core';
import { isProtocolAllowed, verifyMailCredentials, type MailAuthResult } from '@coremail/storage';
import { isAccessTokenRevokedShared } from '@coremail/storage/auth';
import type { SessionAuth } from '../session/session.js';

const log = createLogger('mapi:auth');

export type AuthOutcome =
  | { ok: true; auth: SessionAuth; startedAt: number }
  | { ok: false; status: 401 | 403 | 503; reason: string; retryAfterSec?: number; userId?: string };

export const BASIC_CHALLENGE = 'Basic realm="CoreMail"';

export interface TransportInfo {
  ip: string;
  /** The gateway verified that the client connection was plain HTTP. */
  plainHttp: boolean;
}

/** A successful credential check and when it began. */
export interface CachedAuth { auth: SessionAuth; verifiedAt: number }

export interface AuthDeps {
  verify(login: string, password: string, ctx: { ip: string; protocol: 'mapi' }): Promise<MailAuthResult>;
  /** The `mapi` switch of the account (throws when unreadable). */
  switchAllows(auth: SessionAuth): Promise<boolean>;
  /** A "revoke all" mark of the account newer than `verifiedAt` (ms) exists. */
  revokedSince(userId: string, verifiedAt: number): Promise<boolean>;
  allowPlainHttp(): boolean;
  cache: CredentialCache<CachedAuth>;
  now(): number;
}

export type Authenticator = (header: string | undefined, transport: TransportInfo) => Promise<AuthOutcome>;

function parseBasic(header: string | undefined): { login: string; password: string } | null {
  if (!header || !/^basic\s/i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

const TEMPORARY: AuthOutcome = { ok: false, status: 503, reason: 'temporary failure', retryAfterSec: 30 };

export function createAuthenticator(deps: AuthDeps): Authenticator {
  async function switchOutcome(auth: SessionAuth, startedAt: number): Promise<AuthOutcome> {
    let allowed: boolean;
    try {
      allowed = await deps.switchAllows(auth);
    } catch (err) {
      log.error({ err, userId: auth.user.userId }, 'MAPI switch not readable');
      return TEMPORARY;
    }
    return allowed
      ? { ok: true, auth, startedAt }
      : { ok: false, status: 403, reason: 'MAPI access is disabled for this account', userId: auth.user.userId };
  }

  /** The cached check, unless the account was revoked since (then it is dropped). */
  async function cached(login: string, password: string): Promise<CachedAuth | undefined> {
    const hit = deps.cache.get(login, password);
    if (!hit) return undefined;
    if (!(await deps.revokedSince(hit.auth.user.userId, hit.verifiedAt))) return hit;
    deps.cache.invalidateUser(hit.auth.user.userId);
    return undefined;
  }

  return async (header, transport) => {
    const creds = parseBasic(header);
    if (!creds) return { ok: false, status: 401, reason: 'credentials required' };
    if (transport.plainHttp && !deps.allowPlainHttp()) {
      return { ok: false, status: 403, reason: 'MAPI over HTTP requires HTTPS' };
    }
    const startedAt = deps.now();
    const hit = await cached(creds.login, creds.password);
    if (hit) return switchOutcome(hit.auth, startedAt);

    const r = await deps.verify(creds.login, creds.password, { ip: transport.ip, protocol: 'mapi' });
    switch (r.status) {
      case 'ok': {
        const auth: SessionAuth = {
          user: { userId: r.user.id, email: r.user.email, displayName: r.user.displayName, domainId: r.user.domainId },
          credential: r.method,
          ...(r.appPasswordId ? { appPasswordId: r.appPasswordId } : {}),
          authKey: deps.cache.key(creds.login, creds.password),
        };
        deps.cache.set(creds.login, creds.password, r.user.id, { auth, verifiedAt: startedAt }, startedAt);
        return { ok: true, auth, startedAt };
      }
      case 'protocol_disabled':
        return { ok: false, status: 403, reason: 'MAPI access is disabled for this account', userId: r.userId };
      case 'locked':
        return { ok: false, status: 503, reason: 'too many failed logins', retryAfterSec: r.retryAfterSec };
      case 'error':
        return TEMPORARY;
      default:
        return { ok: false, status: 401, reason: 'invalid credentials' };
    }
  };
}

const cache = new CredentialCache<CachedAuth>({ ttlMs: 60_000, maxEntries: 5000 });
cache.attachInvalidation();

export const authenticate: Authenticator = createAuthenticator({
  verify: (login, password, ctx) => verifyMailCredentials(login, password, ctx),
  switchAllows: (auth) => isProtocolAllowed({ id: auth.user.userId, domainId: auth.user.domainId }, 'mapi'),
  revokedSince: (userId, verifiedAt) => isAccessTokenRevokedShared(userId, Math.floor(verifiedAt / 1000), undefined, verifiedAt),
  allowPlainHttp: () => process.env['MAPI_ALLOW_PLAIN_HTTP'] === 'true',
  cache,
  now: () => Date.now(),
});
