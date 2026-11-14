import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { verifyMailCredentials, clientIpFromRequest } from '@coremail/storage';

const log = createLogger('activesync:auth');

/**
 * ActiveSync Basic auth.
 * v7: shared mail-protocol check — DOMAIN\user / bare user name normalisation,
 * MFA → app passwords only, shared lockout (429 + Retry-After), database
 * errors → 503 (never 401, so devices do not ask for a new password).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'] ?? '';
  if (!/^basic /i.test(authHeader)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  const credentials = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  const colonIdx = credentials.indexOf(':');
  if (colonIdx === -1) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }
  const login = credentials.slice(0, colonIdx);
  const password = credentials.slice(colonIdx + 1);

  const result = await verifyMailCredentials(login, password, {
    ip: clientIpFromRequest(req.socket?.remoteAddress, req.headers['x-forwarded-for']),
    protocol: 'activesync',
  });
  if (result.status === 'locked') {
    res.setHeader('Retry-After', String(result.retryAfterSec));
    res.status(429).send('Too Many Requests');
    return;
  }
  if (result.status === 'error') {
    res.setHeader('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }
  if (result.status !== 'ok') {
    log.warn({ login, status: result.status }, 'EAS auth failed');
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  (req as Request & { easUser: { userId: string; email: string } }).easUser = {
    userId: result.user.id,
    email: result.user.email,
  };
  next();
}
