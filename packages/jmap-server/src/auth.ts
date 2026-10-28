/**
 * JMAP-Authentifizierung.
 *  - Bearer: Session-JWT (HS256, @coremail/core) — MWA/BCP und Web-Clients.
 *    Für EventSource/WebSocket (kein Header möglich) auch `?access_token=`.
 *  - Basic:  E-Mail + Passwort bzw. App-Passwort (Pflicht bei aktivem MFA).
 *    LDAP/OIDC-User ohne lokalen Hash → Login über auth-service.
 * Basic-Ergebnisse werden 60s im Speicher gecacht (JMAP-Clients senden viele
 * kleine Requests; bcrypt pro Request wäre zu teuer).
 */
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { verifyAccessToken, verifyPassword, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import type { JmapUser } from './types.js';

const log = createLogger('jmap:auth');
const AUTH_SERVICE_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';

declare module 'express' {
  interface Request {
    jmapUser?: JmapUser;
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

export async function authenticateBasic(email: string, password: string): Promise<JmapUser | null> {
  const key = cacheKey(email.toLowerCase(), password);
  const hit = basicCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.user;

  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), active: true },
    select: {
      id: true, email: true, displayName: true, domainId: true, role: true,
      passwordHash: true, authSource: true,
      mfa: { select: { totpEnabled: true, webAuthnCredentials: true } },
      appPasswords: { select: { id: true, hash: true } },
    },
  });
  if (!user) return null;

  const hasMfa = !!(user.mfa?.totpEnabled
    || (Array.isArray(user.mfa?.webAuthnCredentials) && (user.mfa.webAuthnCredentials as unknown[]).length > 0));

  let ok = false;
  // 1) App-Passwörter (immer erlaubt — einziger Weg bei MFA)
  for (const ap of user.appPasswords) {
    if (await verifyPassword(password, ap.hash).catch(() => false)) {
      ok = true;
      void prisma.appPassword.update({ where: { id: ap.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      break;
    }
  }
  // 2) Primär-Passwort nur ohne MFA
  if (!ok && !hasMfa && user.passwordHash) {
    ok = await verifyPassword(password, user.passwordHash).catch(() => false);
  }
  // 3) LDAP/OIDC: auth-service fragen
  if (!ok && !hasMfa && user.authSource !== 'LOCAL') {
    try {
      const resp = await fetch(`${AUTH_SERVICE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password }),
        signal: AbortSignal.timeout(5000),
      });
      ok = resp.ok;
    } catch (err) {
      log.warn({ err }, 'auth-service nicht erreichbar');
    }
  }
  if (!ok) return null;

  const jmapUser: JmapUser = {
    userId: user.id, email: user.email, displayName: user.displayName, domainId: user.domainId, role: user.role,
  };
  basicCache.set(key, { user: jmapUser, expires: Date.now() + 60_000 });
  if (basicCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of basicCache) if (v.expires < now) basicCache.delete(k);
  }
  return jmapUser;
}

/** Credentials aus Authorization-Header oder Token-Query auflösen. */
export async function authenticateCredentials(header: string, tokenQuery: string | undefined): Promise<JmapUser | null> {
  if (header.startsWith('Bearer ')) return authenticateBearer(header.slice(7).trim());
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return authenticateBasic(decoded.slice(0, idx), decoded.slice(idx + 1));
  }
  if (tokenQuery) return authenticateBearer(tokenQuery);
  return null;
}

/** Liest Credentials aus Header oder Query und liefert den User (oder null). */
export async function authenticateRequest(req: Request): Promise<JmapUser | null> {
  const q = req.query['access_token'] ?? req.query['token'];
  return authenticateCredentials(req.get('Authorization') ?? '', typeof q === 'string' && q ? q : undefined);
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
    log.error({ err }, 'Auth-Fehler');
  }
  res.set('WWW-Authenticate', 'Basic realm="CoreMail JMAP", Bearer realm="CoreMail JMAP"');
  res.status(401).type('application/problem+json').send(JSON.stringify({
    type: 'urn:ietf:params:jmap:error:unauthorized',
    status: 401,
    detail: 'Authentication required',
  }));
}
