/**
 * ACL (RFC 4314), read-only.
 *
 * IMAP exposes only the user's own mailbox (personal namespace, see NAMESPACE);
 * shared mailboxes and delegated mailboxes are not part of the IMAP namespace.
 * On its own folders the owner holds every right, so:
 *
 *   MYRIGHTS   → all rights
 *   GETACL     → one entry: the owner (login address) with all rights
 *   LISTRIGHTS → the owner: all rights (always granted); anyone else: none
 *   SETACL / DELETEACL → NO [NOPERM] — permissions (shared mailbox FULL_ACCESS /
 *                SEND_AS, mailbox delegation) are managed by administrators in
 *                the BCP, not over IMAP.
 */
import { prisma } from '@coremail/storage';
import { type ImapSession, sendOk, sendNo, sendBad, sendUntagged } from '../session/state.js';
import { resolveStoredName, toClient } from './mailbox-name.js';

/**
 * RFC 4314 §2.1 rights plus the obsolete RFC 2086 "c" (create) and "d"
 * (delete) that §2.1.1 asks servers to report for compatibility.
 */
export const OWNER_RIGHTS = 'lrswipkxteacd';

const quote = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;

async function findFolder(session: ImapSession, name: string): Promise<{ name: string } | null> {
  if (!session.mailboxId || !name) return null;
  return prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: await resolveStoredName(session, name) },
    select: { name: true },
  });
}

/** The user's own ACL identifier (RFC 4314 §3: the login name). */
function ownerIdentifier(session: ImapSession): string {
  return session.userEmail ?? session.userId ?? '';
}

export async function handleMyRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'MYRIGHTS requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendUntagged(session, `MYRIGHTS ${toClient(session, folder.name)} ${OWNER_RIGHTS}`);
  sendOk(session, tag, 'MYRIGHTS completed');
}

export async function handleGetAcl(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'GETACL requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendUntagged(session, `ACL ${toClient(session, folder.name)} ${quote(ownerIdentifier(session))} ${OWNER_RIGHTS}`);
  sendOk(session, tag, 'GETACL completed');
}

export async function handleListRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 2 || !args[1]) { sendBad(session, tag, 'LISTRIGHTS requires a mailbox name and an identifier'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  const identifier = args[1];
  const isOwner = identifier.toLowerCase() === ownerIdentifier(session).toLowerCase();
  // The first rights string is always granted; no optional rights can be granted over IMAP.
  sendUntagged(session, `LISTRIGHTS ${toClient(session, folder.name)} ${quote(identifier)} ${isOwner ? OWNER_RIGHTS : '""'}`);
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
