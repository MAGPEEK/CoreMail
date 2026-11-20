/**
 * Bearer authentication of the account-security routes (/auth/mfa,
 * /auth/app-passwords, /auth/sessions):
 *  - v7: the access token of a logged-out or revoked session is refused until
 *    it expires;
 *  - 9.4: an account whose Webmail is switched off gets 403 PROTOCOL_DISABLED —
 *    except accounts with an admin role, which keep these routes (MFA setup is
 *    needed for the BCP when MFA is mandatory for admins);
 *  - 10.5: with `mfaEnrolmentGate` (listing / creating app passwords) an
 *    account that must enrol a second factor ("MFA für alle Benutzer
 *    erzwingen", storage auth/mfa-enforcement.ts) gets 403
 *    MFA_ENROLMENT_REQUIRED. /auth/mfa (the enrolment itself), /auth/sessions
 *    and revoking an app password stay reachable.
 */
import type { Request, Response } from 'express';
import { verifyAccessToken } from '@coremail/core';
import { isAccessTokenRevokedShared, mfaEnrolmentRefusal, webAccessRefusal } from '@coremail/storage/auth';

export interface BearerOptions {
  /** 10.5: refuse accounts that must enrol a second factor first. */
  mfaEnrolmentGate?: boolean;
}

/** The authenticated user id, or null after the refusal (401 / 403 / 503) was sent. */
export async function requireBearerUser(req: Request, res: Response, opts: BearerOptions = {}): Promise<string | null> {
  return (await requireBearerSession(req, res, opts))?.userId ?? null;
}

/** 9.4: user id + the session the access token belongs to (sessions list marks the current one). */
export async function requireBearerSession(
  req: Request, res: Response, opts: BearerOptions = {},
): Promise<{ userId: string; sessionId: string | null } | null> {
  const header = req.get('Authorization');
  const payload = header?.startsWith('Bearer ') ? verifyAccessToken(header.slice(7)) : null;
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId, payload.iatMs)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const refusal = await webAccessRefusal({ id: payload.sub, role: String(payload.role), domainId: payload.domainId }, 'admin')
    ?? (opts.mfaEnrolmentGate ? await mfaEnrolmentRefusal(payload.sub, payload.mfaVerified) : null);
  if (!refusal) return { userId: payload.sub, sessionId: payload.sessionId ?? null };
  res.status(refusal.status).json(refusal.body);
  return null;
}
