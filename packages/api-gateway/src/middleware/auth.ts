import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { canAccess, isAdminRole, isReadMethod, type AdminArea, type UserRoleName } from '../lib/rbac.js';

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
  try {
    const payload = verifyAccessToken(rawToken);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.apiUser = { userId: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch (err) {
    // jwt.verify() throws TokenExpiredError, JsonWebTokenError, NotBeforeError etc.
    // → always return 401, never propagate as an unhandled error
    const message = err instanceof Error && err.name === 'TokenExpiredError'
      ? 'Token expired'
      : 'Invalid or expired token';
    log.warn({ err }, 'JWT verification failed');
    res.status(401).json({ error: message });
  }
}

// ── Admin RBAC (v6) ───────────────────────────────────────────────────────────
// Role → area matrix and its documentation: lib/rbac.ts.

const MFA_CHECKED = Symbol('adminMfaChecked');

/**
 * v3.18.19 D5: forced 2FA for admins. If the server setting
 * requireMfaForAdmins=true and the user has NO MFA enabled → 403 with
 * code=MFA_REQUIRED. The MFA setup route goes via /auth/mfa (not /admin/*)
 * — no chicken-and-egg lockout. Runs at most once per request.
 */
function enforceAdminMfa(req: Request, res: Response, next: NextFunction): void {
  const flagged = req as Request & { [MFA_CHECKED]?: boolean };
  if (flagged[MFA_CHECKED]) { next(); return; }
  flagged[MFA_CHECKED] = true;
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
        res.status(403).json({ error: 'MFA is required for admin access', code: 'MFA_REQUIRED' });
        return;
      }
      next();
    } catch (err) {
      log.error({ err }, 'MFA enforcement check failed — falling through');
      next();
    }
  })();
}

/** Authenticate (unless an earlier guard already did), check `allowed`, enforce admin MFA. */
function adminGuard(allowed: (role: string, req: Request) => boolean) {
  return function adminGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
    const check = (): void => {
      const role = req.apiUser?.role;
      if (!role || !allowed(role, req)) {
        res.status(403).json({ error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' });
        return;
      }
      enforceAdminMfa(req, res, next);
    };
    if (req.apiUser) check();
    else requireAuth(req, res, check);
  };
}

/**
 * Any admin role (no USER). VIEW_ONLY_ORG only for GET/HEAD.
 * Prefer requireArea() — this is the coarse fallback.
 */
export const requireAdmin = adminGuard((role, req) =>
  isAdminRole(role) && (role !== 'VIEW_ONLY_ORG' || isReadMethod(req.method)));

/**
 * Explicit role list for all methods. ORGANIZATION_MANAGEMENT always passes.
 * Example: router.post('/x', requireRole('SERVER_MANAGEMENT'), handler)
 */
export function requireRole(...roles: UserRoleName[]) {
  return adminGuard((role) => role === 'ORGANIZATION_MANAGEMENT' || (roles as string[]).includes(role));
}

/**
 * Area guard based on AREA_MATRIX (method-aware: read roles get GET/HEAD only).
 * `extra` may grant additional, narrowly scoped access (e.g. HELP_DESK
 * password reset); the route must then enforce its own limits.
 */
export function requireArea(area: AdminArea, extra?: (role: string, req: Request) => boolean) {
  return adminGuard((role, req) => canAccess(role, area, req.method) || (!!extra && isAdminRole(role) && extra(role, req)));
}
