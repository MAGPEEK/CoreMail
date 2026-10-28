import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const contactsRouter: RouterType = Router();
contactsRouter.use(requireAuth);

// GET /api/v1/contacts?q= — unified search across all address sources for the
// compose autocomplete (v3.18.7):
//   1. The user's private contacts (Contact table)
//   2. Global address list (all active users except hiddenFromGal)
//   (ExternalMailContact removed in v3.18.33, DistributionGroup in v5.6.1)
// If `q` is empty, only private contacts are returned (fallback as before).
contactsRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const userId = req.apiUser!.userId;

  // Private contacts (always included)
  const privateWhere = q.length >= 2
    ? {
        userId,
        OR: [
          { displayName: { contains: q, mode: 'insensitive' as const } },
          { email:       { contains: q, mode: 'insensitive' as const } },
          { company:     { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : { userId };
  const privateContacts = await prisma.contact.findMany({
    where: privateWhere,
    orderBy: { displayName: 'asc' },
    select: { id: true, displayName: true, email: true, company: true },
    take: 100,
  });

  // For a short/empty query: private contacts only (for the address book view)
  if (q.length < 2) {
    res.json(privateContacts);
    return;
  }

  // Load GAL (domain users) + distribution groups in parallel.
  // (ExternalMailContact removed in v3.18.33 — external recipients are typed
  // directly in the compose window or maintained as EXTERNAL members in
  // distribution groups.)
  const [galUsers, distGroups] = await Promise.all([
    prisma.user.findMany({
      where: {
        active: true,
        OR: [
          { email:       { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, displayName: true },
      take: 30,
    }),
    // v5.6.1: DistributionGroup search removed
    Promise.resolve([] as Array<{ id: string; email: string; displayName: string }>),
  ]);

  // Unified format. Dedup by email.
  const seen = new Set<string>(privateContacts.map((c) => c.email.toLowerCase()));
  const merged: Array<{ id: string; displayName: string; email: string; company?: string }> = [
    ...privateContacts,
  ];
  for (const u of galUsers) {
    const key = u.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: `gal-${u.id}`, displayName: u.displayName ?? u.email, email: u.email });
  }
  // distGroups loop removed
  void distGroups;
  res.json(merged.slice(0, 50));
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

// GET /api/v1/contacts/gal?q=&type=&limit=&offset= — Global Address List (Browse + Search)
// Returns the entries from the User table. (ExternalMailContact removed in
// v3.18.33, DistributionGroup in v5.6.1 — the type filters `external`/`group`
// return empty lists so that old frontend calls do not break.)
contactsRouter.get('/gal', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const type = String(req.query['type'] ?? 'all') as 'all' | 'users' | 'external' | 'groups';
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10), 500);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

  const searchWhere = q.length >= 2 ? q.toLowerCase() : null;

  // Two sources in parallel — each sorted by displayName/email
  const userPromise = (type === 'all' || type === 'users')
    ? prisma.user.findMany({
        where: {
          active: true,
          ...(searchWhere ? {
            OR: [
              { email:       { contains: searchWhere, mode: 'insensitive' as const } },
              { displayName: { contains: searchWhere, mode: 'insensitive' as const } },
            ],
          } : {}),
        },
        orderBy: [{ displayName: 'asc' }, { email: 'asc' }],
        select: { id: true, email: true, displayName: true, domain: { select: { name: true } } },
      })
    : Promise.resolve([]);

  // v5.6.1: DistributionGroup GAL search removed
  const groupsPromise: Promise<Array<never>> = Promise.resolve([]);

  const [users, groups] = await Promise.all([userPromise, groupsPromise]);
  void groups;

  // Unified format with `kind` and `id` prefix as stabilizer
  type GalEntry = {
    id: string;
    kind: 'USER';
    email: string;
    displayName: string;
    subtitle?: string;
    domain?: string;
  };
  const entries: GalEntry[] = [
    ...users.map((u): GalEntry => ({
      id:          `user-${u.id}`,
      kind:        'USER',
      email:       u.email,
      displayName: u.displayName ?? u.email,
      ...(u.domain?.name ? { domain: u.domain.name } : {}),
    })),
  ];

  // Sort alphabetically by displayName (across all kinds), then paginate
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
  const total = entries.length;
  const paged = entries.slice(offset, offset + limit);

  res.json({ entries: paged, total, limit, offset });
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
