import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger, onAuthInvalidation } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { isAccessTokenRevoked, isAccessTokenRevokedShared } from '@coremail/storage/auth';
import { canAccess, hasAdminAction, isAdminRole, isReadMethod, stricterRole, type AdminAction, type AdminArea, type UserRoleName } from '../lib/rbac.js';
import { redeemEventTicket, type TicketPurpose } from '../lib/event-tickets.js';

// The single role → area permission map (and the narrow action map) the guards
// below use (canAccess → areaAccess, hasAdminAction). Re-exported so routes and
// tests import them from the guard module.
export {
  ROLE_PERMISSIONS, ADMIN_AREAS, ADMIN_ACTIONS, allowedAreas, allowedActions, hasAdminAction,
  type AreaPermission, type AreaAccess, type AdminArea, type AdminAction,
} from '../lib/rbac.js';

const log = createLogger('api:auth');

export interface ApiUser {
  userId: string;
  email: string;
  role: string;
  /** Session the access token belongs to (v7.0.0). */
  sessionId?: string;
  /** true when the session was established with a second factor (v7.0.0). */
  mfaVerified?: boolean;
  /** `iat` (seconds) of the access token (v7.1.0, live-connection termination). */
  issuedAt?: number;
  /** `iatMs` (milliseconds) of the access token (8.0.0). */
  issuedAtMs?: number;
  /** When the token check began (ms) — events since then still end a live connection. */
  authStartedAt?: number;
}

declare module 'express' {
  interface Request {
    apiUser?: ApiUser;
  }
}

/** Claims needed to authenticate a request (from an access token or an SSE ticket). */
export interface AuthClaims {
  sub: string;
  role: string;
  email: string;
  sessionId?: string | undefined;
  mfaVerified?: boolean | undefined;
  iat?: number | undefined;
  iatMs?: number | undefined;
}

/**
 * Bearer token from the Authorization header ONLY (8.0.x). Query-string
 * tokens end up in access logs, proxy logs and browser history; the single
 * exception is the SSE stream (requireSseAuth below), which EventSource opens
 * without custom headers.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('Authorization') ?? '';
  const rawToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!rawToken) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }
  authenticateRawToken(rawToken, req, res, next);
}

/**
 * Auth for GET /api/v1/events (EventSource cannot send headers), in order:
 *   1. Authorization: Bearer header
 *   2. `?ticket=` — single-use, 60 s ticket from POST /api/v1/events/ticket,
 *      bound to the user + session it was issued for (preferred)
 *   3. `?token=` — the access token itself (DEPRECATED, kept for one release so
 *      existing frontends keep working; scheduled for removal)
 */
export function requireSseAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) { authenticateRawToken(header.slice(7), req, res, next); return; }
  const ticket = typeof req.query['ticket'] === 'string' ? req.query['ticket'] : '';
  if (ticket) {
    const authStartedAt = Date.now();
    redeemEventTicket(ticket).then((claims) => {
      if (!claims) { res.status(401).json({ error: 'Invalid or expired ticket' }); return; }
      authenticateClaims(claims, authStartedAt, req, res, next);
    }, (err: unknown) => {
      log.error({ err }, 'SSE ticket redemption failed');
      res.status(503).json({ error: 'Authentication temporarily unavailable' });
    });
    return;
  }
  const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
  if (token) { authenticateRawToken(token, req, res, next); return; }
  res.status(401).json({ error: 'Authorization required' });
}

/**
 * 9.1: Bearer header OR a single-use ticket of `purpose` (?ticket=…) — for GET
 * downloads a browser must open by plain navigation (iOS Safari only hands a
 * .mobileconfig to the profile installer when it navigates to it). Never a raw
 * token in the URL. The ticket carries the claims of the issuing session, so the
 * usual revocation checks apply on redemption.
 */
export function requireTicketAuth(purpose: TicketPurpose) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('Authorization') ?? '';
    if (header.startsWith('Bearer ')) { authenticateRawToken(header.slice(7), req, res, next); return; }
    const ticket = typeof req.query['ticket'] === 'string' ? req.query['ticket'] : '';
    if (!ticket) { res.status(401).json({ error: 'Authorization required' }); return; }
    const authStartedAt = Date.now();
    redeemEventTicket(ticket, purpose).then((claims) => {
      if (!claims) { res.status(401).json({ error: 'Invalid or expired ticket' }); return; }
      authenticateClaims(claims, authStartedAt, req, res, next);
    }, (err: unknown) => {
      log.error({ err, purpose }, 'Ticket redemption failed');
      res.status(503).json({ error: 'Authentication temporarily unavailable' });
    });
  };
}

function authenticateRawToken(rawToken: string, req: Request, res: Response, next: NextFunction): void {
  const authStartedAt = Date.now();
  // verifyAccessToken never throws (returns null for bad/expired/refresh tokens)
  const payload = verifyAccessToken(rawToken);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  authenticateClaims(payload, authStartedAt, req, res, next);
}

