/**
 * Admin API — Journaling Rules (Phase 9)
 *
 * ECP → Compliance Management → Journaling
 *
 * Routes:
 *   GET    /api/v1/admin/compliance/journaling           — list rules
 *   POST   /api/v1/admin/compliance/journaling           — create rule
 *   GET    /api/v1/admin/compliance/journaling/:id       — get rule
 *   PUT    /api/v1/admin/compliance/journaling/:id       — update rule
 *   DELETE /api/v1/admin/compliance/journaling/:id       — delete rule
 *   POST   /api/v1/admin/compliance/journaling/:id/toggle — enable/disable
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminJournalingRouter: RouterType = Router();
adminJournalingRouter.use(requireAuth, requireAdmin);

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
