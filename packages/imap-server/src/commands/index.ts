import {
  prisma, createMessage, copyMessages, moveMessages, modifyFlags, expunge, verifyMailCredentials, isMailboxWriteBlocked, OVER_QUOTA_MESSAGE,
  parseRawMessage, storeRawMessage, truncateBodyColumn, parseMimeTree, headerBytes, bodyBytes,
  attachmentKey, uploadBuffer, loadThreadReferences, deleteFolderMovingMail, announceFolderListChange,
  type RawSourceMessage,
} from '@coremail/storage';
import { type Chunk, flagList, isValidFlag, literal, joinChunks, toBuffer } from '../fetch/imap-string.js';
import { parseFetchItems, sectionLabel, FetchParseError, type FetchItem } from '../fetch/fetch-items.js';
import {
  extractSection, applyPartial, renderBodyStructure, renderEnvelope, envelopeFromHeaders, envelopeFromDb,
} from '../fetch/render.js';
import { binarySection, binaryLiteral, UnknownCteError } from '../fetch/binary.js';
import { getRaw, type CachedRaw } from '../fetch/raw-cache.js';
import { createLogger } from '@coremail/core';
import {
  type ImapSession,
  sendOk, sendNo, sendBad, sendUntagged, send, refreshCapabilities,
} from '../session/state.js';
import {
  createView, loadViewRows, seqOf, lastUid, resolveSet, isValidSequenceSet, markReported, reportExpunged,
  syncView, completeWithUpdates, withUpdateLock,
} from '../session/view.js';
import { ImapParseError, type Token } from '../server/tokenizer.js';
import { registerLiveSession, imapLiveSessions, IMAP_DISABLED } from '../session/live.js';
import { maxConnsPerUser, maxSortMessages } from '../server/limits.js';
import { queueIdleSync } from '../server/idle-push.js';
import {
  parseSearch, needsBody, needsRawHeaders, hasModseq, evaluateSearch, formatEsearch, toSequenceSet,
  type SearchProgram, type SearchableMessage, type ReturnOption, type SearchKey,
} from './search-parser.js';
import {
  parseSortCriteria, parseCharset, sortMessages, threadOrderedSubject, threadReferences, formatThreads,
  type SortCriterion, type SortMessage,
} from './sort-thread.js';
import { displayName, displayNames, formatName, fromClient, toClient } from './mailbox-name.js';
import {
  NOPERM, clientNameOf, findTargetFolder, namespaceResponse, reservedNamePerm, resolveMailbox, revalidateSelected, selectedWritable,
} from './namespaces.js';
import { runStatus } from './list.js';
import { auditImapAccess, selectedAccess } from './access-audit.js';
import {
  parseSelectParams, selectCandidates, sendVanishedEarlier, vanishedUids, type SelectParams,
} from './qresync.js';
import { MAX_UID, clampRanges, parseUidRanges, rangesOf } from '../session/uid-set.js';

export { handleList, handleLsub, handleGetQuotaRoot, handleGetQuota, handleSetQuota } from './list.js';
export { handleMyRights, handleGetAcl, handleListRights, handleSetAcl } from './acl.js';

const log = createLogger('imap:commands');

const DELIMITER = '.';

// ─────────────────────────────────────────────
// CAPABILITY
// ─────────────────────────────────────────────
export async function handleCapability(
  session: ImapSession,
  tag: string,
): Promise<void> {
  sendUntagged(session, `CAPABILITY ${session.capabilities.join(' ')}`);
  sendOk(session, tag, 'CAPABILITY completed');
}

// ─────────────────────────────────────────────
// LOGIN (the dispatcher only calls this in the not-authenticated state)
// ─────────────────────────────────────────────
export async function handleLogin(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  // Arguments arrive already decoded by the tokenizer (atom, quoted string
  // with \" and \\ escapes resolved, or literal).
  if (args.length !== 2) {
    sendBad(session, tag, 'LOGIN requires username and password');
    return;
  }
  const username = args[0] ?? '';
  const password = args[1] ?? '';

  // v7: LOGINDISABLED on plaintext — no cleartext passwords (RFC 9051 §6.2.3).
  if (!session.isTls) {
    sendNo(session, tag, PRIVACY_REQUIRED);
    return;
  }

  await loginUser(session, tag, username, password, 'LOGIN');
}

const PRIVACY_REQUIRED = '[PRIVACYREQUIRED] Authentication requires TLS — use STARTTLS or port 993';

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────
export async function handleLogout(session: ImapSession, tag: string): Promise<void> {
  sendUntagged(session, 'BYE IMAP4rev1 Server logging out');
  sendOk(session, tag, 'LOGOUT completed');
  session.state = 'LOGOUT';
  session.socket.end();
}

// ─────────────────────────────────────────────
// SUBSCRIBE / UNSUBSCRIBE — RFC 3501 §6.3.6/6.3.7
// ─────────────────────────────────────────────
// Both are accepted as no-ops (every mailbox counts as subscribed). Mac Mail
// often calls SUBSCRIBE on its own after LIST.
export async function handleSubscribe(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  if (!args[0]) { sendNo(session, tag, 'Folder name required'); return; }
  const folder = await findTargetFolder(session, args[0]);
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendOk(session, tag, 'SUBSCRIBE completed');
}

export async function handleUnsubscribe(
  session: ImapSession,
  tag: string,
  _args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  // Unsubscribe is a no-op — on the next LSUB everything is subscribed again.
  sendOk(session, tag, 'UNSUBSCRIBE completed');
}

// ─────────────────────────────────────────────
// NAMESPACE — RFC 2342
// ─────────────────────────────────────────────
// Personal namespace with "." as hierarchy delimiter; v9.1: "Other Users/" (delegated
// mailboxes) and "Shared/" (Shared Mailboxes) with "/" — see namespaces.ts.
export function handleNamespace(session: ImapSession, tag: string): void {
  sendUntagged(session, namespaceResponse());
  sendOk(session, tag, 'NAMESPACE completed');
}

// ─────────────────────────────────────────────
// STATUS — RFC 9051 §6.3.11 (implementation in list.ts, shared with LIST-STATUS)
// ─────────────────────────────────────────────
export async function handleStatus(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (await runStatus(session, tag, args)) await completeWithUpdates(session, tag, 'STATUS completed');
}

// ─────────────────────────────────────────────
// CREATE — RFC 9051 §6.3.4
// ─────────────────────────────────────────────
export async function handleCreate(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  // A trailing hierarchy delimiter only declares the intent to create inferiors
  // (Mac Mail sometimes sends "Parent.Child.").
  const rawName = (args[0] ?? '').replace(/[./]+$/, '');
  if (!fromClient(session, rawName)) { sendBad(session, tag, 'Folder name required'); return; }
  // v9.1: names in the Shared / Other Users namespaces create folders in that
  // mailbox (FULL_ACCESS only); an inaccessible or read-only one is NOPERM alike.
  const resolved = await resolveMailbox(session, rawName, true);
  if (!resolved.ok) { sendNo(session, tag, reservedNamePerm(session, rawName)); return; }
  if (!resolved.target.writable) { sendNo(session, tag, NOPERM); return; }
  const { target } = resolved;
  const name = target.folderName;
  if (name === 'INBOX') {
    sendNo(session, tag, '[ALREADYEXISTS] INBOX cannot be created');
    return;
  }
  // A legacy (modified UTF-7) row of the same mailbox name counts as existing.
  const existing = await prisma.folder.findFirst({
    where: { mailboxId: target.mailboxId, name: target.storedName },
    select: { id: true },
  });
  if (existing) {
    sendNo(session, tag, '[ALREADYEXISTS] Mailbox already exists');
    return;
  }
  await prisma.folder.create({
    data: { mailboxId: target.mailboxId, name, displayName: name },
  });
  announceFolderListChange(target.mailboxId);
  log.info({ mailboxId: target.mailboxId, name, foreign: target.foreign?.kind }, 'IMAP folder created');
  auditImapAccess(session, target.foreign, 'mailbox.foreign.folder.create', { folder: name });
  sendOk(session, tag, 'CREATE completed');
}

// ─────────────────────────────────────────────
// DELETE — RFC 9051 §6.3.5
// ─────────────────────────────────────────────
export async function handleDeleteFolder(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  if (!args[0]) { sendBad(session, tag, 'Folder name required'); return; }
  const resolved = await resolveMailbox(session, args[0], true);
  if (resolved.ok && resolved.target.folderName === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be deleted');
    return;
  }
  const folder = await findTargetFolder(session, args[0]); // the access list was just re-read
  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }
  if (!folder.target.writable) { sendNo(session, tag, NOPERM); return; }
  // Same path as the webmail: the messages go to the mailbox Trash through the
  // message store (new UID + modSeq, recoverable; expunged first when the folder is
  // below Trash) — the Message→Folder cascade would remove them for good. Only this
  // name is deleted: inferior names stay, and folders linked to it by parentId
  // (created in the webmail) move up to its parent instead of being orphaned.
  const done = await deleteFolderMovingMail(prisma, { id: folder.id, mailboxId: folder.mailboxId }, 'reparent');
  if (!done.ok) {
    if (done.reason === 'not-found') sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    else sendNo(session, tag, '[CANNOT] Mailbox still holds messages and there is no Trash to move them to');
    return;
  }
  log.info({ mailboxId: folder.mailboxId, folderId: folder.id, movedToTrash: done.moved, reparented: done.reparented }, 'IMAP folder deleted');
  auditImapAccess(session, folder.target.foreign, 'mailbox.foreign.folder.delete', { folder: folder.target.folderName, movedToTrash: done.moved });
  sendOk(session, tag, 'DELETE completed');
}

