/**
 * Admin-API: Domain-Verwaltung
 *
 * GET    /api/v1/admin/domains                    — alle Domains (gefiltert, paginiert)
 * GET    /api/v1/admin/domains/:id                — einzelne Domain
 * POST   /api/v1/admin/domains                    — neue Domain anlegen (DKIM auto-generiert)
 * PUT    /api/v1/admin/domains/:id                — Domain bearbeiten (name, active, dkimSelector)
 * PATCH  /api/v1/admin/domains/:id/toggle         — active umschalten
 * POST   /api/v1/admin/domains/:id/make-primary   — primäre Domain setzen
 * DELETE /api/v1/admin/domains/:id                — Domain löschen
 * GET    /api/v1/admin/domains/:id/dkim-record    — DNS TXT-Eintrag für DKIM
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';

const log = createLogger('admin:domains');
export const adminDomainsRouter: RouterType = Router();
adminDomainsRouter.use(requireAdmin);

const SELECT = {
  id: true, name: true, active: true, primary: true,
  dkimSelector: true, createdAt: true,
  _count: { select: { users: true } },
} as const;

// ── GET / ─────────────────────────────────────────────────────────────────────
adminDomainsRouter.get('/', async (req: Request, res: Response) => {
  const search = String(req.query['search'] ?? '').trim();
  const page   = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit  = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip   = (page - 1) * limit;

  const where = search ? { name: { contains: search, mode: 'insensitive' as const } } : {};

  const [domains, total] = await Promise.all([
    prisma.domain.findMany({ where, select: SELECT, orderBy: [{ primary: 'desc' }, { name: 'asc' }], skip, take: limit }),
    prisma.domain.count({ where }),
  ]);
  res.json({ domains, total, page, limit });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminDomainsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id }, select: SELECT });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  res.json(domain);
});

// ── POST / ────────────────────────────────────────────────────────────────────
adminDomainsRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    name:         z.string().min(3).max(253),
    dkimSelector: z.string().default('coremail'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const existing = await prisma.domain.findUnique({ where: { name: parsed.data.name } });
  if (existing) { res.status(409).json({ error: 'Domain already exists' }); return; }

  // DKIM-Schlüsselpaar automatisch generieren
  const { generateKeyPairSync } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  // Erste Domain wird automatisch primär
  const isPrimary = (await prisma.domain.count()) === 0;

  const domain = await prisma.domain.create({
    data: {
      name:          parsed.data.name,
      dkimSelector:  parsed.data.dkimSelector,
      dkimPrivateKey: privateKey,
      primary:       isPrimary,
    },
    select: SELECT,
  });
  log.info({ name: parsed.data.name, primary: isPrimary }, 'Domain created');
  res.status(201).json(domain);
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminDomainsRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    name:         z.string().min(3).max(253).optional(),
    active:       z.boolean().optional(),
    dkimSelector: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const updated = await prisma.domain.update({
    where: { id },
    data: {
      ...(parsed.data.name         !== undefined ? { name: parsed.data.name }               : {}),
      ...(parsed.data.active       !== undefined ? { active: parsed.data.active }           : {}),
      ...(parsed.data.dkimSelector !== undefined ? { dkimSelector: parsed.data.dkimSelector } : {}),
    },
    select: SELECT,
  });
  log.info({ id }, 'Domain updated');
  res.json(updated);
});

// ── PATCH /:id/toggle ─────────────────────────────────────────────────────────
adminDomainsRouter.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const updated = await prisma.domain.update({
    where: { id },
    data:  { active: !domain.active },
    select: SELECT,
  });
  log.info({ id, active: updated.active }, 'Domain toggled');
  res.json(updated);
});

// ── POST /:id/make-primary ────────────────────────────────────────────────────
adminDomainsRouter.post('/:id/make-primary', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  // Alle anderen Domains als nicht-primär markieren, diese als primär
  await prisma.$transaction([
    prisma.domain.updateMany({ where: { primary: true  }, data: { primary: false } }),
    prisma.domain.update({ where: { id }, data: { primary: true } }),
  ]);
  log.info({ id, name: domain.name }, 'Domain set as primary');

  const domains = await prisma.domain.findMany({
    select: SELECT,
    orderBy: [{ primary: 'desc' }, { name: 'asc' }],
  });
  res.json(domains);
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminDomainsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  if (domain.primary) { res.status(409).json({ error: 'Primary domain cannot be deleted' }); return; }
  const userCount = await prisma.user.count({ where: { domainId: id } });
  if (userCount > 0) { res.status(409).json({ error: 'Domain has active mailboxes' }); return; }
  await prisma.domain.delete({ where: { id } });
  log.info({ id, name: domain.name }, 'Domain deleted');
  res.json({ ok: true });
});

// ── GET /:id/dkim-record ──────────────────────────────────────────────────────
adminDomainsRouter.get('/:id/dkim-record', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const { createPublicKey } = await import('crypto');
  const pubKey    = createPublicKey(domain.dkimPrivateKey);
  const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
  const pubKeyB64 = (pubKeyDer as Buffer).toString('base64');

  res.json({
    selector: domain.dkimSelector,
    dnsName:  `${domain.dkimSelector}._domainkey.${domain.name}`,
    dnsValue: `v=DKIM1; k=rsa; p=${pubKeyB64}`,
  });
});
