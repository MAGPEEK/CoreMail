import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import { notifySecurityEvent, reauthErrorBody, verifyReauth } from '@coremail/storage/auth';
import { featureDisabledBody, isWebmailFeatureEnabled } from '@coremail/storage';
import {
  createAppPassword,
  listAppPasswords,
  deleteAppPassword,
} from '../app-passwords/index.js';
import { requireBearerUser } from './bearer.js';

const log = createLogger('auth:app-passwords:router');

export const appPasswordRouter: RouterType = Router();

// v7: like /auth/mfa and /auth/sessions — the access token of a logged-out or
// revoked session must not mint (persistent) app passwords until it expires
// (requireBearerUser, 9.4: also the Webmail switch).

/**
 * 9.4 webmail policy: with the module "App-Passwörter" off, listing and
 * creating answer 403 FEATURE_DISABLED (revoking stays possible; existing app
 * passwords keep working on the enabled protocols). Unreadable policy → 503.
 */
async function requireAppPasswordUser(req: Request, res: Response): Promise<string | null> {
  // 10.5: not while the account must enrol a second factor (revoking stays possible)
  const userId = await requireBearerUser(req, res, { mfaEnrolmentGate: true });
  if (!userId) return null;
  try {
    if (await isWebmailFeatureEnabled(userId, 'appPasswords')) return userId;
    res.status(403).json(featureDisabledBody('appPasswords'));
  } catch (err) {
    log.error({ err, userId }, 'Webmail policy not readable');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
  return null;
}

appPasswordRouter.get('/', async (req: Request, res: Response) => {
  const userId = await requireAppPasswordUser(req, res);
  if (!userId) return;
  const list = await listAppPasswords(userId);
  res.json(list);
});

// v8.1: an app password is a long-lived credential that bypasses MFA on the
// mail protocols — creating one needs re-authentication (`currentPassword` or
// `mfaCode`, same rules and failure limit as the MFA changes), and the user
// gets a notification mail in the own INBOX.
const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  currentPassword: z.string().max(1024).optional(),
  mfaCode: z.string().max(64).optional(),
  // 10.6: passkey re-authentication (POST /auth/passkeys/reauth/options)
  webauthnFlowId: z.string().max(256).optional(),
  webauthnResponse: z.unknown().optional(),
});

appPasswordRouter.post('/', async (req: Request, res: Response) => {
  const userId = await requireAppPasswordUser(req, res);
  if (!userId) return;

  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Name required' }); return; }

  const r = await verifyReauth(userId, {
    currentPassword: parsed.data.currentPassword, mfaCode: parsed.data.mfaCode,
    webauthnFlowId: parsed.data.webauthnFlowId, webauthnResponse: parsed.data.webauthnResponse,
  });
  if (r !== 'ok') {
    const { status, body } = reauthErrorBody(r);
    log.warn({ userId, result: r }, 'App password creation rejected — re-authentication failed');
    res.status(status).json(body);
    return;
  }

  const result = await createAppPassword(userId, parsed.data.name);
  void notifySecurityEvent({
    userId,
    subject: 'Security notice: a new app password was created',
    bodyText:
      `A new app password "${parsed.data.name}" was created for your account on ${new Date().toUTCString()}` +
      ` (IP ${req.ip ?? 'unknown'}).\n\n` +
      'App passwords give mail programs (IMAP, POP3, SMTP, ActiveSync, CalDAV/CardDAV, JMAP) access to your ' +
      'mailbox without the second factor.\n\nIf you did not create it, revoke it immediately under ' +
      'Settings → App passwords, change your password and inform your administrator.',
  });
  res.status(201).json(result);
});

appPasswordRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = await requireBearerUser(req, res);
  if (!userId) return;

  const ok = await deleteAppPassword(userId, req.params['id'] ?? '');
  if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});