// ─────────────────────────────────────────────
// RENAME — RFC 9051 §6.3.6 (inferior mailboxes are renamed too)
// ─────────────────────────────────────────────
export async function handleRename(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  if (args.length !== 2 || !args[0] || !args[1]) { sendBad(session, tag, 'Old + new folder name required'); return; }
  // v9.1: both names must lie in the same mailbox (own, or a foreign one with FULL_ACCESS).
  const from = await resolveMailbox(session, args[0], true);
  const to = await resolveMailbox(session, args[1]);
  if (!from.ok) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  if (!from.target.writable) { sendNo(session, tag, NOPERM); return; }
  if (!to.ok) { sendNo(session, tag, reservedNamePerm(session, args[1])); return; }
  if (!to.target.writable) { sendNo(session, tag, NOPERM); return; }
  if (to.target.mailboxId !== from.target.mailboxId) {
    sendNo(session, tag, '[CANNOT] A mailbox cannot be renamed into another account');
    return;
  }
  const mailboxId = from.target.mailboxId;
  const oldName = from.target.folderName;
  const newName = to.target.folderName;
  if (oldName === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be renamed');
    return;
  }
  const folders = await prisma.folder.findMany({
    where: { mailboxId },
    select: { id: true, name: true },
  });
  // Hierarchy works on display names: inferiors of a legacy (modified UTF-7)
  // folder may be stored either way. Renamed rows are written in UTF-8.
  const display = displayNames(folders.map((f) => f.name));
  const shown = (f: { name: string }): string => display.get(f.name) ?? f.name;
  const folder = folders.find((f) => shown(f) === oldName);
  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }
  if (newName === oldName || newName.startsWith(`${oldName}${DELIMITER}`)) {
    sendNo(session, tag, '[CANNOT] A mailbox cannot be renamed into itself');
    return;
  }
  const renames = [folder, ...folders.filter((f) => shown(f).startsWith(`${oldName}${DELIMITER}`))]
    .map((f) => ({ id: f.id, name: `${newName}${shown(f).slice(oldName.length)}` }));
  const taken = new Set(folders.flatMap((f) => [f.name, shown(f)]));
  if (newName === 'INBOX' || renames.some((r) => taken.has(r.name))) {
    sendNo(session, tag, '[ALREADYEXISTS] Target folder exists');
    return;
  }
  await prisma.$transaction(async (tx) => {
    for (const r of renames) {
      await tx.folder.update({ where: { id: r.id }, data: { name: r.name, displayName: r.name } });
    }
    announceFolderListChange(mailboxId);
  });
  const selected = session.selected;
  const renamedSelected = selected ? renames.find((r) => r.id === selected.folderId) : undefined;
  if (selected && renamedSelected) {
    selected.folderName = renamedSelected.name;
    selected.clientName = clientNameOf(from.target, renamedSelected.name);
  }
  auditImapAccess(session, from.target.foreign, 'mailbox.foreign.folder.update', { from: oldName, to: newName });
  sendOk(session, tag, 'RENAME completed');
}

// ─────────────────────────────────────────────
// APPEND — RFC 9051 §6.3.12
// ─────────────────────────────────────────────
/** True when the APPEND target mailbox exists (checked before reading the literal). */
export async function appendTargetExists(session: ImapSession, name: string): Promise<boolean> {
  return (await appendTargetCheck(session, name)) === null;
}

/**
 * v9.1: APPEND target check before the literal is read — null when the message
 * may be appended, else the response text (missing mailbox / no write permission).
 */
export async function appendTargetCheck(session: ImapSession, name: string): Promise<string | null> {
  if (!session.mailboxId) return '[TRYCREATE] Mailbox does not exist';
  const folder = await findTargetFolder(session, name, true);
  if (!folder) return '[TRYCREATE] Mailbox does not exist';
  if (!folder.target.writable) return NOPERM;
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 9051 §9 date-time: "dd-Mon-yyyy hh:mm:ss +zzzz" (day may be space-padded). */
export function parseDateTime(value: string): Date | null {
  const m = /^ ?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === (m[2] as string).toLowerCase());
  const [day, year, hh, mm, ss, zh, zm] = [m[1], m[3], m[4], m[5], m[6], m[8], m[9]].map(Number) as number[];
  if (month < 0 || day! < 1 || day! > 31 || hh! > 23 || mm! > 59 || ss! > 60 || zm! > 59) return null;
  const offset = (m[7] === '-' ? -1 : 1) * (zh! * 60 + zm!);
  const date = new Date(Date.UTC(year!, month, day!, hh!, mm!, ss!) - offset * 60_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];

/**
 * Normalises a flag sent by a client (RFC 9051 §2.3.2): system flags are
 * case-insensitive; \Recent and unknown "\" flags cannot be set by a client.
 * Returns null for a flag that must be rejected.
 */
export function normalizeFlag(flag: string): string | null {
  if (flag.startsWith('\\')) {
    return SYSTEM_FLAGS.find((f) => f.toLowerCase() === flag.toLowerCase()) ?? null;
  }
  return isValidFlag(flag) ? flag : null;
}

/** Case-insensitive union / difference that keeps the existing spelling. */
function hasFlag(list: string[], flag: string): boolean {
  return list.some((f) => f.toLowerCase() === flag.toLowerCase());
}

function uniqueFlags(list: string[]): string[] {
  const out: string[] = [];
  for (const f of list) if (!hasFlag(out, f)) out.push(f);
  return out;
}

// The command reader delivers the literal as raw octets (`message`); the
// existence of the mailbox is already checked before the continuation request
// is sent (see server/index.ts), and again here.
export async function handleAppend(
  session: ImapSession,
  tag: string,
  args: string[],
  message?: Buffer,
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  if (args.length < 2 || args.length > 4) { sendBad(session, tag, 'APPEND requires mailbox and message literal'); return; }
  const raw = message ?? Buffer.from(args[args.length - 1] ?? '', 'utf8');
  // Optional flag list and date-time between mailbox and message. Invalid
  // flags and \Recent are dropped (a client cannot set them).
  let flags: string[] = [];
  let internalDate: Date | null = null;
  for (const a of args.slice(1, -1)) {
    const m = /^\((.*)\)$/s.exec(a);
    if (m) {
      flags = uniqueFlags((m[1] ?? '').split(/\s+/).filter(Boolean)
        .map(normalizeFlag).filter((f): f is string => f !== null));
      continue;
    }
    internalDate = parseDateTime(a);
    if (!internalDate) { sendBad(session, tag, 'Invalid APPEND date-time'); return; }
  }
  // v9.1: the target may be a foreign mailbox — permission re-read without the cache.
  const folder = await findTargetFolder(session, args[0] ?? '', true);
  if (!folder) {
    sendNo(session, tag, '[TRYCREATE] Mailbox does not exist');
    return;
  }
  if (!folder.target.writable) { sendNo(session, tag, NOPERM); return; }
  // v8.1 hard quota (of the target mailbox) (ProhibitSendReceiveQuota): RFC 9208 §4.3 / RFC 5530 [OVERQUOTA].
  if (await isMailboxWriteBlocked(folder.mailboxId)) {
    sendNo(session, tag, `[OVERQUOTA] ${OVER_QUOTA_MESSAGE}`);
    return;
  }

  // The appended literal IS the message: store it unchanged (raw-always storage);
  // the columns are only metadata for search, lists and the web preview.
  const parsed = await parseRawMessage(raw);
  const { storagePath } = await storeRawMessage(raw);
  // A plain single-part text body is kept as written (line endings included).
  const tree = parseMimeTree(raw);
  const plainBody = tree.type === 'text' && tree.subtype === 'plain' && ['7BIT', '8BIT'].includes(tree.encoding)
    ? bodyBytes(raw, tree).toString('utf8')
    : parsed.bodyText;

  // UID + modSeq are allocated atomically by the message store.
  const created = await prisma.$transaction((tx) => createMessage(tx, folder.mailboxId, folder.id, {
      subject:   parsed.subject,
      fromAddr:  parsed.fromAddr,
      fromName:  parsed.fromName,
      toAddrs:   parsed.toAddrs,
      ccAddrs:   parsed.ccAddrs,
      bccAddrs:  parsed.bccAddrs,
      replyTo:   parsed.replyTo,
      inReplyTo: parsed.inReplyTo,
      date:      parsed.date,
      rawSize:   raw.length,
      storagePath,
      bodyText:  truncateBodyColumn(plainBody),
      bodyHtml:  truncateBodyColumn(parsed.bodyHtml),
      flags,
      messageId: parsed.messageId,
      // RFC 9051 §6.3.12: the date-time argument sets the internal date.
      ...(internalDate ? { createdAt: internalDate } : {}),
  }));
  const newUid = created.uid;

  // Attachment rows (web client list/download); objects are stored per index.
  for (const [index, att] of parsed.attachments.entries()) {
    try {
      const key = attachmentKey(created.id, `${index}-${att.sha256.slice(0, 16)}`);
      await uploadBuffer(key, att.buffer, att.mimeType);
      await prisma.attachment.create({
        data: {
          messageId: created.id, contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
          size: att.size, sha256: att.sha256, storagePath: key, inline: att.inline,
        },
      });
    } catch (err) {
      log.warn({ err, messageId: created.id }, 'IMAP APPEND: attachment row not stored');
    }
  }

  log.info({ folderId: folder.id, uid: newUid }, 'IMAP APPEND stored message');
  // RFC 9051 §6.3.12: appending to the selected mailbox is announced with EXISTS.
  await completeWithUpdates(session, tag, `[APPENDUID ${folder.mailbox.uidValidity} ${newUid}] APPEND completed`);
}

// ─────────────────────────────────────────────
// Message rows of the selected mailbox
// ─────────────────────────────────────────────
const IN_LIST_LIMIT = 1000;

/** v9.1: the mailbox the selected folder belongs to (own, shared or delegated). */
function selectedMailboxId(session: ImapSession, view: NonNullable<ImapSession['selected']>): string {
  return view.mailboxId ?? session.mailboxId!;
}

/**
 * Database rows of the given UIDs in the selected folder (ascending). UIDs of
 * the view that were expunged elsewhere have no row ("ghosts") and are skipped.
 */
async function loadMessages(folderId: string, uids: number[], withAttachments: boolean) {
  if (uids.length === 0) return [];
  const where = uids.length <= IN_LIST_LIMIT
    ? { folderId, deletedAt: null, uid: { in: uids } }
    : { folderId, deletedAt: null };
  const rows = await prisma.message.findMany({
    where,
    orderBy: { uid: 'asc' },
    include: {
      attachments: withAttachments
        ? { select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true } }
        : false,
    },
  });
  const wanted = new Set(uids);
  return rows.filter((r) => wanted.has(r.uid));
}

