import { createHash, randomBytes, timingSafeEqual } from 'crypto';
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

export function generateAppPassword(): string {
  // 4 groups of 6 chars separated by dashes — like Google app passwords
  const chars = randomBytes(24).toString('base64url').toUpperCase();
  return `${chars.slice(0, 6)}-${chars.slice(6, 12)}-${chars.slice(12, 18)}-${chars.slice(18, 24)}`;
}

function applyPepper(password: string): string {
  return createHash('sha256')
    .update(password + config.PEPPER)
    .digest('hex');
}

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
