/**
 * Admin-API: Mail-Connectors (Sende- / Empfangsconnectors)
 *
 * GET    /api/v1/admin/connectors           — Liste (nach Typ filterbar)
 * POST   /api/v1/admin/connectors           — Erstellen
 * GET    /api/v1/admin/connectors/:id       — Detail
 * PUT    /api/v1/admin/connectors/:id       — Bearbeiten
 * PATCH  /api/v1/admin/connectors/:id/toggle — Aktivieren/Deaktivieren
 * DELETE /api/v1/admin/connectors/:id       — Löschen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:connectors');
export const adminConnectorsRouter: RouterType = Router();
adminConnectorsRouter.use(requireAdmin);

const Schema = z.object({
  name:          z.string().min(1).max(200),
  description:   z.string().max(500).default(''),
  type:          z.enum(['SEND', 'RECEIVE']),
  enabled:       z.boolean().default(true),
  host:          z.string().default(''),
  port:          z.number().int().min(1).max(65535).default(25),
  tls:           z.boolean().default(false),
  requireTls:    z.boolean().default(false),
  sourceIps:     z.array(z.string()).default([]),
  targetDomains: z.array(z.string()).default([]),
  username:      z.string().optional(),
  password:      z.string().optional(),
  priority:      z.number().int().min(0).max(9999).default(0),
});

// ── GET / ─────────────────────────────────────────────────────────────────────
adminConnectorsRouter.get('/', async (req: Request, res: Response) => {
  const { type = '' } = req.query as Record<string, string>;
  const where = type ? { type: type as 'SEND' | 'RECEIVE' } : {};
  const connectors = await prisma.mailConnector.findMany({
    where,
    orderBy: [{ type: 'asc' }, { priority: 'asc' }],
    select: {
      id: true, name: true, description: true, type: true, enabled: true,
      host: true, port: true, tls: true, requireTls: true,
      sourceIps: true, targetDomains: true, priority: true,
      username: true, createdAt: true,
      // password bewusst ausblenden
    },
  });
  res.json(connectors);
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminConnectorsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const c = await prisma.mailConnector.findUnique({
    where: { id },
    select: {
      id: true, name: true, description: true, type: true, enabled: true,
      host: true, port: true, tls: true, requireTls: true,
      sourceIps: true, targetDomains: true, priority: true,
      username: true, createdAt: true,
    },
  });
  if (!c) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(c);
});

// ── POST / ────────────────────────────────────────────────────────────────────
adminConnectorsRouter.post('/', async (req: Request, res: Response) => {
  const p = Schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const actorId = (req as Request & { userId?: string }).userId ?? 'system';
  const { username, password, ...rest } = p.data;
  const c = await prisma.mailConnector.create({
    data: {
      ...rest,
      createdBy: actorId,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    },
  });
  log.info({ id: c.id, name: c.name, type: c.type }, 'Connector created');
  res.status(201).json({ ...c, password: undefined });
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminConnectorsRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = Schema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const { username, password, type: _type, ...rest } = p.data;
  try {
    const data: Record<string, unknown> = {};
    if (rest.name          !== undefined) data['name']          = rest.name;
    if (rest.description   !== undefined) data['description']   = rest.description;
    if (rest.enabled       !== undefined) data['enabled']       = rest.enabled;
    if (rest.host          !== undefined) data['host']          = rest.host;
    if (rest.port          !== undefined) data['port']          = rest.port;
    if (rest.tls           !== undefined) data['tls']           = rest.tls;
    if (rest.requireTls    !== undefined) data['requireTls']    = rest.requireTls;
    if (rest.sourceIps     !== undefined) data['sourceIps']     = rest.sourceIps;
    if (rest.targetDomains !== undefined) data['targetDomains'] = rest.targetDomains;
    if (rest.priority      !== undefined) data['priority']      = rest.priority;
    if (username           !== undefined) data['username']      = username;
    if (password           !== undefined) data['password']      = password;
    const c = await prisma.mailConnector.update({ where: { id }, data });
    res.json({ ...c, password: undefined });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── PATCH /:id/toggle ─────────────────────────────────────────────────────────
adminConnectorsRouter.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const c = await prisma.mailConnector.findUnique({ where: { id }, select: { enabled: true } });
  if (!c) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await prisma.mailConnector.update({ where: { id }, data: { enabled: !c.enabled } });
  res.json({ ...updated, password: undefined });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminConnectorsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.mailConnector.delete({ where: { id } });
    log.info({ id }, 'Connector deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
