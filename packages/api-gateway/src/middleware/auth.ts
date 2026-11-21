import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger, onAuthInvalidation } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  adminMfaEnforcementFor, isAccessTokenRevoked, isAccessTokenRevokedShared, mfaEnrolmentRefusal, webAccessRefusal,
  type WebSurface,
} from '@coremail/storage/auth';
import {
  canAccess, hasAdminAction, isAdminRole, isReadMethod, isUnscopedOnlyArea, stricterRole,
  type AdminAction, type AdminArea, type UserRoleName,
} from '../lib/rbac.js';
import { ORGANISATION_SCOPE, isScoped, type AdminScope } from '../lib/admin-scope.js';
import { loadAdminScope } from './admin-scope.js';
import { redeemEventTicket, type TicketPurpose } from '../lib/event-tickets.js';
import { featureRefusal } from '../lib/webmail-features.js';

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
  /** Domain of the user (token claim, 9.4 protocol switches — saves a lookup). */
  domainId?: string;
  /**
   * 9.5: management scope of an admin, set by every admin guard from the
   * database (never from the token). Read it through scopeOf(req)
   * (middleware/admin-scope.ts), which fails closed when it is missing.
   */
  adminScope?: AdminScope;
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
  domainId?: string | undefined;
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
      ...(typeof payload.domainId === 'string' ? { domainId: payload.domainId } : {}),
      authStartedAt,
    };
    enforceWebmailSwitch(req, res, next);
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

// ── Webmail protocol switch (9.4) ─────────────────────────────────────────────
// A session may only be used for the webmail / user API while Webmail is on for
// the account. Accounts with an admin role keep the admin surface (BCP, admin
// CLI) even with Webmail off: the admin API (whose guards re-check the role)
// and the event stream the BCP subscribes to.

/** API paths of the admin surface (BCP / admin CLI). */
export const ADMIN_SURFACE_PREFIXES: readonly string[] = ['/api/v1/admin', '/api/v1/events'];

/** Which surface a request path belongs to (no path → webmail, the stricter one). */
export function webSurfaceOf(originalUrl: string | undefined): WebSurface {
  const path = (originalUrl ?? '').split('?')[0] ?? '';
  return ADMIN_SURFACE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ? 'admin' : 'webmail';
}

/** The user of a request for the protocol switches (domain from the token — saves a lookup). */
export function protocolSubject(user: ApiUser): string | { id: string; domainId: string } {
  return user.domainId !== undefined ? { id: user.userId, domainId: user.domainId } : user.userId;
}

// ── MFA enforcement for all users (10.5) ──────────────────────────────────────
// With "MFA für alle Benutzer erzwingen" (storage auth/mfa-enforcement.ts) a
// session of an account that must enrol a second factor may only read its
// enrolment state and its profile (the webmail login loads it); everything
// else answers 403 MFA_ENROLMENT_REQUIRED. Enrolment itself (/auth/mfa),
// the sessions list (/auth/sessions) and logout (/auth/logout) are not behind
// requireAuth.

/** API paths (GET/HEAD) a session may use while its account must enrol a second factor. */
export const MFA_ENROLMENT_ALLOWED_PATHS: readonly string[] = ['/api/v1/user/mfa-enforcement', '/api/v1/user/profile'];

/** May this request be served while the account must enrol a second factor? */
export function mfaEnrolmentAllowed(method: string, originalUrl: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = ((originalUrl ?? '').split('?')[0] ?? '').replace(/\/+$/, '');
  return MFA_ENROLMENT_ALLOWED_PATHS.includes(path);
}

function enforceWebmailSwitch(req: Request, res: Response, next: NextFunction): void {
  const user = req.apiUser!;
  // Fails closed like the admin guards (database errors → 503, see webAccessRefusal).
  void webAccessRefusal({ id: user.userId, role: user.role, domainId: user.domainId }, webSurfaceOf(req.originalUrl))
    // 9.4: then the webmail module of the path (lib/webmail-features.ts)
    .then((refusal) => refusal ?? featureRefusal(protocolSubject(user), req))
    // 10.5: then the MFA enforcement (outside the enrolment allow-list)
    .then((refusal) => refusal
      ?? (mfaEnrolmentAllowed(req.method, req.originalUrl) ? null : mfaEnrolmentRefusal(user.userId, user.mfaVerified)))
    .then((refusal) => {
      if (!refusal) { next(); return; }
      if (!res.headersSent) res.status(refusal.status).json(refusal.body);
    }, () => {
      // an unexpected failure of the checks is never "allowed" (and never a hanging request)
      if (!res.headersSent) res.status(503).json({ error: 'Service temporarily unavailable' });
    });
}

// ── Admin RBAC (v6) ───────────────────────────────────────────────────────────
// Role → area matrix and its documentation: lib/rbac.ts. There is no 'ADMIN'
// role (UserRole enum) — admin roles come from lib/rbac.ts only.

const MFA_CHECKED = Symbol('adminMfaChecked');

