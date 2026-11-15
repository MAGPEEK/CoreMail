/**
 * v7.0.1: ActiveSync Ping long-polls (up to 59 min) end with HTTP 401 when the
 * credentials of the request become invalid (password change/reset, MFA
 * enabled, app password revoked, deactivation …) — MS-ASHTTP: the device asks
 * for new credentials. server.ts attaches the registry to the auth bus.
 */
import { LiveConnectionRegistry, type LiveCredential } from '@coremail/core';

export const easLiveRequests = new LiveConnectionRegistry('activesync');

/** Credential facts of an authenticated EAS request (set by requireAuth). */
export interface EasCredentialInfo {
  credential?: LiveCredential;
  appPasswordId?: string;
  /** When the credential check of this request began (ms). */
  authStartedAt?: number;
}
