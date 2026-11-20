import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { verifyMailCredentials, clientIpInfoFromRequest } from '@coremail/storage';
import { sendEasDisabled, type EasCredentialInfo } from './live-sessions.js';
import { parseRequestLine } from './request.js';

const log = createLogger('activesync:auth');

/** 10.5: the request's DeviceId (plain or base64 request line), undefined when absent. */
export function easDeviceIdOf(req: Pick<Request, 'originalUrl' | 'url' | 'get'>): string | undefined {
  try {
    const url = req.originalUrl ?? req.url ?? '';
    const q = url.indexOf('?');
    if (q === -1) return undefined;
    const parsed = parseRequestLine(url.slice(q + 1), (name) => req.get(name));
    if (!parsed.ok) return undefined;
    const id = parsed.line.deviceId;
    return id && id !== 'unknown' ? id.slice(0, 128) : undefined;
  } catch {
    return undefined;
  }
}

export interface EasUser extends EasCredentialInfo {
  userId: string;
  email: string;
}

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

  const authStartedAt = Date.now();
  // 10.5 review: the gateway marks a forwarded IP it could verify (IP_VERIFIED_HEADER)
  const client = clientIpInfoFromRequest(req.socket?.remoteAddress, req.headers);
  const result = await verifyMailCredentials(login, password, {
    ip: client.ip,
    ipTrusted: client.trusted,
    protocol: 'activesync',
    // 10.5: a device that logged in successfully before may still log in while
    // the account is locked by failures from elsewhere (known-client exception) —
    // 10.5 review: only from a known network too (the DeviceId is client-chosen).
    deviceId: easDeviceIdOf(req),
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
  if (result.status === 'protocol_disabled') {
    log.warn({ userId: result.userId }, 'EAS request refused — ActiveSync disabled for this account');
    sendEasDisabled(res);
    return;
  }
  if (result.status !== 'ok') {
    log.warn({ login, status: result.status }, 'EAS auth failed');
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  (req as Request & { easUser: EasUser }).easUser = {
    userId: result.user.id,
    email: result.user.email,
    // v7.1.0: a Ping long-poll ends (401) when these credentials become invalid.
    credential: result.method,
    ...(result.appPasswordId ? { appPasswordId: result.appPasswordId } : {}),
    authStartedAt,
  };
  next();
}
