/**
 * Bearer authentication of the account-security routes (/auth/mfa,
 * /auth/app-passwords, /auth/sessions):
 *  - v7: the access token of a logged-out or revoked session is refused until
 *    it expires;
 *  - 9.4: an account whose Webmail is switched off gets 403 PROTOCOL_DISABLED —
 *    except accounts with an admin role, which keep these routes (MFA setup is
 *    needed for the BCP when MFA is mandatory for admins).
 */
import type { Request, Response } from 'express';
import { createLogger, verifyAccessToken } from '@coremail/core';
import { isAccessTokenRevokedShared, protocolDisabledBody, webAccessPermitted } from '@coremail/storage/auth';

const log = createLogger('auth:bearer');

/** The authenticated user id, or null after the refusal (401 / 403 / 503) was sent. */
export async function requireBearerUser(req: Request, res: Response): Promise<string | null> {
  const header = req.get('Authorization');
  const payload = header?.startsWith('Bearer ') ? verifyAccessToken(header.slice(7)) : null;
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId, payload.iatMs)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const subject = { id: payload.sub, role: String(payload.role), ...(typeof payload.domainId === 'string' ? { domainId: payload.domainId } : {}) };
  try {
    if (await webAccessPermitted(subject, 'admin')) return payload.sub;
  } catch (err) {
    log.error({ err }, 'Webmail switch check failed');
    res.status(503).json({ error: 'Authentication temporarily unavailable' });
    return null;
  }
  res.status(403).json(protocolDisabledBody('webmail'));
  return null;
}
