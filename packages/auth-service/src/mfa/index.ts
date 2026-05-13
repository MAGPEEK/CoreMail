import { prisma } from '@coremail/storage';
import { getRedisClient } from '@coremail/core';
import { randomBytes } from 'node:crypto';
import { verifyTotp } from './totp.js';
import { verifyBackupCode } from './backup-codes.js';
import { finishWebAuthnAuthentication } from './webauthn.js';
import type { MfaChallenge } from '../types.js';

const MFA_CHALLENGE_TTL = 10 * 60; // 10 minutes
const MFA_CHALLENGE_PREFIX = 'auth:mfa:challenge:';

export async function isMfaEnabled(userId: string): Promise<boolean> {
  
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  if (!mfa) return false;
  const hasCreds = Array.isArray(mfa.webAuthnCredentials) && mfa.webAuthnCredentials.length > 0;
  return mfa.totpEnabled || hasCreds;
}

export async function createMfaChallenge(userId: string): Promise<MfaChallenge> {
  
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });

  let method: MfaChallenge['method'] = 'totp';
  const hasCreds = Array.isArray(mfa?.webAuthnCredentials) && (mfa?.webAuthnCredentials as unknown[]).length > 0;
  if (hasCreds) {
    method = 'webauthn';
  } else if (mfa?.totpEnabled) {
    method = 'totp';
  }

  const challengeToken = randomBytes(32).toString('hex');
  const redis = getRedisClient();
  await redis.setex(
    `${MFA_CHALLENGE_PREFIX}${challengeToken}`,
    MFA_CHALLENGE_TTL,
    JSON.stringify({ userId, method }),
  );

  return { userId, method, challengeToken };
}

export async function verifyMfaChallenge(
  challengeToken: string,
  opts: {
    code?: string;
    backupCode?: string;
    webauthnResponse?: unknown;
  },
): Promise<string | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${MFA_CHALLENGE_PREFIX}${challengeToken}`);
  if (!raw) return null;

  const { userId, method } = JSON.parse(raw) as { userId: string; method: string };

  let verified = false;

  if (opts.backupCode) {
    verified = await verifyBackupCode(userId, opts.backupCode);
  } else if (method === 'totp' && opts.code) {
    verified = await verifyTotp(userId, opts.code);
  } else if (method === 'webauthn' && opts.webauthnResponse) {
    verified = await finishWebAuthnAuthentication(
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts.webauthnResponse as any,
    );
  }

  if (verified) {
    await redis.del(`${MFA_CHALLENGE_PREFIX}${challengeToken}`);
    return userId;
  }
  return null;
}

export { verifyTotp, verifyBackupCode };
export * from './totp.js';
export * from './backup-codes.js';
export * from './webauthn.js';
