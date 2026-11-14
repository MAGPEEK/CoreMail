/**
 * JMAP authentication.
 *  - Bearer: session JWT (HS256, @coremail/core) — MWA/BCP and web clients.
 *    For EventSource/WebSocket (no header possible) also `?access_token=`.
 *  - Basic:  e-mail + password or app password (mandatory when MFA is active),
 *    v7: via the shared mail-protocol check verifyMailCredentials() (shared
 *    lockout; LDAP/OIDC users without a local hash → auth-service via the
 *    external-verifier extension point).
 * Basic results are cached in memory for 60s (JMAP clients send many
 * small requests; bcrypt per request would be too expensive).
 */
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { verifyAccessToken, createLogger } from '@coremail/core';
import {
  prisma, verifyMailCredentials, clientIpFromRequest,
} from '@coremail/storage';
import type { JmapUser } from './types.js';

const log = createLogger('jmap:auth');

declare module 'express' {
  interface Request {
    jmapUser?: JmapUser;
  }
}

/** Basic auth could not be decided: lockout (429) or temporary failure (503). */
export class AuthUnavailableError extends Error {
  constructor(readonly reason: 'locked' | 'temporary', readonly retryAfterSec = 30) {
    super(reason === 'locked' ? 'Too many failed login attempts' : 'Temporary authentication failure');
  }
}

const basicCache = new Map<string, { user: JmapUser; expires: number }>();

function cacheKey(email: string, password: string): string {
  return createHash('sha256').update(`${email}\u0000${password}`).digest('hex');
}

async function loadUser(where: { id: string } | { email: string }): Promise<JmapUser | null> {
  const u = await prisma.user.findFirst({
    where: { ...where, active: true },
    select: { id: true, email: true, displayName: true, domainId: true, role: true },
  });
  return u ? { userId: u.id, email: u.email, displayName: u.displayName, domainId: u.domainId, role: u.role } : null;
}

export async function authenticateBearer(token: string): Promise<JmapUser | null> {
  try {
    const payload = verifyAccessToken(token);
    if (!payload?.sub) return null;
    return await loadUser({ id: payload.sub });
  } catch {
    return null;
  }
}

// Directory users (LDAP): the verifier is registered at service start
// (registerLdapMailVerifier() from @coremail/auth-ldap in server.ts).

/**
 * Basic auth (e-mail + password or app password) — v7: shared mail-protocol
 * check (MFA → app passwords only, shared lockout). Failures and lockouts are
 * not cached; `error` (database down) is reported as AuthUnavailableError.
 */
export async function authenticateBasic(email: string, password: string, ip?: string): Promise<JmapUser | null> {
  const key = cacheKey(email.trim().toLowerCase(), password);
  const hit = basicCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.user;

  const result = await verifyMailCredentials(email, password, { ip, protocol: 'jmap' });
  if (result.status === 'error') throw new AuthUnavailableError('temporary');
  if (result.status === 'locked') throw new AuthUnavailableError('locked', result.retryAfterSec);
  if (result.status !== 'ok') return null;
  const user = result.user;

  const jmapUser: JmapUser = {
    userId: user.id, email: user.email, displayName: user.displayName, domainId: user.domainId,
    role: user.role,
  };
  basicCache.set(key, { user: jmapUser, expires: Date.now() + 60_000 });
  if (basicCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of basicCache) if (v.expires < now) basicCache.delete(k);
  }
  return jmapUser;
}

/** Resolve credentials from the Authorization header or token query. */
export async function authenticateCredentials(header: string, tokenQuery: string | undefined, ip?: string): Promise<JmapUser | null> {
  if (header.startsWith('Bearer ')) return authenticateBearer(header.slice(7).trim());
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return authenticateBasic(decoded.slice(0, idx), decoded.slice(idx + 1), ip);
  }
  if (tokenQuery) return authenticateBearer(tokenQuery);
  return null;
}

/** Reads credentials from header or query and returns the user (or null). */
export async function authenticateRequest(req: Request): Promise<JmapUser | null> {
  const q = req.query['access_token'] ?? req.query['token'];
  return authenticateCredentials(
    req.get('Authorization') ?? '',
    typeof q === 'string' && q ? q : undefined,
    clientIpFromRequest(req.socket?.remoteAddress, req.headers['x-forwarded-for']),
  );
}

export async function jmapAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await authenticateRequest(req);
    if (user) {
      req.jmapUser = user;
      next();
      return;
    }
  } catch (err) {
    if (err instanceof AuthUnavailableError) {
      const status = err.reason === 'locked' ? 429 : 503;
      res.set('Retry-After', String(err.retryAfterSec));
      res.status(status).type('application/problem+json').send(JSON.stringify({
        type: 'about:blank', status, detail: err.message,
      }));
      return;
    }
    log.error({ err }, 'Auth error');
  }
  res.set('WWW-Authenticate', 'Basic realm="CoreMail JMAP", Bearer realm="CoreMail JMAP"');
  res.status(401).type('application/problem+json').send(JSON.stringify({
    type: 'urn:ietf:params:jmap:error:unauthorized',
    status: 401,
    detail: 'Authentication required',
  }));
}
