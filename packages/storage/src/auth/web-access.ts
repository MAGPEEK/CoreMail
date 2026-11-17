/**
 * 9.4: the Webmail protocol switch for web/API sessions (protocol-access.ts).
 *
 * `webmail` covers the web login (password, MFA, SSO, token refresh) and the
 * use of a session for the webmail / user REST API. Accounts with an admin
 * role are never locked out of the BCP by it: they still log in, and their
 * session keeps the admin surface (admin API, event stream, account security
 * under /auth) — only the webmail API answers 403 PROTOCOL_DISABLED.
 */
import { UserRole } from '@prisma/client';
import { createLogger } from '@coremail/core';
import { isProtocolAllowed } from '../protocol-access.js';

const log = createLogger('auth:web-access');

/** Where a web/API session is used: the webmail / user API, or the admin surface. */
export type WebSurface = 'webmail' | 'admin';

/** Error code of every web/API refusal caused by a protocol switch. */
export const PROTOCOL_DISABLED_CODE = 'PROTOCOL_DISABLED';

const ADMIN_ROLES: ReadonlySet<string> = new Set(Object.values(UserRole).filter((r) => r !== UserRole.USER));

/** Any role besides USER (UserRole has no 'ADMIN'). */
export function hasAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

/** Pure decision: may a session of a user with `role` be used on `surface`? */
export function webAccessAllowed(webmailOn: boolean, role: string, surface: WebSurface): boolean {
  return webmailOn || (surface === 'admin' && hasAdminRole(role));
}

/** The account of a web/API session (`domainId` from the token saves a lookup). */
export interface WebAccessUser {
  id: string;
  role: string;
  domainId?: string | undefined;
}

/** May the user use a web/API session on `surface`? Throws on database errors. */
export async function webAccessPermitted(user: WebAccessUser, surface: WebSurface): Promise<boolean> {
  if (surface === 'admin' && hasAdminRole(user.role)) return true;
  const subject = user.domainId !== undefined ? { id: user.id, domainId: user.domainId } : user.id;
  return webAccessAllowed(await isProtocolAllowed(subject, 'webmail'), user.role, surface);
}

/** The HTTP answer that refuses a web/API session. */
export interface WebAccessRefusal {
  status: 403 | 503;
  body: Record<string, unknown>;
}

/**
 * The shared request check of every web/API session (api-gateway requireAuth,
 * auth-service account-security routes): null when the session may be used on
 * `surface`, else the answer — 403 PROTOCOL_DISABLED, or 503 when the switch
 * cannot be read (fails closed, like the admin guards).
 */
export async function webAccessRefusal(user: WebAccessUser, surface: WebSurface): Promise<WebAccessRefusal | null> {
  try {
    return (await webAccessPermitted(user, surface)) ? null : { status: 403, body: protocolDisabledBody('webmail') };
  } catch (err) {
    log.error({ err, userId: user.id }, 'Webmail switch check failed');
    return { status: 503, body: { error: 'Authentication temporarily unavailable' } };
  }
}

/**
 * Login / refresh / SSO check (like maintenanceBlock): true when the account
 * may not get a session for `surface` (ClientInfo.surface) — Webmail is off,
 * and it is the webmail asking or the account has no admin role.
 */
export async function webLoginBlocked(user: WebAccessUser, surface: WebSurface = 'admin'): Promise<boolean> {
  return !(await webAccessPermitted(user, surface));
}

/** JSON body of a 403 answer for a disabled protocol. */
export function protocolDisabledBody(protocol: string): { error: string; code: string; protocol: string } {
  return { error: `${protocol} access is disabled for this account`, code: PROTOCOL_DISABLED_CODE, protocol };
}
