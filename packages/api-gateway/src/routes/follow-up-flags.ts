/**
 * 9.4: follow-up flags of the user's own messages ("Kennzeichnen").
 *
 *   PUT /api/v1/mail/follow-up            { ids, status, startAt?, dueAt?, reminderAt? }
 *   GET /api/v1/mail/follow-up?status=    flagged (default) | complete | all — the mails of
 *                                         "Gekennzeichnete Elemente und Aufgaben", due first
 *
 * Writes go through message-store setFollowUp: one modSeq per mailbox, `\Flagged`
 * kept in step, so IMAP/JMAP/EAS clients and the other webmail tabs see the change.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, setFollowUp, followUpOf, FOLLOW_UP_STATUSES, FLAGGED_KEYWORD } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const followUpRouter: RouterType = Router();
followUpRouter.use(requireAuth);

const isoDate = z.string().refine((s) => !isNaN(new Date(s).getTime()), 'invalid date');
const FollowUpSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  status: z.enum(FOLLOW_UP_STATUSES),
  startAt: isoDate.nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  reminderAt: isoDate.nullable().optional(),
});

/** undefined = keep the stored date, null = clear it. */
const asDate = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v ? new Date(v) : null);

followUpRouter.put('/', async (req: Request, res: Response) => {
  const parsed = FollowUpSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const userId = req.apiUser!.userId;
  const mailbox = await prisma.mailbox.findFirst({ where: { userId }, select: { id: true } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  const where = { folder: { mailboxId: mailbox.id }, deletedAt: null };
  const own = await prisma.message.findMany({ where: { id: { in: parsed.data.ids }, ...where }, select: { id: true } });
  if (own.length === 0) { res.status(404).json({ error: 'Keine Nachrichten gefunden' }); return; }

  const dates = { startAt: asDate(parsed.data.startAt), dueAt: asDate(parsed.data.dueAt), reminderAt: asDate(parsed.data.reminderAt) };
  const updated = await prisma.$transaction((tx) => setFollowUp(tx, own.map((m) => m.id), {
    status: parsed.data.status,
    ...(dates.startAt !== undefined ? { startAt: dates.startAt } : {}),
    ...(dates.dueAt !== undefined ? { dueAt: dates.dueAt } : {}),
    ...(dates.reminderAt !== undefined ? { reminderAt: dates.reminderAt } : {}),
  }, { mailboxId: mailbox.id, where }));
  res.json({ ok: true, count: updated.length });
});

const LIST_LIMIT = 500;

followUpRouter.get('/', async (req: Request, res: Response) => {
  const wanted = String(req.query['status'] ?? 'flagged');
  if (!['flagged', 'complete', 'all'].includes(wanted)) { res.status(400).json({ error: 'Invalid status' }); return; }
  const userId = req.apiUser!.userId;
  // legacy rows (before 9.4) carry only \Flagged — included as flagged
  const flaggedWhere = { OR: [{ flagStatus: 'flagged' }, { flagStatus: 'none', flags: { has: FLAGGED_KEYWORD } }] };
  const statusWhere = wanted === 'flagged' ? flaggedWhere
    : wanted === 'complete' ? { flagStatus: 'complete' }
      : { OR: [...flaggedWhere.OR, { flagStatus: 'complete' }] };
  const rows = await prisma.message.findMany({
    where: { deletedAt: null, folder: { mailbox: { userId } }, ...statusWhere },
    select: {
      id: true, folderId: true, subject: true, fromName: true, fromAddr: true, date: true, flags: true,
      flagStatus: true, flagStartAt: true, flagDueAt: true, flagReminderAt: true, flagCompletedAt: true,
      folder: { select: { displayName: true } },
    },
    orderBy: [{ flagDueAt: { sort: 'asc', nulls: 'last' } }, { date: 'desc' }],
    take: LIST_LIMIT,
  });
  res.json(rows.map(({ folder, flags, ...m }) => {
    const state = followUpOf({ flags, ...m });
    return {
      id: m.id, folderId: m.folderId, folderName: folder.displayName, subject: m.subject,
      fromName: m.fromName, fromAddr: m.fromAddr, date: m.date,
      flagStatus: state.status, flagStartAt: state.startAt, flagDueAt: state.dueAt,
      flagReminderAt: state.reminderAt, flagCompletedAt: state.completedAt,
    };
  }));
});
