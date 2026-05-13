import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminDomainsRouter: RouterType = Router();
adminDomainsRouter.use(requireAdmin);

// GET /api/v1/admin/domains
adminDomainsRouter.get('/', async (_req: Request, res: Response) => {
  
  const domains = await prisma.domain.findMany({
    select: { id: true, name: true, active: true, dkimSelector: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  res.json(domains);
});

// GET /api/v1/admin/domains/:id
adminDomainsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const domain = await prisma.domain.findUnique({
    where: { id },
    select: { id: true, name: true, active: true, dkimSelector: true, createdAt: true },
  });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  res.json(domain);
});

// POST /api/v1/admin/domains
adminDomainsRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({ name: z.string().min(3), dkimSelector: z.string().default('default') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const { generateKeyPairSync } = await import('crypto');
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privateKey = keyPair.privateKey;

  
  const existing = await prisma.domain.findUnique({ where: { name: parsed.data.name } });
  if (existing) { res.status(409).json({ error: 'Domain already exists' }); return; }

  const domain = await prisma.domain.create({
    data: { name: parsed.data.name, dkimSelector: parsed.data.dkimSelector, dkimPrivateKey: privateKey },
    select: { id: true, name: true, dkimSelector: true, active: true, createdAt: true },
  });
  res.status(201).json(domain);
});

// PUT /api/v1/admin/domains/:id
adminDomainsRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({ active: z.boolean().optional(), dkimSelector: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const updated = await prisma.domain.update({
    where: { id },
    data: {
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      ...(parsed.data.dkimSelector !== undefined ? { dkimSelector: parsed.data.dkimSelector } : {}),
    },
  });
  res.json({ id: updated.id, name: updated.name, active: updated.active });
});

// DELETE /api/v1/admin/domains/:id
adminDomainsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const userCount = await prisma.user.count({ where: { domainId: id } });
  if (userCount > 0) { res.status(409).json({ error: 'Domain has active mailboxes' }); return; }
  await prisma.domain.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /api/v1/admin/domains/:id/dkim-record — DNS TXT record for DKIM
adminDomainsRouter.get('/:id/dkim-record', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const domain = await prisma.domain.findUnique({ where: { id } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const { createPublicKey } = await import('crypto');
  const pubKey = createPublicKey(domain.dkimPrivateKey);
  const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
  const pubKeyB64 = pubKeyDer.toString('base64');

  res.json({
    selector: domain.dkimSelector,
    dnsName: `${domain.dkimSelector}._domainkey.${domain.name}`,
    dnsValue: `v=DKIM1; k=rsa; p=${pubKeyB64}`,
  });
});