// ─────────────────────────────────────────────
// COPY — RFC 9051 §6.4.7, RFC 4315 COPYUID
// ─────────────────────────────────────────────
export async function handleCopy(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  const view = session.selected;
  if (!view) { sendNo(session, tag, 'No mailbox selected'); return; }
  const seqSet = args[0] ?? '';
  if (args.length !== 2 || !args[1]) { sendBad(session, tag, 'COPY: seq + target required'); return; }
  if (!isValidSequenceSet(seqSet)) { sendBad(session, tag, 'Invalid sequence set'); return; }

  // v9.1: the target may be a foreign mailbox (permission re-read without the cache).
  const target = await findTargetFolder(session, args[1], true);
  if (!target) { sendNo(session, tag, '[TRYCREATE] Target mailbox does not exist'); return; }
  if (!target.target.writable) { sendNo(session, tag, NOPERM); return; }

  const sourceMsgs = await loadMessages(view.folderId, resolveSet(view, seqSet, byUid), false);
  if (sourceMsgs.length === 0) {
    await completeWithUpdates(session, tag, 'COPY completed (no messages matched)');
    return;
  }
  // A copy adds its size to the mailbox: refused over the hard quota (RFC 9208 §4.3).
  if (await isMailboxWriteBlocked(target.mailboxId)) {
    sendNo(session, tag, `[OVERQUOTA] ${OVER_QUOTA_MESSAGE}`);
    return;
  }
  // Fresh UIDs + one modSeq in the target, reserved atomically (never a stale uidNext).
  const { mapping } = await prisma.$transaction((tx) => copyMessages(
    tx, sourceMsgs.map((m) => m.id), target.id, { targetMailboxId: target.mailboxId },
  ));

  const copyUid = `[COPYUID ${target.mailbox.uidValidity} ${mapping.map((m) => m.oldUid).join(',')} ${mapping.map((m) => m.newUid).join(',')}]`;
  await completeWithUpdates(session, tag, `${copyUid} COPY completed`);
}

const RECOVERABLE_PREFIX = 'Recoverable Items';

/** Pure: does a MOVE add to the counted usage of the target mailbox? */
export function movesIntoUsage(sourceFolder: string, targetFolder: string, sourceMailboxId: string, targetMailboxId: string): boolean {
  if (sourceMailboxId !== targetMailboxId) return true;
  return sourceFolder.startsWith(RECOVERABLE_PREFIX) && !targetFolder.startsWith(RECOVERABLE_PREFIX);
}
// ─────────────────────────────────────────────
// MOVE — RFC 6851 (atomic COPY + EXPUNGE)
// ─────────────────────────────────────────────
export async function handleMove(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  const view = session.selected;
  if (!view) { sendNo(session, tag, 'No mailbox selected'); return; }
  const seqSet = args[0] ?? '';
  if (args.length !== 2 || !args[1]) { sendBad(session, tag, 'MOVE: seq + target required'); return; }
  if (!isValidSequenceSet(seqSet)) { sendBad(session, tag, 'Invalid sequence set'); return; }
  // v9.1: moving out of a mailbox needs the "t"/"e" rights (read-only permission → NOPERM).
  if (view.noWrite) { sendNo(session, tag, NOPERM); return; }
  // RFC 9051 §6.3.3: no permanent changes in a mailbox opened with EXAMINE.
  if (view.readOnly) { sendNo(session, tag, '[READ-ONLY] Mailbox is read-only'); return; }
  if (!(await selectedWritable(session))) { sendNo(session, tag, NOPERM); return; }

  const target = await findTargetFolder(session, args[1], true);
  if (!target) { sendNo(session, tag, '[TRYCREATE] Target mailbox does not exist'); return; }
  if (!target.target.writable) { sendNo(session, tag, NOPERM); return; }
  const sourceMailboxId = selectedMailboxId(session, view);

  const matched = await loadMessages(view.folderId, resolveSet(view, seqSet, byUid), false);
  if (matched.length === 0) {
    await completeWithUpdates(session, tag, 'MOVE completed (no messages matched)');
    return;
  }
  // A move inside the mailbox does not change its usage — never blocked — except
  // out of "Recoverable Items" (not counted) or into another mailbox.
  if (movesIntoUsage(view.folderName, target.name, sourceMailboxId, target.mailboxId)
    && await isMailboxWriteBlocked(target.mailboxId)) {
    sendNo(session, tag, `[OVERQUOTA] ${OVER_QUOTA_MESSAGE}`);
    return;
  }
  // RFC 6851 §4.3: the moved messages get new UIDs in the target mailbox and a new
  // modSeq; the rows keep their id.
  const { mapping } = await prisma.$transaction((tx) => moveMessages(
    tx, matched.map((m) => m.id), target.id,
    { targetMailboxId: target.mailboxId, sourceMailboxId },
  ));
  if (mapping.length > 0) {
    sendUntagged(session, `OK [COPYUID ${target.mailbox.uidValidity} ${mapping.map((m) => m.oldUid).join(',')} ${mapping.map((m) => m.newUid).join(',')}] Moved`);
  }
  // 9.4: moving out of a foreign folder (also into the own mailbox) is audited.
  auditImapAccess(session, selectedAccess(session) ?? target.target.foreign, 'mailbox.foreign.message.move', {
    count: mapping.length, from: view.folderName, to: target.target.folderName,
  });
  // RFC 6851 §3.3: EXPUNGE responses for the moved messages. Nothing to expunge
  // when moving into the same folder.
  reportExpunged(session, view, new Set(mapping.map((m) => m.oldUid)));
  await completeWithUpdates(session, tag, 'MOVE completed', true, true);
}

