import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma, verifyMailCredentials, clientIpFromRequest, isProtocolAllowed, isWebmailFeatureEnabled } from '@coremail/storage';
import { isAccessTokenRevokedShared } from '@coremail/storage/auth';

const log = createLogger('caldav:auth');

export interface DavUser {
  userId: string;
  email: string;
}

declare module 'express' {
  interface Request {
    davUser?: DavUser;
  }
}

export async function davAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.get('Authorization') ?? '';

  if (authHeader.startsWith('Bearer ')) {
    const payload = verifyAccessToken(authHeader.slice(7));
    // v7.1.0: tokens of revoked sessions (logout, password change, admin revoke) are refused
    if (payload && !(await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId, payload.iatMs))) {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, active: true, domainId: true },
      });
      if (user?.active) {
        // 9.4: the CalDAV/CardDAV switch applies to tokens as well (unreadable → 503).
        let allowed: boolean;
        try {
          allowed = await isProtocolAllowed({ id: user.id, domainId: user.domainId }, 'dav');
        } catch (err) {
          log.error({ err, userId: user.id }, 'CalDAV/CardDAV switch not readable');
          res.set('Retry-After', '30');
          res.status(503).send('Service Unavailable');
          return;
        }
        if (!allowed) {
          sendDavDisabled(res);
          return;
        }
        req.davUser = { userId: user.id, email: user.email };
        next();
        return;
      }
    }
  }

  // v7: Basic auth uses the shared mail-protocol check (previously a call to
  // the auth-service /auth/login, which rejected app passwords and answered
  // MFA accounts with an MFA challenge). App passwords now work; MFA accounts
  // need an app password; shared lockout; database errors → 503.
  if (/^basic /i.test(authHeader)) {
    const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) {
      const login = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      const result = await verifyMailCredentials(login, password, {
        ip: clientIpFromRequest(req.socket?.remoteAddress, req.headers?.['x-forwarded-for']),
        protocol: 'caldav',
      });
      if (result.status === 'ok') {
        req.davUser = { userId: result.user.id, email: result.user.email };
        next();
        return;
      }
      if (result.status === 'locked') {
        res.set('Retry-After', String(result.retryAfterSec));
        res.status(429).send('Too Many Requests');
        return;
      }
      if (result.status === 'error') {
        log.error({ err: result.error }, 'CalDAV Basic auth: temporary failure');
        res.set('Retry-After', '30');
        res.status(503).send('Service Unavailable');
        return;
      }
      if (result.status === 'protocol_disabled') {
        log.warn({ userId: result.userId }, 'CalDAV/CardDAV request refused — disabled for this account');
        sendDavDisabled(res);
        return;
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="CoreMail CalDAV"');
  res.status(401).send('Unauthorized');
}

/** 9.4 webmail policy: the module a DAV path belongs to (pure; path relative to /dav). */
export function davFeatureOf(path: string): 'calendar' | 'contacts' | null {
  if (path === '/calendars' || path.startsWith('/calendars/')) return 'calendar';
  if (path === '/addressbooks' || path.startsWith('/addressbooks/')) return 'contacts';
  return null;
}

/**
 * 9.4 webmail policy: with the calendar / contacts module off, CalDAV /
 * CardDAV refuse the calendar / address book collections with 403 (the
 * principal stays readable, so clients show "no access" instead of asking for
 * a password again). Unreadable policy → 503.
 */
export async function davFeatureGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const feature = davFeatureOf(req.path);
  if (!feature || !req.davUser) { next(); return; }
  let enabled: boolean;
  try {
    enabled = await isWebmailFeatureEnabled(req.davUser.userId, feature);
  } catch (err) {
    log.error({ err, userId: req.davUser.userId }, 'Webmail policy not readable');
    res.set('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }
  if (enabled) { next(); return; }
  res.status(403).type('text/plain').send(feature === 'calendar'
    ? 'Calendars are disabled for this account'
    : 'Contacts are disabled for this account');
}

/** 9.4: CalDAV/CardDAV switched off for the account — 403, no new password prompt. */
function sendDavDisabled(res: Response): void {
  res.status(403).type('text/plain').send('CalDAV/CardDAV access is disabled for this account');
}
