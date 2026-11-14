import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { isAccessTokenRevoked } from '@coremail/storage/auth';

const log = createLogger('api:auth');

export interface ApiUser {
  userId: string;
  email: string;
  role: string;
  /** Session the access token belongs to (v6.0.0). */
  sessionId?: string;
  /** true when the session was established with a second factor (v6.0.0). */
  mfaVerified?: boolean;
}

declare module 'express' {
  interface Request {
    apiUser?: ApiUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Preferred: Authorization header. Fallback: ?token=… in the query
  // (for EventSource/SSE, which cannot send headers)
  const header = req.get('Authorization') ?? '';
  let rawToken: string | null = null;
  if (header.startsWith('Bearer ')) {
    rawToken = header.slice(7);
  } else if (typeof req.query['token'] === 'string' && req.query['token']) {
    rawToken = req.query['token'];
  }
  if (!rawToken) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }
  // verifyAccessToken never throws (returns null for bad/expired/refresh tokens)
  const payload = verifyAccessToken(rawToken);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // v6.0.0: tokens issued before a "revoke all sessions" event (deactivation,
  // password change/reset) are rejected even before they expire.
  if (isAccessTokenRevoked(payload.sub, payload.iat, payload.sessionId)) {
    res.status(401).json({ error: 'Session revoked', code: 'SESSION_REVOKED' });
    return;
  }
  req.apiUser = {
    userId: payload.sub,
    role: payload.role,
    email: payload.email,
    sessionId: payload.sessionId,
    mfaVerified: payload.mfaVerified === true,
  };
  next();
}

const ADMIN_ROLES = ['ADMIN', 'ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'];

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.apiUser || !ADMIN_ROLES.includes(req.apiUser.role)) {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
    // Forced 2FA for admins (ServerSettings.requireMfaForAdmins):
    //   - no MFA enrolled            → 403 MFA_REQUIRED (setup lives under /auth/mfa,
    //                                  outside /admin — no chicken-and-egg lockout)
    //   - enrolled, but this session was not established with MFA
    //                                → 403 MFA_NOT_VERIFIED (log in again)
    // v6.0.0: fails CLOSED on database errors (503) instead of letting admins through.
    const apiUser = req.apiUser;
    void (async () => {
      try {
        const settings = await prisma.serverSettings.findUnique({
          where: { id: 'singleton' },
          select: { requireMfaForAdmins: true },
        });
        if (!settings?.requireMfaForAdmins) { next(); return; }
        const mfa = await prisma.userMfa.findFirst({
          where: { userId: apiUser.userId },
          select: { totpEnabled: true, webAuthnCredentials: true },
        });
        const hasWebauthn = Array.isArray(mfa?.webAuthnCredentials)
          && (mfa.webAuthnCredentials as unknown[]).length > 0;
        if (!(mfa?.totpEnabled || hasWebauthn)) {
          res.status(403).json({ error: 'MFA is required for admin access', code: 'MFA_REQUIRED' });
          return;
        }
        if (!apiUser.mfaVerified) {
          res.status(403).json({
            error: 'This session was not verified with MFA — please log in again',
            code: 'MFA_NOT_VERIFIED',
          });
          return;
        }
        next();
      } catch (err) {
        log.error({ err }, 'MFA enforcement check failed — denying admin access');
        if (!res.headersSent) res.status(503).json({ error: 'Admin access temporarily unavailable' });
      }
    })();
  });
}
