import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const contactsRouter: RouterType = Router();
contactsRouter.use(requireAuth);

// GET /api/v1/contacts?q=
contactsRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  

  const where = q.length >= 2
    ? {
        userId: req.apiUser!.userId,
        OR: [
          { displayName: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
          { company: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : { userId: req.apiUser!.userId };

  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { displayName: 'asc' },
    select: { id: true, displayName: true, email: true, company: true },
    take: 200,
  });
  res.json(contacts);
});

// GET /api/v1/contacts/:id
contactsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const contact = await prisma.contact.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
  res.json(contact);
});

const ContactSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional().default(''),
  company: z.string().optional().default(''),
  phone: z.string().optional(),
  vcardData: z.string().optional(),
});

// POST /api/v1/contacts
contactsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = ContactSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const { displayName, email, company, phone } = parsed.data;
  const vcardData = parsed.data.vcardData ?? buildVcard({ displayName, email, company, ...(phone !== undefined ? { phone } : {}) });

  
  const contact = await prisma.contact.create({
    data: { userId: req.apiUser!.userId, displayName, email, company, vcardData },
  });
  res.status(201).json(contact);
});

// PUT /api/v1/contacts/:id
contactsRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = ContactSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const contact = await prisma.contact.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }

  const { displayName, email, company, phone } = parsed.data;
  const updatedVcard = buildVcard({
    displayName: displayName ?? contact.displayName,
    email: email ?? contact.email,
    company: company ?? contact.company,
    ...(phone !== undefined ? { phone } : {}),
  });

  const updated = await prisma.contact.update({
    where: { id },
    data: {
      displayName: displayName ?? contact.displayName,
      email: email ?? contact.email,
      company: company ?? contact.company,
      vcardData: updatedVcard,
    },
  });
  res.json(updated);
});

// DELETE /api/v1/contacts/:id
contactsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const contact = await prisma.contact.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
  await prisma.contact.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /api/v1/contacts/gal?q= — Global Address List
contactsRouter.get('/gal', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  if (q.length < 2) { res.json([]); return; }

  
  const users = await prisma.user.findMany({
    where: {
      active: true,
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 20,
    select: { email: true, displayName: true },
  });
  res.json(users);
});

function buildVcard(opts: {
  displayName: string; email: string; company: string; phone?: string;
}): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${opts.displayName}`,
    `N:${opts.displayName.split(' ').reverse().join(';')};;;`,
  ];
  if (opts.email) lines.push(`EMAIL;TYPE=INTERNET:${opts.email}`);
  if (opts.company) lines.push(`ORG:${opts.company}`);
  if (opts.phone) lines.push(`TEL;TYPE=VOICE:${opts.phone}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}
