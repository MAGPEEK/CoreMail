import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import {
  buildVcard,
  patchVcard,
  vcardFields,
  VCARD_FIELD_NAMES,
  type VcardFields,
  type VcardPatch,
} from '@coremail/core/vcard';
import { requireAuth } from '../middleware/auth.js';

export const contactsRouter: RouterType = Router();
contactsRouter.use(requireAuth);

/** Columns returned for the user's own contacts (address book view + autocomplete). */
const CONTACT_LIST_SELECT = {
  id: true, displayName: true, email: true, email2: true, phone: true, mobile: true,
  company: true, department: true, jobTitle: true, notes: true,
} as const;

/**
 * Domain of the caller — the GAL boundary (8.0.0). A server may host several
 * customer domains; a user only ever sees the active users of their own domain,
 * exactly like the ActiveSync GAL (`activesync/src/commands/directory.ts`).
 * Read from the database, not the JWT, so a moved user never sees the old domain.
 */
async function callerDomainId(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { domainId: true } });
  return u?.domainId ?? null;
}

/** Hard cap for one GAL page. */
const GAL_MAX_PAGE = 500;

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
    select: CONTACT_LIST_SELECT,
    take: 100,
  });

  // For a short/empty query: private contacts only (for the address book view)
  if (q.length < 2) {
    res.json(privateContacts);
    return;
  }

  // GAL (domain users). (ExternalMailContact removed in v3.18.33, distribution
  // groups in v5.6.1 — external recipients are typed directly in the compose window.)
  const domainId = await callerDomainId(userId);
  const galUsers = !domainId ? [] : (await prisma.user.findMany({
    where: {
      domainId,
      active: true,
      OR: [
        { email:       { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, displayName: true, domainId: true },
    take: 30,
  })).filter((u) => u.domainId === domainId); // defence in depth: the domain is the boundary

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
  res.json(merged.slice(0, 50));
});

// GET /api/v1/contacts/gal?q=&type=&limit=&offset= — Global Address List (Browse + Search)
// Returns the entries from the User table. (ExternalMailContact removed in
// v3.18.33, DistributionGroup in v5.6.1 — the type filters `external`/`group`
// return empty lists so that old frontend calls do not break.)
// 8.0.0: scoped to the caller's own domain (multi-tenant servers), paginated in the DB.
// v7.1.0: registered BEFORE `/:id` — it used to be shadowed (GET /gal → 404 "Contact not found").
contactsRouter.get('/gal', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const type = String(req.query['type'] ?? 'all') as 'all' | 'users' | 'external' | 'groups';
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10) || 100, GAL_MAX_PAGE);
  const offset = Math.max(0, parseInt(String(req.query['offset'] ?? '0'), 10) || 0);

  const searchWhere = q.length >= 2 ? q.toLowerCase() : null;

  // 8.0.0: own domain only, paginated in the database (no unbounded read of the user table).
  const domainId = (type === 'all' || type === 'users') ? await callerDomainId(req.apiUser!.userId) : null;
  const userWhere = {
    domainId: domainId ?? '',
    active: true,
    ...(searchWhere ? {
      OR: [
        { email:       { contains: searchWhere, mode: 'insensitive' as const } },
        { displayName: { contains: searchWhere, mode: 'insensitive' as const } },
      ],
    } : {}),
  };
  const [users, total] = domainId
    ? await Promise.all([
        prisma.user.findMany({
          where: userWhere,
          orderBy: [{ displayName: 'asc' }, { email: 'asc' }],
          select: { id: true, email: true, displayName: true, domainId: true, domain: { select: { name: true } } },
          skip: offset,
          take: limit,
        }),
        prisma.user.count({ where: userWhere }),
      ])
    : [[], 0] as const;

  // Unified format with `kind` and `id` prefix as stabilizer
  type GalEntry = {
    id: string;
    kind: 'USER';
    email: string;
    displayName: string;
    subtitle?: string;
    domain?: string;
  };
  // Defence in depth: the domain filter is the security boundary.
  const entries: GalEntry[] = users.filter((u) => u.domainId === domainId).map((u): GalEntry => ({
    id:          `user-${u.id}`,
    kind:        'USER',
    email:       u.email,
    displayName: u.displayName ?? u.email,
    ...(u.domain?.name ? { domain: u.domain.name } : {}),
  }));

  // Sorted and paginated by the database (displayName, email).
  res.json({ entries, total, limit, offset });
});

// GET /api/v1/contacts/:id
contactsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const contact = await prisma.contact.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
  res.json(contact);
});

/** An optional e-mail field: empty string (= none/remove) or a valid address. */
const optionalEmail = z.union([z.literal(''), z.string().trim().email()]);

// Every field the webmail edits (v7.1.0: phone/mobile/email2/department/jobTitle/notes
// were silently dropped by the schema before).
const ContactSchema = z.object({
  displayName: z.string().trim().min(1).max(500),
  email: optionalEmail.optional(),
  email2: optionalEmail.optional(),
  phone: z.string().max(100).optional(),
  mobile: z.string().max(100).optional(),
  company: z.string().max(500).optional(),
  department: z.string().max(500).optional(),
  jobTitle: z.string().max(500).optional(),
  notes: z.string().max(10_000).optional(),
  vcardData: z.string().max(1_000_000).optional(),
});

function fieldPatch(data: { [K in keyof VcardFields]?: string | undefined }): VcardPatch {
  const patch: VcardPatch = {};
  for (const k of VCARD_FIELD_NAMES) {
    const v = data[k];
    if (v !== undefined) patch[k] = v;
  }
  return patch;
}

// POST /api/v1/contacts
contactsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = ContactSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const fields = fieldPatch(parsed.data);
  // A supplied vCard is kept as-is and only the explicit fields are applied on top
  const vcardData = parsed.data.vcardData
    ? patchVcard(parsed.data.vcardData, fields)
    : buildVcard({ ...fields, displayName: parsed.data.displayName });
  const columns: VcardFields = vcardFields(vcardData);

  const contact = await prisma.contact.create({
    data: { userId: req.apiUser!.userId, vcardData, ...columns },
  });
  res.status(201).json(contact);
});

// PUT /api/v1/contacts/:id
// v7.1.0: the stored vCard is PATCHED, not rebuilt — TEL/ADR/PHOTO/UID/X-… and every
// other property a CardDAV client stored survive a webmail edit (RFC 6352 §6.3.2).
// Only fields whose value differs from the stored vCard are rewritten.
contactsRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = ContactSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const contact = await prisma.contact.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }

  const current = vcardFields(contact.vcardData);
  const requested = fieldPatch(parsed.data);
  const changed: VcardPatch = {};
  for (const k of VCARD_FIELD_NAMES) {
    const v = requested[k];
    if (v !== undefined && v.trim() !== current[k]) changed[k] = v;
  }
  if (Object.keys(changed).length === 0 && /^UID[:;]/im.test(contact.vcardData)) {
    res.json(contact);
    return;
  }

  const vcardData = patchVcard(contact.vcardData, changed);
  const updated = await prisma.contact.update({
    where: { id },
    data: { vcardData, ...vcardFields(vcardData) },
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
