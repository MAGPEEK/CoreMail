/**
 * Admin routes — eDiscovery & Legal Hold — Phase 8
 *
 * GET/POST/DELETE  /api/v1/admin/ediscovery/searches
 * POST             /api/v1/admin/ediscovery/searches/:id/run
 * POST             /api/v1/admin/ediscovery/searches/:id/export
 * GET/POST/DELETE  /api/v1/admin/ediscovery/holds
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('api:ediscovery');
export const adminEDiscoveryRouter: RouterType = Router();
adminEDiscoveryRouter.use(requireAdmin);

// ──────────────────────────────────────────────────────────────────
// Searches
// ──────────────────────────────────────────────────────────────────

// GET /api/v1/admin/ediscovery/searches
adminEDiscoveryRouter.get('/searches', async (_req: Request, res: Response) => {
  const searches = await prisma.eDiscoverySearch.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json(searches);
});

// GET /api/v1/admin/ediscovery/searches/:id
adminEDiscoveryRouter.get('/searches/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  res.json(search);
});

const SearchQuerySchema = z.object({
  keywords: z.string().optional(),
  senderAddresses: z.array(z.string().email()).default([]),
  recipientAddresses: z.array(z.string().email()).default([]),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  hasAttachment: z.boolean().optional(),
  subjectContains: z.string().optional(),
});

const CreateSearchSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  query: SearchQuerySchema,
  mailboxIds: z.array(z.string()).default([]), // empty = all mailboxes
});

// POST /api/v1/admin/ediscovery/searches
adminEDiscoveryRouter.post('/searches', async (req: Request, res: Response) => {
  const parsed = CreateSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const createdBy = req.apiUser?.userId ?? '';
  const search = await prisma.eDiscoverySearch.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      query: parsed.data.query,
      mailboxIds: parsed.data.mailboxIds,
      createdBy,
    },
  });
  res.status(201).json(search);
});

// DELETE /api/v1/admin/ediscovery/searches/:id
adminEDiscoveryRouter.delete('/searches/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  await prisma.eDiscoverySearch.delete({ where: { id } });
  res.status(204).end();
});

// POST /api/v1/admin/ediscovery/searches/:id/run  — execute the search
adminEDiscoveryRouter.post('/searches/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status === 'RUNNING') {
    res.status(409).json({ error: 'Search is already running' }); return;
  }

  // Mark as running
  await prisma.eDiscoverySearch.update({ where: { id }, data: { status: 'RUNNING' } });

  // Run search asynchronously via Redis job queue
  const redis = getRedisClient();
  await redis.publish('ediscovery:run', JSON.stringify({ searchId: id }));

  // Execute synchronously for now (async worker in production)
  runSearch(id).catch((err: unknown) => {
    log.error({ err, searchId: id }, 'eDiscovery search failed');
    void prisma.eDiscoverySearch.update({
      where: { id },
      data: { status: 'FAILED' },
    });
  });

  res.json({ message: 'Search started', searchId: id });
});

async function runSearch(searchId: string): Promise<void> {
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id: searchId } });
  if (!search) return;

  const q = search.query as {
    keywords?: string;
    senderAddresses?: string[];
    recipientAddresses?: string[];
    dateFrom?: string;
    dateTo?: string;
    hasAttachment?: boolean;
    subjectContains?: string;
  };

  // Build WHERE clause for cross-mailbox message search
  const messageWhere: Record<string, unknown> = { deletedAt: null };

  if (q.senderAddresses && q.senderAddresses.length > 0) {
    messageWhere['fromAddr'] = { in: q.senderAddresses };
  }
  if (q.dateFrom) messageWhere['date'] = { gte: new Date(q.dateFrom) };
  if (q.dateTo) {
    const existingDate = messageWhere['date'] as Record<string, Date> | undefined;
    messageWhere['date'] = { ...existingDate, lte: new Date(q.dateTo) };
  }
  if (q.subjectContains) {
    messageWhere['subject'] = { contains: q.subjectContains, mode: 'insensitive' };
  }
  if (q.keywords) {
    messageWhere['OR'] = [
      { subject: { contains: q.keywords, mode: 'insensitive' } },
      { bodyText: { contains: q.keywords, mode: 'insensitive' } },
    ];
  }

  // If specific mailboxes are requested, scope to them
  let folderWhere: Record<string, unknown> = {};
  if (search.mailboxIds.length > 0) {
    const mailboxes = await prisma.mailbox.findMany({
      where: { userId: { in: search.mailboxIds } },
      select: { id: true },
    });
    folderWhere = { mailboxId: { in: mailboxes.map((m) => m.id) } };
  }

  if (Object.keys(folderWhere).length > 0) {
    const folders = await prisma.folder.findMany({ where: folderWhere, select: { id: true } });
    messageWhere['folderId'] = { in: folders.map((f) => f.id) };
  }

  const count = await prisma.message.count({ where: messageWhere });

  await prisma.eDiscoverySearch.update({
    where: { id: searchId },
    data: { status: 'COMPLETED', resultCount: count },
  });

  log.info({ searchId, count }, 'eDiscovery search completed');
}

// POST /api/v1/admin/ediscovery/searches/:id/export — export results as MBOX
adminEDiscoveryRouter.post('/searches/:id/export', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status !== 'COMPLETED') {
    res.status(409).json({ error: 'Search must be completed before export' }); return;
  }

  // Enqueue export job
  const redis = getRedisClient();
  await redis.publish('ediscovery:export', JSON.stringify({ searchId: id }));

  res.json({
    message: 'Export job queued',
    searchId: id,
    note: 'Download URL will be set on the search record once the export is ready.',
  });
});

// GET /api/v1/admin/ediscovery/searches/:id/results?limit=50&offset=0
adminEDiscoveryRouter.get('/searches/:id/results', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const limit = Math.min(parseInt((req.query as Record<string, string>)['limit'] ?? '50', 10), 200);
  const offset = parseInt((req.query as Record<string, string>)['offset'] ?? '0', 10);

  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status !== 'COMPLETED') {
    res.status(409).json({ error: 'Search not yet completed' }); return;
  }

  const q = search.query as Record<string, unknown>;
  const messageWhere: Record<string, unknown> = { deletedAt: null };
  if (q['senderAddresses']) messageWhere['fromAddr'] = { in: q['senderAddresses'] as string[] };
  if (q['dateFrom']) messageWhere['date'] = { gte: new Date(q['dateFrom'] as string) };
  if (q['dateTo']) {
    const d = messageWhere['date'] as Record<string, Date> | undefined;
    messageWhere['date'] = { ...d, lte: new Date(q['dateTo'] as string) };
  }
  if (q['subjectContains']) {
    messageWhere['subject'] = { contains: q['subjectContains'] as string, mode: 'insensitive' };
  }
  if (q['keywords']) {
    messageWhere['OR'] = [
      { subject: { contains: q['keywords'] as string, mode: 'insensitive' } },
      { bodyText: { contains: q['keywords'] as string, mode: 'insensitive' } },
    ];
  }

  const messages = await prisma.message.findMany({
    where: messageWhere,
    select: {
      id: true, subject: true, fromAddr: true, toAddrs: true, date: true,
      rawSize: true, folder: { select: { name: true, mailbox: { select: { userId: true } } } },
    },
    orderBy: { date: 'desc' },
    skip: offset,
    take: limit,
  });

  res.json({ total: search.resultCount, messages });
});

// ──────────────────────────────────────────────────────────────────
// Legal Hold
// ──────────────────────────────────────────────────────────────────

// GET /api/v1/admin/ediscovery/holds
adminEDiscoveryRouter.get('/holds', async (_req: Request, res: Response) => {
  const holds = await prisma.legalHold.findMany({ orderBy: { appliedAt: 'desc' } });
  res.json(holds);
});

// GET /api/v1/admin/ediscovery/holds/:id
adminEDiscoveryRouter.get('/holds/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hold = await prisma.legalHold.findUnique({ where: { id } });
  if (!hold) { res.status(404).json({ error: 'Legal hold not found' }); return; }
  res.json(hold);
});

const CreateHoldSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  mailboxIds: z.array(z.string()).min(1),
});

// POST /api/v1/admin/ediscovery/holds
adminEDiscoveryRouter.post('/holds', async (req: Request, res: Response) => {
  const parsed = CreateHoldSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const appliedBy = req.apiUser?.userId ?? '';
  const hold = await prisma.legalHold.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      mailboxIds: parsed.data.mailboxIds,
      appliedBy,
    },
  });
  log.info({ holdId: hold.id, mailboxes: parsed.data.mailboxIds.length }, 'Legal hold applied');
  res.status(201).json(hold);
});

// DELETE /api/v1/admin/ediscovery/holds/:id  — release hold
adminEDiscoveryRouter.delete('/holds/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hold = await prisma.legalHold.findUnique({ where: { id } });
  if (!hold) { res.status(404).json({ error: 'Legal hold not found' }); return; }
  await prisma.legalHold.update({
    where: { id },
    data: { active: false, releasedAt: new Date() },
  });
  log.info({ holdId: id }, 'Legal hold released');
  res.status(204).end();
});

// GET /api/v1/admin/ediscovery/holds/check/:userId  — is user under legal hold?
adminEDiscoveryRouter.get('/holds/check/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  const hold = await prisma.legalHold.findFirst({
    where: { active: true, mailboxIds: { has: userId } },
    select: { id: true, name: true, appliedAt: true },
  });
  res.json({ underHold: !!hold, hold: hold ?? null });
});
