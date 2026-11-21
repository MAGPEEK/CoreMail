/**
 * 10.6: passkey / security key management without the WebAuthn ceremonies
 * (those live in @coremail/storage/auth/webauthn) — listing, renaming,
 * removing credentials, passkey-only accounts and admin recovery links.
 * Used by the auth-service (user routes) and the api-gateway (admin routes).
 *
 * Every credential change publishes `mfa-change` (publishUserAuthChange): the
 * mail-protocol credential caches drop the user (a first passkey makes app
 * passwords mandatory) and MFA enforcement re-reads the factors.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { publishUserAuthChange } from './invalidation.js';
import { notifySecurityEvent } from './notify.js';
import { writeAuthAudit } from './auth-audit.js';
import { getAuthFactors } from './factors.js';
import { passkeyProviderName } from './passkey-providers.js';
import { revokeAllSessions } from './sessions.js';

const log = createLogger('auth:passkeys');

export type CredentialKind = 'passkey' | 'security_key';

/** A credential as the user / admin APIs return it (never the key, never the BigInt counter raw). */
export interface PublicCredential {
  id: string;
  name: string;
  kind: CredentialKind;
  /** Migrated pre-10.6 key (second factor only, cannot sign in without a password). */
  legacy: boolean;
  /** BE: may be synced between devices (null = unknown, migrated key not used yet). */
  backupEligible: boolean | null;
  /** BS: currently backed up / synced. */
  synced: boolean;
  discoverable: boolean | null;
  aaguid: string | null;
  /** Known passkey provider of the AAGUID (display only), else null. */
  provider: string | null;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
  signCount: number;
}

interface CredentialRow {
  id: string;
  name: string;
  kind: string;
  userHandle: string | null;
  backupEligible: boolean | null;
  backupState: boolean;
  discoverable: boolean | null;
  aaguid: string | null;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  signCount: bigint | number;
}

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export function publicCredential(row: CredentialRow): PublicCredential {
  const count = typeof row.signCount === 'bigint' ? Number(row.signCount) : Number(row.signCount ?? 0);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'passkey' ? 'passkey' : 'security_key',
    legacy: row.kind !== 'passkey' && row.userHandle === null,
    backupEligible: row.backupEligible,
    synced: row.backupState === true,
    discoverable: row.discoverable,
    aaguid: row.aaguid && row.aaguid !== ZERO_AAGUID ? row.aaguid : null,
    provider: passkeyProviderName(row.aaguid),
    transports: Array.isArray(row.transports) ? row.transports : [],
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    signCount: Number.isSafeInteger(count) ? count : 0,
  };
}

const PUBLIC_SELECT = {
  id: true, name: true, kind: true, userHandle: true, backupEligible: true, backupState: true, discoverable: true,
  aaguid: true, transports: true, createdAt: true, lastUsedAt: true, signCount: true,
} as const;

/** All credentials of a user, oldest first. */
export async function listCredentials(userId: string): Promise<PublicCredential[]> {
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId }, select: PUBLIC_SELECT, orderBy: { createdAt: 'asc' } });
  return (rows as CredentialRow[]).map(publicCredential);
}

/** Credential ids for the Signal API (signalAllAcceptedCredentials) — passkeys only. */
export async function acceptedPasskeyIds(userId: string): Promise<string[]> {
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId, kind: 'passkey' }, select: { credentialId: true } });
  return rows.map((r) => r.credentialId);
}

export const CREDENTIAL_NAME_MAX = 100;

export function cleanCredentialName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CREDENTIAL_NAME_MAX) : '';
  return s || fallback;
}

export async function renameCredential(userId: string, id: string, name: string): Promise<PublicCredential | null> {
  const r = await prisma.webAuthnCredential.updateMany({ where: { id, userId }, data: { name: cleanCredentialName(name, 'Passkey') } });
  if (r.count !== 1) return null;
  const row = await prisma.webAuthnCredential.findUnique({ where: { id }, select: PUBLIC_SELECT });
  return row ? publicCredential(row as CredentialRow) : null;
}

export type DeleteCredentialResult = 'ok' | 'not_found' | 'last_passkey';

/**
 * Removes one credential of the user. A passkey-only account
 * (passwordLoginDisabled) keeps its last passkey (`last_passkey` → 409).
 * `actor` = who removed it (the user itself or an admin) for audit + notice.
 * 10.6 review: removed by the user itself → every OTHER session of the user ends
 * (`actor.sessionId` = the session that removed it and stays; without it all end).
 */
export async function deleteCredential(
  userId: string, id: string,
  actor: { id: string; email?: string | undefined; ip?: string | undefined; admin?: boolean; sessionId?: string | null | undefined },
): Promise<DeleteCredentialResult> {
  const row = await prisma.webAuthnCredential.findFirst({ where: { id, userId }, select: { id: true, kind: true, name: true } });
  if (!row) return 'not_found';
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordLoginDisabled: true } });
  if (user?.passwordLoginDisabled && row.kind === 'passkey') {
    const left = await prisma.webAuthnCredential.count({ where: { userId, kind: 'passkey', NOT: { id } } });
    if (left === 0) return 'last_passkey';
  }
  const r = await prisma.webAuthnCredential.deleteMany({ where: { id, userId } });
  if (r.count !== 1) return 'not_found';
  await publishUserAuthChange(userId, 'mfa-change');
  if (!actor.admin) {
    // 10.6 review: a removed factor may have been abused elsewhere — the other sessions end
    await revokeAllSessions(userId, {
      ...(actor.sessionId ? { exceptSessionId: actor.sessionId } : {}), reason: 'passkey-removed',
    }).catch((err: unknown) => log.error({ err, userId }, 'Revoking the other sessions after a passkey removal failed'));
  }
  await writeAuthAudit({
    action: actor.admin ? 'passkey.admin_remove' : 'passkey.remove',
    actorId: actor.id, actorEmail: actor.email, ipAddress: actor.ip,
    targetType: 'mailbox', targetId: userId, targetName: user?.email,
    changes: { credential: row.id, kind: row.kind, name: row.name },
  });
  void notifySecurityEvent({
    userId,
    subject: `Security notice: a ${row.kind === 'passkey' ? 'passkey' : 'security key'} was removed`,
    bodyText:
      `The ${row.kind === 'passkey' ? 'passkey' : 'security key'} "${row.name}" was removed from your account on ${new Date().toUTCString()}` +
      `${actor.admin ? ' by an administrator' : ''}${actor.ip ? ` (IP ${actor.ip})` : ''}.\n\n` +
      'If you did not do this, sign in, check Settings → Security and inform your administrator.',
  });
  log.info({ userId, credential: row.id, admin: actor.admin === true }, 'WebAuthn credential removed');
  return 'ok';
}

