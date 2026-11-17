/**
 * v7.1.0: authenticated IMAP connections end when the credentials they used
 * become invalid (password change/reset, MFA enabled, app password revoked,
 * deactivation, deletion, all sessions revoked) — see LiveConnectionRegistry
 * in @coremail/core. server.ts attaches the registry to the auth bus.
 * 9.4: they also end when IMAP is switched off for the account.
 */
import { LiveConnectionRegistry, PROTOCOL_ACCESS_CHANGE, type AuthInvalidationEvent, type LiveCredential } from '@coremail/core';
import type { ImapSession } from './state.js';

export const imapLiveSessions = new LiveConnectionRegistry('imap');

export const CREDENTIALS_CHANGED_BYE = 'BYE Credentials changed, please log in again';
/** 9.4: IMAP switched off for the account — login refusal (tagged NO) and BYE of open sessions. */
export const IMAP_DISABLED = '[AUTHORIZATIONFAILED] IMAP access is disabled for this account';
export const IMAP_DISABLED_BYE = 'BYE IMAP access has been disabled for this account';

function toCredential(method: string): LiveCredential {
  return method === 'password' || method === 'app_password' || method === 'external' ? method : 'unknown';
}

/** Registers a session after a successful login (replaces an earlier registration). */
export function registerLiveSession(session: ImapSession, method: string, appPasswordId?: string, authStartedAt?: number): void {
  session.unregisterLive?.();
  session.unregisterLive = null;
  if (!session.userId) return;
  session.unregisterLive = imapLiveSessions.register({
    userId: session.userId,
    credential: toCredential(method),
    protocol: 'imap',
    ...(appPasswordId ? { appPasswordId } : {}),
    terminate: (event) => terminateForCredentialChange(session, event),
  }, authStartedAt);
}

/** Removes the session from the registry (connection closed). */
export function unregisterLiveSession(session: ImapSession): void {
  session.unregisterLive?.();
  session.unregisterLive = null;
}

/**
 * Sends `* BYE` and closes the connection (RFC 9051 §7.1.5). A command that
 * is running (e.g. a FETCH writing a literal) finishes first, so the BYE never
 * lands inside another response; an IDLE connection is closed immediately.
 */
export function terminateForCredentialChange(session: ImapSession, event?: AuthInvalidationEvent): void {
  session.unregisterLive = null;
  const bye = event?.reason === PROTOCOL_ACCESS_CHANGE ? IMAP_DISABLED_BYE : CREDENTIALS_CHANGED_BYE;
  const run = (): void => {
    if (session.state === 'LOGOUT') return;
    session.state = 'LOGOUT';
    session.idleActive = false;
    session.selected = null;
    const socket = session.socket;
    if (socket.writable) socket.write(`* ${bye}\r\n`);
    socket.end();
    setTimeout(() => socket.destroy(), 2000).unref();
  };
  if (session.busy) session.afterCommand = run;
  else run();
}
