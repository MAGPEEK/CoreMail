/**
 * v7.1.0: the SSE stream GET /api/v1/events is a long-lived connection
 * authenticated with a web access token. It is registered in a
 * LiveConnectionRegistry (credential `token`) so that a credential change or
 * session revocation ends it — same rules as JMAP Bearer push connections
 * (revoked session, "revoke all sessions" incl. password change / role change,
 * deactivation, deletion). server.ts attaches the registry to the auth bus.
 * 9.4: the stream of a non-admin account also ends when Webmail is switched
 * off; admin accounts keep it (the BCP subscribes to the same stream).
 */
import { LiveConnectionRegistry, type AuthInvalidationEvent } from '@coremail/core';
import { hasAdminRole } from '@coremail/storage/auth';
import type { ApiUser } from '../middleware/auth.js';

export const sseLiveConnections = new LiveConnectionRegistry('api-sse');

/** Registers an SSE stream of `user`; returns the unregister function. */
export function registerSseConnection(user: ApiUser, terminate: (event: AuthInvalidationEvent) => void): () => void {
  return sseLiveConnections.register({
    userId: user.userId,
    credential: 'token',
    ...(hasAdminRole(user.role) ? {} : { protocol: 'webmail' }),
    ...(user.sessionId ? { sessionId: user.sessionId } : {}),
    ...(user.issuedAt !== undefined ? { issuedAt: user.issuedAt } : {}),
    ...(user.issuedAtMs !== undefined ? { issuedAtMs: user.issuedAtMs } : {}),
    terminate,
  }, user.authStartedAt);
}
