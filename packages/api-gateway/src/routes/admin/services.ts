/**
 * Admin-API: Service-Listeners
 *
 * GET    /api/v1/admin/services/overview             — Übersicht aller Services
 * GET    /api/v1/admin/services/listeners/:service   — Listener eines Services
 * POST   /api/v1/admin/services/listeners/:service   — Listener hinzufügen
 * PUT    /api/v1/admin/services/listeners/:id        — Listener bearbeiten
 * PATCH  /api/v1/admin/services/listeners/:id/toggle — Listener aktivieren/deaktivieren
 * DELETE /api/v1/admin/services/listeners/:id        — Listener löschen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';

const log = createLogger('admin:services');
export const adminServicesRouter: RouterType = Router();
adminServicesRouter.use(requireAdmin);

// ── Gültige Service-Typen ─────────────────────────────────────────────────────
const SERVICE_TYPES = ['SMTP_RECEIVE', 'SMTP_SEND', 'IMAP', 'POP3'] as const;
type SvcType = typeof SERVICE_TYPES[number];

// Slug → DB-Enum (URL benutzt Bindestriche, DB Unterstriche)
function slugToEnum(slug: string): SvcType | null {
  const upper = slug.toUpperCase().replace(/-/g, '_');
  return (SERVICE_TYPES as readonly string[]).includes(upper) ? upper as SvcType : null;
}

const ServiceTypeSchema = z.enum(SERVICE_TYPES);

const ListenerSchema = z.object({
  address: z.string().min(1).max(64).default('0.0.0.0'),
  port:    z.number().int().min(1).max(65535),
  ssl:     z.boolean().default(false),
  active:  z.boolean().default(true),
});

// ── Default-Listener pro Service (werden beim ersten Abruf gesät) ──────────────
const DEFAULTS: { service: SvcType; address: string; port: number; ssl: boolean }[] = [
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 25,  ssl: false },
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 465, ssl: true  },
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 587, ssl: true  },
  { service: 'SMTP_SEND',    address: '0.0.0.0', port: 587, ssl: true  },
  { service: 'IMAP',         address: '0.0.0.0', port: 143, ssl: false },
  { service: 'IMAP',         address: '0.0.0.0', port: 993, ssl: true  },
  { service: 'POP3',         address: '0.0.0.0', port: 110, ssl: false },
  { service: 'POP3',         address: '0.0.0.0', port: 995, ssl: true  },
];

async function ensureDefaults(service: SvcType) {
  const count = await prisma.serviceListener.count({ where: { service } });
  if (count === 0) {
    const defs = DEFAULTS.filter(d => d.service === service);
    if (defs.length > 0) {
      await prisma.serviceListener.createMany({ data: defs });
    }
  }
}

// ── GET /overview ─────────────────────────────────────────────────────────────
adminServicesRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    // Seed alle Services mit Defaults, falls leer
    for (const svc of SERVICE_TYPES) {
      await ensureDefaults(svc);
    }

    const result: Record<string, { total: number; active: number }> = {};
    for (const svc of SERVICE_TYPES) {
      const [total, active] = await Promise.all([
        prisma.serviceListener.count({ where: { service: svc } }),
        prisma.serviceListener.count({ where: { service: svc, active: true } }),
      ]);
      result[svc] = { total, active };
    }
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Failed to get service overview');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /listeners/:service ───────────────────────────────────────────────────
adminServicesRouter.get('/listeners/:service', async (req: Request, res: Response) => {
  const svc = slugToEnum(req.params['service'] ?? '');
  if (!svc) { res.status(400).json({ error: 'Invalid service type' }); return; }

  await ensureDefaults(svc);
  const listeners = await prisma.serviceListener.findMany({
    where:   { service: svc },
    orderBy: { port: 'asc' },
  });
  res.json(listeners);
});

// ── POST /listeners/:service ──────────────────────────────────────────────────
adminServicesRouter.post('/listeners/:service', async (req: Request, res: Response) => {
  const svc = slugToEnum(req.params['service'] ?? '');
  if (!svc) { res.status(400).json({ error: 'Invalid service type' }); return; }

  const parsed = ListenerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }
  const listener = await prisma.serviceListener.create({
    data: { service: svc, ...parsed.data },
  });
  log.info({ service: svc, port: parsed.data.port }, 'Listener added');
  res.status(201).json(listener);
});

// ── PUT /listeners/:id ────────────────────────────────────────────────────────
adminServicesRouter.put('/listeners/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const parsed = ListenerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }
  try {
    const listener = await prisma.serviceListener.update({
      where: { id },
      data:  parsed.data,
    });
    log.info({ id }, 'Listener updated');
    res.json(listener);
  } catch {
    res.status(404).json({ error: 'Listener not found' });
  }
});

// ── PATCH /listeners/:id/toggle ───────────────────────────────────────────────
adminServicesRouter.patch('/listeners/:id/toggle', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    const existing = await prisma.serviceListener.findUniqueOrThrow({ where: { id } });
    const listener = await prisma.serviceListener.update({
      where: { id },
      data:  { active: !existing.active },
    });
    log.info({ id, active: listener.active }, 'Listener toggled');
    res.json(listener);
  } catch {
    res.status(404).json({ error: 'Listener not found' });
  }
});

// ── DELETE /listeners/:id ─────────────────────────────────────────────────────
adminServicesRouter.delete('/listeners/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.serviceListener.delete({ where: { id } });
    log.info({ id }, 'Listener deleted');
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Listener not found' });
  }
});

// ── Re-export Zod schema for type inference ───────────────────────────────────
export { ServiceTypeSchema };
