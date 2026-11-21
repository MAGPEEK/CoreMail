/**
 * 10.6: external recovery address of an account (self-service password reset,
 * docs/password-reset.md). The single writer of the RecoveryEmail model.
 *
 *  - A new / changed address is only PENDING until the link sent to it is
 *    opened (token stored as sha256, single use, RECOVERY_CONFIRM_TTL). An
 *    unconfirmed address never receives a reset link; the previously confirmed
 *    address stays in force until then.
 *  - Never an address of a domain hosted on this server (a mailbox here is
 *    exactly what a user who forgot the password cannot read, and others may).
 *  - The caller (api-gateway) re-authenticates the user, sends the mails
 *    (confirmation, notice to the old address + own mailbox) and audits.
 */
import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { prisma } from '../prisma/index.js';

/** Validity of the confirmation link (24 h). */
export const RECOVERY_CONFIRM_TTL = 24 * 60 * 60;

export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RecoveryEmailState {
  /** Confirmed address (the one reset links go to), null = none. */
  address: string | null;
  verifiedAt: Date | null;
  /** Requested change waiting for its confirmation (expired ones are reported as null). */
  pendingAddress: string | null;
  pendingExpiresAt: Date | null;
}

const EMPTY: RecoveryEmailState = { address: null, verifiedAt: null, pendingAddress: null, pendingExpiresAt: null };

// Deliberately strict: one @, a dotted domain, no spaces / quotes / brackets.
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[^\s@"<>()[\],;:\\]+\.[^\s@"<>()[\],;:\\]+$/;

/** Pure: canonical form of a recovery address (trimmed, lower-case, IDN domain as ASCII) or null. */
export function normalizeRecoveryAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length < 3 || s.length > 254 || !ADDRESS_RE.test(s)) return null;
  const at = s.lastIndexOf('@');
  const local = s.slice(0, at);
  const domain = domainToASCII(s.slice(at + 1).toLowerCase());
  if (!domain || local.length > 64) return null;
  return `${local.toLowerCase()}@${domain}`;
}

/** Is the address in a domain hosted on this server? A failed lookup counts as hosted (fail closed). */
export async function isHostedAddress(address: string): Promise<boolean> {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  try {
    const hit = await prisma.domain.findFirst({
      where: { name: { equals: domain, mode: 'insensitive' } },
      select: { id: true },
    });
    return hit !== null;
  } catch {
    return true;
  }
}

/** The recovery address state of a user (an expired pending change is not reported). */
export async function getRecoveryEmailState(userId: string, now = Date.now()): Promise<RecoveryEmailState> {
  const row = await prisma.recoveryEmail.findUnique({ where: { userId } });
  if (!row) return { ...EMPTY };
  const pendingLive = !!row.pendingAddress && !!row.pendingExpiresAt && row.pendingExpiresAt.getTime() > now;
  return {
    address: row.verifiedAt ? row.address : null,
    verifiedAt: row.address ? row.verifiedAt : null,
    pendingAddress: pendingLive ? row.pendingAddress : null,
    pendingExpiresAt: pendingLive ? row.pendingExpiresAt : null,
  };
}

export type RecoveryRequestError = 'invalid_address' | 'hosted_address' | 'same_address';

export type RecoveryRequestResult =
  | { ok: true; token: string; address: string; previous: string | null; expiresAt: Date }
  | { ok: false; error: RecoveryRequestError };

/**
 * Starts a change to `rawAddress`: stores it as pending with a fresh
 * confirmation token (replacing an earlier pending change). Returns the raw
 * token for the confirmation mail and the currently confirmed address (the
 * caller notifies it).
 */
export async function requestRecoveryEmail(userId: string, rawAddress: unknown): Promise<RecoveryRequestResult> {
  const address = normalizeRecoveryAddress(rawAddress);
  if (!address) return { ok: false, error: 'invalid_address' };
  if (await isHostedAddress(address)) return { ok: false, error: 'hosted_address' };
  const current = await getRecoveryEmailState(userId);
  if (current.address === address) return { ok: false, error: 'same_address' };

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RECOVERY_CONFIRM_TTL * 1000);
  const pending = { pendingAddress: address, pendingTokenHash: hashRecoveryToken(token), pendingExpiresAt: expiresAt };
  await prisma.recoveryEmail.upsert({
    where: { userId },
    create: { userId, ...pending },
    update: pending,
  });
  return { ok: true, token, address, previous: current.address, expiresAt };
}

export type RecoveryConfirmResult =
  | { ok: true; userId: string; address: string; previous: string | null }
  | { ok: false; reason: 'invalid' | 'hosted_address' };

/** Confirms a pending change (single use). The confirmed address replaces the previous one. */
export async function confirmRecoveryEmail(token: string): Promise<RecoveryConfirmResult> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return { ok: false, reason: 'invalid' };
  const tokenHash = hashRecoveryToken(token);
  const row = await prisma.recoveryEmail.findUnique({ where: { pendingTokenHash: tokenHash } });
  if (!row?.pendingAddress || !row.pendingExpiresAt || row.pendingExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'invalid' };
  }
  // The domain may have been added to this server since the request.
  if (await isHostedAddress(row.pendingAddress)) {
    await prisma.recoveryEmail.updateMany({
      where: { id: row.id, pendingTokenHash: tokenHash },
      data: { pendingAddress: null, pendingTokenHash: null, pendingExpiresAt: null },
    });
    return { ok: false, reason: 'hosted_address' };
  }
  const previous = row.verifiedAt ? row.address : null;
  // Conditional update: exactly one concurrent confirmation wins.
  const claimed = await prisma.recoveryEmail.updateMany({
    where: { id: row.id, pendingTokenHash: tokenHash },
    data: {
      address: row.pendingAddress, verifiedAt: new Date(),
      pendingAddress: null, pendingTokenHash: null, pendingExpiresAt: null,
    },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'invalid' };
  return { ok: true, userId: row.userId, address: row.pendingAddress, previous };
}

/** Removes the recovery address and any pending change. Returns the confirmed address that was removed. */
export async function removeRecoveryEmail(userId: string): Promise<{ previous: string | null; removed: boolean }> {
  const current = await getRecoveryEmailState(userId);
  const r = await prisma.recoveryEmail.deleteMany({ where: { userId } });
  return { previous: current.address, removed: r.count > 0 };
}

/** Number of accounts with a confirmed recovery address (BCP page). */
export async function countVerifiedRecoveryEmails(): Promise<number> {
  return prisma.recoveryEmail.count({ where: { NOT: [{ address: null }, { verifiedAt: null }] } });
}
