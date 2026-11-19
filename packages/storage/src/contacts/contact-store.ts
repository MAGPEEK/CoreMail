/**
 * 9.5: the contact row writer. Every write of a `contacts` row — REST, CardDAV and
 * ActiveSync — stores the vCard (the source of truth) together with the columns
 * derived from it in one place (contactColumnsFromVcard); a deleted contact leaves
 * every contact group. Realtime announcements stay with the callers (the REST
 * middleware, the CardDAV handler, the ActiveSync class module).
 */
import { prisma } from '../prisma/index.js';
import { contactColumnsFromVcard, vcardUidKey } from './contact-vcard.js';
import { contactRowData, detachCardFromGroups } from './contact-groups.js';

/** Create a contact of `userId` from its vCard (`id`: a client-chosen resource id, CardDAV). */
export async function createContactRow(userId: string, vcardData: string, id?: string) {
  return prisma.contact.create({
    data: { ...(id ? { id } : {}), userId, vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)) },
  });
}

/** Replace the vCard of contact `id` (the derived columns follow). */
export async function updateContactRow(id: string, vcardData: string) {
  return prisma.contact.update({ where: { id }, data: { vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)) } });
}

/** Delete a contact of `userId`; it leaves every group. Returns the ids of the groups that changed. */
export async function deleteContactRow(userId: string, contact: { id: string; uid?: string; vcardData: string }): Promise<string[]> {
  await prisma.contact.delete({ where: { id: contact.id } });
  return detachCardFromGroups(userId, contact.uid || vcardUidKey(contact.vcardData));
}
