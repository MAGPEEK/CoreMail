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
  setVcardPhoto, setVcardRelated, setVcardText, updateContactRow, vcardPhoneKinds, vcardPhoto, vcardRelated, vcardText, vcardUidKey,
  CONTACT_RELATED_TYPES, CONTACT_TEXT_PROPERTIES,
} from '@coremail/storage';
import type { UserEventAction } from '@coremail/core';
import { contactChange, renderContact, PICTURE_MAX_BYTES } from './contacts-codec.js';
import { EXTRA_ELEMENTS, type ContactItem, type ExtraElement } from './contacts-view.js';
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

/** Where an element outside the card lives in the vCard: its own property or a related person (the first of its type). */
const EXTRA_STORE: Readonly<Record<ExtraElement, { property: string } | { related: string }>> = {
  OfficeLocation: { property: CONTACT_TEXT_PROPERTIES.officeLocation },
  YomiFirstName: { property: CONTACT_TEXT_PROPERTIES.phoneticGiven },
  YomiLastName: { property: CONTACT_TEXT_PROPERTIES.phoneticFamily },
  YomiCompanyName: { property: CONTACT_TEXT_PROPERTIES.phoneticCompany },
  CustomerId: { property: CONTACT_TEXT_PROPERTIES.customerId },
  GovernmentId: { property: CONTACT_TEXT_PROPERTIES.governmentId },
  AccountName: { property: CONTACT_TEXT_PROPERTIES.accountName },
  Spouse: { related: CONTACT_RELATED_TYPES.spouse },
  AssistantName: { related: CONTACT_RELATED_TYPES.assistant },
  ManagerName: { related: CONTACT_RELATED_TYPES.manager },
};

function readExtra(vcard: string, e: ExtraElement): string {
  const at = EXTRA_STORE[e];
  return 'property' in at ? vcardText(vcard, at.property) : vcardRelated(vcard, at.related)[0] ?? '';
}

/** `vcard` with element `e` set to `value`; for a related person only the first one of its type (the one the device saw). */
function writeExtra(vcard: string, e: ExtraElement, value: string): string {
  const at = EXTRA_STORE[e];
  if ('property' in at) return setVcardText(vcard, at.property, value);
  const rest = vcardRelated(vcard, at.related).slice(1);
  return setVcardRelated(vcard, at.related, value ? [value, ...rest] : rest);
}

function announce(userId: string, action: UserEventAction, ids: string[]): void {
  if (ids.length > 0) announceUserEvent(userId, { type: 'contacts', action, ids });
}

/** The ActiveSync view of a stored contact (a photo over the bound is not shown). */
export function contactItemOf(row: ContactRow): ContactItem {
  const photo = vcardPhoto(row.vcardData);
  return {
    card: contactCardFromRow(row),
    extras: Object.fromEntries(EXTRA_ELEMENTS.map((e) => [e, readExtra(row.vcardData, e)])),
    children: vcardRelated(row.vcardData, CONTACT_RELATED_TYPES.child),
    picture: photo && photo.data.length <= PICTURE_MAX_BYTES ? photo.data.toString('base64') : '',
    phoneKinds: vcardPhoneKinds(row.vcardData),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The stored vCard with `item` written into it (only what differs from `stored`). */
export function contactVcard(vcard: string, stored: ContactItem | null, item: ContactItem): string {
  let out = applyContactCard(vcard, item.card, { phoneKinds: item.phoneKinds });
  for (const e of EXTRA_ELEMENTS) {
    const value = item.extras[e] ?? '';
    if (value !== (stored?.extras[e] ?? '')) out = writeExtra(out, e, value);
  }
  if (!sameList(item.children, stored?.children ?? [])) out = setVcardRelated(out, CONTACT_RELATED_TYPES.child, item.children);
  if (item.picture !== (stored?.picture ?? '')) {
    const data = Buffer.from(item.picture, 'base64');
    const mediaType = photoMediaType(data);
    out = setVcardPhoto(out, item.picture && mediaType ? { mediaType, data } : null);
  }
  return out;
}

const kindsOf = (item: ContactItem): string[] => item.card.phones.map((_, i) => item.phoneKinds[i] ?? '');

const sameItem = (a: ContactItem, b: ContactItem): boolean =>
  sameContactCard(a.card, b.card) && a.picture === b.picture && sameList(kindsOf(a), kindsOf(b)) && sameList(a.children, b.children)
  && EXTRA_ELEMENTS.every((e) => (a.extras[e] ?? '') === (b.extras[e] ?? ''));

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
