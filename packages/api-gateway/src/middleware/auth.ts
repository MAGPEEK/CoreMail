import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { isAccessTokenRevoked } from '@coremail/storage/auth';
import { canAccess, isAdminRole, isReadMethod, type AdminArea, type UserRoleName } from '../lib/rbac.js';

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

// ── Admin RBAC (v6) ───────────────────────────────────────────────────────────
// Role → area matrix and its documentation: lib/rbac.ts. There is no 'ADMIN'
// role (UserRole enum) — admin roles come from lib/rbac.ts only.

const MFA_CHECKED = Symbol('adminMfaChecked');

/**
 * Forced 2FA for admins (ServerSettings.requireMfaForAdmins):
 *   - no MFA enrolled            → 403 MFA_REQUIRED (setup lives under /auth/mfa,
 *                                  outside /admin — no chicken-and-egg lockout)
 *   - enrolled, but this session was not established with MFA
 *                                → 403 MFA_NOT_VERIFIED (log in again)
 * v6.0.0: fails CLOSED on database errors (503) instead of letting admins through.
 * Runs at most once per request.
 */
function enforceAdminMfa(req: Request, res: Response, next: NextFunction): void {
  const flagged = req as Request & { [MFA_CHECKED]?: boolean };
  if (flagged[MFA_CHECKED]) { next(); return; }
  flagged[MFA_CHECKED] = true;
  const apiUser = req.apiUser!;
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
