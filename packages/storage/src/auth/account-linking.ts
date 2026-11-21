/**
 * 10.6 review: account pre-takeover protection when an external identity
 * (OIDC sign-in, LDAP login or LDAP sync) meets an existing CoreMail account.
 *
 *  - An account created by self-registration (User.selfRegistration exists) is
 *    NEVER linked to an OIDC subject nor taken over by LDAP: an anonymous
 *    visitor could have registered the address before its real owner arrives
 *    through the directory / IdP and would keep the password, sessions and app
 *    passwords of the account. Refused, logged, audited
 *    (`auth.account-link.refused`) and recorded as security event
 *    ACCOUNT_LINK_REFUSED. A lookup error counts as self-registered (fail closed).
 *  - When OIDC links, or LDAP takes over, any other LOCAL account, every
 *    session, app password, MCP token and remembered device of it ends
 *    (revokeAllSessions with appPasswords → publishUserAuthChange): whatever was
 *    issued before the external identity vouched for the account is void.
 */
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { recordSecurityEvent } from '../security-events.js';
import { writeAuthAudit } from './auth-audit.js';
import { revokeAllSessions } from './sessions.js';

const log = createLogger('auth:account-linking');

export type AccountLinkVia = 'oidc' | 'ldap-login' | 'ldap-sync';

/** Was the account created by self-registration? Errors count as yes (fail closed). */
export async function isSelfRegisteredAccount(userId: string): Promise<boolean> {
  try {
    const row = await prisma.selfRegistration.findUnique({ where: { userId }, select: { id: true } });
    return row !== null;
  } catch (err) {
    log.error({ err, userId }, 'Self-registration lookup failed — account link refused (fail closed)');
    return true;
  }
}

/** Logs, audits and records a refused link / takeover of a self-registered account. Never throws. */
export async function reportRefusedAccountLink(
  user: { id: string; email: string }, via: AccountLinkVia, ip?: string | null,
): Promise<void> {
  log.warn({ userId: user.id, via }, 'External identity refused for a self-registered account (pre-takeover protection)');
  try {
    await writeAuthAudit({
      action: 'auth.account-link.refused', targetType: 'mailbox', targetId: user.id, targetName: user.email,
      ...(ip ? { ipAddress: ip } : {}),
      changes: { via, reason: 'self-registered' }, success: false, errorMsg: 'self-registered account is never linked or taken over',
    });
  } catch { /* writeAuthAudit never throws */ }
  recordSecurityEvent({
    type: 'ACCOUNT_LINK_REFUSED', ip: ip ?? null, protocol: 'web', target: user.email,
    detail: { via, reason: 'self-registered' }, important: true,
  });
}

/**
 * After OIDC linked / LDAP took over a LOCAL account: end every session, app
 * password, MCP token and remembered device (publishes the auth change). Never throws.
 */
export async function revokeOnAccountLink(userId: string, via: AccountLinkVia): Promise<void> {
  try {
    await revokeAllSessions(userId, { appPasswords: true, reason: via === 'oidc' ? 'oidc-link' : 'ldap-takeover' });
  } catch (err) {
    log.error({ err, userId, via }, 'Revoking the credentials of a linked account failed');
  }
}
