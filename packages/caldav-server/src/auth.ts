import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma, verifyMailCredentials, clientIpFromRequest } from '@coremail/storage';
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
    if (payload && !(await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId))) {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, active: true },
      });
      if (user?.active) {
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
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="CoreMail CalDAV"');
  res.status(401).send('Unauthorized');
}
