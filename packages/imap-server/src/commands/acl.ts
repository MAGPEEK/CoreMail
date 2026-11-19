/**
 * ACL (RFC 4314) — w3: backed by folder permissions (storage folder-access.ts).
 *
 * Rights (commands/acl-rights.ts) reflect the real permissions per folder:
 *   own folders                       → lrswipkxteacd (everything)
 *   Shared Mailbox / delegation with FULL_ACCESS → lrswipkxtecd (no "a")
 *   … with READ_ONLY                  → lr, plus what folder permissions add
 *   folder permissions only           → the granted rights (e.g. Reviewer "lr")
 *
 *   MYRIGHTS   → the caller's rights on the folder
 *   GETACL     → needs "a" (the owner, or a grantee with the folder owner right):
 *                the mailbox owner with all rights, "anyone" (Default) and every
 *                user grantee (by address) — own and inherited entries;
 *                otherwise NO [NOPERM] (grantees are not disclosed)
 *   LISTRIGHTS → the caller's own identifier: its current rights; with "a" for
 *                another identifier: nothing required, the tied groups optional
 *   SETACL / DELETEACL → need "a": set / remove the folder permission of a user
 *                (login address) or of "anyone" (= Default, every user of the
 *                organisation). "anonymous", negative rights ("-identifier") and
 *                the mailbox owner are refused with NO [CANNOT]; so is a grantee's
 *                change of an entry that reaches subfolders it does not administer
 *                (w3 review: storage subfolderAuthorizer). Changes are
 *                audited and end the grantee's live access at once
 *                (`permission-change`).
 *
 * A foreign name the user may not open is answered exactly like a missing mailbox.
 */
import {
  prisma, describeFolderPermissions, setFolderPermissions, publishFolderPermissionChange, canAdministerFolder, subfolderAuthorizer,
  FolderPermissionError, DEFAULT_GRANTEE_KEY, granteeUserId, userGranteeKey,
  type FolderPermissionInput, type FolderPermissionWriteDb,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { type ImapSession, sendOk, sendNo, sendBad, sendUntagged } from '../session/state.js';
import { displayName, formatName } from './mailbox-name.js';
import { NOPERM, clientNameOf, findTargetFolder } from './namespaces.js';
import { OPTIONAL_RIGHTS, OWNER_RIGHTS, applyImapRights, imapRights, rightsString } from './acl-rights.js';

export { OWNER_RIGHTS } from './acl-rights.js';

const log = createLogger('imap:acl');

/** RFC 4314 §3: "anyone" — every user of the organisation (Default). */
const ANYONE = 'anyone';
const db = (): FolderPermissionWriteDb => prisma as unknown as FolderPermissionWriteDb;

const quote = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;

async function findFolder(session: ImapSession, name: string, fresh = false) {
  if (!session.mailboxId || !name) return null;
  const folder = await findTargetFolder(session, name, fresh);
  if (!folder) return null;
  return { ...folder, shown: formatName(session, clientNameOf(folder.target, displayName(folder.name))) };
}

type AclFolder = NonNullable<Awaited<ReturnType<typeof findFolder>>>;

/** The user's own ACL identifier (RFC 4314 §3: the login name). */
function ownerIdentifier(session: ImapSession): string {
  return session.userEmail ?? session.userId ?? '';
}

/** The mailbox owner of the folder: [user id, identifier]; none for a Shared Mailbox. */
function mailboxOwner(session: ImapSession, folder: AclFolder): { id: string; identifier: string } | null {
  const foreign = folder.target.foreign;
  if (!foreign) return { id: session.userId ?? '', identifier: ownerIdentifier(session) };
  return foreign.ownerUserId ? { id: foreign.ownerUserId, identifier: foreign.email } : null;
}

export async function handleMyRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'MYRIGHTS requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendUntagged(session, `MYRIGHTS ${folder.shown} ${imapRights(folder.access)}`);
  sendOk(session, tag, 'MYRIGHTS completed');
}

export async function handleGetAcl(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'GETACL requires a mailbox name'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  if (!canAdministerFolder(folder.access)) { sendNo(session, tag, NOPERM); return; }
  const view = await describeFolderPermissions(db(), { id: folder.id, mailboxId: folder.mailboxId });
  const owner = mailboxOwner(session, folder);
  const pairs: string[] = owner ? [`${quote(owner.identifier)} ${OWNER_RIGHTS}`] : [];
  for (const e of [...view.entries, ...view.inherited]) {
    const identifier = e.user ? e.user.email : ANYONE;
    pairs.push(`${quote(identifier)} ${quote(rightsString(e.rights))}`);
  }
  sendUntagged(session, `ACL ${folder.shown} ${pairs.join(' ')}`);
  sendOk(session, tag, 'GETACL completed');
}

