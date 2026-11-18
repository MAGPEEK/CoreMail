/**
 * Authentication of MAPI over HTTP requests: HTTP Basic with the shared
 * mail-protocol check (verifyMailCredentials, protocol `mapi`: MFA accounts
 * need an app password, shared lockout, LDAP verifier, protocol switch after
 * the password). Every request carries credentials; successful checks are
 * cached (HMAC-keyed CredentialCache, dropped on every credential/switch
 * change of the user). Basic over a connection the gateway verified as plain
 * HTTP is refused unless MAPI_ALLOW_PLAIN_HTTP=true (test setups).
 * NTLM / Negotiate follow in a later package.
 */
import { CredentialCache, createLogger } from '@coremail/core';
import { isProtocolAllowed, verifyMailCredentials } from '@coremail/storage';
import type { SessionAuth } from '../session/session.js';

const log = createLogger('mapi:auth');

export type AuthOutcome =
  | { ok: true; auth: SessionAuth; startedAt: number }
  | { ok: false; status: 401 | 403 | 429 | 503; reason: string; retryAfterSec?: number; userId?: string };

export const BASIC_CHALLENGE = 'Basic realm="CoreMail"';

const cache = new CredentialCache<SessionAuth>({ ttlMs: 60_000, maxEntries: 5000 });
cache.attachInvalidation();

/** Test helper. */
export function clearAuthCache(): void {
  cache.clear();
}

export interface TransportInfo {
  ip: string;
  /** The gateway verified that the client connection was plain HTTP. */
  plainHttp: boolean;
}

function parseBasic(header: string | undefined): { login: string; password: string } | null {
  if (!header || !/^basic\s/i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

async function switchAllows(auth: SessionAuth): Promise<boolean | 'error'> {
  try {
    return await isProtocolAllowed({ id: auth.user.userId, domainId: auth.user.domainId }, 'mapi');
  } catch (err) {
    log.error({ err, userId: auth.user.userId }, 'MAPI switch not readable');
    return 'error';
  }
}

export async function authenticate(header: string | undefined, transport: TransportInfo): Promise<AuthOutcome> {
  const creds = parseBasic(header);
  if (!creds) return { ok: false, status: 401, reason: 'credentials required' };
  if (transport.plainHttp && process.env['MAPI_ALLOW_PLAIN_HTTP'] !== 'true') {
    return { ok: false, status: 403, reason: 'MAPI over HTTP requires HTTPS' };
  }
  const startedAt = Date.now();
  const hit = cache.get(creds.login, creds.password);
  if (hit) {
    const allowed = await switchAllows(hit);
    if (allowed === 'error') return { ok: false, status: 503, reason: 'temporary failure', retryAfterSec: 30 };
    return allowed
      ? { ok: true, auth: hit, startedAt }
      : { ok: false, status: 403, reason: 'MAPI access is disabled for this account', userId: hit.user.userId };
  }

  const r = await verifyMailCredentials(creds.login, creds.password, { ip: transport.ip, protocol: 'mapi' });
  switch (r.status) {
    case 'ok': {
      const auth: SessionAuth = {
        user: { userId: r.user.id, email: r.user.email, displayName: r.user.displayName, domainId: r.user.domainId },
        credential: r.method,
        ...(r.appPasswordId ? { appPasswordId: r.appPasswordId } : {}),
        authKey: cache.key(creds.login, creds.password),
      };
      cache.set(creds.login, creds.password, r.user.id, auth, startedAt);
      return { ok: true, auth, startedAt };
    }
    case 'protocol_disabled':
      return { ok: false, status: 403, reason: 'MAPI access is disabled for this account', userId: r.userId };
    case 'locked':
      return { ok: false, status: 429, reason: 'too many failed logins', retryAfterSec: r.retryAfterSec };
    case 'error':
      return { ok: false, status: 503, reason: 'temporary failure', retryAfterSec: 30 };
    default:
      return { ok: false, status: 401, reason: 'invalid credentials' };
  }
}
