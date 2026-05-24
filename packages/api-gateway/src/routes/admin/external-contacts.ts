/**
 * Admin-API: Externe Mail-Kontakte
 * Erscheinen in der GAL (Global Address List), werden zentral vom Admin verwaltet.
 *
 * GET/POST/PUT/DELETE /api/v1/admin/contacts
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminExternalContactsRouter: RouterType = Router();
adminExternalContactsRouter.use(requireAdmin);

const Schema = z.object({
  email:         z.string().email(),
  displayName:   z.string().min(1).max(200),
  firstName:     z.string().max(100).default(''),
  lastName:      z.string().max(100).default(''),
  company:       z.string().max(200).default(''),
  department:    z.string().max(200).default(''),
  phone:         z.string().max(50).default(''),
  mobile:        z.string().max(50).default(''),
  hiddenFromGal: z.boolean().default(false),
  notes:         z.string().max(2000).default(''),
});

// GET /api/v1/admin/contacts?search=&limit=100&offset=0
adminExternalContactsRouter.get('/', async (req: Request, res: Response) => {
  const { search = '', limit = '100', offset = '0' } = req.query as Record<string, string>;
  const take = Math.min(parseInt(limit), 500);
  const skip = parseInt(offset);

  const where = search ? {
    OR: [
      { displayName: { contains: search, mode: 'insensitive' as const } },
      { email:       { contains: search, mode: 'insensitive' as const } },
      { company:     { contains: search, mode: 'insensitive' as const } },
    ],
  } : {};

  const [contacts, total] = await Promise.all([
    prisma.externalMailContact.findMany({
      where, take, skip, orderBy: { displayName: 'asc' },
    }),
    prisma.externalMailContact.count({ where }),
  ]);

  res.json({ contacts, total });
});

// GET /api/v1/admin/contacts/:id
adminExternalContactsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const contact = await prisma.externalMailContact.findUnique({ where: { id } });
  if (!contact) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(contact);
});

// POST /api/v1/admin/contacts
adminExternalContactsRouter.post('/', async (req: Request, res: Response) => {
  const p = Schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const existing = await prisma.externalMailContact.findUnique({ where: { email: p.data.email } });
  if (existing) { res.status(409).json({ error: 'E-Mail-Adresse wird bereits verwendet' }); return; }

  const contact = await prisma.externalMailContact.create({ data: p.data });
  res.status(201).json(contact);
});

// PUT /api/v1/admin/contacts/:id
adminExternalContactsRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = Schema.omit({ email: true }).partial().safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const d = p.data;
    const data: Record<string, unknown> = {};
    if (d.displayName   !== undefined) data['displayName']   = d.displayName;
    if (d.firstName     !== undefined) data['firstName']     = d.firstName;
    if (d.lastName      !== undefined) data['lastName']      = d.lastName;
    if (d.company       !== undefined) data['company']       = d.company;
    if (d.department    !== undefined) data['department']    = d.department;
    if (d.phone         !== undefined) data['phone']         = d.phone;
    if (d.mobile        !== undefined) data['mobile']        = d.mobile;
    if (d.hiddenFromGal !== undefined) data['hiddenFromGal'] = d.hiddenFromGal;
    if (d.notes         !== undefined) data['notes']         = d.notes;
    const contact = await prisma.externalMailContact.update({ where: { id }, data });
    res.json(contact);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// DELETE /api/v1/admin/contacts/:id
adminExternalContactsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.externalMailContact.delete({ where: { id } });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
