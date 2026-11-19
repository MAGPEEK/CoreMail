/**
 * 9.5: the address objects of the default address book — contacts and contact
 * groups (`KIND:group` / `X-ADDRESSBOOKSERVER-KIND:group`) share one resource
 * namespace (`<id>.vcf`). Data access for the CardDAV handlers; every write
 * derives its columns through the storage contact / group mapping.
 */
import {
  prisma, announceUserEvent, contactColumnsFromVcard, contactGroupColumnsFromVcard, contactGroupData, contactRowData,
  detachCardFromGroups, findContactUidOwner, isGroupVcard, membersFromJson, vcardUidKey,
} from '@coremail/storage';
import { collectionTag } from '../dav-utils.js';

export type AddressObjectKind = 'contact' | 'group';
export type AddressObject = { kind: AddressObjectKind; id: string; vcardData: string; updatedAt: Date };
export type AddressObjectRef = { kind: AddressObjectKind; id: string; userId: string; updatedAt: Date };

const DATA = { id: true, vcardData: true, updatedAt: true } as const;
const REF = { id: true, userId: true, updatedAt: true } as const;

export const kindOfVcard = (vcard: string): AddressObjectKind => (isGroupVcard(vcard) ? 'group' : 'contact');

/** CTag / sync-token of the default address book: object count + newest updatedAt (contacts and groups). */
export async function addressbookTag(userId: string): Promise<string> {
  const [c, g] = await Promise.all([
    prisma.contact.aggregate({ where: { userId }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.contactGroup.aggregate({ where: { userId }, _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  const newest = [c._max.updatedAt, g._max.updatedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return collectionTag(c._count._all + g._count._all, newest);
}

/** Every address object of the user (optionally only the given resource ids). */
export async function listAddressObjects(userId: string, ids?: string[]): Promise<AddressObject[]> {
  const where = ids ? { userId, id: { in: ids } } : { userId };
  const [contacts, groups] = await Promise.all([
    prisma.contact.findMany({ where, select: DATA }),
    prisma.contactGroup.findMany({ where, select: DATA }),
  ]);
  return [
    ...contacts.map((c) => ({ kind: 'contact' as const, ...c })),
    ...groups.map((g) => ({ kind: 'group' as const, ...g })),
  ];
}

/** One address object of the user (null when absent). */
export async function findAddressObject(userId: string, id: string): Promise<AddressObject | null> {
  const c = await prisma.contact.findFirst({ where: { id, userId }, select: DATA });
  if (c) return { kind: 'contact', ...c };
  const g = await prisma.contactGroup.findFirst({ where: { id, userId }, select: DATA });
  return g ? { kind: 'group', ...g } : null;
}

/** The object with this resource id, whoever owns it (resource names are global). */
export async function findAnyObject(id: string): Promise<AddressObjectRef | null> {
  const c = await prisma.contact.findFirst({ where: { id }, select: REF });
  if (c) return { kind: 'contact', ...c };
  const g = await prisma.contactGroup.findFirst({ where: { id }, select: REF });
  return g ? { kind: 'group', ...g } : null;
}

/** Resource id of another object of the user that already uses `uid` (null when unique). */
export function findUidOwner(userId: string, uid: string, selfId: string): Promise<string | null> {
  return findContactUidOwner(userId, uid, selfId);
}

export type PutOutcome =
  | { status: 'created' | 'updated'; id: string; updatedAt: Date }
  | { status: 'kindChanged' };

/** Store a client vCard as contact or group (create or replace an object of the same user). */
export async function putAddressObject(userId: string, id: string, vcardData: string, existing: AddressObjectRef | null): Promise<PutOutcome> {
  const kind = kindOfVcard(vcardData);
  // A resource keeps its kind: a contact never silently turns into a group (or back)
  if (existing && existing.kind !== kind) return { status: 'kindChanged' };

  let saved: { id: string; updatedAt: Date };
  if (kind === 'group') {
    const previous = existing
      ? membersFromJson((await prisma.contactGroup.findFirst({ where: { id }, select: { members: true } }))?.members)
      : [];
    const data = contactGroupData(contactGroupColumnsFromVcard(vcardData, previous)!);
    saved = existing
      ? await prisma.contactGroup.update({ where: { id }, data, select: { id: true, updatedAt: true } })
      : await prisma.contactGroup.create({ data: { id, userId, ...data }, select: { id: true, updatedAt: true } });
  } else {
    const data = { vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)) };
    saved = existing
      ? await prisma.contact.update({ where: { id }, data, select: { id: true, updatedAt: true } })
      : await prisma.contact.create({ data: { id, userId, ...data }, select: { id: true, updatedAt: true } });
  }
  announceUserEvent(userId, { type: 'contacts', action: existing ? 'update' : 'create', ids: [id] });
  return { status: existing ? 'updated' : 'created', ...saved };
}

/** Delete an address object; a deleted card also leaves every group it was a member of. */
export async function deleteAddressObject(userId: string, obj: AddressObject): Promise<void> {
  if (obj.kind === 'group') await prisma.contactGroup.delete({ where: { id: obj.id } });
  else await prisma.contact.delete({ where: { id: obj.id } });
  const changedGroups = await detachCardFromGroups(userId, vcardUidKey(obj.vcardData));
  announceUserEvent(userId, { type: 'contacts', action: 'delete', ids: [obj.id] });
  if (changedGroups.length) announceUserEvent(userId, { type: 'contacts', action: 'update', ids: changedGroups });
}
