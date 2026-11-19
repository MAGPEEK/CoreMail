/**
 * Admin API of profile photos (9.5), mounted by routes/admin/mailboxes.ts:
 *
 *   GET    /api/v1/admin/mailboxes/:id/photo   the stored photo (BCP mailbox detail)
 *   DELETE /api/v1/admin/mailboxes/:id/photo   remove it → { removed }
 *
 * Area `recipients`, management scope through the router's `:id` param guard
 * (a mailbox outside the admin's scope is "not found"). Removing the photo of
 * an admin account needs a role that may manage that account (canManageAccount,
 * as for every other change of an admin account). The removal is audited as
 * `mailbox.photo.remove` and announced to the owner (`settings` / `profile`).
 */
import type { Request, Response } from 'express';
import { prisma, removeProfilePhoto, announceUserEvent } from '@coremail/storage';
import { audit, auditContext } from '../audit.js';
import { canManageAccount } from '../rbac.js';
import { sendPhoto } from './serve.js';

export async function getMailboxPhotoHandler(req: Request, res: Response): Promise<void> {
  const row = await prisma.user.findUnique({ where: { id: req.params['id'] ?? '' }, select: { photoKey: true } });
  await sendPhoto(req, res, row?.photoKey ?? null);
}

export async function deleteMailboxPhotoHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] ?? '';
  const actor = req.apiUser!;
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  if (actor.userId !== id && !canManageAccount(actor.role, user.role)) {
    res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
    return;
  }
  const removed = await removeProfilePhoto(id);
  if (removed) {
    audit({
      actorId: actor.userId, actorEmail: actor.email,
      action: 'mailbox.photo.remove', targetType: 'mailbox', targetId: id, targetName: user.email,
      ...auditContext(req),
    });
    announceUserEvent(id, { type: 'settings', action: 'delete', section: 'profile' });
  }
  res.json({ removed });
}
