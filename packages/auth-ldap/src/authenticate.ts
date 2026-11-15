/**
 * LDAP / Active Directory password verification (v6.1).
 *
 *   1. empty password → refused (an empty password is an unauthenticated
 *      "simple bind" that many directories accept)
 *   2. the login domain must be a configured, active CoreMail domain with an
 *      enabled LdapConfig
 *   3. an existing CoreMail account must have authSource LDAP — a LOCAL account
 *      is only taken over with the explicit `allowLocalTakeover` opt-in
 *      (OIDC accounts never); inactive accounts are refused
 *   4. bind with the service account, search the user with the configured
 *      filter (RFC 4515-escaped), exactly one entry required
 *   5. the directory `mail` attribute must equal the login e-mail
 *   6. bind as the found DN with the given password
 *   7. a stored directory id (externalId) must match the entry
 *   8. first login: create the user AND provision the mailbox
 */
import { createLogger } from '@coremail/core';
import {
  prisma, ensureMailboxProvisioned, registerExternalPasswordVerifier, type ExternalPasswordVerifier,
} from '@coremail/storage';
import { revokeAllSessions, type ExternalAuthenticator } from '@coremail/storage/auth';
import { buildUserFilter } from './filter.js';
import {
  attrFirst, attrId, attrValues, isSizeLimitError, mailAttr, nameAttr, openClient, serviceBind, toLdapSettings, uidAttr,
  type LdapSettings,
} from './client.js';

const log = createLogger('auth:ldap');

export type LdapAuthReason =
  | 'empty_password' | 'invalid_email' | 'unknown_domain' | 'not_configured' | 'local_account' | 'inactive'
  | 'not_found' | 'ambiguous' | 'mail_mismatch' | 'wrong_password' | 'external_id_mismatch' | 'error';

export type LdapAuthDecision =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; reason: LdapAuthReason };

export const LDAP_EXTERNAL_ID_PREFIX = 'ldap:';

/**
 * v8.1: a LOCAL account linked via SSO by an older build carries its OIDC
 * binding (`oidc:<provider>:<sub>`) in `externalId`. That is no directory id:
 * LDAP compares only real ids, and a takeover moves the binding to
 * `User.oidcSubject` before it writes its own `ldap:<id>`.
 * Returns the directory id to compare and the update data for the migration.
 */
export function legacyOidcBinding(u: { externalId: string | null; oidcSubject?: string | null }): {
  directoryId: string | null;
  migrate: { externalId?: null; oidcSubject?: string };
} {
  if (!u.externalId?.startsWith('oidc:')) return { directoryId: u.externalId, migrate: {} };
  return { directoryId: null, migrate: { externalId: null, ...(u.oidcSubject ? {} : { oidcSubject: u.externalId }) } };
}

async function loadSettings(domainName: string): Promise<{ settings: LdapSettings; domainId: string } | 'unknown_domain' | 'not_configured'> {
  const domain = await prisma.domain.findUnique({ where: { name: domainName }, select: { id: true, active: true } });
  if (!domain || !domain.active) return 'unknown_domain';
  const row = await prisma.ldapConfig.findUnique({ where: { domainId: domain.id } });
  if (!row) return 'not_configured';
  const settings = toLdapSettings(row);
  if (!settings.enabled) return 'not_configured';
  return { settings, domainId: domain.id };
}