// ─────────────────────────────────────────────
// SEARCH — RFC 9051 §6.4.4, ESEARCH (RFC 4731), SEARCHRES (RFC 5182),
// CONDSTORE MODSEQ (RFC 7162 §3.1.5)
// ─────────────────────────────────────────────
// The search program is parsed into an AST (search-parser.ts) and evaluated in
// memory against the messages of the session's view (sequence numbers come
// from the view, never from the database order). Bodies are loaded only for
// BODY/TEXT, raw headers only for HEADER fields without their own column.
export async function handleSearch(
  session: ImapSession,
  tag: string,
  tokens: Token[],
  byUid = false,
): Promise<void> {
  const view = session.selected;
  if (!view) { sendNo(session, tag, 'No mailbox selected'); return; }

  let program: SearchProgram;
  try {
    program = parseSearch(tokens);
  } catch (err) {
    // RFC 5182 §2.1: a failed SEARCH ... RETURN (SAVE) leaves "$" empty.
    if (tokens.some((t) => t.type === 'list' && t.items.some((i) => i.type === 'atom' && i.value.toUpperCase() === 'SAVE'))) {
      view.searchRes = [];
    }
    sendBad(session, tag, err instanceof ImapParseError ? err.message : 'Invalid search program');
    return;
  }
  const saving = program.returnOptions?.includes('SAVE') ?? false;
  if (program.charset && program.charset !== 'UTF-8' && program.charset !== 'US-ASCII') {
    if (saving) view.searchRes = [];
    sendNo(session, tag, '[BADCHARSET (UTF-8 US-ASCII)] Unsupported charset');
    return;
  }
  const withModseq = hasModseq(program.key);
  // RFC 7162 §3.1: SEARCH MODSEQ is a CONDSTORE-enabling command.
  if (withModseq) session.condstoreEnabled = true;

  const matched = await matchSearch(session, tag, view, program.key);
  if (matched === null) return;
  const results = matched.map((m) => (byUid ? m.uid : m.seq));

  // IMAP4rev2: SEARCH without RETURN is answered with ESEARCH (RETURN (ALL)).
  const options: ReturnOption[] | null = program.returnOptions ?? (session.imap4rev2Enabled ? ['ALL'] : null);
  const reported = options === null ? [] : options.filter((o) => o !== 'SAVE');
  // Messages whose values are returned (MIN/MAX only → just those two).
  const minMaxOnly = reported.length > 0 && !reported.includes('ALL') && !reported.includes('COUNT');
  const returned = minMaxOnly && matched.length > 0
    ? [
      ...(reported.includes('MIN') ? [matched[0]!] : []),
      ...(reported.includes('MAX') ? [matched[matched.length - 1]!] : []),
    ]
    : matched;
  if (saving) {
    // RFC 5182 §2.4: with MIN/MAX only, just those messages are saved.
    view.searchRes = (minMaxOnly ? returned : matched).map((m) => m.uid);
  }
  const modseq = withModseq ? maxModSeq(returned) : null;

  if (options === null) {
    const tail = modseq !== null ? ` (MODSEQ ${modseq})` : '';
    sendUntagged(session, `SEARCH${results.length ? ' ' + results.join(' ') : ''}${tail}`);
  } else if (reported.length > 0) {
    sendUntagged(session, `ESEARCH ${formatEsearch(tag, byUid, results, reported, modseq)}`);
  }
  // RFC 5182 §2.4: RETURN (SAVE) alone produces no ESEARCH response.
  await completeWithUpdates(session, tag, `${byUid ? 'UID SEARCH' : 'SEARCH'} completed`, byUid);
}

/** Highest modSeq of a result (null when empty) — RFC 7162 §3.1.5/§3.1.6. */
function maxModSeq(rows: Array<{ modSeq: bigint }>): bigint | null {
  return rows.length > 0 ? rows.reduce((max, m) => (m.modSeq > max ? m.modSeq : max), 0n) : null;
}

type MatchedRow = SearchableMessage & { id: string; uid: number; seq: number; modSeq: bigint };

/**
 * Evaluates a search key against the messages of the session's view
 * (ascending UID order). Returns null when an error response was sent.
 */
async function matchSearch(
  session: ImapSession, tag: string, view: NonNullable<ImapSession['selected']>, key: SearchKey,
): Promise<MatchedRow[] | null> {
  const withBody = needsBody(key);
  const withHeaders = needsRawHeaders(key);
  const rows = withHeaders
    ? await loadMessages(view.folderId, view.uids, true)
    : await prisma.message.findMany({
      where: { folderId: view.folderId, deletedAt: null },
      select: {
        id: true, uid: true, modSeq: true, flags: true, subject: true, fromAddr: true, fromName: true,
        toAddrs: true, ccAddrs: true, bccAddrs: true, replyTo: true, messageId: true, inReplyTo: true,
        date: true, createdAt: true, rawSize: true,
        ...(withBody ? { bodyText: true, bodyHtml: true } : {}),
      },
      orderBy: { uid: 'asc' },
    });

  const maxSeq = view.uids.length;
  const maxUid = lastUid(view);
  const saved = new Set(view.searchRes);
  const matched: MatchedRow[] = [];
  for (const msg of rows) {
    const seq = seqOf(view, msg.uid);
    if (seq === 0) continue; // not announced to the client yet
    let headers: Array<{ name: string; value: string }> | undefined;
    if (withHeaders) {
      try {
        headers = (await getRaw(session, msg as unknown as RawSourceMessage)).tree().headers;
      } catch (err) {
        log.error({ err, uid: msg.uid }, 'IMAP SEARCH: raw message unavailable');
        sendNo(session, tag, '[UNAVAILABLE] Message content temporarily unavailable');
        return null;
      }
    }
    const ctx = { seq, maxSeq, maxUid, saved, ...(headers ? { headers } : {}) };
    if (evaluateSearch(key, msg as SearchableMessage, ctx)) {
      matched.push({ ...(msg as unknown as SearchableMessage & { id: string }), seq });
    }
  }
  return matched;
}

// ─────────────────────────────────────────────
// SORT / THREAD — RFC 5256 (UID variants, charsets UTF-8 and US-ASCII)
// ─────────────────────────────────────────────
// The search criteria are evaluated like SEARCH (column projection, bodies only
// for BODY/TEXT); sorting and threading run in memory on the matching rows.
// Mailboxes larger than IMAP_SORT_MAX_MESSAGES are refused with NO [LIMIT].

/** Parses "<charset> <criteria>" and evaluates the criteria; null when a response was sent. */
async function sortThreadMatches(
  session: ImapSession, tag: string, tokens: Token[], verb: string,
): Promise<{ rows: MatchedRow[]; withModseq: boolean } | null> {
  const view = session.selected!;
  let charset: string;
  let program: SearchProgram;
  try {
    charset = parseCharset(tokens[0]);
    if (tokens.length < 2) throw new ImapParseError(`${verb} requires search criteria`);
    program = parseSearch(tokens.slice(1));
    if (program.returnOptions !== null || program.charset !== null) throw new ImapParseError(`Invalid ${verb} criteria`);
  } catch (err) {
    sendBad(session, tag, err instanceof ImapParseError ? err.message : `Invalid ${verb} command`);
    return null;
  }
  if (charset !== 'UTF-8' && charset !== 'US-ASCII') {
    sendNo(session, tag, '[BADCHARSET (UTF-8 US-ASCII)] Unsupported charset');
    return null;
  }
  if (view.uids.length > maxSortMessages()) {
    sendNo(session, tag, `[LIMIT] ${verb} is limited to mailboxes with ${maxSortMessages()} messages`);
    return null;
  }
  if (hasModseq(program.key)) session.condstoreEnabled = true;
  const rows = await matchSearch(session, tag, view, program.key);
  if (rows === null) return null;
  return { rows, withModseq: hasModseq(program.key) };
}

export async function handleSort(session: ImapSession, tag: string, tokens: Token[], byUid: boolean): Promise<void> {
  let criteria: SortCriterion[];
  try {
    criteria = parseSortCriteria(tokens[0]);
  } catch (err) {
    sendBad(session, tag, err instanceof ImapParseError ? err.message : 'Invalid SORT command');
    return;
  }
  const found = await sortThreadMatches(session, tag, tokens.slice(1), 'SORT');
  if (found === null) return;
  const { rows } = found;
  const sorted = sortMessages(rows, criteria);
  // RFC 7162 §3.1.5: with a MODSEQ criterion the response carries the highest MODSEQ.
  const modseq = found.withModseq ? maxModSeq(rows) : null;
  const numbers = sorted.map((m) => (byUid ? m.uid : m.seq));
  sendUntagged(session, `SORT${numbers.length ? ' ' + numbers.join(' ') : ''}${modseq !== null ? ` (MODSEQ ${modseq})` : ''}`);
  // RFC 5256 §4: like SEARCH, non-UID SORT must not cause EXPUNGE responses.
  await completeWithUpdates(session, tag, `${byUid ? 'UID SORT' : 'SORT'} completed`, byUid);
}

export async function handleThread(session: ImapSession, tag: string, tokens: Token[], byUid: boolean): Promise<void> {
  const algorithm = tokens[0]?.type === 'atom' ? tokens[0].value.toUpperCase() : '';
  if (algorithm !== 'ORDEREDSUBJECT' && algorithm !== 'REFERENCES') {
    sendBad(session, tag, 'Unsupported THREAD algorithm (ORDEREDSUBJECT, REFERENCES)');
    return;
  }
  const found = await sortThreadMatches(session, tag, tokens.slice(1), 'THREAD');
  if (found === null) return;
  const { rows } = found;
  const idOf = (m: SortMessage): number => (byUid ? m.uid : m.seq);
  let threads;
  if (algorithm === 'REFERENCES') {
    // v9.1: the stored References chains (Message.references, lazily backfilled
    // for older rows) of the selected folder — own or foreign (session.selected).
    // The lazy step is capped (200 rows, REFERENCES_LAZY_BUDGET_MS, default 1500 ms)
    // and skips rows that failed recently; the rest is the background job's.
    const refs = await loadThreadReferences(session.selected!.folderId, rows.map((r) => r.id));
    const list = rows.map((r) => ({ ...r, references: refs.get(r.id) ?? null }));
    threads = threadReferences(list, idOf);
  } else {
    threads = threadOrderedSubject(rows, idOf);
  }
  const text = formatThreads(threads);
  sendUntagged(session, `THREAD${text ? ' ' + text : ''}`);
  await completeWithUpdates(session, tag, `${byUid ? 'UID THREAD' : 'THREAD'} completed`, byUid);
}

