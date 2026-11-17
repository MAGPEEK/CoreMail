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
import { isProtocolAllowed } from '../protocol-access.js';

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

export interface WebAccessUser {
  id: string;
  role: string;
  domainId?: string;
}

/** May the user use a web/API session on `surface`? Throws on database errors. */
export async function webAccessPermitted(user: WebAccessUser, surface: WebSurface): Promise<boolean> {
  if (surface === 'admin' && hasAdminRole(user.role)) return true;
  const subject = user.domainId !== undefined ? { id: user.id, domainId: user.domainId } : user.id;
  return webAccessAllowed(await isProtocolAllowed(subject, 'webmail'), user.role, surface);
}

/**
 * Login / refresh check (like maintenanceBlock): true when the account may not
 * get a web session — Webmail is off and the account has no admin role.
 */
export async function webLoginBlocked(user: WebAccessUser): Promise<boolean> {
  return !(await webAccessPermitted(user, 'admin'));
}

/** JSON body of a 403 answer for a disabled protocol. */
export function protocolDisabledBody(protocol: string): { error: string; code: string; protocol: string } {
  return { error: `${protocol} access is disabled for this account`, code: PROTOCOL_DISABLED_CODE, protocol };
}
