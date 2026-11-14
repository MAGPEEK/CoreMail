/**
 * MFA building blocks of the auth-service. v6.0.0: MFA login challenges and
 * their verification (attempt limits, TOTP replay protection, backup codes)
 * live in the shared login service, @coremail/storage/auth.
 */
import { getMfaState } from '@coremail/storage/auth';

export async function isMfaEnabled(userId: string): Promise<boolean> {
  return (await getMfaState(userId)).enabled;
}

export * from './totp.js';
export * from './backup-codes.js';
export * from './webauthn.js';