/**
 * Admin: removes every WebAuthn credential (optionally also TOTP and backup
 * codes = "reset all MFA"), turns passwordLoginDisabled off and revokes the
 * user's sessions. Returns the counts.
 */
export async function removeAllCredentials(
  userId: string, opts: { allMfa: boolean; actor: { id: string; email?: string | undefined; ip?: string | undefined } },
): Promise<{ credentials: number; totp: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const credentials = (await prisma.webAuthnCredential.deleteMany({ where: { userId } })).count;
  let totp = false;
  if (opts.allMfa) {
    const r = await prisma.userMfa.updateMany({
      where: { userId },
      data: { totpEnabled: false, totpSecret: null, totpLastUsedStep: null, backupCodes: [], webAuthnCredentials: [] },
    });
    totp = r.count > 0;
  }
  await prisma.user.updateMany({ where: { id: userId }, data: { passwordLoginDisabled: false } });
  await publishUserAuthChange(userId, 'mfa-change');
  // 10.6 review: the user's sessions end (as documented above) — also MCP tokens and remembered devices
  await revokeAllSessions(userId, { reason: opts.allMfa ? 'mfa-reset' : 'passkeys-removed' });
  await writeAuthAudit({
    action: opts.allMfa ? 'passkey.admin_reset_mfa' : 'passkey.admin_remove_all',
    actorId: opts.actor.id, actorEmail: opts.actor.email, ipAddress: opts.actor.ip,
    targetType: 'mailbox', targetId: userId, targetName: user?.email,
    changes: { credentials, totp: opts.allMfa },
  });
  void notifySecurityEvent({
    userId,
    subject: opts.allMfa ? 'Security notice: your sign-in factors were reset' : 'Security notice: your passkeys were removed',
    bodyText:
      `An administrator removed ${opts.allMfa ? 'all second factors (passkeys, security keys, authenticator app, backup codes)' : 'all passkeys and security keys'}` +
      ` from your account on ${new Date().toUTCString()}.\n\nSet up a new factor under Settings → Security.`,
  });
  return { credentials, totp };
}

// ── Passkey-only accounts ─────────────────────────────────────────────────────

export type PasskeyOnlyRefusal = 'NEEDS_PASSKEYS' | 'LAST_ORG_ADMIN';

/**
 * Precondition of a passkey-only account: ≥ 2 passkeys, or 1 synced passkey
 * (BS) plus backup codes. The last active ORGANIZATION_MANAGEMENT account needs
 * ≥ 2 passkeys. Null = allowed.
 */
export async function passkeyOnlyRefusal(userId: string): Promise<PasskeyOnlyRefusal | null> {
  const [factors, user] = await Promise.all([
    getAuthFactors(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ]);
  if (user?.role === 'ORGANIZATION_MANAGEMENT') {
    const orgAdmins = await prisma.user.count({ where: { role: 'ORGANIZATION_MANAGEMENT', active: true } });
    if (orgAdmins <= 1 && factors.passkeys < 2) return 'LAST_ORG_ADMIN';
  }
  if (factors.passkeys >= 2) return null;
  if (factors.syncedPasskeys >= 1 && factors.backupCodes > 0) return null;
  return 'NEEDS_PASSKEYS';
}

// ── Recovery links ────────────────────────────────────────────────────────────

export const PASSKEY_RECOVERY_TTL_MS = 24 * 3600 * 1000;

export function hashPasskeyRecoveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a one-time recovery token (shown once). Earlier unused tokens of the user are dropped. */
export async function issuePasskeyRecoveryToken(userId: string, createdById: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PASSKEY_RECOVERY_TTL_MS);
  await prisma.passkeyRecoveryToken.deleteMany({ where: { userId, usedAt: null } });
  await prisma.passkeyRecoveryToken.create({ data: { userId, tokenHash: hashPasskeyRecoveryToken(token), createdById, expiresAt } });
  return { token, expiresAt };
}

/** The user of a valid (unused, unexpired) recovery token, or null. Does not consume it. */
export async function peekPasskeyRecoveryToken(token: string): Promise<{ tokenId: string; userId: string } | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const row = await prisma.passkeyRecoveryToken.findUnique({ where: { tokenHash: hashPasskeyRecoveryToken(token) } });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
  return { tokenId: row.id, userId: row.userId };
}

/** Claims the token atomically — true only for the one caller that consumed it. */
export async function consumePasskeyRecoveryToken(tokenId: string): Promise<boolean> {
  const r = await prisma.passkeyRecoveryToken.updateMany({
    where: { id: tokenId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return r.count === 1;
}
