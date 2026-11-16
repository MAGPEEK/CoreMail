/**
 * Admin API: service listeners
 *
 * GET    /api/v1/admin/services/overview                          — overview of all services
 * GET    /api/v1/admin/services/listeners/:service                — listeners of a service
 * POST   /api/v1/admin/services/listeners/:service                — add listener
 * PUT    /api/v1/admin/services/listeners/:id                     — edit listener
 * PATCH  /api/v1/admin/services/listeners/:id/toggle              — enable/disable listener
 * DELETE /api/v1/admin/services/listeners/:id                     — delete listener
 * POST   /api/v1/admin/services/listeners/:service/restore-defaults — restore default ports
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { isIP } from 'node:net';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { invalidInputMessage } from '../../lib/zod-message.js';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';

const log = createLogger('admin:services');
export const adminServicesRouter: RouterType = Router();
adminServicesRouter.use(requireArea('servers'));

// ── Valid service types ───────────────────────────────────────────────────────
const SERVICE_TYPES = ['SMTP_RECEIVE', 'SMTP_SEND', 'IMAP', 'POP3'] as const;
type SvcType = typeof SERVICE_TYPES[number];

// Slug → DB enum (URL uses hyphens, DB underscores)
/** Another listener of the same service already uses this port (409). */
export async function portTaken(service: SvcType, port: number, exceptId?: string): Promise<boolean> {
  const other = await prisma.serviceListener.findFirst({
    where: { service, port, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  return other !== null;
}

function slugToEnum(slug: string): SvcType | null {
  const upper = slug.toUpperCase().replace(/-/g, '_');
  return (SERVICE_TYPES as readonly string[]).includes(upper) ? upper as SvcType : null;
}

const ServiceTypeSchema = z.enum(SERVICE_TYPES);

const ListenerSchema = z.object({
  // IPv4/IPv6 literal the listener binds to (0.0.0.0 = all interfaces)
  address: z.string().trim().max(64).refine((a) => isIP(a) !== 0, 'IP address required').default('0.0.0.0'),
  port:    z.number().int().min(1).max(65535),
  ssl:     z.boolean().default(false),
  active:  z.boolean().default(true),
});

// ── Default listeners per service (seeded on first fetch) ──────────────────────
const DEFAULTS: { service: SvcType; address: string; port: number; ssl: boolean }[] = [
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 25,  ssl: false },
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 465, ssl: true  },
  // 587 = submission with STARTTLS (ssl:false); ssl:true would start implicit TLS
  // on 587 and break every client. Same seed as smtp-server/src/server.ts.
  { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: 587, ssl: false },
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

/** Publishes a Redis reload signal for the responsible service process. */
async function publishReload(service: SvcType): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.publish(CHANNEL_SERVICE_LISTENERS_RELOAD, JSON.stringify({ service }));
  } catch (err) {
    log.warn({ err }, 'Failed to publish listener reload signal — service will pick up changes on next poll');
  }
}

// ── GET /overview ─────────────────────────────────────────────────────────────
adminServicesRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    // Seed all services with defaults if empty
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
    res.status(400).json({ error: invalidInputMessage(parsed.error), details: parsed.error.issues });
    return;
  }
  if (await portTaken(svc, parsed.data.port)) {
    res.status(409).json({ error: `Port ${parsed.data.port} ist für diesen Dienst bereits konfiguriert` });
    return;
  }
  const listener = await prisma.serviceListener.create({
    data: { service: svc, ...parsed.data },
  });
  log.info({ service: svc, port: parsed.data.port }, 'Listener added');
  await publishReload(svc);
  res.status(201).json(listener);
});

// ── PUT /listeners/:id ────────────────────────────────────────────────────────
adminServicesRouter.put('/listeners/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const parsed = ListenerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: invalidInputMessage(parsed.error), details: parsed.error.issues });
    return;
  }
  const existing = await prisma.serviceListener.findUnique({ where: { id }, select: { service: true } });
  if (!existing) { res.status(404).json({ error: 'Listener not found' }); return; }
  if (await portTaken(existing.service as SvcType, parsed.data.port, id)) {
    res.status(409).json({ error: `Port ${parsed.data.port} ist für diesen Dienst bereits konfiguriert` });
    return;
  }
  try {
    const listener = await prisma.serviceListener.update({
      where: { id },
      data:  parsed.data,
    });
    log.info({ id }, 'Listener updated');
    await publishReload(listener.service as SvcType);
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

    // Signal the responsible service to reload its listeners
    try {
      const redis = getRedisClient();
      await redis.publish(
        CHANNEL_SERVICE_LISTENERS_RELOAD,
        JSON.stringify({ service: listener.service, port: listener.port, active: listener.active }),
      );
    } catch (err) {
      log.warn({ err }, 'Failed to publish listener reload signal — service must be restarted manually');
    }

    res.json(listener);
  } catch {
    res.status(404).json({ error: 'Listener not found' });
  }
});

// ── DELETE /listeners/:id ─────────────────────────────────────────────────────
adminServicesRouter.delete('/listeners/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    // Read first (for the service type), then delete, then reload signal
    const existing = await prisma.serviceListener.findUniqueOrThrow({ where: { id } });
    await prisma.serviceListener.delete({ where: { id } });
    log.info({ id, service: existing.service, port: existing.port }, 'Listener deleted');
    await publishReload(existing.service as SvcType);
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Listener not found' });
  }
});

// ── POST /listeners/:service/restore-defaults ────────────────────────────────
adminServicesRouter.post('/listeners/:service/restore-defaults', async (req: Request, res: Response) => {
  const svc = slugToEnum(req.params['service'] ?? '');
  if (!svc) { res.status(400).json({ error: 'Invalid service type' }); return; }

  try {
    const defs = DEFAULTS.filter(d => d.service === svc);
    if (defs.length === 0) {
      res.status(400).json({ error: 'No defaults defined for this service' });
      return;
    }

    // Delete all existing listeners, then create defaults with active=true
    await prisma.serviceListener.deleteMany({ where: { service: svc } });
    await prisma.serviceListener.createMany({
      data: defs.map(d => ({ ...d, active: true })),
    });
    log.info({ service: svc, count: defs.length }, 'Listener defaults restored');

    // Send reload signal so ports are restarted immediately
    await publishReload(svc);

    const listeners = await prisma.serviceListener.findMany({
      where:   { service: svc },
      orderBy: { port: 'asc' },
    });
    res.json(listeners);
  } catch (err) {
    log.error({ err, service: svc }, 'Failed to restore listener defaults');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Re-export Zod schema for type inference ───────────────────────────────────
export { ServiceTypeSchema };