/**
 * Forced 2FA for admins (ServerSettings.requireMfaForAdmins; 10.6: the admin
 * rule of the MFA policy model or the admin's own "required" override):
 *   - no MFA enrolled            → 10.6: allowed during the admin grace period
 *                                  (≤ 14 days, header X-CoreMail-Mfa-Grace-Until),
 *                                  then 403 MFA_REQUIRED (setup lives under
 *                                  /auth/mfa, outside /admin — no chicken-and-egg lockout)
 *   - enrolled, but this session was not established with MFA
 *                                → 403 MFA_NOT_VERIFIED (log in again)
 * v7.0.0: fails CLOSED on database errors (503) instead of letting admins through.
 * Runs at most once per request. 10.3: the rule on its own is also used by the
 * admin MCP endpoint for its tokens (without grace).
 */
export interface AdminMfaRefusal {
  error: string;
  code: 'MFA_REQUIRED' | 'MFA_NOT_VERIFIED';
  /** 10.6: end of the admin grace period that is over (MFA_REQUIRED after a grace period). */
  deadline?: string;
}

/** 10.6: response header naming the end of the admin MFA grace period while it runs (ISO time). */
export const ADMIN_MFA_GRACE_HEADER = 'X-CoreMail-Mfa-Grace-Until';

/**
 * 10.6: the admin rule (storage mfa-policy.ts: admin rule or the admin's own
 * "required" override) with its grace period: an admin without a factor may
 * use the admin API until the deadline (at most 14 days from the first check;
 * `graceUntil` set — the BCP shows a prompt), afterwards 403 MFA_REQUIRED. An
 * enrolled admin needs an MFA-verified session (MFA_NOT_VERIFIED) as before.
 * `allowGrace: false` (MCP tokens) refuses during the grace period too.
 * Throws on database errors (callers fail closed).
 */
export async function adminMfaCheck(
  userId: string, mfaVerified: boolean | undefined, opts: { allowGrace?: boolean } = {},
): Promise<{ refusal: AdminMfaRefusal | null; graceUntil?: Date }> {
  const { status } = await adminMfaEnforcementFor(userId);
  switch (status.state) {
    case 'off':
      return { refusal: null };
    case 'satisfied':
      return mfaVerified
        ? { refusal: null }
        : { refusal: { error: 'This session was not verified with MFA — please log in again', code: 'MFA_NOT_VERIFIED' } };
    case 'grace':
      if (opts.allowGrace !== false) return { refusal: null, graceUntil: status.deadline };
      return { refusal: { error: 'MFA is required for admin access', code: 'MFA_REQUIRED' } };
    case 'required':
      return { refusal: { error: 'MFA is required for admin access', code: 'MFA_REQUIRED', deadline: status.deadline.toISOString() } };
  }
}

/** The forced-2FA answer alone (null = the admin may go on). Throws on database errors. */
export async function adminMfaRefusal(
  userId: string, mfaVerified: boolean | undefined, opts: { allowGrace?: boolean } = {},
): Promise<AdminMfaRefusal | null> {
  return (await adminMfaCheck(userId, mfaVerified, opts)).refusal;
}

function enforceAdminMfa(req: Request, res: Response, next: NextFunction): void {
  const flagged = req as Request & { [MFA_CHECKED]?: boolean };
  if (flagged[MFA_CHECKED]) { next(); return; }
  flagged[MFA_CHECKED] = true;
  const apiUser = req.apiUser!;
  void (async () => {
    try {
      const { refusal, graceUntil } = await adminMfaCheck(apiUser.userId, apiUser.mfaVerified);
      if (refusal) { res.status(403).json(refusal); return; }
      if (graceUntil) res.setHeader(ADMIN_MFA_GRACE_HEADER, graceUntil.toISOString());
      next();
    } catch (err) {
      log.error({ err }, 'MFA enforcement check failed — denying admin access');
      if (!res.headersSent) res.status(503).json({ error: 'Admin access temporarily unavailable' });
    }
  })();
}

// ── Current role + management scope (v7.1.0, 9.5) ─────────────────────────────
// The role travels inside the access token (up to JWT_ACCESS_TTL). A role
// change revokes the user's sessions, but an admin guard must not rely on that
// event alone: when a token claims admin rights, the CURRENT role is read from
// the database (short in-process cache, dropped on every auth invalidation
// event of the user) and the stricter of both roles applies. 9.5: the admin's
// management scope (AdminScope rows) is read and cached together with the role;
// a scope change publishes the same invalidation event as a role change.

const ROLE_CACHE_TTL_MS = 15_000;
interface AdminState { role: string | null; scope: AdminScope }
const roleCache = new Map<string, { state: AdminState; expires: number }>();
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

/**
 * Current role (null when the user is gone or inactive) and management scope
 * of a user. Throws on database errors.
 */
export async function currentAdminState(userId: string): Promise<AdminState> {
  const now = Date.now();
  const hit = roleCache.get(userId);
  if (hit && hit.expires > now) return hit.state;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
  const role = row && row.active !== false ? String(row.role) : null;
  const scope = role && isAdminRole(role) ? await loadAdminScope(userId, role) : ORGANISATION_SCOPE;
  const state = { role, scope };
  // A lookup that raced with an invalidation is not cached (could be stale).
  if ((roleInvalidatedAt.get(userId) ?? 0) < now) {
    if (roleCache.size > 10_000) roleCache.clear();
    roleCache.set(userId, { state, expires: now + ROLE_CACHE_TTL_MS });
  }
  return state;
}

