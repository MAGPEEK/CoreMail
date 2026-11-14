/**
 * MFA backup codes: 10 codes of 8 hex characters (shown as XXXX-XXXX), stored
 * as bcrypt hashes of the normalised code. Input is normalised (dashes and
 * whitespace removed, upper case), so pre-v6 codes (8 hex, no dash) still work.
 * Consumption is atomic: compare-and-swap on the whole array, so a code can be
 * used exactly once even under concurrent requests.
 */
import { randomBytes } from 'node:crypto';
import { hashOneTimeSecret, verifyOneTimeSecret } from '@coremail/core';
import { prisma } from '../prisma/index.js';

export const BACKUP_CODE_COUNT = 10;

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function isBackupCodeFormat(code: string): boolean {
  return /^[0-9A-F]{8}$/.test(normalizeBackupCode(code));
}

/** Generates new codes (replacing all old ones) and returns them in display form. */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const raw = Array.from({ length: BACKUP_CODE_COUNT }, () => randomBytes(4).toString('hex').toUpperCase());
  const hashes = await Promise.all(raw.map((c) => hashOneTimeSecret(c)));
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, backupCodes: hashes, backupCodesUsed: 0 },
    update: { backupCodes: hashes, backupCodesUsed: 0 },
  });
  return raw.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
}

/** Verifies and consumes a backup code. Returns true exactly once per code. */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  if (!isBackupCodeFormat(code)) return false;
  const normalized = normalizeBackupCode(code);
  for (let attempt = 0; attempt < 3; attempt++) {
    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    if (!mfa || mfa.backupCodes.length === 0) return false;
    let index = -1;
    for (let i = 0; i < mfa.backupCodes.length; i++) {
      if (await verifyOneTimeSecret(normalized, mfa.backupCodes[i]!)) { index = i; break; }
    }
    if (index === -1) return false;
    const remaining = mfa.backupCodes.filter((_, i) => i !== index);
    const res = await prisma.userMfa.updateMany({
      where: { userId, backupCodes: { equals: mfa.backupCodes } },
      data: { backupCodes: remaining, backupCodesUsed: { increment: 1 } },
    });
    if (res.count === 1) return true;
    // Array changed concurrently — re-read; if this code was taken, it is gone now.
  }
  return false;
}
