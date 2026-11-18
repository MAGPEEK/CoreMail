/**
 * 9.5: contact groups ("Kontaktlisten") — /api/v1/contacts/groups.
 * Mounted inside contactsRouter (authentication, the contacts module switch
 * and the realtime `contacts` announcement apply). Members are own contacts,
 * nested groups or plain addresses; every write goes through the storage
 * group helpers so the CardDAV vCard and the member list stay in step.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import {
  prisma, contactGroupColumns, contactGroupData, detachCardFromGroups, ensureContactUid, expandContactGroup,
  membersFromJson, resolveCards, uidKey,
  type ContactGroupMember,
} from '@coremail/storage';
import { GroupCreateSchema, GroupUpdateSchema, firstIssue, type GroupMemberInput } from '../lib/contact-input.js';

export const contactGroupsRouter: RouterType = Router();

type MemberView =
  | { kind: 'contact'; contactId: string; uid: string; displayName: string; email: string }
  | { kind: 'group'; groupId: string; uid: string; name: string }
  | { kind: 'address'; email: string; name: string }
  | { kind: 'missing'; uid: string };

class MemberError extends Error {}

/** Storage members of the request body (own contacts / groups only). */
async function membersFromInput(userId: string, input: GroupMemberInput[], selfId: string | null): Promise<ContactGroupMember[]> {
  const contactIds = input.flatMap((m) => ('contactId' in m ? [m.contactId] : []));
  const groupIds = input.flatMap((m) => ('groupId' in m ? [m.groupId] : []));
  if (selfId && groupIds.includes(selfId)) throw new MemberError('Eine Liste kann sich nicht selbst enthalten');
  const [contacts, groups] = await Promise.all([
    contactIds.length ? prisma.contact.findMany({ where: { userId, id: { in: contactIds } }, select: { id: true, uid: true, vcardData: true } }) : [],
    groupIds.length ? prisma.contactGroup.findMany({ where: { userId, id: { in: groupIds } }, select: { id: true, uid: true } }) : [],
  ]);
  const contactUid = new Map<string, string>();
  for (const c of contacts) contactUid.set(c.id, await ensureContactUid(c));
  const groupUid = new Map(groups.map((g) => [g.id, g.uid]));

  return input.map((m): ContactGroupMember => {
    if ('contactId' in m) {
      const uid = contactUid.get(m.contactId);
      if (!uid) throw new MemberError('Kontakt nicht gefunden');
      return { kind: 'card', uid };
    }
    if ('groupId' in m) {
      const uid = groupUid.get(m.groupId);
      if (!uid) throw new MemberError('Kontaktliste nicht gefunden');
      return { kind: 'card', uid };
    }
    if ('uid' in m) return { kind: 'card', uid: uidKey(m.uid) };
    return { kind: 'address', address: m.email, name: m.name?.trim() ?? '' };
  });
}

async function memberViews(userId: string, members: ContactGroupMember[]): Promise<MemberView[]> {
  const cards = await resolveCards(userId, members.flatMap((m) => (m.kind === 'card' ? [m.uid] : [])));
  return members.map((m): MemberView => {
    if (m.kind === 'address') return { kind: 'address', email: m.address, name: m.name };
    const c = cards.get(m.uid);
    if (!c) return { kind: 'missing', uid: m.uid };
    return c.kind === 'contact'
      ? { kind: 'contact', contactId: c.id, uid: c.uid, displayName: c.displayName, email: c.email }
      : { kind: 'group', groupId: c.id, uid: c.uid, name: c.name };
  });
}

type GroupRow = { id: string; uid: string; name: string; members: unknown; updatedAt: Date };

async function groupView(userId: string, g: GroupRow) {
  const members = membersFromJson(g.members);
  return { id: g.id, uid: g.uid, name: g.name, updatedAt: g.updatedAt, members: await memberViews(userId, members) };
}

const findOwn = (userId: string, id: string) => prisma.contactGroup.findFirst({ where: { id, userId } });

function sendMemberError(res: Response, err: unknown): boolean {
  if (!(err instanceof MemberError)) return false;
  res.status(400).json({ error: err.message });
  return true;
}

// GET /api/v1/contacts/groups
contactGroupsRouter.get('/', async (req: Request, res: Response) => {
  const groups = await prisma.contactGroup.findMany({
    where: { userId: req.apiUser!.userId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, members: true, updatedAt: true },
  });
  res.json(groups.map((g) => ({ id: g.id, name: g.name, memberCount: membersFromJson(g.members).length, updatedAt: g.updatedAt })));
});

// GET /api/v1/contacts/groups/:id
contactGroupsRouter.get('/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const g = await findOwn(userId, String(req.params['id']));
  if (!g) { res.status(404).json({ error: 'Contact group not found' }); return; }
  res.json(await groupView(userId, g));
});

// GET /api/v1/contacts/groups/:id/expand — recipients for the compose window
contactGroupsRouter.get('/:id/expand', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const g = await findOwn(userId, String(req.params['id']));
  if (!g) { res.status(404).json({ error: 'Contact group not found' }); return; }
  res.json({ name: g.name, ...(await expandContactGroup(userId, membersFromJson(g.members))) });
});

// POST /api/v1/contacts/groups
contactGroupsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = GroupCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }
  const userId = req.apiUser!.userId;
  try {
    const members = await membersFromInput(userId, parsed.data.members ?? [], null);
    const created = await prisma.contactGroup.create({
      data: { userId, ...contactGroupData(contactGroupColumns('', parsed.data.name, members)) },
    });
    res.status(201).json(await groupView(userId, created));
  } catch (err) {
    if (!sendMemberError(res, err)) throw err;
  }
});

// PUT /api/v1/contacts/groups/:id — name and/or the whole member list
contactGroupsRouter.put('/:id', async (req: Request, res: Response) => {
  const parsed = GroupUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }
  const userId = req.apiUser!.userId;
  const g = await findOwn(userId, String(req.params['id']));
  if (!g) { res.status(404).json({ error: 'Contact group not found' }); return; }
  try {
    const members = parsed.data.members ? await membersFromInput(userId, parsed.data.members, g.id) : membersFromJson(g.members);
    const updated = await prisma.contactGroup.update({
      where: { id: g.id },
      data: contactGroupData(contactGroupColumns(g.vcardData, parsed.data.name ?? g.name, members)),
    });
    res.json(await groupView(userId, updated));
  } catch (err) {
    if (!sendMemberError(res, err)) throw err;
  }
});

// DELETE /api/v1/contacts/groups/:id
contactGroupsRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const g = await findOwn(userId, String(req.params['id']));
  if (!g) { res.status(404).json({ error: 'Contact group not found' }); return; }
  await prisma.contactGroup.delete({ where: { id: g.id } });
  await detachCardFromGroups(userId, g.uid);
  res.json({ ok: true });
});
