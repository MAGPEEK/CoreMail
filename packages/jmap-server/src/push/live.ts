/**
 * v7.1.0: JMAP push connections (WebSocket, EventSource) end when the
 * credentials they authenticated with become invalid (password change/reset,
 * MFA enabled, app password revoked, deactivation, revoked web session …) —
 * see LiveConnectionRegistry in @coremail/core. server.ts attaches the
 * registry to the auth bus.
 */
import { LiveConnectionRegistry } from '@coremail/core';
import type { JmapUser } from '../types.js';

export const jmapLiveConnections = new LiveConnectionRegistry('jmap');

/** WebSocket close code after a credential change (RFC 6455 §7.4.1 policy violation). */
export const WS_CLOSE_CREDENTIALS_CHANGED = 1008;
export const WS_CLOSE_REASON = 'Credentials changed, please authenticate again';

/** Registers a push connection of `user`; returns the unregister function. */
export function registerPushConnection(user: JmapUser, terminate: () => void): () => void {
  const a = user.auth;
  return jmapLiveConnections.register({
    userId: user.userId,
    credential: a?.credential ?? 'unknown',
    ...(a?.appPasswordId ? { appPasswordId: a.appPasswordId } : {}),
    ...(a?.sessionId ? { sessionId: a.sessionId } : {}),
    ...(a?.issuedAt !== undefined ? { issuedAt: a.issuedAt } : {}),
    ...(a?.issuedAtMs !== undefined ? { issuedAtMs: a.issuedAtMs } : {}),
    terminate,
  }, a?.startedAt);
}
