/**
 * Admin-API: Organisation (Sharing-Richtlinien + Adresslisten)
 *
 * GET/POST/PUT/DELETE /api/v1/admin/organisation/sharing-policies
 * GET/POST/PUT/DELETE /api/v1/admin/organisation/address-lists
 * GET                 /api/v1/admin/organisation/gal            — Globale Adressliste (Live-Abfrage)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:organisation');
export const adminOrganisationRouter: RouterType = Router();
adminOrganisationRouter.use(requireAdmin);

// ─── Sharing Policies ─────────────────────────────────────────────────────────

const SharingSchema = z.object({
  name:           z.string().min(1).max(200),
  description:    z.string().max(500).default(''),
  enabled:        z.boolean().default(true),
  allowedDomains: z.array(z.string()).default([]),
  allowCalendar:  z.boolean().default(true),
  allowContacts:  z.boolean().default(false),
  calendarDetail: z.enum(['FREEBUSY', 'LIMITED', 'FULL']).default('FREEBUSY'),
  isDefault:      z.boolean().default(false),
});

adminOrganisationRouter.get('/sharing-policies', async (_req: Request, res: Response) => {
  const policies = await prisma.sharingPolicy.findMany({ orderBy: { name: 'asc' } });
  res.json(policies);
});

adminOrganisationRouter.post('/sharing-policies', async (req: Request, res: Response) => {
  const p = SharingSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }
  if (p.data.isDefault) {
    await prisma.sharingPolicy.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }
  const policy = await prisma.sharingPolicy.create({ data: p.data });
  log.info({ id: policy.id }, 'Sharing policy created');
  res.status(201).json(policy);
});

adminOrganisationRouter.put('/sharing-policies/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = SharingSchema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    if (p.data.isDefault) {
      await prisma.sharingPolicy.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const d = p.data;
    const updateData: Record<string, unknown> = {};
    if (d.name           !== undefined) updateData['name']           = d.name;
    if (d.description    !== undefined) updateData['description']    = d.description;
    if (d.enabled        !== undefined) updateData['enabled']        = d.enabled;
    if (d.allowedDomains !== undefined) updateData['allowedDomains'] = d.allowedDomains;
    if (d.allowCalendar  !== undefined) updateData['allowCalendar']  = d.allowCalendar;
    if (d.allowContacts  !== undefined) updateData['allowContacts']  = d.allowContacts;
    if (d.calendarDetail !== undefined) updateData['calendarDetail'] = d.calendarDetail;
    if (d.isDefault      !== undefined) updateData['isDefault']      = d.isDefault;
    const policy = await prisma.sharingPolicy.update({ where: { id }, data: updateData });
    res.json(policy);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

adminOrganisationRouter.delete('/sharing-policies/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.sharingPolicy.delete({ where: { id } });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─── Address Lists ────────────────────────────────────────────────────────────

const AddressListSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(500).default(''),
  filter:      z.record(z.unknown()).default({}),
  isGal:       z.boolean().default(false),
});

adminOrganisationRouter.get('/address-lists', async (_req: Request, res: Response) => {
  const lists = await prisma.addressList.findMany({ orderBy: [{ isGal: 'desc' }, { name: 'asc' }] });
  res.json(lists);
});

adminOrganisationRouter.post('/address-lists', async (req: Request, res: Response) => {
  const p = AddressListSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }
  const list = await prisma.addressList.create({
    data: { name: p.data.name, description: p.data.description, isGal: p.data.isGal, filter: p.data.filter as object },
  });
  res.status(201).json(list);
});

adminOrganisationRouter.put('/address-lists/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = AddressListSchema.partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const d = p.data;
    const updateData: Record<string, unknown> = {};
    if (d.name        !== undefined) updateData['name']        = d.name;
    if (d.description !== undefined) updateData['description'] = d.description;
    if (d.isGal       !== undefined) updateData['isGal']       = d.isGal;
    if (d.filter      !== undefined) updateData['filter']      = d.filter as object;
    const list = await prisma.addressList.update({ where: { id }, data: updateData });
    res.json(list);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

adminOrganisationRouter.delete('/address-lists/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.addressList.delete({ where: { id } });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─── GAL (Live-Abfrage aller Postfächer) ─────────────────────────────────────
adminOrganisationRouter.get('/gal', async (req: Request, res: Response) => {
  const { search = '', limit = '200' } = req.query as Record<string, string>;
  const where = search
    ? { OR: [
        { email: { contains: search, mode: 'insensitive' as const } },
        { displayName: { contains: search, mode: 'insensitive' as const } },
      ]}
    : {};

  const [users, sharedBoxes, groups, resources] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true, domainId: true },
    }),
    prisma.sharedMailbox.findMany({
      where: { active: true, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true },
    }),
    prisma.distributionGroup.findMany({
      where: { active: true, hiddenFromGal: false, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true },
    }),
    prisma.resourceMailbox.findMany({
      where: { active: true, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true, resourceType: true },
    }),
  ]);

  res.json({
    users:     users.map(u => ({ ...u, type: 'USER' })),
    shared:    sharedBoxes.map(s => ({ ...s, type: 'SHARED' })),
    groups:    groups.map(g => ({ ...g, type: 'GROUP' })),
    resources: resources.map(r => ({ ...r, type: r.resourceType })),
    total: users.length + sharedBoxes.length + groups.length + resources.length,
  });
});
