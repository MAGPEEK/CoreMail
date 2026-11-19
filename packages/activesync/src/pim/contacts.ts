/**
 * Contacts class module ([MS-ASCNTC]): the user's own contacts as one folder (FolderSync
 * type 9, the default contacts folder). Contact groups are not synced (ActiveSync has no
 * group item). Every write goes through the storage contact writer shared with REST and
 * CardDAV (contact-store.ts): the vCard stays the source of truth — only the properties whose
 * field changed are rewritten, everything a CardDAV client stored survives — and the columns
 * are derived from it; writes are announced to the user's other clients (realtime `contacts`).
 */
import { prisma } from '@coremail/storage/prisma';
import {
  announceUserEvent, applyContactCard, contactCardFromRow, createContactRow, deleteContactRow, photoMediaType, sameContactCard,
  setVcardPhoto, setVcardText, updateContactRow, vcardPhoto, vcardText, vcardUidKey, OFFICE_LOCATION_PROPERTY,
} from '@coremail/storage';
import type { UserEventAction } from '@coremail/core';
import { contactChange, renderContact, PICTURE_MAX_BYTES } from './contacts-codec.js';
import type { ContactItem } from './contacts-view.js';
import { PIM_STATUS, versionOf, type PimClassModule, type PimCollection } from './types.js';

export const CONTACTS_COLLECTION_ID = 'contacts:default';
/** Display name of the folder (the device shows it under its own contacts label). */
const FOLDER_NAME = 'Kontakte';

const CONTACT_SELECT = {
  id: true, uid: true, vcardData: true, displayName: true, email: true, email2: true, phone: true, mobile: true,
  company: true, department: true, jobTitle: true, notes: true, updatedAt: true,
} as const;

export interface ContactRow {
  id: string; uid: string; vcardData: string; displayName: string; email: string; email2: string; phone: string; mobile: string;
  company: string; department: string; jobTitle: string; notes: string; updatedAt: Date;
}

function announce(userId: string, action: UserEventAction, ids: string[]): void {
  if (ids.length > 0) announceUserEvent(userId, { type: 'contacts', action, ids });
}

/** The ActiveSync view of a stored contact (a photo over the bound is not shown). */
export function contactItemOf(row: ContactRow): ContactItem {
  const photo = vcardPhoto(row.vcardData);
  return {
    card: contactCardFromRow(row),
    officeLocation: vcardText(row.vcardData, OFFICE_LOCATION_PROPERTY),
    picture: photo && photo.data.length <= PICTURE_MAX_BYTES ? photo.data.toString('base64') : '',
  };
}

/** The stored vCard with `item` written into it (only what differs from `stored`). */
export function contactVcard(vcard: string, stored: ContactItem | null, item: ContactItem): string {
  let out = applyContactCard(vcard, item.card);
  if (item.officeLocation !== (stored?.officeLocation ?? '')) out = setVcardText(out, OFFICE_LOCATION_PROPERTY, item.officeLocation);
  if (item.picture !== (stored?.picture ?? '')) {
    const data = Buffer.from(item.picture, 'base64');
    const mediaType = photoMediaType(data);
    out = setVcardPhoto(out, item.picture && mediaType ? { mediaType, data } : null);
  }
  return out;
}

const sameItem = (a: ContactItem, b: ContactItem): boolean =>
  sameContactCard(a.card, b.card) && a.officeLocation === b.officeLocation && a.picture === b.picture;

async function findContact(col: PimCollection, id: string): Promise<ContactRow | null> {
  return prisma.contact.findFirst({ where: { id, userId: col.key }, select: CONTACT_SELECT });
}

export const contactsModule: PimClassModule<ContactRow> = {
  className: 'Contacts',
  idPrefix: 'contacts:',
  feature: 'contacts',

  async folders() {
    return [{ serverId: CONTACTS_COLLECTION_ID, displayName: FOLDER_NAME, type: '9' }];
  },

  async collection(userId, collectionId) {
    return collectionId === CONTACTS_COLLECTION_ID ? { id: collectionId, userId, key: userId } : null;
  },

  async states(col) {
    const rows = await prisma.contact.findMany({ where: { userId: col.key }, select: { id: true, updatedAt: true } });
    return rows.map((r) => ({ serverId: r.id, version: versionOf(r.updatedAt), inFilter: true }));
  },

  async load(col, ids) {
    if (ids.length === 0) return [];
    return prisma.contact.findMany({ where: { userId: col.key, id: { in: ids } }, select: CONTACT_SELECT });
  },

  rowId: (row) => row.id,
  rowVersion: (row) => versionOf(row.updatedAt),
  render: (row, ctx) => renderContact(contactItemOf(row), ctx),

  async create(col, data, ctx) {
    const { item, normalized } = contactChange(data, null, ctx);
    const saved = await createContactRow(col.key, contactVcard('', null, item));
    announce(col.key, 'create', [saved.id]);
    return { ok: true, serverId: saved.id, version: versionOf(saved.updatedAt), ...(normalized ? { normalized } : {}) };
  },

  async update(col, serverId, data, ctx) {
    const row = await findContact(col, serverId);
    if (!row) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    const stored = contactItemOf(row);
    const { item, normalized } = contactChange(data, stored, ctx);
    // nothing changed (and the row has a real vCard): no write, no new version
    if (sameItem(item, stored) && vcardUidKey(row.vcardData)) {
      return { ok: true, serverId: row.id, version: versionOf(row.updatedAt), ...(normalized ? { normalized } : {}) };
    }
    const saved = await updateContactRow(row.id, contactVcard(row.vcardData, stored, item));
    announce(col.key, 'update', [saved.id]);
    return { ok: true, serverId: saved.id, version: versionOf(saved.updatedAt), ...(normalized ? { normalized } : {}) };
  },

  async remove(col, serverId) {
    const row = await findContact(col, serverId);
    if (!row) return false;
    const changedGroups = await deleteContactRow(col.key, row);
    announce(col.key, 'delete', [row.id]);
    announce(col.key, 'update', changedGroups);
    return true;
  },

  async fingerprint(col) {
    const [count, newest] = await Promise.all([
      prisma.contact.count({ where: { userId: col.key } }),
      prisma.contact.aggregate({ where: { userId: col.key }, _max: { updatedAt: true } }),
    ]);
    return `${count}:${newest._max.updatedAt?.getTime() ?? 0}`;
  },
};
