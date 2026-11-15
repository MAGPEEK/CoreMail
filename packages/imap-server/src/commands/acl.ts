/**
 * ACL (RFC 4314), read-only.
 *
 * Rights reflect the real permissions (see namespaces.ts):
 *   own folders                       → lrswipkxteacd (everything)
 *   Shared Mailbox / delegation with FULL_ACCESS → lrswipkxtecd (no "a": the ACL
 *                                       itself is administered in the BCP)
 *   … with READ_ONLY                  → lr
 *
 *   MYRIGHTS   → the caller's rights on the folder
 *   GETACL     → own folders: one entry, the owner (login address) with all rights;
 *                foreign folders: NO [NOPERM] (RFC 4314 §4: needs "a" — and the
 *                other grantees of a shared mailbox are not disclosed)
 *   LISTRIGHTS → own folders: the owner all rights, anyone else none; foreign
 *                folders: only for the caller's own identifier (its fixed rights),
 *                anything else NO [NOPERM]
 *   SETACL / DELETEACL → NO [NOPERM] — permissions (shared mailbox FULL_ACCESS /
 *                READ_ONLY / SEND_AS, mailbox delegation) are managed by
 *                administrators in the BCP, not over IMAP.
 *
 * A foreign name the user may not open is answered exactly like a missing mailbox.
 */
import { type ImapSession, sendOk, sendNo, sendBad, sendUntagged } from '../session/state.js';
import { displayName, formatName } from './mailbox-name.js';
import { NOPERM, OWNER_RIGHTS, clientNameOf, findTargetFolder } from './namespaces.js';

export { OWNER_RIGHTS } from './namespaces.js';

const quote = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;

async function findFolder(session: ImapSession, name: string) {
  if (!session.mailboxId || !name) return null;
  const folder = await findTargetFolder(session, name);
  if (!folder) return null;
  return { ...folder, shown: formatName(session, clientNameOf(folder.target, displayName(folder.name))) };
}

/** The user's own ACL identifier (RFC 4314 §3: the login name). */
function ownerIdentifier(session: ImapSession): string {
  return session.userEmail ?? session.userId ?? '';
}

export async function handleMyRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'MYRIGHTS requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendUntagged(session, `MYRIGHTS ${folder.shown} ${folder.target.rights}`);
  sendOk(session, tag, 'MYRIGHTS completed');
}

export async function handleGetAcl(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'GETACL requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  if (folder.target.foreign) { sendNo(session, tag, `${NOPERM} — the ACL of this mailbox is managed in the BCP`); return; }
  sendUntagged(session, `ACL ${folder.shown} ${quote(ownerIdentifier(session))} ${OWNER_RIGHTS}`);
  sendOk(session, tag, 'GETACL completed');
}

export async function handleListRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 2 || !args[1]) { sendBad(session, tag, 'LISTRIGHTS requires a mailbox name and an identifier'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  const identifier = args[1];
  const isSelf = identifier.toLowerCase() === ownerIdentifier(session).toLowerCase();
  if (folder.target.foreign && !isSelf) { sendNo(session, tag, `${NOPERM} — the ACL of this mailbox is managed in the BCP`); return; }
  // The first rights string is always granted; no optional rights can be granted over IMAP.
  sendUntagged(session, `LISTRIGHTS ${folder.shown} ${quote(identifier)} ${isSelf ? folder.target.rights : '""'}`);
  sendOk(session, tag, 'LISTRIGHTS completed');
}

export async function handleSetAcl(session: ImapSession, tag: string, args: string[], command: 'SETACL' | 'DELETEACL'): Promise<void> {
  const expected = command === 'SETACL' ? 3 : 2;
  if (args.length !== expected) {
    sendBad(session, tag, command === 'SETACL' ? 'SETACL requires mailbox, identifier and rights' : 'DELETEACL requires mailbox and identifier');
    return;
  }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendNo(session, tag, '[NOPERM] Access rights are managed by the administrator (BCP), not over IMAP');
}
