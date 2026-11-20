/**
 * X.500 legacy distinguished names of directory objects, as MAPI clients expect
 * them (Autodiscover `<LegacyDN>`, MAPI over HTTP Connect `UserDn` and RopLogon
 * `Essdn`). The last RDN carries the CoreMail id of the user or shared mailbox.
 * Pure module.
 */

export const LEGACY_DN_PREFIX = '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=';

export function legacyDnFor(directoryId: string): string {
  return LEGACY_DN_PREFIX + directoryId;
}

/** The directory id of a legacy DN of this server (case-insensitive prefix), else null. */
export function directoryIdFromLegacyDn(dn: string): string | null {
  const value = dn.trim();
  if (value.length <= LEGACY_DN_PREFIX.length) return null;
  if (value.slice(0, LEGACY_DN_PREFIX.length).toLowerCase() !== LEGACY_DN_PREFIX.toLowerCase()) return null;
  const id = value.slice(LEGACY_DN_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
