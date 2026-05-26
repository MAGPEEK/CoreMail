import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const contactsRouter: RouterType = Router();
contactsRouter.use(requireAuth);

// GET /api/v1/contacts?q= — vereinte Suche über alle Adressquellen für den
// Compose-Autocomplete (v3.18.7):
//   1. Private Kontakte des Users (Contact-Tabelle)
//   2. Globale Adressliste (alle aktiven User außer hiddenFromGal)
//   3. Externe Kontakte aus dem Admin-Verzeichnis (ExternalContact)
//   4. Verteilergruppen (DistributionGroup, sichtbar in GAL, aktiv)
// Wenn `q` leer ist, werden nur private Kontakte zurückgegeben (Fallback wie zuvor).
contactsRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const userId = req.apiUser!.userId;

  // Private Kontakte (immer berücksichtigt)
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

  // Bei kurzem/leerem Query: nur private Kontakte (für Adressbuch-Ansicht)
  if (q.length < 2) {
    res.json(privateContacts);
    return;
  }

  // GAL (Domain-User) + Verteilergruppen parallel laden.
  // (ExternalMailContact entfernt in v3.18.33 — externe Empfänger werden
  // direkt im Compose-Fenster eingetippt oder als EXTERNAL-Mitglieder in
  // Verteilergruppen gepflegt.)
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
    prisma.distributionGroup.findMany({
      where: {
        active: true,
        hiddenFromGal: false,
        OR: [
          { email:       { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, displayName: true },
      take: 20,
    }),
  ]);

  // Vereintes Format (`isGroup` markiert Verteilergruppen). Dedup über E-Mail.
  const seen = new Set<string>(privateContacts.map((c) => c.email.toLowerCase()));
  const merged: Array<{ id: string; displayName: string; email: string; company?: string; isGroup?: boolean }> = [
    ...privateContacts,
  ];
  for (const u of galUsers) {
    const key = u.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: `gal-${u.id}`, displayName: u.displayName ?? u.email, email: u.email });
  }
  for (const g of distGroups) {
    const key = g.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: `grp-${g.id}`, displayName: g.displayName, email: g.email, isGroup: true });
  }
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
// Liefert die vereinten Einträge aus User-Tabelle und DistributionGroup.
// (ExternalMailContact entfernt in v3.18.33 — Type-Filter `external` liefert
// jetzt immer eine leere Liste, damit alte Frontend-Aufrufe nicht brechen.)
contactsRouter.get('/gal', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const type = String(req.query['type'] ?? 'all') as 'all' | 'users' | 'external' | 'groups';
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10), 500);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

  const searchWhere = q.length >= 2 ? q.toLowerCase() : null;

  // Zwei Quellen parallel — jeweils sortiert nach displayName/email
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

  const groupsPromise = (type === 'all' || type === 'groups')
    ? prisma.distributionGroup.findMany({
        where: {
          active: true,
          hiddenFromGal: false,
          ...(searchWhere ? {
            OR: [
              { email:       { contains: searchWhere, mode: 'insensitive' as const } },
              { displayName: { contains: searchWhere, mode: 'insensitive' as const } },
              { description: { contains: searchWhere, mode: 'insensitive' as const } },
            ],
          } : {}),
        },
        orderBy: [{ displayName: 'asc' }],
        include: { _count: { select: { members: true } } },
      })
    : Promise.resolve([]);

  const [users, groups] = await Promise.all([userPromise, groupsPromise]);

  // Vereintes Format mit `kind` und `id`-Prefix als Stabilizer
  type GalEntry = {
    id: string;
    kind: 'USER' | 'GROUP';
    email: string;
    displayName: string;
    subtitle?: string;
    domain?: string;
    memberCount?: number;
  };
  const entries: GalEntry[] = [
    ...users.map((u): GalEntry => ({
      id:          `user-${u.id}`,
      kind:        'USER',
      email:       u.email,
      displayName: u.displayName ?? u.email,
      ...(u.domain?.name ? { domain: u.domain.name } : {}),
    })),
    ...groups.map((g): GalEntry => ({
      id:          `grp-${g.id}`,
      kind:        'GROUP',
      email:       g.email,
      displayName: g.displayName,
      memberCount: g._count.members,
      ...(g.description ? { subtitle: g.description } : {}),
    })),
  ];

  // Alphabetisch sortieren nach displayName (über alle Kinds), dann paginieren
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
