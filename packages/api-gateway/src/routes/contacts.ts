import { Router, type Router as RouterType, type Request, type Response } from 'express';
import {
  prisma, GAL_VISIBLE_WHERE, isWebmailFeatureEnabled,
  applyContactCard, applyContactPatch, contactCardFromRow, contactCardFromVcard, contactColumnsFromVcard, contactRowData, detachCardFromGroups,
  emptyContactCard, flatContactColumns, isGroupVcard, membersFromJson, sameContactCard, vcardUidKey, type ContactRowFlat,
} from '@coremail/storage';
import { protocolSubject, requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';
import {
  ContactCreateSchema, contactPatchFromInput, contactUpdateSchema, firstIssue, withoutUnchangedFields,
} from '../lib/contact-input.js';
import { contactGroupsRouter } from './contact-groups.js';

export const contactsRouter: RouterType = Router();
contactsRouter.use(requireAuth);
// 9.4: contact writes reach the user's other tabs and devices (9.5: groups too)
contactsRouter.use(announceOnWrite({ type: 'contacts' }));

/** Columns returned for the user's own contacts (address book view + autocomplete). */
const CONTACT_LIST_SELECT = {
  id: true, displayName: true, email: true, email2: true, phone: true, mobile: true,
  company: true, department: true, jobTitle: true, notes: true, fileAs: true, categories: true,
} as const;

/** Groups offered by the compose autocomplete (`?groups=1`). */
const GROUP_SUGGESTIONS = 10;

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
// 9.5: the search covers every contact field (searchText: names, nickname, all
// e-mails, phones, addresses, URLs, IM, categories); `groups=1` adds the user's
// contact groups (kind "group", id "group-<id>") for the compose autocomplete.
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
          { searchText:  { contains: q.toLowerCase() } },
        ],
      }
    : { userId };
  // 9.4: without the contacts module (webmail policy) the compose autocomplete
  // offers address-list entries only (the gate lets only searches through).
  const ownContacts = await isWebmailFeatureEnabled(protocolSubject(req.apiUser!), 'contacts');
  const privateContacts = !ownContacts ? [] : await prisma.contact.findMany({
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
      ...GAL_VISIBLE_WHERE, // 9.4: hidden from the address list
      OR: [
        { email:       { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, displayName: true, domainId: true },
    take: 30,
  })).filter((u) => u.domainId === domainId); // defence in depth: the domain is the boundary

  const groups = !ownContacts || req.query['groups'] !== '1' ? [] : await prisma.contactGroup.findMany({
    where: { userId, name: { contains: q, mode: 'insensitive' } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, members: true },
    take: GROUP_SUGGESTIONS,
  });

  // Unified format. Dedup by email.
  const seen = new Set<string>(privateContacts.map((c) => c.email.toLowerCase()));
  const merged: Array<{ id: string; displayName: string; email: string; company?: string; kind?: 'group'; memberCount?: number }> = [
    ...privateContacts,
    ...groups.map((g) => ({ id: `group-${g.id}`, kind: 'group' as const, displayName: g.name, email: '', memberCount: membersFromJson(g.members).length })),
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
    ...GAL_VISIBLE_WHERE, // 9.4: hidden from the address list
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

// 9.5: contact groups ("Kontaktlisten") — registered BEFORE `/:id`
contactsRouter.use('/groups', contactGroupsRouter);

type ContactRow = ContactRowFlat & { searchText?: string } & Record<string, unknown>;

/**
 * A contact as the API returns it: the row plus the structured fields read
 * from its vCard (rows stored before 9.5 have empty structured columns until
 * their next write). The internal search text is left out.
 */
function contactView(row: ContactRow): Record<string, unknown> {
  const { searchText: _searchText, ...rest } = row;
  const card = contactCardFromRow(row);
  return { ...rest, ...card, ...flatContactColumns(card) };
}

const findOwnContact = (userId: string, id: string) => prisma.contact.findFirst({ where: { id, userId } });

// GET /api/v1/contacts/:id
contactsRouter.get('/:id', async (req: Request, res: Response) => {
  const contact = await findOwnContact(req.apiUser!.userId, String(req.params['id']));
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
  res.json(contactView(contact));
});

// POST /api/v1/contacts — structured fields (9.5) or the legacy flat ones.
// A supplied vCard is kept as-is and the fields are applied on top.
contactsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = ContactCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }
  const source = parsed.data.vcardData ?? '';
  if (source && isGroupVcard(source)) {
    res.status(400).json({ error: 'Invalid request', field: 'vcardData', message: 'Kontaktlisten über /contacts/groups anlegen' });
    return;
  }

  const base = source ? contactCardFromVcard(source) : emptyContactCard();
  const card = applyContactPatch(base, contactPatchFromInput(parsed.data));
  if (!card.displayName) { res.status(400).json({ error: 'Invalid request', field: 'displayName', message: 'Name fehlt' }); return; }

  const vcardData = applyContactCard(source, card);
  const contact = await prisma.contact.create({
    data: { userId: req.apiUser!.userId, vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)) },
  });
  res.status(201).json(contactView(contact));
});

// PUT /api/v1/contacts/:id — partial update.
// v7.1.0: the stored vCard is PATCHED, not rebuilt — PHOTO/UID/X-… and every other
// property a CardDAV client stored survive a webmail edit (RFC 6352 §6.3.2).
// 9.5: only the properties whose field changed are rewritten (storage contact-vcard.ts).
// Review 9.5: fields the body repeats unchanged are dropped before validation and
// values the contact already holds pass as they are — data a CardDAV client stored
// (a URL without scheme, a long note, many entries) never blocks a webmail edit.
contactsRouter.put('/:id', async (req: Request, res: Response) => {
  const contact = await findOwnContact(req.apiUser!.userId, String(req.params['id']));
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }

  const current = contactCardFromRow(contact);
  const parsed = contactUpdateSchema(current).safeParse(withoutUnchangedFields(req.body, current));
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }

  const card = applyContactPatch(current, contactPatchFromInput(parsed.data));
  if (!card.displayName) { res.status(400).json({ error: 'Invalid request', field: 'displayName', message: 'Name fehlt' }); return; }
  if (sameContactCard(card, current) && vcardUidKey(contact.vcardData)) {
    res.json(contactView(contact));
    return;
  }

  const vcardData = applyContactCard(contact.vcardData, card);
  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)) },
  });
  res.json(contactView(updated));
});

// DELETE /api/v1/contacts/:id — 9.5: the contact also leaves every contact group
contactsRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const contact = await findOwnContact(userId, String(req.params['id']));
  if (!contact) { res.status(404).json({ error: 'Contact not found' }); return; }
  await prisma.contact.delete({ where: { id: contact.id } });
  await detachCardFromGroups(userId, contact.uid || vcardUidKey(contact.vcardData));
  res.json({ ok: true });
});