/** Current role of an active user; null when the user is gone or inactive. Throws on database errors. */
export async function currentRole(userId: string): Promise<string | null> {
  return (await currentAdminState(userId)).role;
}

/** Is `role` allowed for this request? `scoped` = the admin is limited to domains (9.5). */
type AdminCheck = (role: string, req: Request, scoped: boolean) => boolean;

/**
 * Authenticate (unless an earlier guard already did), check `allowed`, enforce
 * admin MFA (`adminMfa: false` only for requireRoleInSetupWindow below).
 */
function adminGuard(allowed: AdminCheck, opts: { adminMfa?: boolean } = {}) {
  return function adminGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
    const check = (): void => {
      const apiUser = req.apiUser;
      const tokenRole = apiUser?.role;
      // early refusal on the token alone (the scope is not known yet — checked below)
      if (!apiUser || !tokenRole || !allowed(tokenRole, req, false)) {
        res.status(403).json({ error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' });
        return;
      }
      // v7.1.0: the token claims admin rights → both the token role and the
      // current role must pass; the stricter one is what the route sees.
      // 9.5: both checked again with the admin's current management scope.
      currentAdminState(apiUser.userId).then(({ role: dbRole, scope }) => {
        if (dbRole === null) {
          res.status(401).json({ error: 'Account is disabled or no longer exists', code: 'SESSION_REVOKED' });
          return;
        }
        const scoped = isScoped(scope);
        if (!allowed(dbRole, req, scoped) || !allowed(tokenRole, req, scoped)) {
          log.warn({ userId: apiUser.userId, tokenRole, currentRole: dbRole, scoped }, 'Admin access denied: current role or scope does not allow this route');
          res.status(403).json({ error: 'Insufficient admin role for this operation', code: 'FORBIDDEN_ROLE' });
          return;
        }
        if (dbRole !== tokenRole) apiUser.role = stricterRole(tokenRole, dbRole);
        apiUser.adminScope = scope;
        if (opts.adminMfa === false) next();
        else enforceAdminMfa(req, res, next);
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
 * Any admin role (no USER). VIEW_ONLY_ORG only for GET/HEAD. Scoped admins
 * pass (what such a route returns must then follow the scope).
 * Prefer requireArea() — this is the coarse fallback.
 */
export const requireAdmin = adminGuard((role, req) =>
  isAdminRole(role) && (role !== 'VIEW_ONLY_ORG' || isReadMethod(req.method)));

/**
 * Explicit role list for all methods. ORGANIZATION_MANAGEMENT always passes.
 * Server-wide by nature: a scoped admin never passes (9.5).
 * Example: router.post('/x', requireRole('SERVER_MANAGEMENT'), handler)
 */
export function requireRole(...roles: UserRoleName[]) {
  return adminGuard((role, _req, scoped) => !scoped && (role === 'ORGANIZATION_MANAGEMENT' || (roles as string[]).includes(role)));
}

/**
 * 10.5: requireRole() WITHOUT the admin-MFA rule — ONLY for the setup wizard's
 * follow-up routes (routes/setup-followup.ts: secrets download, finish), which
 * are themselves limited to the setup window (at most 24 h after the setup,
 * closed by the wizard's summary). Fresh installations start with
 * requireMfaForAdmins on; the first admin enrols a second factor after the
 * wizard, so the wizard's own session (password only) must still reach these
 * two routes. Role, current role, scope and session checks apply as usual.
 */
export function requireRoleInSetupWindow(...roles: UserRoleName[]) {
  return adminGuard((role, _req, scoped) => !scoped && (role === 'ORGANIZATION_MANAGEMENT' || (roles as string[]).includes(role)),
    { adminMfa: false });
}

/**
 * Area guard based on AREA_MATRIX (method-aware: read roles get GET/HEAD only).
 * `extra` may grant additional, narrowly scoped access (e.g. HELP_DESK
 * password reset); the route must then enforce its own limits. 9.5: a scoped
 * admin never reaches a server-wide area (lib/rbac.ts UNSCOPED_ONLY_AREAS),
 * not even through `extra`.
 */
export function requireArea(area: AdminArea, extra?: AdminCheck) {
  return adminGuard((role, req, scoped) => canAccess(role, area, req.method, scoped)
    || (!!extra && isAdminRole(role) && !(scoped && isUnscopedOnlyArea(area)) && extra(role, req, scoped)));
}

/**
 * Guard for a narrow admin action (8.x, lib/rbac.ts ADMIN_ACTIONS) — e.g. the
 * mailbox-content backup routes (`backupMailboxData`). Same checks as every
 * admin guard (current role, scope, admin MFA).
 */
export function requireAction(action: AdminAction) {
  return adminGuard((role, _req, scoped) => hasAdminAction(role, action, scoped));
}
