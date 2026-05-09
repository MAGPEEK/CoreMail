import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { getPrisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('auth:app-passwords');

function generateAppPassword(): string {
  // Format: XXXX-XXXX-XXXX-XXXX (16 random bytes as 4 groups of 4 hex chars)
  const raw = randomBytes(8).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export async function createAppPassword(
  userId: string,
  name: string,
): Promise<{ id: string; password: string }> {
  const password = generateAppPassword();
  const hash = await bcrypt.hash(password, 12);

  const prisma = getPrisma();
  const record = await prisma.appPassword.create({
    data: { userId, name, hash },
  });

  log.info({ userId, name }, 'App password created');
  return { id: record.id, password };
}

export async function listAppPasswords(userId: string) {
  const prisma = getPrisma();
  return prisma.appPassword.findMany({
    where: { userId },
    select: { id: true, name: true, lastUsed: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deleteAppPassword(userId: string, id: string): Promise<boolean> {
  const prisma = getPrisma();
  const record = await prisma.appPassword.findFirst({ where: { id, userId } });
  if (!record) return false;
  await prisma.appPassword.delete({ where: { id } });
  log.info({ userId, id }, 'App password deleted');
  return true;
}