// ─────────────────────────────────────────────
// CLOSE — RFC 9051 §6.4.1 (deselect mailbox + silent EXPUNGE)
// ─────────────────────────────────────────────
export async function handleClose(
  session: ImapSession,
  tag: string,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  // Implicitly remove messages with the \Deleted flag (not for a mailbox
  // opened with EXAMINE). The expunge bumps the modSeq.
  const closing = session.selected;
  // v9.1: a foreign mailbox is only expunged with a current write permission.
  if (!closing.readOnly && !closing.noWrite && (!closing.foreign || await selectedWritable(session))) {
    const doomed = await prisma.message.findMany({
      where: {
        folderId:  closing.folderId,
        deletedAt: null,
        flags:     { has: '\\Deleted' },
      },
      select: { id: true },
    });
    if (doomed.length > 0) {
      const mailboxId = selectedMailboxId(session, closing);
      await prisma.$transaction((tx) => expunge(tx, doomed.map((m) => m.id), { mailboxId }));
      auditImapAccess(session, selectedAccess(session), 'mailbox.foreign.message.delete', { count: doomed.length, folder: closing.folderName, expunge: true });
    }
  }
  session.selected = null;
  session.state = 'AUTHENTICATED';
  sendOk(session, tag, 'CLOSE completed');
}

// ─────────────────────────────────────────────
// CHECK — RFC 3501 §6.4.1 (a NOOP that reports mailbox updates)
// ─────────────────────────────────────────────
export async function handleCheck(session: ImapSession, tag: string): Promise<void> {
  await completeWithUpdates(session, tag, 'CHECK completed');
}

// ─────────────────────────────────────────────
// UNSELECT — RFC 3691 / RFC 9051
// ─────────────────────────────────────────────
// Closes the currently selected folder WITHOUT performing EXPUNGE.
export function handleUnselect(session: ImapSession, tag: string): void {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  session.selected = null;
  session.state = 'AUTHENTICATED';
  sendOk(session, tag, 'UNSELECT completed');
}

// ─────────────────────────────────────────────
// ID — RFC 2971 (Client/Server Identification)
// ─────────────────────────────────────────────
export function handleId(session: ImapSession, tag: string, _args: string[]): void {
  sendUntagged(session, 'ID ("name" "CoreMail" "vendor" "MAGPEEK" "support-url" "https://github.com/MAGPEEK/CoreMail")');
  sendOk(session, tag, 'ID completed');
}

// ─────────────────────────────────────────────
// AUTHENTICATE — RFC 9051 §6.2.2 + RFC 4959 SASL-IR
// ─────────────────────────────────────────────
// Supported: PLAIN (RFC 4616), LOGIN (deprecated but widespread).
// XOAUTH2 (RFC 7628) is deliberately NOT implemented — mainstream clients offer
// no UI for custom OAuth servers; app passwords are the MFA path.

/** Strict base64 (RFC 4648 §4); null when the client sent something else. */
function decodeBase64(data: string): string | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
  return Buffer.from(data, 'base64').toString('utf8');
}

function resetSasl(session: ImapSession): void {
  session.saslMech = null;
  session.saslStep = 0;
  session.saslUser = '';
}

export async function handleAuthenticate(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  const mech = (args[0] ?? '').toUpperCase();
  const initialResponse = args[1];

  // v7: no AUTH= mechanisms are advertised before TLS — refuse before any
  // continuation so the client never sends credentials in cleartext.
  if (!session.isTls) {
    sendNo(session, tag, PRIVACY_REQUIRED);
    return;
  }

  // RFC 4959: "=" is an empty initial response.
  const initial = initialResponse === undefined ? null : initialResponse === '=' ? '' : decodeBase64(initialResponse);
  if (initialResponse !== undefined && initial === null) {
    sendBad(session, tag, 'Invalid base64 in initial response');
    return;
  }

  if (mech === 'PLAIN') {
    if (initial !== null) {
      await processPlainAuth(session, tag, initial);
      return;
    }
    // No SASL-IR → server sends an empty continuation and waits for the response
    session.saslMech = 'PLAIN';
    session.saslStep = 0;
    send(session, '+ ');
    return;
  }

  if (mech === 'LOGIN') {
    session.saslMech = 'LOGIN';
    if (initial !== null) {
      // Some clients send the user name as initial response
      session.saslStep = 1;
      session.saslUser = initial;
      send(session, '+ ' + Buffer.from('Password:').toString('base64'));
      return;
    }
    session.saslStep = 0;
    send(session, '+ ' + Buffer.from('Username:').toString('base64'));
    return;
  }

  sendNo(session, tag, `[CANNOT] Unsupported SASL mechanism. Use PLAIN, LOGIN, or LOGIN command`);
}

/**
 * Called by the dispatcher when session.saslMech is set,
 * i.e. we are waiting for the next continuation response.
 */
export async function handleSaslContinuation(
  session: ImapSession,
  tag: string,
  line: string,
): Promise<void> {
  const data = line.trim();
  // Client may abort with "*"
  if (data === '*') {
    resetSasl(session);
    sendBad(session, tag, 'Authentication cancelled');
    return;
  }
  // RFC 9051 §6.2.2: a response that is not valid base64 is answered with BAD.
  const decoded = decodeBase64(data);
  if (decoded === null) {
    resetSasl(session);
    sendBad(session, tag, 'Invalid base64 in SASL response');
    return;
  }

  if (session.saslMech === 'PLAIN') {
    resetSasl(session);
    await processPlainAuth(session, tag, decoded);
    return;
  }

  if (session.saslMech === 'LOGIN') {
    if (session.saslStep === 0) {
      session.saslUser = decoded;
      session.saslStep = 1;
      send(session, '+ ' + Buffer.from('Password:').toString('base64'));
      return;
    }
    const user = session.saslUser;
    resetSasl(session);
    await loginUser(session, tag, user, decoded);
    return;
  }

  // Fallback — no active mechanism
  sendBad(session, tag, 'Unexpected continuation');
}

