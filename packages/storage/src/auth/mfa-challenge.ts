/**
 * MFA login challenges (Redis). A challenge is created after a successful
 * first factor and consumed by exactly one successful /auth/mfa/verify.
 * Limits: MAX_ATTEMPTS failed codes per challenge (then it is deleted) and
 * MAX_IP_FAILURES failed verifications per client IP per IP_WINDOW.
 */
import { randomBytes } from 'node:crypto';
import { authRedis, incrWithTtl } from './redis.js';

export const MFA_CHALLENGE_TTL = 10 * 60;
export const MFA_CHALLENGE_PREFIX = 'auth:mfa:challenge:';
const ATTEMPTS_PREFIX = 'auth:mfa:attempts:';
const IP_PREFIX = 'auth:mfa:ipfail:';
export const MFA_MAX_ATTEMPTS = 5;
export const MFA_MAX_IP_FAILURES = 20;
const IP_WINDOW = 15 * 60;

export type MfaMethod = 'totp' | 'webauthn' | 'backup_code';

export interface MfaChallengeData {
  userId: string;
  /** Primary method (kept for the existing frontends). */
  method: 'totp' | 'webauthn';
  /** All methods accepted for this challenge. */
  methods: MfaMethod[];
  createdAt: number;
}

export async function createMfaChallenge(
  userId: string,
  method: MfaChallengeData['method'],
  methods: MfaMethod[],
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const data: MfaChallengeData = { userId, method, methods, createdAt: Date.now() };
  await authRedis().setex(`${MFA_CHALLENGE_PREFIX}${token}`, MFA_CHALLENGE_TTL, JSON.stringify(data));
  return token;
}

export async function getMfaChallenge(token: string): Promise<MfaChallengeData | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const raw = await authRedis().get(`${MFA_CHALLENGE_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<MfaChallengeData>;
    if (typeof d.userId !== 'string') return null;
    return {
      userId: d.userId,
      method: d.method === 'webauthn' ? 'webauthn' : 'totp',
      methods: Array.isArray(d.methods) ? d.methods : [d.method === 'webauthn' ? 'webauthn' : 'totp', 'backup_code'],
      createdAt: d.createdAt ?? 0,
    };
  } catch {
    return null;
  }
}

/** Deletes the challenge. Returns true only for the caller that deleted it. */
export async function consumeMfaChallenge(token: string): Promise<boolean> {
  const r = authRedis();
  const n = await r.del(`${MFA_CHALLENGE_PREFIX}${token}`);
  await r.del(`${ATTEMPTS_PREFIX}${token}`);
  return n === 1;
}

/**
 * Records a failed attempt. Returns true when the challenge is now exhausted
 * (and has been deleted).
 */
export async function registerMfaIpFailure(ip: string): Promise<void> {
  await incrWithTtl(`${IP_PREFIX}${ip}`, IP_WINDOW);
}

export async function registerMfaFailure(token: string, ip: string): Promise<boolean> {
  await registerMfaIpFailure(ip);
  const n = await incrWithTtl(`${ATTEMPTS_PREFIX}${token}`, MFA_CHALLENGE_TTL);
  if (n >= MFA_MAX_ATTEMPTS) {
    await consumeMfaChallenge(token);
    return true;
  }
  return false;
}

export async function isMfaIpBlocked(ip: string): Promise<boolean> {
  const raw = await authRedis().get(`${IP_PREFIX}${ip}`);
  return Number(raw ?? 0) >= MFA_MAX_IP_FAILURES;
}
