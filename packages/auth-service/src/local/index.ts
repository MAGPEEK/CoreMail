import bcrypt from 'bcrypt';
import { prisma } from '@coremail/storage';
import type { AuthResult } from '../types.js';

export async function authenticateLocal(
  email: string,
  password: string,
): Promise<AuthResult | null> {
  

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { domain: true },
  });

  if (!user || !user.active || !user.passwordHash) return null;

  const pepper = process.env['PEPPER'] ?? '';
  const pepperedPassword = password + pepper;
  const valid = await bcrypt.compare(pepperedPassword, user.passwordHash);
  if (!valid) return null;

  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    source: 'local',
    mfaRequired: false,
  };
}

export async function authenticateAppPassword(
  email: string,
  password: string,
): Promise<AuthResult | null> {
  

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user || !user.active) return null;

  const appPasswords = await prisma.appPassword.findMany({
    where: { userId: user.id },
  });

  for (const ap of appPasswords) {
    const valid = await bcrypt.compare(password, ap.hash);
    if (valid) {
      await prisma.appPassword.update({
        where: { id: ap.id },
        data: { lastUsedAt: new Date() },
      });
      return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        source: 'local',
        mfaRequired: false,
      };
    }
  }

  return null;
}