async function processPlainAuth(session: ImapSession, tag: string, decoded: string): Promise<void> {
  // RFC 4616: [authzid] NUL authcid NUL passwd
  const parts = decoded.split('\0');
  if (parts.length !== 3) { sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid PLAIN format'); return; }
  const [authzid, user, password] = parts as [string, string, string];
  // No proxy authorization: an authorization identity must be the login itself.
  if (authzid !== '' && authzid.toLowerCase() !== user.toLowerCase()) {
    sendNo(session, tag, '[AUTHORIZATIONFAILED] Authorization identity not permitted');
    return;
  }
  await loginUser(session, tag, user, password);
}

/**
 * Login verification for LOGIN and AUTHENTICATE PLAIN/LOGIN.
 * v7: shared mail-protocol check (verifyMailCredentials) — login normalisation
 * (bare user name, DOMAIN\user), MFA → app passwords only, shared lockout,
 * database errors → NO [UNAVAILABLE] instead of "invalid credentials".
 */
async function loginUser(
  session: ImapSession,
  tag: string,
  username: string,
  password: string,
  command: 'LOGIN' | 'AUTHENTICATE' = 'AUTHENTICATE',
): Promise<void> {
  if (!session.isTls) { sendNo(session, tag, PRIVACY_REQUIRED); return; }
  const authStartedAt = Date.now();
  const result = await verifyMailCredentials(username, password, {
    ip: session.socket.remoteAddress,
    protocol: 'imap',
  });
  switch (result.status) {
    case 'ok':
      // v8.1: concurrent sessions per user (Exchange-style per-protocol cap).
      if (maxConnsPerUser() > 0 && imapLiveSessions.count(result.user.id) >= maxConnsPerUser()) {
        log.warn({ email: result.user.email, limit: maxConnsPerUser(), command, ip: session.socket.remoteAddress }, 'IMAP login refused — too many sessions for this user');
        sendNo(session, tag, '[LIMIT] Too many concurrent IMAP sessions for this account');
        return;
      }
      session.state = 'AUTHENTICATED';
      session.onAuthenticated?.();
      session.userId = result.user.id;
      session.userEmail = result.user.email;
      session.mailboxId = result.user.mailboxId;
      // v7.1.0: the connection ends when these credentials become invalid.
      registerLiveSession(session, result.method, result.appPasswordId, authStartedAt);
      refreshCapabilities(session);
      log.info({ email: result.user.email, method: result.method, command, ip: session.socket.remoteAddress }, 'IMAP login success');
      sendOk(session, tag, `[CAPABILITY ${session.capabilities.join(' ')}] ${command} completed`);
      return;
    case 'locked':
      sendNo(session, tag, '[UNAVAILABLE] Too many failed login attempts - try again later');
      return;
    case 'error':
      sendNo(session, tag, '[UNAVAILABLE] Temporary authentication failure - try again later');
      return;
    case 'protocol_disabled':
      // 9.4: credentials were correct, IMAP is switched off for the account.
      log.warn({ userId: result.userId, command, ip: session.socket.remoteAddress }, 'IMAP login refused — IMAP disabled for this account');
      sendNo(session, tag, IMAP_DISABLED);
      return;
    default:
      // invalid and mfa_app_password_required get the same text (no oracle).
      log.warn({ login: username, status: result.status, command, ip: session.socket.remoteAddress }, 'IMAP login failed');
      sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials (accounts with two-factor authentication need an app password)');
  }
}

// ─────────────────────────────────────────────
// SELECT / EXAMINE — RFC 9051 §6.3.2–3, RFC 7162 §3.1.8 (CONDSTORE parameter)
// ─────────────────────────────────────────────
export async function handleSelect(
  session: ImapSession,
  tag: string,
  args: string[],
  readOnly = false,
): Promise<void> {
  if (!session.mailboxId) {
    sendNo(session, tag, 'Not authenticated');
    return;
  }
  const verb = readOnly ? 'EXAMINE' : 'SELECT';
  if (args.length < 1 || args.length > 2 || !args[0]) { sendBad(session, tag, `${verb} requires a mailbox name`); return; }
  let params: SelectParams = { condstore: false, qresync: null };
  if (args[1] !== undefined) {
    try {
      params = parseSelectParams(args[1]);
    } catch (err) {
      sendBad(session, tag, err instanceof ImapParseError ? `${verb}: ${err.message}` : `Unknown ${verb} parameter`);
      return;
    }
    // RFC 7162 §3.2.5: the QRESYNC parameter needs a prior "ENABLE QRESYNC".
    if (params.qresync && !session.qresyncEnabled) {
      sendBad(session, tag, `${verb} QRESYNC requires ENABLE QRESYNC first`);
      return;
    }
  }
  const condstore = params.condstore;

  // RFC 9051 §6.3.2: the selected mailbox is closed first (no EXPUNGE); a
  // failed SELECT leaves the session in the authenticated state.
  // RFC 7162 §3.2.11: a server advertising QRESYNC reports the implicit close
  // with the CLOSED response code (also required by IMAP4rev2).
  if (session.selected) {
    session.selected = null;
    session.state = 'AUTHENTICATED';
    sendUntagged(session, 'OK [CLOSED] Previous mailbox closed');
  }

  // v9.1: foreign mailboxes (Shared / Other Users) — the permission is always re-read here.
  const folder = await findTargetFolder(session, args[0], true);
  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }
  if (condstore) session.condstoreEnabled = true;
  const { target } = folder;
  // Read-only permission → EXAMINE semantics even for SELECT (RFC 4314 §4, RFC 9051 §6.3.2).
  const noWrite = !target.writable;
  const effectiveReadOnly = readOnly || noWrite;

  const rows = await loadViewRows(folder.id);
  const view = createView({ id: folder.id, name: folder.name, uidValidity: folder.mailbox.uidValidity }, rows, effectiveReadOnly, {
    mailboxId: target.mailboxId,
    foreign: target.foreign ? { kind: target.foreign.kind, email: target.foreign.email } : null,
    clientName: target.foreign ? clientNameOf(target, displayName(folder.name)) : undefined,
    delimiter: target.delimiter,
    noWrite,
  });
  session.state = 'SELECTED';
  session.selected = view;
  // 9.4: opening a foreign mailbox (one entry per user, mailbox and hour)
  auditImapAccess(session, target.foreign, 'mailbox.foreign.open', { folder: target.folderName, readOnly: effectiveReadOnly });

  sendUntagged(session, `${view.uids.length} EXISTS`);
  if (session.imap4rev2Enabled) {
    // RFC 9051 §6.3.2: a LIST response with the mailbox name; no RECENT, no UNSEEN code.
    sendUntagged(session, view.clientName !== undefined
      ? `LIST () "${target.delimiter}" ${formatName(session, view.clientName)}`
      : `LIST () "${DELIMITER}" ${toClient(session, folder.name)}`);
  } else {
    sendUntagged(session, '0 RECENT');
    // RFC 3501 §7.1: [UNSEEN n] carries the sequence number of the first unseen message.
    const firstUnseen = rows.findIndex((r) => !hasFlag(r.flags, '\\Seen'));
    if (firstUnseen >= 0) sendUntagged(session, `OK [UNSEEN ${firstUnseen + 1}] First unseen message`);
  }
  sendUntagged(session, `OK [UIDVALIDITY ${folder.mailbox.uidValidity}] UIDs valid`);
  sendUntagged(session, `OK [UIDNEXT ${folder.mailbox.uidNext}] Predicted next UID`);
  sendUntagged(session, `OK [HIGHESTMODSEQ ${folder.mailbox.highestModSeq}] Highest`);
  sendUntagged(session, `FLAGS (${SYSTEM_FLAGS.join(' ')})`);
  sendUntagged(session, effectiveReadOnly
    ? 'OK [PERMANENTFLAGS ()] No permanent flags permitted'
    : `OK [PERMANENTFLAGS (${SYSTEM_FLAGS.join(' ')} \\*)] Flags permitted`);

  // RFC 7162 §3.2.5.1: QRESYNC resynchronisation — only when the client's
  // UIDVALIDITY still matches (otherwise its cache is void anyway).
  const q = params.qresync;
  if (q && q.uidValidity === folder.mailbox.uidValidity) {
    const candidates = selectCandidates(q, folder.mailbox.uidNext);
    // Explicit known UIDs are reported even when the expunge predates the modseq.
    sendVanishedEarlier(session, await vanishedUids(folder.id, candidates, q.knownUids === null ? q.modSeq : null));
    for (const [i, row] of rows.entries()) {
      if (row.modSeq <= q.modSeq) continue;
      sendUntagged(session, `${i + 1} FETCH (UID ${row.uid} FLAGS ${flagList(row.flags)} MODSEQ (${row.modSeq}))`);
    }
  }

  sendOk(session, tag, `${effectiveReadOnly ? '[READ-ONLY]' : '[READ-WRITE]'} ${verb} completed`);
}

