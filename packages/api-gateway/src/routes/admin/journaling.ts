/**
 * Admin API — Journaling Rules & Settings (Phase 9 / Exchange-2019-konform)
 *
 * Rules:
 *   GET    /api/v1/admin/compliance/journaling
 *   POST   /api/v1/admin/compliance/journaling
 *   GET    /api/v1/admin/compliance/journaling/:id
 *   PUT    /api/v1/admin/compliance/journaling/:id
 *   DELETE /api/v1/admin/compliance/journaling/:id
 *   POST   /api/v1/admin/compliance/journaling/:id/toggle
 *
 * Settings:
 *   GET    /api/v1/admin/compliance/journaling/settings
 *   PUT    /api/v1/admin/compliance/journaling/settings
 *
 * Failures:
 *   GET    /api/v1/admin/compliance/journaling/failures?status=PENDING|ABANDONED|RESOLVED
 *   POST   /api/v1/admin/compliance/journaling/failures/:id/retry
 *   DELETE /api/v1/admin/compliance/journaling/failures/:id
 *
 * Test:
 *   POST   /api/v1/admin/compliance/journaling/:id/test
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminJournalingRouter: RouterType = Router();
adminJournalingRouter.use(requireAuth, requireAdmin);

// ── Settings (Singleton) ─────────────────────────────────────────────────────
// Wichtig: vor /:id-Routen registriert, weil Express sonst "settings" als id matcht.

adminJournalingRouter.get('/settings', async (_req: Request, res: Response) => {
  let s = await prisma.journalingSettings.findUnique({ where: { id: 'singleton' } });
  if (!s) {
    s = await prisma.journalingSettings.create({ data: { id: 'singleton' } });
  }
  res.json(s);
});

adminJournalingRouter.put('/settings', async (req: Request, res: Response) => {
  const {
    alternativeJournalAddress, holdOnFailure, maxRetries, initialRetryDelaySec,
  } = req.body as {
    alternativeJournalAddress?: string | null;
    holdOnFailure?:             boolean;
    maxRetries?:                number;
    initialRetryDelaySec?:      number;
  };

  if (alternativeJournalAddress && !alternativeJournalAddress.includes('@')) {
    res.status(400).json({ error: 'alternativeJournalAddress muss eine gültige E-Mail-Adresse sein' });
    return;
  }
  if (maxRetries !== undefined && (maxRetries < 0 || maxRetries > 50)) {
    res.status(400).json({ error: 'maxRetries muss zwischen 0 und 50 liegen' });
    return;
  }
  if (initialRetryDelaySec !== undefined && (initialRetryDelaySec < 5 || initialRetryDelaySec > 3600)) {
    res.status(400).json({ error: 'initialRetryDelaySec muss zwischen 5 und 3600 liegen' });
    return;
  }

  const s = await prisma.journalingSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      ...(alternativeJournalAddress !== undefined ? { alternativeJournalAddress: alternativeJournalAddress || null } : {}),
      ...(holdOnFailure        !== undefined ? { holdOnFailure }        : {}),
      ...(maxRetries           !== undefined ? { maxRetries }           : {}),
      ...(initialRetryDelaySec !== undefined ? { initialRetryDelaySec } : {}),
    },
    update: {
      ...(alternativeJournalAddress !== undefined ? { alternativeJournalAddress: alternativeJournalAddress || null } : {}),
      ...(holdOnFailure        !== undefined ? { holdOnFailure }        : {}),
      ...(maxRetries           !== undefined ? { maxRetries }           : {}),
      ...(initialRetryDelaySec !== undefined ? { initialRetryDelaySec } : {}),
    },
  });

  // SMTP-Server-Engines invalidieren ihren Settings-Cache via Redis
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ kind: 'journaling' })).catch(() => undefined);
  res.json(s);
});

// ── Failures ─────────────────────────────────────────────────────────────────

adminJournalingRouter.get('/failures', async (req: Request, res: Response) => {
  const { status } = req.query as { status?: string };
  const where = status ? { status: status as 'PENDING'|'RETRYING'|'ALTERNATIVE'|'RESOLVED'|'ABANDONED' } : {};
  const failures = await prisma.journalingFailure.findMany({
    where,
    include: { rule: { select: { id: true, name: true, journalAddress: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(failures);
});

adminJournalingRouter.post('/failures/:id/retry', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const f = await prisma.journalingFailure.findUnique({ where: { id } });
  if (!f) { res.status(404).json({ error: 'Failure not found' }); return; }
  // Direkt fällig machen, der Retry-Loop holt es im nächsten Tick
  await prisma.journalingFailure.update({
    where: { id },
    data:  { status: 'PENDING', nextAttemptAt: new Date(), errorMessage: null },
  });
  res.json({ ok: true });
});

adminJournalingRouter.delete('/failures/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  await prisma.journalingFailure.delete({ where: { id } }).catch(() => undefined);
  res.status(204).end();
});

/**
 * GET /api/v1/admin/compliance/journaling
 * List all journaling rules.
 */
