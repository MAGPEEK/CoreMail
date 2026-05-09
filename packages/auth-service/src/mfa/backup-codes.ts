import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { getPrisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('auth:backup-codes');

function generateCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

export async function generateBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => generateCode());
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 12)));

  const prisma = getPrisma();
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, backupCodes: hashes, backupCodesUsed: 0 },
    update: { backupCodes: hashes, backupCodesUsed: 0 },
  });

  log.info({ userId }, 'Backup codes regenerated');
  return codes;
}

export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  const prisma = getPrisma();
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa || mfa.backupCodes.length === 0) return false;

  for (let i = 0; i < mfa.backupCodes.length; i++) {
    const hash = mfa.backupCodes[i];
    if (!hash) continue;
    const valid = await bcrypt.compare(code.toUpperCase(), hash);
    if (valid) {
      const remaining = mfa.backupCodes.filter((_, idx) => idx !== i);
      await prisma.userMfa.update({
        where: { userId },
        data: { backupCodes: remaining, backupCodesUsed: { increment: 1 } },
      });
      log.warn({ userId }, 'Backup code used');
      return true;
    }
  }
  return false;
}
