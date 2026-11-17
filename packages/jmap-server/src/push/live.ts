/**
 * v7.1.0: JMAP push connections (WebSocket, EventSource) end when the
 * credentials they authenticated with become invalid (password change/reset,
 * MFA enabled, app password revoked, deactivation, revoked web session …) —
 * see LiveConnectionRegistry in @coremail/core. server.ts attaches the
 * registry to the auth bus. 9.4: they also end when JMAP is switched off for
 * the account.
 */
import { LiveConnectionRegistry, PROTOCOL_ACCESS_CHANGE, type AuthInvalidationEvent } from '@coremail/core';
import type { JmapUser } from '../types.js';

export const jmapLiveConnections = new LiveConnectionRegistry('jmap');

/** WebSocket close code after a credential change (RFC 6455 §7.4.1 policy violation). */
export const WS_CLOSE_CREDENTIALS_CHANGED = 1008;
export const WS_CLOSE_REASON = 'Credentials changed, please authenticate again';
export const WS_CLOSE_REASON_DISABLED = 'JMAP access has been disabled for this account';

/** WebSocket close reason for an invalidation event. */
export function wsCloseReason(event: AuthInvalidationEvent): string {
  return event.reason === PROTOCOL_ACCESS_CHANGE ? WS_CLOSE_REASON_DISABLED : WS_CLOSE_REASON;
}

/** Registers a push connection of `user`; returns the unregister function. */
export function registerPushConnection(user: JmapUser, terminate: (event: AuthInvalidationEvent) => void): () => void {
  const a = user.auth;
  return jmapLiveConnections.register({
    userId: user.userId,
    credential: a?.credential ?? 'unknown',
    protocol: 'jmap',
    ...(a?.appPasswordId ? { appPasswordId: a.appPasswordId } : {}),
    ...(a?.sessionId ? { sessionId: a.sessionId } : {}),
    ...(a?.issuedAt !== undefined ? { issuedAt: a.issuedAt } : {}),
    ...(a?.issuedAtMs !== undefined ? { issuedAtMs: a.issuedAtMs } : {}),
    terminate,
  }, a?.startedAt);
}
