import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('api:auth');

export interface ApiUser {
  userId: string;
  email: string;
  role: string;
}

declare module 'express' {
  interface Request {
    apiUser?: ApiUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Bevorzugt: Authorization-Header. Fallback: ?token=… in Query
  // (für EventSource/SSE, das keine Header senden kann)
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
  try {
    const payload = verifyAccessToken(rawToken);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.apiUser = { userId: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch (err) {
    // jwt.verify() wirft TokenExpiredError, JsonWebTokenError, NotBeforeError etc.
    // → immer 401 zurückgeben, nie als unhandled error propagieren
    const message = err instanceof Error && err.name === 'TokenExpiredError'
      ? 'Token expired'
      : 'Invalid or expired token';
    log.warn({ err }, 'JWT verification failed');
    res.status(401).json({ error: message });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const adminRoles = ['ADMIN', 'ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'];
    if (!req.apiUser || !adminRoles.includes(req.apiUser.role)) {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
    // v3.18.19 D5: Forced 2FA für Admins. Wenn Server-Setting
    // requireMfaForAdmins=true und User hat KEINE MFA aktiviert → 403 mit
    // code=MFA_REQUIRED. Frontend zeigt Force-Setup-Banner. MFA-Setup-Route
    // läuft über /auth/mfa (nicht /admin/*) — keine Chicken-and-Egg-Sperre.
    void (async () => {
      try {
        const [settings, mfa] = await Promise.all([
          prisma.serverSettings.findUnique({
            where: { id: 'singleton' },
            select: { requireMfaForAdmins: true },
          }),
          prisma.userMfa.findFirst({
            where: { userId: req.apiUser!.userId },
            select: { totpEnabled: true, webAuthnCredentials: true },
          }),
        ]);
        if (!settings?.requireMfaForAdmins) { next(); return; }
        const hasWebauthn = Array.isArray(mfa?.webAuthnCredentials)
          && (mfa.webAuthnCredentials as unknown[]).length > 0;
        const hasMfa = !!(mfa?.totpEnabled || hasWebauthn);
        if (!hasMfa) {
          res.status(403).json({
            error: 'MFA is required for admin access',
            code: 'MFA_REQUIRED',
          });
          return;
        }
        next();
      } catch (err) {
        log.error({ err }, 'MFA enforcement check failed — falling through');
        next();
      }
    })();
  });
}
