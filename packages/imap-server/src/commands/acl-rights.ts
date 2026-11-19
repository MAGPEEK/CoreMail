/**
 * w3: IMAP ACL rights (RFC 4314) ⇄ folder permissions (storage folder-permissions.ts).
 *
 *   l  folder visible            r  read items
 *   s  w  edit all items         i  p  create items
 *   k  create subfolders         x  a  folder owner (rename / delete / administer)
 *   t  e  delete all items       c  (obsolete) = k        d  (obsolete) = t + e
 *
 * Tied rights (granted and revoked together): "sw", "ip", "xa", "te".
 * "x"/"a" also carry "folder contact" (the Owner role); "own items" rights (edit /
 * delete own) have no letter of their own:
 * they are kept by "+"/"-" changes and dropped by a full replacement.
 *
 * The user's own folders report everything; mailbox FULL_ACCESS everything but
 * "a" (permissions are administered by the owner or in the BCP).
 */
import { FolderRight, normalizeRights, type FolderAccess } from '@coremail/storage';

/** RFC 4314 §2.1 rights plus the obsolete RFC 2086 "c" and "d" (§2.1.1). */
export const OWNER_RIGHTS = 'lrswipkxteacd';
/** FULL_ACCESS: everything except administering the ACL ("a"). */
export const FULL_ACCESS_RIGHTS = 'lrswipkxtecd';

const LETTER_BITS: Readonly<Record<string, number>> = Object.freeze({
  l: FolderRight.FolderVisible,
  r: FolderRight.ReadAny,
  s: FolderRight.EditAny | FolderRight.EditOwned,
  w: FolderRight.EditAny | FolderRight.EditOwned,
  i: FolderRight.Create,
  p: FolderRight.Create,
  k: FolderRight.CreateSubfolder,
  c: FolderRight.CreateSubfolder,
  x: FolderRight.FolderOwner | FolderRight.FolderContact,
  a: FolderRight.FolderOwner | FolderRight.FolderContact,
  t: FolderRight.DeleteAny | FolderRight.DeleteOwned,
  e: FolderRight.DeleteAny | FolderRight.DeleteOwned,
  d: FolderRight.DeleteAny | FolderRight.DeleteOwned,
});

/** Pure: the RFC 4314 rights string of a folder access. */
export function imapRights(access: FolderAccess): string {
  if (access.level === 'owner') return OWNER_RIGHTS;
  if (access.level === 'full') return FULL_ACCESS_RIGHTS;
  return rightsString(access.rights);
}

/** Pure: the rights string of a member-rights bitmask (canonical order). */
export function rightsString(rights: number): string {
  const r = normalizeRights(rights);
  const on = (bit: number): boolean => (r & bit) !== 0;
  let out = '';
  if (on(FolderRight.FolderVisible)) out += 'l';
  if (on(FolderRight.ReadAny)) out += 'r';
  if (on(FolderRight.EditAny)) out += 'sw';
  if (on(FolderRight.Create)) out += 'ip';
  if (on(FolderRight.CreateSubfolder)) out += 'k';
  if (on(FolderRight.FolderOwner)) out += 'x';
  if (on(FolderRight.DeleteAny)) out += 'te';
  if (on(FolderRight.FolderOwner)) out += 'a';
  if (on(FolderRight.CreateSubfolder)) out += 'c';
  if (on(FolderRight.DeleteAny)) out += 'd';
  return out;
}

/** LISTRIGHTS (RFC 4314 §3.7): optional rights, tied ones grouped. */
export const OPTIONAL_RIGHTS = ['l', 'r', 'sw', 'ip', 'k', 'xa', 'te', 'c', 'd'] as const;

/**
 * Pure: the bitmask after a SETACL rights argument — "+..." adds, "-..."
 * removes, anything else replaces. null for an unknown right letter.
 */
export function applyImapRights(current: number, spec: string): number | null {
  const mode = spec.startsWith('+') ? 'add' : spec.startsWith('-') ? 'remove' : 'replace';
  const letters = mode === 'replace' ? spec : spec.slice(1);
  let bits = 0;
  for (const ch of letters.toLowerCase()) {
    const b = LETTER_BITS[ch];
    if (b === undefined) return null;
    bits |= b;
  }
  if (mode === 'add') return normalizeRights(current | bits);
  if (mode === 'remove') {
    // Removing an "all items" right keeps the matching "own items" right of a role.
    const keepOwn = current & (FolderRight.EditOwned | FolderRight.DeleteOwned);
    const removed = bits & ~(FolderRight.EditOwned | FolderRight.DeleteOwned);
    return normalizeRights((current & ~removed) | keepOwn);
  }
  return normalizeRights(bits);
}
