/**
 * Address book restore (9.5): the contacts and contact groups of a ZIP mailbox
 * backup (`contacts/<id>.vcf`) go back into the target user's address book.
 *
 *  - Like a CardDAV PUT, the vCard decides: a group vCard (KIND:group or the
 *    X-ADDRESSBOOKSERVER-KIND form) becomes a group, everything else a contact.
 *    Every entry must hold exactly one vCard; the vCard is stored verbatim and
 *    the columns are derived through the storage contact / group mapping.
 *  - Contacts first, then groups: group members reference cards by UID, and the
 *    restored contacts keep their UIDs, so the members resolve again (also
 *    against a contact the target already had with that UID). Address members
 *    get their display names back from the archive manifest.
 *  - Idempotent: an object whose UID the address book already uses (contact or
 *    group) is skipped as a duplicate; one without UID when an identical vCard is
 *    already stored. A second restore adds nothing.
 */
import { countVcards, parseVcard } from '@coremail/core/vcard';
import {
  prisma, announceUserEvent, contactColumnsFromVcard, contactGroupColumnsFromVcard, contactGroupData, contactRowData,
  findContactUidOwner, isGroupVcard, vcardUidKey, type ContactGroupMember,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { openZip, type ZipEntry, type ZipFile } from './zip-reader.js';
import { MANIFEST_NAME, parseManifestContactGroups } from '../export/manifest.js';

const log = createLogger('backup:restore-contacts');

/** Max. size of one vCard entry. */
export const MAX_VCARD_BYTES = 1024 * 1024;
/** Max. manifest size read for the group member names (same cap as the message restore). */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface AddressBookCounts {
  contactsImported: number;
  contactsDuplicates: number;
  contactGroupsImported: number;
  contactGroupsDuplicates: number;
  /** Unreadable / invalid vCard entries. */
  addressBookFailed: number;
}

export function emptyAddressBookCounts(): AddressBookCounts {
  return { contactsImported: 0, contactsDuplicates: 0, contactGroupsImported: 0, contactGroupsDuplicates: 0, addressBookFailed: 0 };
}

/** True for an address book entry of a CoreMail ZIP backup. */
export function isAddressBookEntry(name: string): boolean {
  return name.startsWith('contacts/') && name.toLowerCase().endsWith('.vcf');
}

/** The vCard of an entry, or null when it is unreadable, too large or not exactly one vCard. */
async function readVcard(zip: ZipFile, entry: ZipEntry): Promise<string | null> {
  try {
    const text = (await zip.read(entry, MAX_VCARD_BYTES)).toString('utf8');
    return countVcards(text) === 1 && parseVcard(text) ? text : null;
  } catch (err) {
    log.warn({ err, ref: entry.name }, 'Restore: vCard entry unreadable');
    return null;
  }
}

async function namedMembers(zip: ZipFile): Promise<Map<string, ContactGroupMember[]>> {
  const m = zip.entries.find((e) => e.name === MANIFEST_NAME);
  if (!m) return new Map();
  try {
    return parseManifestContactGroups((await zip.read(m, MAX_MANIFEST_BYTES)).toString('utf8'));
  } catch {
    return new Map();
  }
}

/** True when the user's address book already holds this object (by UID, else the identical vCard). */
async function alreadyStored(userId: string, vcard: string, kind: 'contact' | 'group'): Promise<boolean> {
  const uid = vcardUidKey(vcard);
  if (uid) return (await findContactUidOwner(userId, uid)) !== null;
  const same = kind === 'contact'
    ? await prisma.contact.findFirst({ where: { userId, vcardData: vcard }, select: { id: true } })
    : await prisma.contactGroup.findFirst({ where: { userId, vcardData: vcard }, select: { id: true } });
  return !!same;
}

/**
 * Restores the address book entries of the ZIP at `path` into the address book
 * of `userId`. Never throws for a single bad entry (counted as failed).
 */
export async function restoreAddressBook(
  path: string,
  userId: string,
  counts: AddressBookCounts,
  isAborted: () => boolean = () => false,
): Promise<void> {
  const zip = await openZip(path);
  const created: string[] = [];
  try {
    const entries = zip.entries.filter((e) => isAddressBookEntry(e.name));
    if (!entries.length) return;
    const memberNames = await namedMembers(zip);
    // Two passes (contacts, then groups) instead of holding every vCard in memory.
    for (const pass of ['contact', 'group'] as const) {
      for (const entry of entries) {
        if (isAborted()) return;
        const vcard = await readVcard(zip, entry);
        if (vcard === null) {
          if (pass === 'contact') counts.addressBookFailed++;
          continue;
        }
        if ((isGroupVcard(vcard) ? 'group' : 'contact') !== pass) continue;
        try {
          const id = pass === 'contact'
            ? await restoreContact(userId, vcard, counts)
            : await restoreGroup(userId, vcard, memberNames.get(entry.name) ?? [], counts);
          if (id) created.push(id);
        } catch (err) {
          counts.addressBookFailed++;
          log.warn({ err, ref: entry.name }, 'Restore: address book entry could not be restored');
        }
      }
    }
  } finally {
    await zip.close();
    if (created.length) announceUserEvent(userId, { type: 'contacts', action: 'create', ids: created });
  }
}

async function restoreContact(userId: string, vcard: string, counts: AddressBookCounts): Promise<string | null> {
  if (await alreadyStored(userId, vcard, 'contact')) { counts.contactsDuplicates++; return null; }
  const row = await prisma.contact.create({
    data: { userId, vcardData: vcard, ...contactRowData(contactColumnsFromVcard(vcard)) },
    select: { id: true },
  });
  counts.contactsImported++;
  return row.id;
}

async function restoreGroup(userId: string, vcard: string, named: ContactGroupMember[], counts: AddressBookCounts): Promise<string | null> {
  if (await alreadyStored(userId, vcard, 'group')) { counts.contactGroupsDuplicates++; return null; }
  const columns = contactGroupColumnsFromVcard(vcard, named);
  if (!columns) throw new Error('not a contact group vCard');
  const row = await prisma.contactGroup.create({ data: { userId, ...contactGroupData(columns) }, select: { id: true } });
  counts.contactGroupsImported++;
  return row.id;
}
