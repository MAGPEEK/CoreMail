/**
 * Recover deleted items (v8.1) — the user's own mailbox.
 *
 *   GET  /api/v1/mail/recoverable[?q=&limit=]   list (newest deletion first)
 *   POST /api/v1/mail/recoverable/restore {ids, folderId?}
 *        → back into the original folder (Trash/retention → INBOX) or folderId,
 *          with new UIDs through the message store
 *   POST /api/v1/mail/recoverable/purge {ids}   permanently remove
 *
 * 9.1 — the same three routes for mailboxes the user holds FULL_ACCESS on:
 *
 *   /api/v1/user/shared-mailboxes/:id/recoverable[/restore|/purge]
 *        :id = SharedMailbox id; FULL_ACCESS on the (active) shared mailbox
 *   /api/v1/mail/delegated-mailboxes/:id/recoverable[/restore|/purge]
 *        :id = Mailbox id (GET /mail/delegated-mailboxes → mailboxId); FULL_ACCESS delegation
 *
 * READ_ONLY / SEND_AS / SEND_ON_BEHALF are not enough (listing deleted items
 * reveals content the folder views no longer show; restore and purge change the
 * mailbox). No access, an unknown or inactive mailbox → 403 (no existence oracle).
 * A restore or purge in someone else's mailbox is audited
 * (`mailbox.recoverable.restore` / `mailbox.recoverable.purge`). A delegation counts
 * only while the owner exists, is active and is not the caller (lib/mailbox-access.ts).
 *
 * Items stay recoverable for DELETED_ITEM_RETENTION_DAYS (default 30); see
 * @coremail/storage recoverable-items.ts and docs/mailbox-quotas-recovery.md.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, listRecoverableItems, restoreRecoverableItems, purgeRecoverableItems } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { getWritableSharedMailbox, getFullAccessDelegatedMailbox } from '../lib/mailbox-access.js';
import { audit, auditContext } from '../lib/audit.js';

const IdsSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(1000),
  folderId: z.string().min(1).max(64).optional(),
});

/** Resolves the target mailbox of a request, or null when the caller may not use it. */
type MailboxResolver = (req: Request) => Promise<string | null>;

interface RecoverableRouterOpts {
  resolve: MailboxResolver;
  /** Status + message when `resolve` yields null. */
  denied: { status: number; error: string };
  /** Audit target of a purge (only for mailboxes other than the caller's own). */
  auditTarget?: { type: string; param: string };
}

export function createRecoverableRouter(opts: RecoverableRouterOpts): RouterType {
  const router: RouterType = Router({ mergeParams: true });
  router.use(requireAuth);

  const target = async (req: Request, res: Response): Promise<string | null> => {
    const mailboxId = await opts.resolve(req);
    if (!mailboxId) res.status(opts.denied.status).json({ error: opts.denied.error });
    return mailboxId;
  };

  /** Audits restore/purge in someone else's mailbox (no-op for the caller's own). */
  const auditForeign = (req: Request, action: string, mailboxId: string, changes: Record<string, unknown>): void => {
    if (!opts.auditTarget) return;
    const params = req.params as Record<string, string>;
    audit({
      actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
      action, targetType: opts.auditTarget.type,
      targetId: params[opts.auditTarget.param] ?? mailboxId,
      changes,
      ...auditContext(req),
    });
  };

  router.get('/', async (req: Request, res: Response) => {
    const mailboxId = await target(req, res);
    if (!mailboxId) return;
    const limit = Number(req.query['limit'] ?? 200);
    const q = typeof req.query['q'] === 'string' ? req.query['q'].slice(0, 200) : undefined;
    const out = await listRecoverableItems(mailboxId, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(q ? { search: q } : {}),
    });
    res.json(out);
  });

  router.post('/restore', async (req: Request, res: Response) => {
    const parsed = IdsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
    const mailboxId = await target(req, res);
    if (!mailboxId) return;
    try {
      const result = await restoreRecoverableItems(mailboxId, parsed.data.ids, {
        ...(parsed.data.folderId ? { targetFolderId: parsed.data.folderId } : {}),
      });
      auditForeign(req, 'mailbox.recoverable.restore', mailboxId, {
        restored: result.restored.length, notFound: result.notFound.length, ids: parsed.data.ids.length, mailboxId,
        ...(parsed.data.folderId ? { folderId: parsed.data.folderId } : {}),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof RangeError) { res.status(400).json({ error: 'Invalid target folder' }); return; }
      res.status(500).json({ error: 'Restore failed' });
    }
  });

  router.post('/purge', async (req: Request, res: Response) => {
    const parsed = IdsSchema.omit({ folderId: true }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
    const mailboxId = await target(req, res);
    if (!mailboxId) return;
    const purged = await purgeRecoverableItems(mailboxId, parsed.data.ids);
    auditForeign(req, 'mailbox.recoverable.purge', mailboxId, { purged, ids: parsed.data.ids.length, mailboxId });
    res.json({ ok: true, purged });
  });

  return router;
}

/** /api/v1/mail/recoverable — the caller's own mailbox. */
export const recoverableRouter: RouterType = createRecoverableRouter({
  resolve: async (req) => {
    const mbx = await prisma.mailbox.findUnique({ where: { userId: req.apiUser!.userId }, select: { id: true } });
    return mbx?.id ?? null;
  },
  denied: { status: 404, error: 'Mailbox not found' },
});

/** /api/v1/user/shared-mailboxes/:id/recoverable — FULL_ACCESS on the shared mailbox. */
export const sharedRecoverableRouter: RouterType = createRecoverableRouter({
  resolve: async (req) => (await getWritableSharedMailbox(req.apiUser!.userId, String(req.params['id'] ?? '')))?.mailboxId ?? null,
  denied: { status: 403, error: 'Full access required' },
  auditTarget: { type: 'sharedMailbox', param: 'id' },
});

/** /api/v1/mail/delegated-mailboxes/:id/recoverable — FULL_ACCESS delegation on the user mailbox. */
export const delegatedRecoverableRouter: RouterType = createRecoverableRouter({
  resolve: async (req) => (await getFullAccessDelegatedMailbox(req.apiUser!.userId, String(req.params['id'] ?? '')))?.mailboxId ?? null,
  denied: { status: 403, error: 'Full access required' },
  auditTarget: { type: 'mailbox', param: 'id' },
});