/** Full decision with a reason (used by tests and the BCP test endpoint). */
export async function ldapAuthDecision(rawEmail: string, password: string): Promise<LdapAuthDecision> {
  if (typeof password !== 'string' || password.length === 0) return { ok: false, reason: 'empty_password' };
  const email = rawEmail.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return { ok: false, reason: 'invalid_email' };

  const loaded = await loadSettings(email.slice(at + 1));
  if (loaded === 'unknown_domain' || loaded === 'not_configured') return { ok: false, reason: loaded };
  const { settings, domainId } = loaded;

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, authSource: true, active: true, externalId: true, oidcSubject: true, displayName: true },
  });
  if (existing) {
    if (existing.authSource !== 'LDAP' && !(existing.authSource === 'LOCAL' && settings.allowLocalTakeover)) {
      return { ok: false, reason: 'local_account' };
    }
    if (!existing.active) return { ok: false, reason: 'inactive' };
  }

  let svc;
  try {
    svc = await serviceBind(settings);
  } catch (err) {
    log.error({ err, domainId }, 'LDAP service bind failed');
    return { ok: false, reason: 'error' };
  }

  let entry;
  try {
    const { searchEntries } = await svc.search(settings.userDN, {
      scope: 'sub',
      filter: buildUserFilter(settings.userFilter, email),
      attributes: [mailAttr(settings), nameAttr(settings), uidAttr(settings), 'entryUUID'],
      explicitBufferAttributes: ['objectGUID'],
      sizeLimit: 2,
    });
    if (searchEntries.length === 0) return { ok: false, reason: 'not_found' };
    if (searchEntries.length > 1) return { ok: false, reason: 'ambiguous' };
    entry = searchEntries[0]!;
  } catch (err) {
    if (isSizeLimitError(err)) return { ok: false, reason: 'ambiguous' };
    log.error({ err, domainId }, 'LDAP user search failed');
    return { ok: false, reason: 'error' };
  } finally {
    await svc.unbind().catch(() => undefined);
  }

  const mails = attrValues(entry[mailAttr(settings)]).map((m) => m.trim().toLowerCase());
  if (!mails.includes(email)) {
    log.warn({ email, dn: entry.dn }, 'LDAP entry mail attribute does not match the login');
    return { ok: false, reason: 'mail_mismatch' };
  }

  // Bind as the user (separate connection, so the service bind cannot leak).
  const userClient = await openClient(settings).catch((err: unknown) => {
    log.error({ err, domainId }, 'LDAP connection failed');
    return null;
  });
  if (!userClient) return { ok: false, reason: 'error' };
  try {
    await userClient.bind(entry.dn, password);
  } catch {
    return { ok: false, reason: 'wrong_password' };
  } finally {
    await userClient.unbind().catch(() => undefined);
  }

  const dirId = attrId(entry[uidAttr(settings)]) ?? attrId(entry['entryUUID']);
  const externalId = dirId ? `${LDAP_EXTERNAL_ID_PREFIX}${dirId}` : undefined;
  const displayName = attrFirst(entry[nameAttr(settings)])?.trim() || email;

  if (existing) {
    const { directoryId, migrate } = legacyOidcBinding(existing);
    if (directoryId && externalId && directoryId !== externalId) {
      log.warn({ email }, 'LDAP directory id differs from the linked account — refused');
      return { ok: false, reason: 'external_id_mismatch' };
    }
    const takeover = existing.authSource === 'LOCAL';
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...migrate,
        displayName,
        ...(externalId ? { externalId } : {}),
        ...(takeover ? { authSource: 'LDAP' as const, passwordHash: null } : {}),
      },
    });
    if (takeover) {
      log.warn({ userId: existing.id, email }, 'LOCAL account taken over by LDAP (allowLocalTakeover)');
      await revokeAllSessions(existing.id, { reason: 'ldap-takeover' }).catch(() => undefined);
    }
    await ensureMailboxProvisioned(existing.id).catch((err: unknown) => log.error({ err }, 'Mailbox provisioning failed'));
    return { ok: true, userId: existing.id, created: false };
  }

  let userId: string;
  try {
    const u = await prisma.user.create({
      data: {
        email, displayName, passwordHash: null, role: 'USER', authSource: 'LDAP', domainId,
        ...(externalId ? { externalId } : {}),
      },
      select: { id: true },
    });
    userId = u.id;
    log.info({ userId, email }, 'LDAP user provisioned on first login');
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const again = await prisma.user.findUnique({ where: { email }, select: { id: true, authSource: true } });
    if (!again || again.authSource !== 'LDAP') return { ok: false, reason: 'local_account' };
    userId = again.id;
  }
  await ensureMailboxProvisioned(userId);
  return { ok: true, userId, created: true };
}

/**
 * Verifies e-mail + password against the domain's directory. Returns the
 * CoreMail userId (creating + provisioning the account on first login) or null.
 * Never throws.
 */
export async function authenticateLdap(email: string, password: string): Promise<{ userId: string } | null> {
  try {
    const d = await ldapAuthDecision(email, password);
    if (d.ok) return { userId: d.userId };
    if (d.reason !== 'not_configured' && d.reason !== 'unknown_domain' && d.reason !== 'local_account') {
      log.info({ email, reason: d.reason }, 'LDAP authentication refused');
    }
    return null;
  } catch (err) {
    log.error({ err, email }, 'LDAP authentication error');
    return null;
  }
}

/**
 * Mail-protocol hook (IMAP/POP3/SMTP AUTH) for
 * `registerExternalPasswordVerifier()` in @coremail/storage:
 * resolves to `{ userId }` on success, `false` otherwise. Never throws.
 */
export async function verifyLdapMailPassword(email: string, password: string): Promise<false | { userId: string }> {
  return (await authenticateLdap(email, password)) ?? false;
}

/**
 * Adapter to the ExternalPasswordVerifier signature of the shared mail
 * credential check (verifyMailCredentials). It is only consulted for existing
 * non-LOCAL users without MFA; only LDAP accounts are checked, and the bind
 * must resolve to the same CoreMail user.
 */
export const ldapMailPasswordVerifier: ExternalPasswordVerifier = async (user, password) => {
  if (user.authSource !== 'LDAP') return false;
  const result = await verifyLdapMailPassword(user.email, password);
  return result !== false && result.userId === user.id;
};

/**
 * Registers LDAP as directory backend for the mail protocols (SMTP AUTH, IMAP,
 * POP3, ActiveSync, JMAP/CalDAV Basic, Autodiscover). Call once at service start.
 */
export function registerLdapMailVerifier(): void {
  registerExternalPasswordVerifier('ldap', ldapMailPasswordVerifier);
}

/** First-factor step for the shared web/API login service (`registerAuthenticator`). */
export function ldapAuthenticator(): ExternalAuthenticator {
  return {
    name: 'ldap',
    authenticate: (email, password) => authenticateLdap(email, password),
  };
}
