import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';

const BCRYPT_COST = 12;

export async function hashPassword(password: string): Promise<string> {
  const pepperedPassword = applyPepper(password);
  return bcrypt.hash(pepperedPassword, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const pepperedPassword = applyPepper(password);
  return bcrypt.compare(pepperedPassword, hash);
}

export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function applyPepper(password: string): string {
  return createHash('sha256')
    .update(password + config.PEPPER)
    .digest('hex');
}
