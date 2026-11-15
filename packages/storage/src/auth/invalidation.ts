/**
 * Publishing side of the credential/session invalidation bus (v7.1.0) — see
 * @coremail/core auth/invalidation.ts. Every code path that changes whether a
 * user's credentials or sessions remain valid calls publishUserAuthChange().
 * Never throws (caches fall back to their TTL when Redis is unavailable).
 */
import {
  publishAuthInvalidation, type AuthInvalidationEvent, type AuthInvalidationPublisher, type AuthInvalidationReason,
} from '@coremail/core';
import { authRedis } from './redis.js';

export async function publishUserAuthChange(
  userId: string,
  reason: AuthInvalidationReason,
  extra: Omit<AuthInvalidationEvent, 'userId' | 'reason'> = {},
): Promise<void> {
  let redis: AuthInvalidationPublisher | null = null;
  try {
    redis = authRedis() as unknown as AuthInvalidationPublisher;
  } catch {
    /* no Redis client available — local handlers only */
  }
  await publishAuthInvalidation({ userId, reason, ...extra }, { redis });
}