// ─────────────────────────────────────────────
// FETCH — RFC 9051 §6.4.5. Message content is always served from the original
// raw message (object storage; legacy rows are reconstructed deterministically),
// so BODY[]/RFC822.SIZE/sections/BODYSTRUCTURE/BINARY are byte-exact and consistent.
// ─────────────────────────────────────────────
export async function handleFetch(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  const view = session.selected;
  if (!view) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const sequenceSet = args[0] ?? '';
  if (!isValidSequenceSet(sequenceSet)) {
    sendBad(session, tag, 'Invalid sequence set');
    return;
  }
  let items: FetchItem[];
  try {
    items = parseFetchItems(args[1] ?? '');
  } catch (err) {
    sendBad(session, tag, err instanceof FetchParseError ? err.message : 'Invalid FETCH data items');
    return;
  }
  // RFC 7162 §3.1.4: FETCH ... (CHANGEDSINCE <modseq>)
  // RFC 7162 §3.2.6: UID FETCH ... (CHANGEDSINCE <modseq> VANISHED)
  let changedSince: bigint | null = null;
  let withVanished = false;
  if (args.length > 3) { sendBad(session, tag, 'Too many FETCH arguments'); return; }
  if (args[2] !== undefined) {
    const mods = /^\((.*)\)$/s.exec(args[2]);
    const words = (mods?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
    for (let i = 0; mods && i < words.length; i++) {
      const word = words[i]!.toUpperCase();
      if (word === 'CHANGEDSINCE' && changedSince === null && /^\d{1,19}$/.test(words[i + 1] ?? '')) {
        changedSince = BigInt(words[++i]!);
      } else if (word === 'VANISHED' && !withVanished) {
        withVanished = true;
      } else {
        sendBad(session, tag, 'Unknown FETCH modifier');
        return;
      }
    }
    if (!mods || words.length === 0) { sendBad(session, tag, 'Unknown FETCH modifier'); return; }
    // VANISHED needs QRESYNC, a UID FETCH and CHANGEDSINCE.
    if (withVanished && (!session.qresyncEnabled || !byUid || changedSince === null)) {
      sendBad(session, tag, 'VANISHED requires UID FETCH with CHANGEDSINCE after ENABLE QRESYNC');
      return;
    }
  }
  if (withVanished && changedSince !== null) {
    const folder = await prisma.folder.findFirst({ where: { id: view.folderId }, include: { mailbox: true } });
    const top = Math.max(lastUid(view), (folder?.mailbox.uidNext ?? 1) - 1);
    // "$" (SEARCHRES) is a saved UID list; otherwise the UID set, "*" = highest UID ever assigned.
    const requested = sequenceSet === '$'
      ? rangesOf([...new Set(view.searchRes)].sort((a, b) => a - b))
      : parseUidRanges(sequenceSet, top) ?? [];
    const candidates = clampRanges(requested, 1, Math.min(top, MAX_UID));
    sendVanishedEarlier(session, await vanishedUids(view.folderId, candidates, changedSince));
  }

  const has = (k: string): boolean => items.some((i) => i.kind === k);
  // RFC 7162 §3.1: FETCH MODSEQ and FETCH CHANGEDSINCE enable CONDSTORE.
  if (has('MODSEQ') || changedSince !== null) session.condstoreEnabled = true;
  const contentItems = items.some((i) => i.kind === 'SECTION' || i.kind === 'BODYSTRUCTURE' || i.kind === 'BODY'
    || i.kind === 'RFC822' || i.kind === 'RFC822.HEADER' || i.kind === 'RFC822.TEXT'
    || i.kind === 'BINARY' || i.kind === 'BINARY.SIZE');
  const setsSeen = items.some((i) => ((i.kind === 'SECTION' || i.kind === 'BINARY') && !i.peek)
    || i.kind === 'RFC822' || i.kind === 'RFC822.TEXT');
  const wantModSeq = session.condstoreEnabled;

  const messages = (await loadMessages(view.folderId, resolveSet(view, sequenceSet, byUid), contentItems))
    .filter((m) => changedSince === null || m.modSeq > changedSince);

  // Implicit \Seen (never in an EXAMINEd mailbox) in one store operation; the
  // new flags are reported in the FETCH responses.
  const seenNow = new Set<string>();
  if (setsSeen && !view.readOnly && session.mailboxId) {
    const unseen = messages.filter((m) => !hasFlag(m.flags, '\\Seen'));
    // v9.1: a write to a foreign mailbox re-checks the permission first.
    if (unseen.length > 0 && view.foreign && !(await selectedWritable(session))) {
      if (session.selected !== view) { sendNo(session, tag, NOPERM); return; }
      unseen.length = 0;
    }
    if (unseen.length > 0) {
      const mailboxId = selectedMailboxId(session, view);
      // Flags are re-read under the mailbox lock: a concurrent STORE is not overwritten.
      const updated = await prisma.$transaction((tx) => modifyFlags(
        tx, unseen.map((m) => m.id), (flags) => (hasFlag(flags, '\\Seen') ? null : [...flags, '\\Seen']), { mailboxId },
      ));
      const byId = new Map(updated.map((u) => [u.id, u]));
      for (const m of unseen) {
        const u = byId.get(m.id);
        if (!u) continue;
        m.flags = u.flags;
        m.modSeq = u.modSeq;
        seenNow.add(m.id);
      }
    }
  }

  for (const msg of messages) {
    const seqNum = seqOf(view, msg.uid);
    if (seqNum === 0) continue;

    // The raw message is needed for content items, and for RFC822.SIZE of legacy
    // rows (no stored object yet → the size of the reconstruction).
    let cached: CachedRaw | null = null;
    if (contentItems || (has('RFC822.SIZE') && !msg.storagePath)) {
      try {
        cached = await getRaw(session, msg as unknown as RawSourceMessage);
      } catch (err) {
        log.error({ err, messageId: msg.id, storagePath: msg.storagePath }, 'IMAP FETCH: raw message unavailable');
        sendNo(session, tag, '[UNAVAILABLE] Message content temporarily unavailable');
        return;
      }
    }

    const flags = msg.flags;
    const flagsChanged = seenNow.has(msg.id);
    const parts: Chunk[][] = [[`UID ${msg.uid}`]];
    const emitted = new Set<string>(['UID']);
    const once = (key: string): boolean => {
      if (emitted.has(key)) return false;
      emitted.add(key);
      return true;
    };
    for (const item of items) {
      switch (item.kind) {
        case 'UID': break;
        case 'FLAGS': if (once('FLAGS')) parts.push([`FLAGS ${flagList(flags)}`]); break;
        case 'INTERNALDATE':
          if (once('INTERNALDATE')) parts.push([`INTERNALDATE "${formatInternalDate(msg.createdAt ?? msg.date)}"`]);
          break;
        case 'RFC822.SIZE':
          if (once('RFC822.SIZE')) parts.push([`RFC822.SIZE ${cached ? cached.raw.length : msg.rawSize}`]);
          break;
        case 'ENVELOPE':
          if (once('ENVELOPE')) {
            const source = cached ? envelopeFromHeaders(cached.tree().headers) : envelopeFromDb(msg);
            parts.push(['ENVELOPE ', ...renderEnvelope(source)]);
          }
          break;
        case 'BODYSTRUCTURE':
          if (once('BODYSTRUCTURE')) parts.push(['BODYSTRUCTURE ', ...renderBodyStructure(cached!.raw, cached!.tree(), true)]);
          break;
        case 'BODY':
          if (once('BODY')) parts.push(['BODY ', ...renderBodyStructure(cached!.raw, cached!.tree(), false)]);
          break;
        case 'MODSEQ': break;
        case 'RFC822':
          if (once('RFC822')) parts.push(['RFC822 ', ...literal(cached!.raw)]);
          break;
        case 'RFC822.HEADER':
          if (once('RFC822.HEADER')) parts.push(['RFC822.HEADER ', ...literal(headerBytes(cached!.raw, cached!.tree()))]);
          break;
        case 'RFC822.TEXT':
          if (once('RFC822.TEXT')) parts.push(['RFC822.TEXT ', ...literal(bodyBytes(cached!.raw, cached!.tree()))]);
          break;
        case 'SECTION': {
          const label = `BODY[${sectionLabel(item.section)}]${item.partial ? `<${item.partial.origin}>` : ''}`;
          if (!once(label)) break;
          const data = extractSection(cached!.raw, cached!.tree(), item.section);
          parts.push(data === null ? [`${label} NIL`] : [`${label} `, ...literal(applyPartial(data, item.partial))]);
          break;
        }
        case 'BINARY':
        case 'BINARY.SIZE': {
          const path = item.path.join('.');
          const label = item.kind === 'BINARY'
            ? `BINARY[${path}]${item.partial ? `<${item.partial.origin}>` : ''}`
            : `BINARY.SIZE[${path}]`;
          if (!once(label)) break;
          let data: Buffer | null;
          try {
            data = binarySection(cached!.raw, cached!.tree(), item.path);
          } catch (err) {
            if (!(err instanceof UnknownCteError)) throw err;
            // RFC 3516 §4.3: the part's encoding cannot be decoded.
            sendNo(session, tag, '[UNKNOWN-CTE] Unknown Content-Transfer-Encoding');
            return;
          }
          if (item.kind === 'BINARY.SIZE') parts.push([`${label} ${data?.length ?? 0}`]);
          else parts.push(data === null ? [`${label} NIL`] : [`${label} `, ...binaryLiteral(applyPartial(data, item.partial))]);
          break;
        }
      }
    }
    if (flagsChanged && once('FLAGS')) parts.push([`FLAGS ${flagList(flags)}`]);
    if (wantModSeq) parts.push([`MODSEQ (${msg.modSeq})`]);
    // Flags reported here count as known (no second unsolicited FETCH later).
    if (emitted.has('FLAGS')) markReported(view, msg.uid, msg.modSeq);

    session.socket.write(toBuffer([`* ${seqNum} FETCH (`, ...joinChunks(parts), ')\r\n']));
  }

  // RFC 9051 §7.5.1: no EXPUNGE responses during FETCH (UID FETCH may send them).
  await completeWithUpdates(session, tag, 'FETCH completed', byUid);
}

// ─────────────────────────────────────────────
// FETCH helpers
// ─────────────────────────────────────────────

/** RFC 3501 §6.4.5 INTERNALDATE format: "01-Jan-2026 12:34:56 +0000" */
function formatInternalDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()] ?? 'Jan';
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd}-${mon}-${yyyy} ${hh}:${mm}:${ss} +0000`;
}

// ─────────────────────────────────────────────
// STORE — RFC 9051 §6.4.6, CONDSTORE UNCHANGEDSINCE (RFC 7162 §3.1.3)
// ─────────────────────────────────────────────
export async function handleStore(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  const view = session.selected;
  if (!view) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const sequenceSet = args[0] ?? '';
  if (!isValidSequenceSet(sequenceSet)) {
    sendBad(session, tag, 'Invalid sequence set');
    return;
  }
  // STORE <set> [(UNCHANGEDSINCE <modseq>)] <item> <flags>
  let index = 1;
  let unchangedSince: bigint | null = null;
  if (args[1]?.startsWith('(')) {
    const m = /^\(\s*UNCHANGEDSINCE\s+(\d{1,19})\s*\)$/i.exec(args[1]);
    if (!m) { sendBad(session, tag, 'Unknown STORE modifier'); return; }
    unchangedSince = BigInt(m[1]!);
    index = 2;
  }
  const command = (args[index] ?? '').toUpperCase();
  if (!/^[+-]?FLAGS(?:\.SILENT)?$/.test(command)) {
    sendBad(session, tag, 'Unknown STORE data item');
    return;
  }
  const flagArgs = args.slice(index + 1);
  const flagText = flagArgs.length === 1 && /^\(.*\)$/s.test(flagArgs[0]!) ? flagArgs[0]!.slice(1, -1) : flagArgs.join(' ');
  const requested: string[] = [];
  for (const raw of flagText.split(/\s+/).filter(Boolean)) {
    const flag = normalizeFlag(raw);
    if (flag === null) { sendBad(session, tag, `Invalid flag ${raw}${raw.toLowerCase() === '\\recent' ? ' (\\Recent cannot be changed)' : ''}`); return; }
    requested.push(flag);
  }
  const newFlags = uniqueFlags(requested);
  // v9.1: read-only permission on a foreign mailbox → NOPERM (RFC 4314 §4).
  if (view.noWrite) { sendNo(session, tag, NOPERM); return; }
  // RFC 9051 §6.3.3: no permanent state changes in a mailbox opened with EXAMINE.
  if (view.readOnly) {
    sendNo(session, tag, '[READ-ONLY] Mailbox is read-only');
    return;
  }
  if (!(await selectedWritable(session))) { sendNo(session, tag, NOPERM); return; }
  // RFC 7162 §3.1: STORE UNCHANGEDSINCE enables CONDSTORE.
  if (unchangedSince !== null) session.condstoreEnabled = true;

  const messages = await loadMessages(view.folderId, resolveSet(view, sequenceSet, byUid), false);
  const modified: number[] = [];
  const results: Array<{ uid: number; id: string; flags: string[]; modSeq: bigint; changed: boolean; seenBefore: boolean }> = [];
  const apply = (flags: string[]): string[] => {
    if (command.startsWith('+')) return uniqueFlags([...flags, ...newFlags]);
    if (command.startsWith('-')) return flags.filter((f) => !hasFlag(newFlags, f));
    return newFlags;
  };
  const differs = (a: string[], b: string[]): boolean => a.length !== b.length || a.some((f, i) => f !== b[i]);
  for (const msg of messages) {
    if (unchangedSince !== null && msg.modSeq > unchangedSince) {
      modified.push(byUid ? msg.uid : seqOf(view, msg.uid));
      continue;
    }
    const updated = apply(msg.flags);
    results.push({
      uid: msg.uid, id: msg.id, flags: updated, modSeq: msg.modSeq, changed: differs(updated, msg.flags),
      seenBefore: view.known.get(msg.uid) === msg.modSeq,
    });
  }

  // One new mailbox modSeq for the whole STORE (RFC 7162 §3.1: HIGHESTMODSEQ ≥ every MODSEQ).
  // The flags read above only decide whether a write is needed: the new flags
  // are computed from the rows re-read under the mailbox lock (modifyFlags), so
  // concurrent "+FLAGS" from two clients both survive.
  const toWrite = results.filter((r) => r.changed);
  const mailboxId = selectedMailboxId(session, view);
  const fresh = new Map<string, { flags: string[]; modSeq: bigint }>();
  const conflicts = new Set<string>();
  const stored = toWrite.length === 0 ? [] : await prisma.$transaction((tx) => modifyFlags(
    tx, toWrite.map((c) => c.id), (flags, modSeq, id) => {
      fresh.set(id, { flags, modSeq });
      if (unchangedSince !== null && modSeq > unchangedSince) { conflicts.add(id); return null; }
      const updated = apply(flags);
      return differs(updated, flags) ? updated : null;
    }, { mailboxId },
  ));
  const storedById = new Map(stored.map((s) => [s.id, s]));
  for (const r of [...results]) {
    if (conflicts.has(r.id)) {
      modified.push(byUid ? r.uid : seqOf(view, r.uid));
      results.splice(results.indexOf(r), 1);
      continue;
    }
    const s = storedById.get(r.id);
    const f = fresh.get(r.id);
    if (s) { r.flags = s.flags; r.modSeq = s.modSeq; }
    else if (f) { r.flags = f.flags; r.modSeq = f.modSeq; r.changed = false; }
  }
  modified.sort((a, b) => a - b);
  const modSeqById = new Map(stored.map((s) => [s.id, s.modSeq]));

  const silent = command.endsWith('.SILENT');
  for (const r of results) {
    const seq = seqOf(view, r.uid);
    const modSeq = modSeqById.get(r.id) ?? r.modSeq;
    const uidItem = byUid ? `UID ${r.uid} ` : '';
    const modSeqItem = session.condstoreEnabled ? ` MODSEQ (${modSeq})` : '';
    if (!silent || !r.seenBefore) {
      // .SILENT still reports flags another client changed in the meantime.
      sendUntagged(session, `${seq} FETCH (${uidItem}FLAGS ${flagList(r.flags)}${modSeqItem})`);
    } else if (r.changed && session.condstoreEnabled) {
      // RFC 7162 §3.1.3: with CONDSTORE the new MODSEQ is sent even for .SILENT.
      sendUntagged(session, `${seq} FETCH (${uidItem}MODSEQ (${modSeq}))`);
    }
    markReported(view, r.uid, modSeq);
  }

  const text = modified.length > 0
    ? `[MODIFIED ${toSequenceSet(modified)}] Conditional STORE failed for some messages`
    : 'STORE completed';
  // RFC 9051 §7.5.1: no EXPUNGE responses during STORE (UID STORE may send them).
  await completeWithUpdates(session, tag, text, byUid);
}

// ─────────────────────────────────────────────
// EXPUNGE
// ─────────────────────────────────────────────
/**
 * EXPUNGE (RFC 9051 §6.4.3) and UID EXPUNGE (RFC 4315 §2.1).
 *
 * @param uidSet  undefined → plain EXPUNGE (all \Deleted messages of the view);
 *                a UID set → UID EXPUNGE: only \Deleted messages whose UID
 *                is in the set are removed.
 */
export async function handleExpunge(session: ImapSession, tag: string, uidSet?: string): Promise<void> {
  const view = session.selected;
  if (!view) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }
  if (uidSet !== undefined && !isValidSequenceSet(uidSet)) {
    sendBad(session, tag, 'Invalid UID set');
    return;
  }
  if (view.noWrite) { sendNo(session, tag, NOPERM); return; }
  // RFC 9051 §6.3.3: nothing is removed from a mailbox opened with EXAMINE.
  if (view.readOnly) {
    sendNo(session, tag, '[READ-ONLY] Mailbox is read-only');
    return;
  }
  if (!(await selectedWritable(session))) { sendNo(session, tag, NOPERM); return; }

  // Only messages the client knows about (its view) are candidates.
  const candidates = uidSet !== undefined ? resolveSet(view, uidSet, true) : view.uids;
  const toDelete = (await loadMessages(view.folderId, candidates, false)).filter((m) => hasFlag(m.flags, '\\Deleted'));
  if (toDelete.length > 0) {
    const mailboxId = selectedMailboxId(session, view);
    await prisma.$transaction((tx) => expunge(tx, toDelete.map((m) => m.id), { mailboxId }));
    auditImapAccess(session, selectedAccess(session), 'mailbox.foreign.message.delete', { count: toDelete.length, folder: view.folderName, expunge: true });
  }
  // The EXPUNGE responses (ours and those of other clients) come from the view sync.
  await completeWithUpdates(session, tag, uidSet !== undefined ? 'UID EXPUNGE completed' : 'EXPUNGE completed', true, true);
}

// ─────────────────────────────────────────────
// IDLE (RFC 2177 / RFC 9051 §6.3.13)
// ─────────────────────────────────────────────
/**
 * 9.4: fallback interval of the mailbox check while idling. Changes are pushed
 * (mailbox:changes, server/idle-push.ts); the timer only covers a lost Redis
 * message or a Redis outage.
 */
let idlePollMs = 120_000;

/** Interval of the fallback mailbox check while idling. */
export function setIdlePollInterval(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) idlePollMs = ms;
}

async function idleSync(session: ImapSession): Promise<void> {
  if (!session.idleActive || !session.selected) return;
  try {
    // v9.1: a revoked permission on a selected foreign mailbox closes it ([CLOSED]).
    if (!(await revalidateSelected(session, false))) return;
    await syncView(session, { expunge: true });
  } catch (err) {
    log.warn({ err, id: session.id }, 'IMAP IDLE: mailbox check failed');
  }
}

/** Queues a mailbox check for an idling session (new-mail push). */
export function notifyMailboxChanged(session: ImapSession): void {
  if (!session.idleActive) return;
  // 9.4: wake-ups coalesce while a re-read is still waiting for the lock
  queueIdleSync(session, (run) => { void withUpdateLock(session, run); }, () => idleSync(session));
}

/** Stops the IDLE poll timer (DONE, logout, connection closed). */
export function stopIdleTimer(session: ImapSession): void {
  if (session.idleTimer) clearInterval(session.idleTimer);
  session.idleTimer = null;
}

export async function handleIdle(session: ImapSession, tag: string): Promise<void> {
  session.idleActive = true;
  session.idleTag = tag;
  send(session, '+ idling');
  if (!session.selected) return;
  // Pending updates first, then periodic checks until DONE.
  await withUpdateLock(session, () => idleSync(session));
  stopIdleTimer(session);
  if (!session.idleActive) return;
  session.idleTimer = setInterval(() => notifyMailboxChanged(session), idlePollMs);
  session.idleTimer.unref?.();
}

export async function handleIdleDone(session: ImapSession): Promise<void> {
  if (!session.idleActive || !session.idleTag) return;
  const tag = session.idleTag;
  session.idleActive = false;
  session.idleTag = null;
  stopIdleTimer(session);
  // A check that is still writing finishes before the tagged OK.
  await withUpdateLock(session, async () => { sendOk(session, tag, 'IDLE terminated'); });
}

// ─────────────────────────────────────────────
// NOOP — RFC 9051 §6.1.2: reports mailbox updates
// ─────────────────────────────────────────────
export async function handleNoop(session: ImapSession, tag: string): Promise<void> {
  await completeWithUpdates(session, tag, 'NOOP completed');
}
