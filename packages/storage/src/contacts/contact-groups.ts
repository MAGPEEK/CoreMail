/**
 * 9.5: contact group storage. Every write of a group (REST, CardDAV) and every
 * change that affects group membership (a deleted contact) goes through here,
 * so `contact_groups.members` and the group's vcardData never disagree.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma/index.js';
import {
  applyContactCard, contactCardFromRow, contactColumnsFromVcard, uidKey, vcardUidKey, type ContactRowFlat,
} from './contact-vcard.js';
import {
  applyContactGroup, contactGroupFromVcard, expandGroupMembers, membersFromJson, uniqueMembers, GROUP_NESTING_LIMIT,
  type ContactGroupMember, type GroupExpansion, type ResolvedCard,
} from './contact-group-vcard.js';

export type ContactGroupColumns = { uid: string; name: string; vcardData: string; members: ContactGroupMember[] };

/** Address members keep the display name they had (a vCard MEMBER carries none). */
export function keepMemberNames(previous: readonly ContactGroupMember[], next: readonly ContactGroupMember[]): ContactGroupMember[] {
  const names = new Map<string, string>();
  for (const m of previous) if (m.kind === 'address' && m.name) names.set(m.address.toLowerCase(), m.name);
  return next.map((m) => (m.kind === 'address' && !m.name ? { ...m, name: names.get(m.address.toLowerCase()) ?? '' } : m));
}

/** Columns of a group stored from a client vCard (CardDAV PUT); null when it is no group. */
export function contactGroupColumnsFromVcard(vcard: string, previousMembers: readonly ContactGroupMember[] = []): ContactGroupColumns | null {
  const data = contactGroupFromVcard(vcard);
  if (!data) return null;
  return { uid: data.uid, name: data.name, vcardData: vcard, members: keepMemberNames(previousMembers, data.members) };
}

/** Columns of a group written from structured data (REST): the vCard follows the data. */
export function contactGroupColumns(currentVcard: string, name: string, members: readonly ContactGroupMember[]): ContactGroupColumns {
  const unique = uniqueMembers(members);
  const vcardData = applyContactGroup(currentVcard, { name, members: unique });
  return { uid: vcardUidKey(vcardData), name: name.trim(), vcardData, members: unique };
}

const asJson = (members: ContactGroupMember[]): Prisma.InputJsonValue => members as unknown as Prisma.InputJsonValue;

/** Prisma data for a group row. */
export function contactGroupData(c: ContactGroupColumns): { uid: string; name: string; vcardData: string; members: Prisma.InputJsonValue } {
  return { uid: c.uid, name: c.name, vcardData: c.vcardData, members: asJson(c.members) };
}

/**
 * Remove a card (deleted contact or group) from every group of the user.
 * Returns the ids of the groups that changed.
 */
export async function detachCardFromGroups(userId: string, uid: string): Promise<string[]> {
  const key = uidKey(uid);
  if (!key) return [];
  const groups = await prisma.contactGroup.findMany({ where: { userId }, select: { id: true, name: true, vcardData: true, members: true } });
  const changed: string[] = [];
  for (const g of groups) {
    const members = membersFromJson(g.members);
    const rest = members.filter((m) => !(m.kind === 'card' && m.uid === key));
    if (rest.length === members.length) continue;
    await prisma.contactGroup.update({ where: { id: g.id }, data: contactGroupData(contactGroupColumns(g.vcardData, g.name, rest)) });
    changed.push(g.id);
  }
  return changed;
}

export type ResolvedCardRow = ResolvedCard & { id: string; uid: string };

/**
 * The user's cards (contacts and groups) with the given UIDs. Contacts stored
 * before 9.5 have no `uid` column yet; they are found through their vCard.
 */
export async function resolveCards(userId: string, uids: readonly string[]): Promise<Map<string, ResolvedCardRow>> {
  const wanted = [...new Set(uids.filter(Boolean))];
  const out = new Map<string, ResolvedCardRow>();
  if (wanted.length === 0) return out;
  const [contacts, groups] = await Promise.all([
    prisma.contact.findMany({ where: { userId, uid: { in: wanted } }, select: { id: true, uid: true, displayName: true, email: true } }),
    prisma.contactGroup.findMany({ where: { userId, uid: { in: wanted } }, select: { id: true, uid: true, name: true, members: true } }),
  ]);
  for (const c of contacts) out.set(c.uid, { kind: 'contact', id: c.id, uid: c.uid, displayName: c.displayName, email: c.email });
  for (const g of groups) out.set(g.uid, { kind: 'group', id: g.id, uid: g.uid, name: g.name, members: membersFromJson(g.members) });
  if (wanted.every((u) => out.has(u))) return out;
  const legacy = await prisma.contact.findMany({
    where: { userId, uid: '' }, select: { id: true, vcardData: true, displayName: true, email: true, updatedAt: true },
  });
  for (const c of legacy) {
    const uid = vcardUidKey(c.vcardData);
    if (!uid) continue;
    // Review 9.5: fill the column once, so the next lookup finds the row by index
    // instead of reading every pre-9.5 vCard again (updatedAt kept: no new ETag).
    await prisma.contact.update({ where: { id: c.id }, data: { uid, updatedAt: c.updatedAt } });
    if (wanted.includes(uid) && !out.has(uid)) out.set(uid, { kind: 'contact', id: c.id, uid, displayName: c.displayName, email: c.email });
  }
  return out;
}

/** Recipients of a group for the compose window (nested groups expanded, bounded). */
export async function expandContactGroup(userId: string, members: readonly ContactGroupMember[]): Promise<GroupExpansion> {
  const cards = new Map<string, ResolvedCardRow>();
  let pending = members;
  for (let depth = 0; depth <= GROUP_NESTING_LIMIT && pending.length > 0; depth++) {
    const uids = pending.flatMap((m) => (m.kind === 'card' && !cards.has(m.uid) ? [m.uid] : []));
    const found = await resolveCards(userId, uids);
    for (const [uid, card] of found) cards.set(uid, card);
    pending = [...found.values()].flatMap((c) => (c.kind === 'group' ? c.members : []));
  }
  return expandGroupMembers(members, (uid) => cards.get(uid));
}

/**
 * UID of a contact as a group member references it. A contact without a UID
 * (created before 7.1) gets one written into its vCard; a pre-9.5 row gets
 * its `uid` column filled.
 */
export async function ensureContactUid(contact: { id: string; uid: string } & ContactRowFlat): Promise<string> {
  if (contact.uid) return contact.uid;
  const existing = vcardUidKey(contact.vcardData);
  const vcardData = existing ? contact.vcardData : applyContactCard(contact.vcardData, contactCardFromRow(contact));
  const columns = contactColumnsFromVcard(vcardData);
  await prisma.contact.update({ where: { id: contact.id }, data: { vcardData, ...contactRowData(columns) } });
  return columns.uid;
}

/** Prisma data of the derived contact columns (JSON lists typed for Prisma). */
export function contactRowData(c: ReturnType<typeof contactColumnsFromVcard>): Omit<typeof c, 'emails' | 'phones' | 'addresses' | 'urls' | 'ims'> & {
  emails: Prisma.InputJsonValue; phones: Prisma.InputJsonValue; addresses: Prisma.InputJsonValue; urls: Prisma.InputJsonValue; ims: Prisma.InputJsonValue;
} {
  return { ...c, emails: c.emails, phones: c.phones, addresses: c.addresses, urls: c.urls, ims: c.ims };
}
