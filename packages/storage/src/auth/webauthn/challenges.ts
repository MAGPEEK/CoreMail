/**
 * 10.6: WebAuthn challenges in Redis — `auth:passkey:chal:<sha256(flowId)>`
 * → { challenge, purpose, userId?, sessionId?, surface?, rpId, … }, TTL 300 s,
 * single use (GETDEL, G7): a verification consumes the challenge whether it
 * succeeds or not. The flow id is the client's handle (random, returned with
 * the options); only its hash is a key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { authRedis, takeOnce } from '../redis.js';

export const PASSKEY_CHALLENGE_TTL = 300;
export const PASSKEY_CHALLENGE_PREFIX = 'auth:passkey:chal:';

export type ChallengePurpose = 'login' | 'register' | 'reauth' | 'recovery' | 'second_factor' | 'security_key_register';

export interface ChallengeData {
  challenge: string;
  purpose: ChallengePurpose;
  rpId: string;
  userId?: string;
  sessionId?: string;
  surface?: 'webmail' | 'admin';
  /** recovery: the PasskeyRecoveryToken row. */
  tokenId?: string;
  createdAt: number;
}

export function newFlowId(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeKey(flowId: string): string {
  return `${PASSKEY_CHALLENGE_PREFIX}${createHash('sha256').update(flowId).digest('hex')}`;
}

export async function storeChallenge(flowId: string, data: Omit<ChallengeData, 'createdAt'>): Promise<void> {
  await authRedis().setex(challengeKey(flowId), PASSKEY_CHALLENGE_TTL, JSON.stringify({ ...data, createdAt: Date.now() }));
}

/** Reads and deletes the challenge (single use). Null when unknown, expired or already used. */
export async function takeChallenge(flowId: unknown): Promise<ChallengeData | null> {
  if (typeof flowId !== 'string' || flowId.length < 16 || flowId.length > 256) return null;
  const raw = await takeOnce(challengeKey(flowId));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<ChallengeData>;
    if (typeof d.challenge !== 'string' || typeof d.purpose !== 'string' || typeof d.rpId !== 'string') return null;
    return d as ChallengeData;
  } catch {
    return null;
  }
}
