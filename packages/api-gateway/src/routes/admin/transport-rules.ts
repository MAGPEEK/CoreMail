/**
 * Admin-API: Transportregeln
 *
 * GET    /api/v1/admin/transport-rules            — Liste
 * POST   /api/v1/admin/transport-rules            — Neue Regel
 * GET    /api/v1/admin/transport-rules/:id        — Detail
 * PUT    /api/v1/admin/transport-rules/:id        — Bearbeiten
 * PATCH  /api/v1/admin/transport-rules/:id/toggle — Aktivieren/Deaktivieren
 * DELETE /api/v1/admin/transport-rules/:id        — Löschen
 * POST   /api/v1/admin/transport-rules/reorder    — Prioritäten neu setzen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:transport-rules');
export const adminTransportRulesRouter: RouterType = Router();
adminTransportRulesRouter.use(requireAdmin);

const ConditionSchema = z.object({
  field: z.enum(['from', 'to', 'cc', 'subject', 'body', 'hasAttachment', 'size', 'spamScore']),
  op:    z.enum(['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'regex', 'greaterThan', 'lessThan', 'is']),
  value: z.string(),
});

const ActionSchema = z.object({
  type:  z.enum(['addHeader', 'removeHeader', 'redirect', 'reject', 'addRecipient', 'removeRecipient', 'setSubjectPrefix', 'setSubjectSuffix', 'quarantine', 'addDisclaimer']),
  value: z.string().default(''),
});

const RuleSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(500).default(''),
  enabled:     z.boolean().default(true),
  priority:    z.number().int().min(0).max(9999).default(0),
  conditions:  z.array(ConditionSchema).min(1),
  actions:     z.array(ActionSchema).min(1),
});

// ── GET / ─────────────────────────────────────────────────────────────────────
adminTransportRulesRouter.get('/', async (_req: Request, res: Response) => {
  const rules = await prisma.transportRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  res.json(rules);
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminTransportRulesRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const rule = await prisma.transportRule.findUnique({ where: { id } });
  if (!rule) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(rule);
});

// ── POST / ────────────────────────────────────────────────────────────────────
adminTransportRulesRouter.post('/', async (req: Request, res: Response) => {
  const p = RuleSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const actorId = (req as Request & { userId?: string }).userId ?? 'system';
  const rule = await prisma.transportRule.create({
    data: {
      ...p.data,
      conditions: p.data.conditions as object[],
      actions:    p.data.actions as object[],
      createdBy:  actorId,
    },
  });
  log.info({ id: rule.id, name: rule.name }, 'Transport rule created');
  res.status(201).json(rule);
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminTransportRulesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = RuleSchema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const rule = await prisma.transportRule.update({
      where: { id },
      data: {
        ...(p.data.name        !== undefined ? { name: p.data.name }               : {}),
        ...(p.data.description !== undefined ? { description: p.data.description } : {}),
        ...(p.data.enabled     !== undefined ? { enabled: p.data.enabled }         : {}),
        ...(p.data.priority    !== undefined ? { priority: p.data.priority }       : {}),
        ...(p.data.conditions  !== undefined ? { conditions: p.data.conditions as object[] } : {}),
        ...(p.data.actions     !== undefined ? { actions: p.data.actions as object[] }       : {}),
      },
    });
    res.json(rule);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── PATCH /:id/toggle ─────────────────────────────────────────────────────────
adminTransportRulesRouter.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const rule = await prisma.transportRule.findUnique({ where: { id }, select: { enabled: true } });
  if (!rule) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await prisma.transportRule.update({ where: { id }, data: { enabled: !rule.enabled } });
  res.json(updated);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminTransportRulesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.transportRule.delete({ where: { id } });
    log.info({ id }, 'Transport rule deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── POST /reorder ─────────────────────────────────────────────────────────────
// Body: { order: [{id, priority}] }
adminTransportRulesRouter.post('/reorder', async (req: Request, res: Response) => {
  const schema = z.object({ order: z.array(z.object({ id: z.string(), priority: z.number().int() })) });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }

  await prisma.$transaction(
    p.data.order.map(({ id, priority }) => prisma.transportRule.update({ where: { id }, data: { priority } }))
  );
  res.json({ message: 'Reihenfolge gespeichert' });
});
