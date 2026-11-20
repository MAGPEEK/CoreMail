/**
 * 10.5: GET /api/v1/user/mfa-enforcement — the "MFA für alle Benutzer
 * erzwingen" state of the signed-in account (storage auth/mfa-enforcement.ts):
 *
 *   { state: 'off' | 'satisfied' | 'grace' | 'required', deadline?: ISO, canEnrol: boolean }
 *
 * `grace` → the webmail shows a banner until `deadline`; `required` → the
 * webmail shows the mandatory enrolment page (every other API call answers 403
 * MFA_ENROLMENT_REQUIRED). `canEnrol` is false for SSO-only accounts (no
 * password to confirm an enrolment with — they satisfy the rule by signing in
 * with MFA at their identity provider). Reachable while enrolment is required
 * (middleware/auth.ts MFA_ENROLMENT_ALLOWED_PATHS). The first call after the
 * switch was turned on starts the account's grace period.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { mfaEnforcementFor } from '@coremail/storage/auth';
import { requireAuth } from '../middleware/auth.js';

const log = createLogger('api:mfa-enforcement');

export const mfaEnforcementRouter: RouterType = Router();

mfaEnforcementRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = req.apiUser!;
  try {
    const { status, canEnrol } = await mfaEnforcementFor(user.userId, { mfaVerified: user.mfaVerified });
    res.set('Cache-Control', 'no-store');
    res.json({
      state: status.state,
      ...('deadline' in status ? { deadline: status.deadline.toISOString() } : {}),
      canEnrol,
    });
  } catch (err) {
    log.error({ err, userId: user.userId }, 'MFA enforcement state not readable');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
});