export async function handleListRights(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 2 || !args[1]) { sendBad(session, tag, 'LISTRIGHTS requires a mailbox name and an identifier'); return; }
  const folder = await findFolder(session, args[0]!);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  const identifier = args[1];
  const isSelf = identifier.toLowerCase() === ownerIdentifier(session).toLowerCase();
  if (isSelf) {
    // The caller's own rights are fixed here: nothing can be granted to oneself.
    sendUntagged(session, `LISTRIGHTS ${folder.shown} ${quote(identifier)} ${imapRights(folder.access)}`);
  } else if (canAdministerFolder(folder.access)) {
    const owner = mailboxOwner(session, folder);
    const isOwner = owner !== null && owner.identifier.toLowerCase() === identifier.toLowerCase();
    sendUntagged(session, isOwner
      ? `LISTRIGHTS ${folder.shown} ${quote(identifier)} ${OWNER_RIGHTS}`
      : `LISTRIGHTS ${folder.shown} ${quote(identifier)} "" ${OPTIONAL_RIGHTS.join(' ')}`);
  } else {
    sendNo(session, tag, NOPERM);
    return;
  }
  sendOk(session, tag, 'LISTRIGHTS completed');
}

/** The grantee key of an identifier, or a refusal text. */
async function granteeOf(session: ImapSession, folder: AclFolder, identifier: string): Promise<{ key: string } | { refusal: string }> {
  const id = identifier.toLowerCase();
  if (id.startsWith('-')) return { refusal: '[CANNOT] Negative rights are not supported' };
  if (id === 'anonymous') return { refusal: '[CANNOT] Anonymous users get no rights on mail folders' };
  if (id === ANYONE) return { key: DEFAULT_GRANTEE_KEY };
  const owner = mailboxOwner(session, folder);
  if (owner && owner.identifier.toLowerCase() === id) return { refusal: '[CANNOT] The mailbox owner always has every right' };
  const user = await prisma.user.findFirst({ where: { email: id }, select: { id: true } });
  return user ? { key: userGranteeKey(user.id) } : { refusal: '[CANNOT] Unknown identifier' };
}

export async function handleSetAcl(session: ImapSession, tag: string, args: string[], command: 'SETACL' | 'DELETEACL'): Promise<void> {
  const expected = command === 'SETACL' ? 3 : 2;
  if (args.length !== expected || !args[1]) {
    sendBad(session, tag, command === 'SETACL' ? 'SETACL requires mailbox, identifier and rights' : 'DELETEACL requires mailbox and identifier');
    return;
  }
  // The permission to administer is re-read without the cache.
  const folder = await findFolder(session, args[0]!, true);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  if (!canAdministerFolder(folder.access)) { sendNo(session, tag, NOPERM); return; }
  const grantee = await granteeOf(session, folder, args[1]);
  if ('refusal' in grantee) { sendNo(session, tag, grantee.refusal); return; }

  let input: FolderPermissionInput;
  if (command === 'DELETEACL') {
    input = { granteeKey: grantee.key, remove: true };
  } else {
    const view = await describeFolderPermissions(db(), { id: folder.id, mailboxId: folder.mailboxId });
    const current = view.entries.find((e) => e.granteeKey === grantee.key);
    const rights = applyImapRights(current?.rights ?? 0, args[2] ?? '');
    if (rights === null) { sendBad(session, tag, 'SETACL: unknown right'); return; }
    input = { granteeKey: grantee.key, rights, applyToSubfolders: current?.applyToSubfolders ?? false };
  }
  try {
    const changes = await setFolderPermissions(db(), {
      folder: { id: folder.id, mailboxId: folder.mailboxId, name: folder.name },
      mailboxOwnerId: mailboxOwner(session, folder)?.id ?? null,
      inputs: [input],
      replace: false,
      actor: { userId: session.userId ?? '', ...(session.userEmail ? { email: session.userEmail } : {}), source: 'imap' },
      authorize: subfolderAuthorizer(
        await prisma.folder.findMany({ where: { mailboxId: folder.mailboxId }, select: { id: true, name: true, parentId: true } }),
        folder.id, folder.target.folders,
      ),
    });
    await publishFolderPermissionChange(changes, session.userId ?? '');
    log.info({ id: session.id, folderId: folder.id, grantee: granteeUserId(grantee.key) ?? grantee.key, changes: changes.length }, `IMAP ${command}`);
  } catch (err) {
    if (err instanceof FolderPermissionError) { sendNo(session, tag, `[CANNOT] ${err.message}`); return; }
    throw err;
  }
  sendOk(session, tag, `${command} completed`);
}
