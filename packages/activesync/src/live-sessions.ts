/**
 * v7.1.0: ActiveSync Ping long-polls (up to 59 min) end with HTTP 401 when the
 * credentials of the request become invalid (password change/reset, MFA
 * enabled, app password revoked, deactivation …) — MS-ASHTTP: the device asks
 * for new credentials. server.ts attaches the registry to the auth bus.
 * 9.4: they end with HTTP 403 when ActiveSync is switched off for the account.
 */
import type { Response } from 'express';
import { LiveConnectionRegistry, type LiveCredential } from '@coremail/core';

export const easLiveRequests = new LiveConnectionRegistry('activesync');

/** Credential facts of an authenticated EAS request (set by requireAuth). */
export interface EasCredentialInfo {
  credential?: LiveCredential;
  appPasswordId?: string;
  /** When the credential check of this request began (ms). */
  authStartedAt?: number;
}

/**
 * 9.4: ActiveSync is switched off for the account — MS-ASHTTP 403 Forbidden
 * ("the user is not enabled for ActiveSync"): the device stops syncing
 * instead of asking for a new password.
 */
export function sendEasDisabled(res: Response): void {
  res.removeHeader('Content-Type');
  res.status(403).type('text/plain').send('ActiveSync access is disabled for this account');
}