function authenticateClaims(payload: AuthClaims, authStartedAt: number, req: Request, res: Response, next: NextFunction): void {
  // v7.0.0: tokens issued before a "revoke all sessions" event (deactivation,
  // password change/reset) are rejected even before they expire.
  // 8.0.0: besides the in-process maps, the shared Redis markers are consulted
  // (short local cache), so a gateway restart or a lost invalidation event cannot
  // revive a revoked token.
  const accept = (): void => {
    req.apiUser = {
      userId: payload.sub,
      role: payload.role,
      email: payload.email,
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      mfaVerified: payload.mfaVerified === true,
      ...(payload.iat !== undefined ? { issuedAt: payload.iat } : {}),
      ...(typeof payload.iatMs === 'number' ? { issuedAtMs: payload.iatMs } : {}),
      authStartedAt,
    };
    next();
  };
  const reject = (): void => {
    res.status(401).json({ error: 'Session revoked', code: 'SESSION_REVOKED' });
  };
  if (isAccessTokenRevoked(payload.sub, payload.iat, payload.sessionId, payload.iatMs)) { reject(); return; }
  // A slow or unreachable Redis must not stall every request: after
  // SHARED_REVOCATION_TIMEOUT_MS the in-process verdict (not revoked) applies —
  // the same fail-open rule as a Redis error inside isAccessTokenRevokedShared.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ userId: payload.sub }, 'Shared revocation check timed out — using the in-process result');
      resolve(false);
    }, SHARED_REVOCATION_TIMEOUT_MS);
  });
  Promise.race([isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId, payload.iatMs), timeout]).then(
    (revoked) => { clearTimeout(timer); if (revoked) reject(); else accept(); },
    (err: unknown) => { clearTimeout(timer); log.error({ err }, 'Revocation check failed'); accept(); },
  );
}

const SHARED_REVOCATION_TIMEOUT_MS = 1_000;

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
 * v7.0.0: fails CLOSED on database errors (503) instead of letting admins through.
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

// ── Current role (v7.1.0) ─────────────────────────────────────────────────────
// The role travels inside the access token (up to JWT_ACCESS_TTL). A role
// change revokes the user's sessions, but an admin guard must not rely on that
// event alone: when a token claims admin rights, the CURRENT role is read from
// the database (short in-process cache, dropped on every auth invalidation
// event of the user) and the stricter of both roles applies.

const ROLE_CACHE_TTL_MS = 15_000;
const roleCache = new Map<string, { role: string | null; expires: number }>();
const roleInvalidatedAt = new Map<string, number>();

onAuthInvalidation((e) => {
  roleCache.delete(e.userId);
  roleInvalidatedAt.set(e.userId, Date.now());
  if (roleInvalidatedAt.size > 10_000) {
    const cutoff = Date.now() - ROLE_CACHE_TTL_MS;
    for (const [u, t] of roleInvalidatedAt) if (t < cutoff) roleInvalidatedAt.delete(u);
  }
});

/** Clears the current-role cache (tests). */
export function clearCurrentRoleCache(): void {
  roleCache.clear();
  roleInvalidatedAt.clear();
}

/** Current role of an active user; null when the user is gone or inactive. Throws on database errors. */
export async function currentRole(userId: string): Promise<string | null> {
  const now = Date.now();
  const hit = roleCache.get(userId);
  if (hit && hit.expires > now) return hit.role;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
  const role = row && row.active !== false ? String(row.role) : null;
  // A lookup that raced with an invalidation is not cached (could be stale).
  if ((roleInvalidatedAt.get(userId) ?? 0) < now) {
    if (roleCache.size > 10_000) roleCache.clear();
    roleCache.set(userId, { role, expires: now + ROLE_CACHE_TTL_MS });
  }
  return role;
}

/** Authenticate (unless an earlier guard already did), check `allowed`, enforce admin MFA. */
function adminGuard(allowed: (role: string, req: Request) => boolean) {
  return function adminGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
    const check = (): void => {
      const apiUser = req.apiUser;
      const tokenRole = apiUser?.role;
      if (!apiUser || !tokenRole || !allowed(tokenRole, req)) {
        res.status(403).json({ error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' });
        return;
      }
      // v7.1.0: the token claims admin rights → both the token role and the
      // current role must pass; the stricter one is what the route sees.
      currentRole(apiUser.userId).then((dbRole) => {
        if (dbRole === null) {
          res.status(401).json({ error: 'Account is disabled or no longer exists', code: 'SESSION_REVOKED' });
          return;
        }
        if (!allowed(dbRole, req)) {
          log.warn({ userId: apiUser.userId, tokenRole, currentRole: dbRole }, 'Admin access denied: role in the token is outdated');
          res.status(403).json({ error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' });
          return;
        }
        if (dbRole !== tokenRole) apiUser.role = stricterRole(tokenRole, dbRole);
        enforceAdminMfa(req, res, next);
      }, (err: unknown) => {
        log.error({ err }, 'Current role check failed — denying admin access');
        if (!res.headersSent) res.status(503).json({ error: 'Admin access temporarily unavailable' });
      });
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

/**
 * Guard for a narrow admin action (8.x, lib/rbac.ts ADMIN_ACTIONS) — e.g. the
 * mailbox-content backup routes (`backupMailboxData`). Same checks as every
 * admin guard (current role, admin MFA).
 */
export function requireAction(action: AdminAction) {
  return adminGuard((role) => hasAdminAction(role, action));
}
