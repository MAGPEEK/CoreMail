/**
 * Recover deleted items (v8.1) — the user's own mailbox.
 *
 *   GET  /api/v1/mail/recoverable[?q=&limit=]   list (newest deletion first)
 *   POST /api/v1/mail/recoverable/restore {ids, folderId?}
 *        → back into the original folder (Trash/retention → INBOX) or folderId,
 *          with new UIDs through the message store
 *   POST /api/v1/mail/recoverable/purge {ids}   permanently remove
 *
 * Items stay recoverable for DELETED_ITEM_RETENTION_DAYS (default 30); see
 * @coremail/storage recoverable-items.ts and docs/mailbox-quotas-recovery.md.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, listRecoverableItems, restoreRecoverableItems, purgeRecoverableItems } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const recoverableRouter: RouterType = Router();
recoverableRouter.use(requireAuth);

const IdsSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(1000),
  folderId: z.string().min(1).max(64).optional(),
});

async function ownMailboxId(userId: string): Promise<string | null> {
  const mbx = await prisma.mailbox.findUnique({ where: { userId }, select: { id: true } });
  return mbx?.id ?? null;
}

recoverableRouter.get('/', async (req: Request, res: Response) => {
  const mailboxId = await ownMailboxId(req.apiUser!.userId);
  if (!mailboxId) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  const limit = Number(req.query['limit'] ?? 200);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].slice(0, 200) : undefined;
  const out = await listRecoverableItems(mailboxId, {
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(q ? { search: q } : {}),
  });
  res.json(out);
});

recoverableRouter.post('/restore', async (req: Request, res: Response) => {
  const parsed = IdsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const mailboxId = await ownMailboxId(req.apiUser!.userId);
  if (!mailboxId) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  try {
    const result = await restoreRecoverableItems(mailboxId, parsed.data.ids, {
      ...(parsed.data.folderId ? { targetFolderId: parsed.data.folderId } : {}),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof RangeError) { res.status(400).json({ error: 'Invalid target folder' }); return; }
    res.status(500).json({ error: 'Restore failed' });
  }
});

recoverableRouter.post('/purge', async (req: Request, res: Response) => {
  const parsed = IdsSchema.omit({ folderId: true }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const mailboxId = await ownMailboxId(req.apiUser!.userId);
  if (!mailboxId) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  const purged = await purgeRecoverableItems(mailboxId, parsed.data.ids);
  res.json({ ok: true, purged });
});
