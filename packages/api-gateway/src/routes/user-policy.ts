/**
 * 9.4: the webmail policy of the signed-in user (mounted on /api/v1/user before
 * routes/user.ts) — see docs/webmail-policies.md.
 *
 *   GET    /features                 → { features, content }
 *   GET    /trusted-senders          → { senders }
 *   POST   /trusted-senders          { sender }   (address or "@domain")
 *   DELETE /trusted-senders/:sender
 *
 * `features.changePassword` is false for accounts without a local password
 * (LDAP / SSO). `content.maxUploadBytes` is the per-attachment limit of the
 * webmail upload (null = the message size limit only). The webmail reads
 * /features once and again on the `settings` / `policies` live event.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  prisma, effectiveWebmailPolicy, maxUploadBytes, listTrustedSenders, addTrustedSender, removeTrustedSender,
  MAX_TRUSTED_SENDERS,
} from '@coremail/storage';
import { protocolSubject, requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';

export const userPolicyRouter: RouterType = Router();

/** True for an account with a local password (LDAP / SSO accounts change it at their directory). */
export function isLocalAccount(u: { authSource?: string | null; passwordHash?: string | null } | null): boolean {
  return !!u && (u.authSource ?? 'LOCAL') === 'LOCAL' && !!u.passwordHash;
}

userPolicyRouter.get('/features', requireAuth, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const [policy, user] = await Promise.all([
    effectiveWebmailPolicy(protocolSubject(req.apiUser!)),
    prisma.user.findUnique({ where: { id: userId }, select: { authSource: true, passwordHash: true } }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    features: { ...policy.features, changePassword: policy.features.changePassword && isLocalAccount(user) },
    content: {
      blockedExtensions: policy.content.blockedExtensions,
      downloadOnlyExtensions: policy.content.downloadOnlyExtensions,
      maxUploadBytes: maxUploadBytes(policy.content),
      externalImages: policy.content.externalImages,
    },
  });
});

// Trusted senders are a reading setting: writes reach the user's other tabs.
const announceTrusted = announceOnWrite({ type: 'settings', section: 'policies' });

userPolicyRouter.get('/trusted-senders', requireAuth, async (req: Request, res: Response) => {
  res.json({ senders: await listTrustedSenders(req.apiUser!.userId), max: MAX_TRUSTED_SENDERS });
});

const AddSchema = z.object({ sender: z.string().min(1).max(254) }).strict();

userPolicyRouter.post('/trusted-senders', requireAuth, announceTrusted, async (req: Request, res: Response) => {
  const parsed = AddSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Eingabe' }); return; }
  const r = await addTrustedSender(req.apiUser!.userId, parsed.data.sender);
  if (!r.ok) {
    res.status(400).json(r.reason === 'limit'
      ? { error: `Höchstens ${MAX_TRUSTED_SENDERS} vertrauenswürdige Absender`, code: 'TOO_MANY_TRUSTED_SENDERS' }
      : { error: 'Ungültige Absenderadresse oder Domain', code: 'INVALID_SENDER' });
    return;
  }
  res.status(201).json({ sender: r.sender });
});

userPolicyRouter.delete('/trusted-senders/:sender', requireAuth, announceTrusted, async (req: Request, res: Response) => {
  const removed = await removeTrustedSender(req.apiUser!.userId, String(req.params['sender'] ?? ''));
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});