adminJournalingRouter.get('/', async (_req: Request, res: Response) => {
  const rules = await prisma.journalingRule.findMany({
    orderBy: { createdAt: 'asc' },
  });
  res.json(rules);
});

/**
 * POST /api/v1/admin/compliance/journaling
 * Create a journaling rule.
 */
adminJournalingRouter.post('/', async (req: Request, res: Response) => {
  const {
    name,
    description,
    journalAddress,
    scope,
    recipientType,
    recipientIds,
    wrapAsReport,
    enabled,
  } = req.body as {
    name?: string;
    description?: string;
    journalAddress?: string;
    scope?: string;
    recipientType?: string;
    recipientIds?: string[];
    wrapAsReport?: boolean;
    enabled?: boolean;
  };

  if (!name || !journalAddress) {
    res.status(400).json({ error: 'name and journalAddress are required' });
    return;
  }

  // Validate journal address format
  if (!journalAddress.includes('@')) {
    res.status(400).json({ error: 'journalAddress must be a valid email address' });
    return;
  }

  const validScopes = ['ALL', 'INBOUND', 'OUTBOUND', 'INTERNAL'];
  if (scope && !validScopes.includes(scope)) {
    res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
    return;
  }

  const validRecipientTypes = ['ALL_MAILBOXES', 'SPECIFIC_USERS', 'DOMAIN'];
  if (recipientType && !validRecipientTypes.includes(recipientType)) {
    res.status(400).json({ error: `recipientType must be one of: ${validRecipientTypes.join(', ')}` });
    return;
  }

  const rule = await prisma.journalingRule.create({
    data: {
      name,
      description: description ?? '',
      journalAddress,
      scope: (scope as 'ALL' | 'INBOUND' | 'OUTBOUND' | 'INTERNAL') ?? 'ALL',
      recipientType: (recipientType as 'ALL_MAILBOXES' | 'SPECIFIC_USERS' | 'DOMAIN') ?? 'ALL_MAILBOXES',
      recipientIds: recipientIds ?? [],
      wrapAsReport: wrapAsReport ?? true,
      enabled: enabled ?? true,
      createdBy: req.apiUser!.userId,
    },
  });

  res.status(201).json(rule);
});

/**
 * GET /api/v1/admin/compliance/journaling/:id
 * Get a specific journaling rule.
 */
adminJournalingRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const rule = await prisma.journalingRule.findUnique({ where: { id } });
  if (!rule) {
    res.status(404).json({ error: 'Journaling rule not found' });
    return;
  }
  res.json(rule);
});

/**
 * PUT /api/v1/admin/compliance/journaling/:id
 * Update a journaling rule.
 */
adminJournalingRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const {
    name,
    description,
    journalAddress,
    scope,
    recipientType,
    recipientIds,
    wrapAsReport,
    enabled,
  } = req.body as {
    name?: string;
    description?: string;
    journalAddress?: string;
    scope?: string;
    recipientType?: string;
    recipientIds?: string[];
    wrapAsReport?: boolean;
    enabled?: boolean;
  };

  const existing = await prisma.journalingRule.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Journaling rule not found' });
    return;
  }

  const rule = await prisma.journalingRule.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(journalAddress !== undefined ? { journalAddress } : {}),
      ...(scope !== undefined ? { scope: scope as 'ALL' | 'INBOUND' | 'OUTBOUND' | 'INTERNAL' } : {}),
      ...(recipientType !== undefined ? { recipientType: recipientType as 'ALL_MAILBOXES' | 'SPECIFIC_USERS' | 'DOMAIN' } : {}),
      ...(recipientIds !== undefined ? { recipientIds } : {}),
      ...(wrapAsReport !== undefined ? { wrapAsReport } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  });

  res.json(rule);
});

/**
 * DELETE /api/v1/admin/compliance/journaling/:id
 * Delete a journaling rule.
 */
adminJournalingRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.journalingRule.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Journaling rule not found' });
    return;
  }
  await prisma.journalingRule.delete({ where: { id } });
  res.json({ ok: true });
});

/**
 * POST /api/v1/admin/compliance/journaling/:id/toggle
 * Enable or disable a journaling rule.
 */
adminJournalingRouter.post('/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.journalingRule.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Journaling rule not found' });
    return;
  }
  const rule = await prisma.journalingRule.update({
    where: { id },
    data: { enabled: !existing.enabled },
  });
  res.json({ ok: true, enabled: rule.enabled });
});
