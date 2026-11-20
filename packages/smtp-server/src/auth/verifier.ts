/**
 * SMTP credential verifier (AUTH PLAIN / LOGIN on the submission ports).
 *
 * v7: delegates to the shared mail-protocol check verifyMailCredentials()
 * from @coremail/storage — same rules for every protocol:
 *  - primary password or app password, MFA accounts: app passwords only
 *  - shared Redis lockout per client IP and per account (checked per attempt)
 *  - database errors are temporary failures (454 4.7.0), never "invalid"
 */

import { createLogger } from '@coremail/core';
import { verifyMailCredentials } from '@coremail/storage';
import type { AuthUser, SmtpAuthFailure } from '../core/types.js';

const log = createLogger('smtp:auth');

export async function verifySmtpCredentials(
  username: string,
  password: string,
  /** Client IP — for the shared brute-force lockout. */
  clientIp?: string,
): Promise<AuthUser | null | SmtpAuthFailure> {
  const result = await verifyMailCredentials(username, password, { ip: clientIp, protocol: 'smtp' });
  switch (result.status) {
    case 'ok':
      log.info({ email: result.user.email, method: result.method }, 'SMTP auth success');
      return {
        id: result.user.id,
        email: result.user.email,
        credential: result.method,
        ...(result.appPasswordId ? { appPasswordId: result.appPasswordId } : {}),
      };
    case 'locked':
      return { failure: 'locked', retryAfterSec: result.retryAfterSec };
    case 'error':
      return { failure: 'temporary' };
    case 'protocol_disabled':
      return { failure: 'protocol_disabled' };
    case 'mfa_app_password_required':
    case 'invalid':
    default:
      // 10.5: the attack dashboard event is recorded by the shared lockout (all protocols).
      return null;
  }
}
