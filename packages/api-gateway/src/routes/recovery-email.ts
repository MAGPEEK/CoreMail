/**
 * 10.6: the signed-in user's recovery address for self-service password reset
 * (webmail Settings → Sicherheit, docs/password-reset.md).
 *
 *   GET    /api/v1/user/recovery-email  → state + what the reset policy means for this account
 *   PUT    /api/v1/user/recovery-email  { address, currentPassword | mfaCode }
 *          → 202 { ok, pendingAddress, pendingExpiresAt } — a confirmation link goes to
 *            the new address; until it is opened the previous address stays in force
 *   DELETE /api/v1/user/recovery-email  { currentPassword | mfaCode } → { ok }
 *
 * Changes need a re-authentication (current password or a TOTP / backup code,
 * storage auth/reauth.ts), are rate-limited per account (mail bombing of a
 * foreign address), notify the own mailbox and the previously confirmed address,
 * and are audited (`auth.recovery-email.*`, always logged). LOCAL accounts only.
 * The confirmation itself is the public POST /auth/recovery-email/confirm.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import {
  authRedis,
  getRecoveryEmailState,
  loadResetFactors,
  loadSsprPolicy,
  mailboxReadableByOthers,
  reauthErrorBody,
  removeRecoveryEmail,
  requestRecoveryEmail,
  ssprAvailable,
  ssprRoleAllowed,
  verifyReauth,
} from '@coremail/storage/auth';
import { createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';
import { audit, auditContext } from '../lib/audit.js';
import { maskAddress, notifyRecoveryChange, sendRecoveryConfirmation } from '../lib/password-reset.js';

const log = createLogger('api:recovery-email');
export const recoveryEmailRouter: RouterType = Router();
recoveryEmailRouter.use(requireAuth);

/** Address changes per account and hour (each sends a confirmation mail to a foreign address). */
export const RECOVERY_CHANGES_PER_HOUR = 5;

const ERROR_TEXT: Record<'invalid_address' | 'hosted_address' | 'same_address', string> = {
  invalid_address: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
  hosted_address: 'Die Wiederherstellungsadresse muss eine externe Adresse sein, nicht eine Adresse dieses Servers.',
  same_address: 'Diese Adresse ist bereits Ihre Wiederherstellungsadresse.',
};

async function localAccount(userId: string): Promise<{ email: string; role: string } | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true, authSource: true } });
  return u && u.authSource === 'LOCAL' ? { email: u.email, role: u.role } : null;
}

recoveryEmailRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, authSource: true } });
    const [state, policy, factors, readable] = await Promise.all([
      getRecoveryEmailState(userId), loadSsprPolicy(), loadResetFactors(userId), mailboxReadableByOthers(userId),
    ]);
    const reason = u?.authSource !== 'LOCAL' ? 'external_directory'
      : !ssprRoleAllowed(u.role, policy) ? 'admin_excluded'
        : factors.any && !factors.provable ? 'mfa_unprovable'
          : null;
    res.json({
      address: state.address,
      verifiedAt: state.verifiedAt,
      pendingAddress: state.pendingAddress,
      pendingExpiresAt: state.pendingExpiresAt,
      policy: { available: ssprAvailable(policy), recoveryEmail: policy.recoveryEmail, ownMailbox: policy.ownMailbox },
      account: {
        eligible: reason === null,
        ...(reason ? { reason } : {}),
        // the own-mailbox method is skipped while others can read this mailbox
        ownMailboxUsable: policy.ownMailbox && !readable,
        mfaRequired: factors.any,
      },
    });
  } catch (err) {
    log.error({ err, userId }, 'recovery-email state failed');
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

const PutSchema = z.object({
  address: z.string().max(320),
  currentPassword: z.string().max(1024).optional(),
  mfaCode: z.string().max(32).optional(),
});

recoveryEmailRouter.put('/', async (req: Request, res: Response) => {
  const parsed = PutSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Anfrage' }); return; }
  const user = req.apiUser!;
  const account = await localAccount(user.userId);
  if (!account) {
    res.status(409).json({ error: 'Ihr Konto meldet sich über einen Verzeichnisdienst an. Das Passwort setzen Sie dort zurück.', code: 'NOT_LOCAL' });
    return;
  }
  const re = await verifyReauth(user.userId, { currentPassword: parsed.data.currentPassword, mfaCode: parsed.data.mfaCode });
  if (re !== 'ok') { const e = reauthErrorBody(re); res.status(e.status).json(e.body); return; }

  const rateKey = `recovery:rate:${user.userId}`;
  const n = await authRedis().incr(rateKey);
  if (n === 1) await authRedis().expire(rateKey, 3600);
  if (n > RECOVERY_CHANGES_PER_HOUR) {
    res.status(429).json({ error: 'Zu viele Änderungen. Bitte versuchen Sie es später erneut.', code: 'RATE_LIMITED' });
    return;
  }

  const r = await requestRecoveryEmail(user.userId, parsed.data.address);
  if (!r.ok) {
    res.status(400).json({ error: ERROR_TEXT[r.error], code: r.error.toUpperCase() });
    return;
  }
  try {
    await sendRecoveryConfirmation(r.address, r.token, account.email);
  } catch (err) {
    log.error({ err, userId: user.userId }, 'Failed to send the recovery confirmation');
    res.status(502).json({ error: 'Die Bestätigungs-E-Mail konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.', code: 'MAIL_FAILED' });
    return;
  }
  void notifyRecoveryChange(user.userId, 'requested', r.previous, r.address);
  audit({
    actorId: user.userId, actorEmail: user.email,
    action: 'auth.recovery-email.request', targetType: 'user', targetId: user.userId,
    changes: { pendingAddress: maskAddress(r.address), previous: maskAddress(r.previous) },
    ...auditContext(req),
  });
  res.status(202).json({ ok: true, pendingAddress: r.address, pendingExpiresAt: r.expiresAt });
});

const DeleteSchema = z.object({
  currentPassword: z.string().max(1024).optional(),
  mfaCode: z.string().max(32).optional(),
});

recoveryEmailRouter.delete('/', async (req: Request, res: Response) => {
  const parsed = DeleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Anfrage' }); return; }
  const user = req.apiUser!;
  const re = await verifyReauth(user.userId, { currentPassword: parsed.data.currentPassword, mfaCode: parsed.data.mfaCode });
  if (re !== 'ok') { const e = reauthErrorBody(re); res.status(e.status).json(e.body); return; }
  const r = await removeRecoveryEmail(user.userId);
  if (r.removed) {
    void notifyRecoveryChange(user.userId, 'removed', r.previous, null);
    audit({
      actorId: user.userId, actorEmail: user.email,
      action: 'auth.recovery-email.remove', targetType: 'user', targetId: user.userId,
      changes: { previous: maskAddress(r.previous) },
      ...auditContext(req),
    });
  }
  res.json({ ok: true });
});
