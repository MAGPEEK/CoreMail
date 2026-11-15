import {
  prisma, createMessage, copyMessages, moveMessages, setFlags, expunge, verifyMailCredentials,
  parseRawMessage, storeRawMessage, truncateBodyColumn, parseMimeTree, headerBytes, bodyBytes,
  attachmentKey, uploadBuffer,
  type RawSourceMessage,
} from '@coremail/storage';
import { type Chunk, flagList, isValidFlag, literal, joinChunks, toBuffer, mailboxName } from '../fetch/imap-string.js';
import { parseFetchItems, sectionLabel, FetchParseError, type FetchItem } from '../fetch/fetch-items.js';
import {
  extractSection, applyPartial, renderBodyStructure, renderEnvelope, envelopeFromHeaders, envelopeFromDb,
} from '../fetch/render.js';
import { getRaw, type CachedRaw } from '../fetch/raw-cache.js';
import { createLogger } from '@coremail/core';
import {
  type ImapSession,
  sendOk, sendNo, sendBad, sendUntagged, send, refreshCapabilities,
} from '../session/state.js';
import { ImapParseError, type Token } from '../server/tokenizer.js';
import { registerLiveSession } from '../session/live.js';
import {
  parseSearch, needsBody, evaluateSearch, formatEsearch,
  type SearchProgram, type SearchableMessage,
} from './search-parser.js';

const log = createLogger('imap:commands');

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
// LOGIN
// ─────────────────────────────────────────────
export async function handleLogin(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    sendBad(session, tag, 'LOGIN requires username and password');
    return;
  }

  // Arguments arrive already decoded by the tokenizer (atom, quoted string
  // with \" and \\ escapes resolved, or literal) — no further unquoting.
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
// LIST — v5.2.18 with SPECIAL-USE flags (RFC 6154)
// ─────────────────────────────────────────────
//
// Mac Mail / Apple Mail only recognizes the system folders via SPECIAL-USE flags:
//   \Drafts, \Sent, \Trash, \Junk, \Archive, \Flagged, \All
// Without these flags Mac Mail only shows INBOX — the other folders are
// included in LIST but are not recognized by Mac Mail as "standard folders"
// and are therefore hidden.

/**
 * Maps a folder name (case-insensitive) to its SPECIAL-USE flag.
 * Supports both English (INBOX, Drafts, Sent, …) and typical German
 * aliases (Entwürfe, Gesendet, …) — in case someone renames their
 * folder scheme.
 */
function specialUseFlag(name: string): string | null {
  const n = name.toLowerCase();
  if (n === 'inbox' || n === 'posteingang') return null; // INBOX has NO SPECIAL-USE
  if (n === 'drafts' || n === 'entwürfe' || n === 'entwurf') return '\\Drafts';
  if (n === 'sent' || n === 'gesendet' || n === 'sent items' || n === 'sent messages') return '\\Sent';
  if (n === 'trash' || n === 'gelöscht' || n === 'deleted items' || n === 'deleted messages') return '\\Trash';
  if (n === 'junk' || n === 'spam' || n === 'junk-e-mail' || n === 'junk e-mail') return '\\Junk';
  if (n === 'archive' || n === 'archiv') return '\\Archive';
  if (n === 'flagged' || n === 'starred') return '\\Flagged';
  if (n === 'all' || n === 'all mail' || n === 'alle nachrichten') return '\\All';
  return null;
}

export async function handleList(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) {
    sendNo(session, tag, 'No mailbox');
    return;
  }

  const reference = unquote(args[0] ?? '');
  const pattern   = unquote(args[1] ?? '*');
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/%/g, '[^.]*');
  // v5.2.19: Defensive — also escape the reference in case the client sends it
  // with special characters. Plus try/catch around RegExp so invalid patterns
  // do not lead to a 500 but return all folders instead.
  const escapedReference = reference.replace(/[.+^${}()|[\]\\*]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`^${escapedReference}${regexPattern}$`, 'i');
  } catch {
    // Fallback: match all folders
    regex = /.*/;
  }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId },
    orderBy: { name: 'asc' },
  });

  for (const folder of folders) {
    if (pattern === '*' || pattern === '%' || regex.test(folder.name)) {
      // RFC 3348 (CHILDREN) / RFC 9051 §7.3.1: \HasChildren when an inferior mailbox exists.
      const hasChildren = folders.some((f) => f.name.startsWith(`${folder.name}.`));
      const flags: string[] = [hasChildren ? '\\HasChildren' : '\\HasNoChildren'];
      const special = specialUseFlag(folder.name);
      if (special) flags.push(special);
      sendUntagged(session, `LIST (${flags.join(' ')}) "." ${mailboxName(folder.name)}`);
    }
  }

  sendOk(session, tag, 'LIST completed');
}

// ─────────────────────────────────────────────
// LSUB — Mac Mail's first query after login (RFC 3501 §6.3.9)
// ─────────────────────────────────────────────
// Without an LSUB handler our server replies "BAD" → Mac Mail assumes
// that only INBOX exists. We treat all standard folders as
// automatically subscribed.
export async function handleLsub(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) {
    sendNo(session, tag, 'No mailbox');
    return;
  }

  const reference = unquote(args[0] ?? '');
  const pattern   = unquote(args[1] ?? '*');
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/%/g, '[^.]*');
  // v5.2.19: Defensive — also escape the reference in case the client sends it
  // with special characters. Plus try/catch around RegExp so invalid patterns
  // do not lead to a 500 but return all folders instead.
  const escapedReference = reference.replace(/[.+^${}()|[\]\\*]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`^${escapedReference}${regexPattern}$`, 'i');
  } catch {
    // Fallback: match all folders
    regex = /.*/;
  }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId },
    orderBy: { name: 'asc' },
  });

  for (const folder of folders) {
    if (pattern === '*' || pattern === '%' || regex.test(folder.name)) {
      // Emit SPECIAL-USE flags in LSUB as well — Mac Mail validates them
      const flags: string[] = ['\\HasNoChildren'];
      const special = specialUseFlag(folder.name);
      if (special) flags.push(special);
      sendUntagged(session, `LSUB (${flags.join(' ')}) "." ${mailboxName(folder.name)}`);
    }
  }

  sendOk(session, tag, 'LSUB completed');
}

// ─────────────────────────────────────────────
// SUBSCRIBE / UNSUBSCRIBE — RFC 3501 §6.3.6/6.3.7
// ─────────────────────────────────────────────
// We accept both as no-ops (all standard folders are always
// subscribed). Mac Mail often calls SUBSCRIBE on its own after LIST.
export async function handleSubscribe(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  const folderName = unquote(args[0] ?? '');
  if (!folderName) { sendNo(session, tag, 'Folder name required'); return; }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: folderName },
    select: { id: true },
  });
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendOk(session, tag, 'SUBSCRIBE completed');
}

export async function handleUnsubscribe(
  session: ImapSession,
  tag: string,
  _args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  // We allow unsubscribe (no-op) — on the next LSUB everything is
  // subscribed again. Mac Mail copes with this behavior.
  sendOk(session, tag, 'UNSUBSCRIBE completed');
}

// ─────────────────────────────────────────────
// NAMESPACE — RFC 2342
// ─────────────────────────────────────────────
// Personal namespace with "." as hierarchy delimiter. No other-user
// or shared namespaces (would require CoreMail shared mailboxes —
// may follow later).
export function handleNamespace(session: ImapSession, tag: string): void {
  sendUntagged(session, 'NAMESPACE (("" ".")) NIL NIL');
  sendOk(session, tag, 'NAMESPACE completed');
}

// ─────────────────────────────────────────────
// STATUS — RFC 3501 §6.3.10
// ─────────────────────────────────────────────
// Mac Mail uses STATUS to refresh the folder overview without SELECT.
// Returns MESSAGES, UIDNEXT, UIDVALIDITY, UNSEEN, RECENT, HIGHESTMODSEQ.
export async function handleStatus(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }

  // RFC 9051 §6.3.11: STATUS <mailbox> "(" status-att *(SP status-att) ")".
  // The tokenizer groups the parenthesised list into one argument.
  const folderName = args[0] ?? '';
  const list = /^\((.*)\)$/.exec(args[1] ?? '');
  if (!folderName || !list || args.length !== 2) {
    sendBad(session, tag, 'STATUS requires a mailbox and a parenthesised item list');
    return;
  }
  const items = (list[1] ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  const KNOWN = ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN', 'DELETED', 'RECENT', 'HIGHESTMODSEQ', 'SIZE'];
  const unknown = items.find((i) => !KNOWN.includes(i));
  if (items.length === 0 || unknown) {
    sendBad(session, tag, unknown ? `Unknown STATUS item ${unknown}` : 'Empty STATUS item list');
    return;
  }

  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: folderName },
    include: { mailbox: true },
  });
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }

  const base = { folderId: folder.id, deletedAt: null };
  const want = (item: string): boolean => items.includes(item);
  const [messages, unseen, deleted, sizeRows] = await Promise.all([
    want('MESSAGES') ? prisma.message.count({ where: base }) : Promise.resolve(0),
    want('UNSEEN')
      ? prisma.message.count({ where: { ...base, NOT: { flags: { has: '\\Seen' } } } })
      : Promise.resolve(0),
    want('DELETED')
      ? prisma.message.count({ where: { ...base, flags: { has: '\\Deleted' } } })
      : Promise.resolve(0),
    // RFC 8438: SIZE is the total size of the mailbox in octets (sum of RFC822.SIZE).
    want('SIZE')
      ? prisma.message.findMany({ where: base, select: { rawSize: true } })
      : Promise.resolve([] as Array<{ rawSize: number }>),
  ]);
  const size = sizeRows.reduce((sum, m) => sum + m.rawSize, 0);

  const parts: string[] = [];
  for (const item of items) {
    switch (item) {
      case 'MESSAGES':       parts.push(`MESSAGES ${messages}`); break;
      case 'UIDNEXT':        parts.push(`UIDNEXT ${folder.mailbox.uidNext}`); break;
      case 'UIDVALIDITY':    parts.push(`UIDVALIDITY ${folder.mailbox.uidValidity}`); break;
      case 'UNSEEN':         parts.push(`UNSEEN ${unseen}`); break;
      case 'DELETED':        parts.push(`DELETED ${deleted}`); break;
      case 'RECENT':         parts.push('RECENT 0'); break;
      case 'HIGHESTMODSEQ':  parts.push(`HIGHESTMODSEQ ${folder.mailbox.highestModSeq}`); break;
      case 'SIZE':           parts.push(`SIZE ${size}`); break;
    }
  }
  sendUntagged(session, `STATUS ${mailboxName(folder.name)} (${parts.join(' ')})`);
  sendOk(session, tag, 'STATUS completed');
}

// ─────────────────────────────────────────────
// CREATE — RFC 3501 §6.3.3 (Mac Mail needs this for "New Folder" + Drafts/Sent upload)
// ─────────────────────────────────────────────
export async function handleCreate(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  let name = unquote(args[0] ?? '');
  if (!name) { sendBad(session, tag, 'Folder name required'); return; }
  // Remove trailing slash (Mac Mail sometimes sends "Parent.Child.")
  name = name.replace(/[.\/]+$/, '');
  if (name.toUpperCase() === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be created');
    return;
  }
  // Prevent duplicate folders
  const existing = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name },
    select: { id: true },
  });
  if (existing) {
    sendNo(session, tag, '[ALREADYEXISTS] Mailbox already exists');
    return;
  }
  await prisma.folder.create({
    data: { mailboxId: session.mailboxId, name, displayName: name },
  });
  log.info({ mailboxId: session.mailboxId, name }, 'IMAP folder created');
  sendOk(session, tag, 'CREATE completed');
}

// ─────────────────────────────────────────────
// DELETE — RFC 3501 §6.3.4
// ─────────────────────────────────────────────
export async function handleDeleteFolder(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  const name = unquote(args[0] ?? '');
  if (!name) { sendBad(session, tag, 'Folder name required'); return; }
  if (name.toUpperCase() === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be deleted');
    return;
  }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name },
    select: { id: true },
  });
  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }
  // Soft-delete the messages, then delete the folder
  await prisma.message.updateMany({
    where: { folderId: folder.id, deletedAt: null },
    data:  { deletedAt: new Date() },
  });
  await prisma.folder.delete({ where: { id: folder.id } });
  sendOk(session, tag, 'DELETE completed');
}

// ─────────────────────────────────────────────
// RENAME — RFC 3501 §6.3.5
// ─────────────────────────────────────────────
export async function handleRename(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  const oldName = unquote(args[0] ?? '');
  const newName = unquote(args[1] ?? '');
  if (!oldName || !newName) { sendBad(session, tag, 'Old + new folder name required'); return; }
  if (oldName.toUpperCase() === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be renamed');
    return;
  }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: oldName },
    select: { id: true },
  });
  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }
  // Conflict with an existing folder?
  const conflict = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: newName },
    select: { id: true },
  });
  if (conflict) {
    sendNo(session, tag, '[ALREADYEXISTS] Target folder exists');
    return;
  }
  await prisma.folder.update({
    where: { id: folder.id },
    data:  { name: newName, displayName: newName },
  });
  sendOk(session, tag, 'RENAME completed');
}

// ─────────────────────────────────────────────
// APPEND — RFC 3501 §6.3.11 (Mac Mail uploads Drafts/Sent to the server)
// ─────────────────────────────────────────────
/** True when the APPEND target mailbox exists (checked before reading the literal). */
export async function appendTargetExists(session: ImapSession, name: string): Promise<boolean> {
  if (!session.mailboxId) return false;
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name },
    select: { id: true },
  });
  return !!folder;
}

// RFC 9051 §6.3.12: APPEND <mailbox> [<flag-list>] [<date-time>] <literal>.
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
  const folderName = args[0] ?? '';
  const raw = message ?? Buffer.from(args[args.length - 1] ?? '', 'utf8');
  // Optional flag list between mailbox and message (only syntactically valid flags;
  // \Recent cannot be set by a client).
  let flags: string[] = [];
  for (const a of args.slice(1, -1)) {
    const m = /^\((.*)\)$/.exec(a);
    if (m && m[1]) flags = m[1].split(/\s+/).filter((f) => isValidFlag(f) && f.toLowerCase() !== '\\recent');
  }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: folderName },
    include: { mailbox: true },
  });
  if (!folder) {
    sendNo(session, tag, '[TRYCREATE] Mailbox does not exist');
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
  sendOk(session, tag, `[APPENDUID ${folder.mailbox.uidValidity} ${newUid}] APPEND completed`);
}

// ─────────────────────────────────────────────
// COPY — RFC 3501 §6.4.7 (Mac Mail "move to folder" = COPY + STORE \Deleted + EXPUNGE)
// ─────────────────────────────────────────────
export async function handleCopy(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  const seqSet = args[0] ?? '';
  const targetName = unquote(args[1] ?? '');
  if (!seqSet || !targetName) { sendBad(session, tag, 'COPY: seq + target required'); return; }

  const target = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId!, name: targetName },
    include: { mailbox: true },
  });
  if (!target) { sendNo(session, tag, '[TRYCREATE] Target mailbox does not exist'); return; }

  // Load messages of the current folder
  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
  });
  // Parse sequence set (UID or seq number)
  const uids = messages.map((m) => m.uid);
  const matchedUids = parseSequenceSet(seqSet, uids, byUid);

  if (matchedUids.length === 0) {
    sendOk(session, tag, 'COPY completed (no messages matched)');
    return;
  }

  const sourceMsgs = messages.filter((m) => matchedUids.includes(m.uid));
  // Fresh UIDs + one modSeq in the target, reserved atomically (never a stale uidNext).
  const { mapping } = await prisma.$transaction((tx) => copyMessages(
    tx, sourceMsgs.map((m) => m.id), target.id, { targetMailboxId: target.mailboxId },
  ));

  const copyUid = `[COPYUID ${target.mailbox.uidValidity} ${mapping.map((m) => m.oldUid).join(',')} ${mapping.map((m) => m.newUid).join(',')}]`;
  sendOk(session, tag, `${copyUid} COPY completed`);
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
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  const seqSet = args[0] ?? '';
  const targetName = unquote(args[1] ?? '');
  if (!seqSet || !targetName) { sendBad(session, tag, 'MOVE: seq + target required'); return; }

  const target = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId!, name: targetName },
    include: { mailbox: true },
  });
  if (!target) { sendNo(session, tag, '[TRYCREATE] Target mailbox does not exist'); return; }

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    select: { id: true, uid: true },
    orderBy: { uid: 'asc' },
  });
  const uids = messages.map((m) => m.uid);
  const matchedUids = parseSequenceSet(seqSet, uids, byUid);
  if (matchedUids.length === 0) {
    sendOk(session, tag, 'MOVE completed (no messages matched)');
    return;
  }
  const matched = messages.filter((m) => matchedUids.includes(m.uid));
  // RFC 6851 §4.3: the moved messages get new UIDs in the target mailbox and a new
  // modSeq; the rows keep their id.
  const { mapping } = await prisma.$transaction((tx) => moveMessages(
    tx, matched.map((m) => m.id), target.id,
    { targetMailboxId: target.mailboxId, sourceMailboxId: session.mailboxId! },
  ));
  if (mapping.length > 0) {
    sendUntagged(session, `OK [COPYUID ${target.mailbox.uidValidity} ${mapping.map((m) => m.oldUid).join(',')} ${mapping.map((m) => m.newUid).join(',')}] Moved`);
  }
  // RFC 6851 §3.3: EXPUNGE responses for the moved messages (sequence numbers shift
  // down after every response). Nothing to expunge when moving into the same folder.
  const moved = new Set(mapping.map((m) => m.oldUid));
  let removed = 0;
  for (const [i, msg] of messages.entries()) {
    if (moved.has(msg.uid)) {
      sendUntagged(session, `${i + 1 - removed} EXPUNGE`);
      removed++;
    }
  }
  session.selected.exists = Math.max(0, session.selected.exists - removed);
  sendOk(session, tag, 'MOVE completed');
}

// ─────────────────────────────────────────────
// SEARCH — RFC 3501 §6.4.4 — Mac Mail uses this on every folder open!
// ─────────────────────────────────────────────
// The search program is parsed into an AST (search-parser.ts) and evaluated
// against the non-deleted messages of the selected folder, ordered by UID —
// the same ordering that defines message sequence numbers. Evaluation happens
// in memory because sequence-set keys, OR/NOT nesting and HEADER cannot be
// expressed as a single Prisma filter; only the columns the program needs are
// loaded (bodies only for BODY/TEXT).
// Without SEARCH, Mac Mail shows folders as empty because it first runs SEARCH ALL
// to fetch the UID list.
export async function handleSearch(
  session: ImapSession,
  tag: string,
  tokens: Token[],
  byUid = false,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }

  let program: SearchProgram;
  try {
    program = parseSearch(tokens);
  } catch (err) {
    sendBad(session, tag, err instanceof ImapParseError ? err.message : 'Invalid search program');
    return;
  }
  if (program.charset && program.charset !== 'UTF-8' && program.charset !== 'US-ASCII') {
    sendNo(session, tag, '[BADCHARSET (UTF-8 US-ASCII)] Unsupported charset');
    return;
  }

  const withBody = needsBody(program.key);
  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    select: {
      uid: true, modSeq: true, flags: true, subject: true, fromAddr: true, fromName: true,
      toAddrs: true, ccAddrs: true, bccAddrs: true, replyTo: true, messageId: true, inReplyTo: true,
      date: true, createdAt: true, rawSize: true,
      ...(withBody ? { bodyText: true, bodyHtml: true } : {}),
    },
    orderBy: { uid: 'asc' },
  });

  const maxSeq = messages.length;
  const maxUid = messages.length ? (messages[messages.length - 1]?.uid ?? 0) : 0;
  const results: number[] = [];
  messages.forEach((msg, idx) => {
    if (evaluateSearch(program.key, msg as SearchableMessage, { seq: idx + 1, maxSeq, maxUid })) {
      results.push(byUid ? msg.uid : idx + 1);
    }
  });

  if (program.returnOptions) {
    sendUntagged(session, `ESEARCH ${formatEsearch(tag, byUid, results, program.returnOptions)}`);
  } else {
    sendUntagged(session, `SEARCH${results.length ? ' ' + results.join(' ') : ''}`);
  }
  sendOk(session, tag, `${byUid ? 'UID SEARCH' : 'SEARCH'} completed`);
}

// ─────────────────────────────────────────────
// CLOSE — RFC 3501 §6.4.2 (deselect mailbox + implicit EXPUNGE)
// ─────────────────────────────────────────────
export async function handleClose(
  session: ImapSession,
  tag: string,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  // Implicitly remove messages with the \Deleted flag (RFC 9051 §6.4.1: not
  // for a mailbox opened with EXAMINE). The expunge bumps the modSeq.
  if (!session.selected.readOnly) {
    const doomed = await prisma.message.findMany({
      where: {
        folderId:  session.selected.folderId,
        deletedAt: null,
        flags:     { has: '\\Deleted' },
      },
      select: { id: true },
    });
    if (doomed.length > 0) {
      const mailboxId = session.mailboxId!;
      await prisma.$transaction((tx) => expunge(tx, doomed.map((m) => m.id), { mailboxId }));
    }
  }
  session.selected = null;
  session.state = 'AUTHENTICATED';
  sendOk(session, tag, 'CLOSE completed');
}

// ─────────────────────────────────────────────
// CHECK — RFC 3501 §6.4.1 (server sync, essentially a NOOP for us)
// ─────────────────────────────────────────────
export function handleCheck(session: ImapSession, tag: string): void {
  sendOk(session, tag, 'CHECK completed');
}

// ─────────────────────────────────────────────
// UNSELECT — RFC 3691 / RFC 9051 IMAP4rev2 mandatory
// ─────────────────────────────────────────────
// Closes the currently selected folder WITHOUT performing EXPUNGE.
// Unlike CLOSE, \Deleted messages are preserved.
export function handleUnselect(session: ImapSession, tag: string): void {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  session.selected = null;
  session.state = 'AUTHENTICATED';
  sendOk(session, tag, 'UNSELECT completed');
}

// ─────────────────────────────────────────────
// ID — RFC 2971 (Client/Server Identification)
// ─────────────────────────────────────────────
// Client identifies itself with ("name" "Thunderbird" "version" "115.0")
// — we reply with our server ID. Some clients send ID
// proactively; the server response may be NIL.
export function handleId(session: ImapSession, tag: string, _args: string[]): void {
  sendUntagged(session, 'ID ("name" "CoreMail" "version" "5.5.0" "vendor" "MAGPEEK" "support-url" "https://github.com/MAGPEEK/CoreMail")');
  sendOk(session, tag, 'ID completed');
}

// ─────────────────────────────────────────────
// AUTHENTICATE — RFC 3501 §6.2.2 + RFC 4959 SASL-IR
// ─────────────────────────────────────────────
// Supported: PLAIN (RFC 4616), LOGIN (deprecated but widespread).
// With the SASL-IR capability the client may send the initial response
// directly (`A1 AUTHENTICATE PLAIN <base64>`). Otherwise the server prompts with
// `+ ` (challenge) → client sends the base64 response.
//
// XOAUTH2 would be RFC 7628 — deliberately NOT implemented because mainstream
// clients (Apple Mail, Outlook LTSC) offer no UI for custom OAuth servers.
// App passwords are the practical MFA bypass.
export async function handleAuthenticate(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  const mech = (args[0] ?? '').toUpperCase();
  const initialResponse = args[1] ?? '';

  // v7: no AUTH= mechanisms are advertised before TLS — refuse before any
  // continuation so the client never sends credentials in cleartext.
  if (!session.isTls) {
    sendNo(session, tag, PRIVACY_REQUIRED);
    return;
  }

  if (mech === 'PLAIN') {
    // RFC 4616 PLAIN: base64("\x00user\x00password")
    if (initialResponse) {
      await processPlainAuth(session, tag, initialResponse);
      return;
    }
    // No SASL-IR → server sends an empty continuation and waits for the response
    session.saslMech = 'PLAIN';
    session.saslStep = 0;
    send(session, '+ ');
    return;
  }

  if (mech === 'LOGIN') {
    // SASL LOGIN: 2-step (Username challenge → Password challenge)
    if (initialResponse) {
      // Some clients send username as initial response
      session.saslMech = 'LOGIN';
      session.saslStep = 1;
      try { session.saslUser = Buffer.from(initialResponse, 'base64').toString('utf8'); } catch { /* ignore */ }
      send(session, '+ ' + Buffer.from('Password:').toString('base64'));
      return;
    }
    session.saslMech = 'LOGIN';
    session.saslStep = 0;
    send(session, '+ ' + Buffer.from('Username:').toString('base64'));
    return;
  }

  // v5.5.0: XOAUTH2 explicitly NOT implemented — see comment above
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
    session.saslMech = null;
    session.saslStep = 0;
    sendBad(session, tag, 'Authentication cancelled');
    return;
  }

  if (session.saslMech === 'PLAIN') {
    session.saslMech = null;
    await processPlainAuth(session, tag, data);
    return;
  }

  if (session.saslMech === 'LOGIN') {
    if (session.saslStep === 0) {
      // Username
      try { session.saslUser = Buffer.from(data, 'base64').toString('utf8'); } catch { /* ignore */ }
      session.saslStep = 1;
      send(session, '+ ' + Buffer.from('Password:').toString('base64'));
      return;
    }
    // Password
    let password = '';
    try { password = Buffer.from(data, 'base64').toString('utf8'); } catch { /* ignore */ }
    session.saslMech = null;
    session.saslStep = 0;
    await loginUser(session, tag, session.saslUser, password);
    session.saslUser = '';
    return;
  }

  // Fallback — no active mechanism
  sendBad(session, tag, 'Unexpected continuation');
}

async function processPlainAuth(session: ImapSession, tag: string, b64Data: string): Promise<void> {
  let decoded: string;
  try { decoded = Buffer.from(b64Data, 'base64').toString('utf8'); }
  catch { sendBad(session, tag, '[ALERT] Invalid base64 in PLAIN'); return; }
  // RFC 4616: [authzid] \0 authcid \0 password
  const parts = decoded.split(' ');
  if (parts.length < 3) { sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid PLAIN format'); return; }
  const user     = parts[1] ?? '';
  const password = parts[2] ?? '';
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
      session.state = 'AUTHENTICATED';
      session.userId = result.user.id;
      session.mailboxId = result.user.mailboxId;
      // v7.1.0: the connection ends when these credentials become invalid.
      registerLiveSession(session, result.method, result.appPasswordId, authStartedAt);
      refreshCapabilities(session);
      log.info({ email: result.user.email, method: result.method, command }, 'IMAP login success');
      sendOk(session, tag, `[CAPABILITY ${session.capabilities.join(' ')}] ${command} completed`);
      return;
    case 'locked':
      sendNo(session, tag, '[UNAVAILABLE] Too many failed login attempts - try again later');
      return;
    case 'error':
      sendNo(session, tag, '[UNAVAILABLE] Temporary authentication failure - try again later');
      return;
    default:
      // invalid and mfa_app_password_required get the same text (no oracle).
      log.warn({ login: username, status: result.status, command }, 'IMAP login failed');
      sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials (accounts with two-factor authentication need an app password)');
  }
}

// ─────────────────────────────────────────────
// SELECT / EXAMINE
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

  const folderName = unquote(args[0] ?? 'INBOX');

  const folder = await prisma.folder.findFirst({
    where: {
      mailboxId: session.mailboxId,
      OR: [{ name: folderName }, { name: 'INBOX', ...(folderName === 'INBOX' ? {} : { id: 'never' }) }],
    },
    include: { mailbox: true },
  });

  if (!folder) {
    sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist');
    return;
  }

  const [exists, recent, unseen] = await Promise.all([
    prisma.message.count({ where: { folderId: folder.id, deletedAt: null } }),
    Promise.resolve(0), // recent = new since last SELECT (simplified)
    prisma.message.count({
      where: { folderId: folder.id, deletedAt: null, NOT: { flags: { has: '\\Seen' } } },
    }),
  ]);

  session.state = 'SELECTED';
  session.selected = {
    folderId: folder.id,
    folderName: folder.name,
    uidValidity: folder.mailbox.uidValidity,
    exists,
    recent,
    unseen,
    uidNext: folder.mailbox.uidNext,
    readOnly,
    highestModSeq: folder.mailbox.highestModSeq,
  };

  sendUntagged(session, `${exists} EXISTS`);
  sendUntagged(session, `${recent} RECENT`);
  if (unseen > 0) {
    sendUntagged(session, `OK [UNSEEN ${unseen}] first unseen message`);
  }
  sendUntagged(session, `OK [UIDVALIDITY ${folder.mailbox.uidValidity}] UIDs valid`);
  sendUntagged(session, `OK [UIDNEXT ${folder.mailbox.uidNext}] Predicted next UID`);
  sendUntagged(session, `OK [HIGHESTMODSEQ ${folder.mailbox.highestModSeq}] Highest`);
  sendUntagged(session, `FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`);
  sendUntagged(session, `OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted`);

  const rw = readOnly ? '[READ-ONLY]' : '[READ-WRITE]';
  sendOk(session, tag, `${rw} ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
}

// ─────────────────────────────────────────────
// FETCH — RFC 9051 §6.4.5. Message content is always served from the original
// raw message (object storage; legacy rows are reconstructed deterministically),
// so BODY[]/RFC822.SIZE/sections/BODYSTRUCTURE are byte-exact and consistent.
// ─────────────────────────────────────────────
export async function handleFetch(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  if (!session.selected) {
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
  let changedSince: bigint | null = null;
  if (args.length > 3) { sendBad(session, tag, 'Too many FETCH arguments'); return; }
  if (args[2] !== undefined) {
    const m = /^\(\s*CHANGEDSINCE\s+(\d{1,19})\s*\)$/i.exec(args[2]);
    if (!m) { sendBad(session, tag, 'Unknown FETCH modifier'); return; }
    changedSince = BigInt(m[1]!);
  }

  const has = (k: string): boolean => items.some((i) => i.kind === k);
  const contentItems = items.some((i) => i.kind === 'SECTION' || i.kind === 'BODYSTRUCTURE' || i.kind === 'BODY'
    || i.kind === 'RFC822' || i.kind === 'RFC822.HEADER' || i.kind === 'RFC822.TEXT');
  const setsSeen = items.some((i) => (i.kind === 'SECTION' && !i.peek) || i.kind === 'RFC822' || i.kind === 'RFC822.TEXT');
  const wantModSeq = has('MODSEQ') || session.condstoreEnabled || changedSince !== null;

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    include: { attachments: { select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true } } },
  });

  // UID mode is passed explicitly by the dispatcher (UID FETCH); the dispatcher
  // strips the "UID" token, so it cannot be detected from args.
  const wanted = new Set(parseSequenceSet(sequenceSet, messages.map((m) => m.uid), byUid));

  for (const [seqNum, msg] of messages.entries()) {
    if (!wanted.has(msg.uid)) continue;
    if (changedSince !== null && msg.modSeq <= changedSince) continue;

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

    // Implicit \Seen (never in an EXAMINEd mailbox); the new flags are reported.
    let flags = msg.flags;
    let flagsChanged = false;
    if (setsSeen && !flags.includes('\\Seen') && !session.selected.readOnly && session.mailboxId) {
      const mailboxId = session.mailboxId;
      flags = [...flags, '\\Seen'];
      const [updated] = await prisma.$transaction((tx) => setFlags(tx, [{ id: msg.id, flags }], { mailboxId }));
      if (updated) msg.modSeq = updated.modSeq;
      flagsChanged = true;
    }

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
      }
    }
    if (flagsChanged && once('FLAGS')) parts.push([`FLAGS ${flagList(flags)}`]);
    if (wantModSeq) parts.push([`MODSEQ (${msg.modSeq})`]);

    session.socket.write(toBuffer([`* ${seqNum + 1} FETCH (`, ...joinChunks(parts), ')\r\n']));
  }

  sendOk(session, tag, 'FETCH completed');
}

// ─────────────────────────────────────────────
// FETCH helpers
// ─────────────────────────────────────────────

/** RFC 3501 §6.4.5 INTERNALDATE format: "01-Jan-2026 12:34:56 +0000" */
function formatInternalDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()] ?? 'Jan';
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd}-${mon}-${yyyy} ${hh}:${mm}:${ss} +0000`;
}

// ─────────────────────────────────────────────
// STORE — set/add/remove flags
// ─────────────────────────────────────────────
export async function handleStore(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  if (!session.selected) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const sequenceSet = args[0] ?? '';
  const command     = (args[1] ?? '').toUpperCase();
  const flagsStr    = args.slice(2).join(' ').replace(/[()]/g, '');
  const newFlags    = flagsStr.split(/\s+/).filter(Boolean);

  if (!isValidSequenceSet(sequenceSet)) {
    sendBad(session, tag, 'Invalid sequence set');
    return;
  }
  if (!/^[+-]?FLAGS(?:\.SILENT)?$/.test(command)) {
    sendBad(session, tag, 'Unknown STORE data item');
    return;
  }
  // RFC 9051 §6.3.3: no permanent state changes in a mailbox opened with EXAMINE.
  if (session.selected.readOnly) {
    sendNo(session, tag, '[READ-ONLY] Mailbox is read-only');
    return;
  }

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    select: { id: true, uid: true, flags: true, modSeq: true },
    orderBy: { uid: 'asc' },
  });

  // byUid comes from the dispatcher: plain STORE uses sequence numbers,
  // UID STORE uses UIDs (RFC 9051 §6.4.6, §6.4.9).
  const uids = parseSequenceSet(sequenceSet, messages.map((m: { uid: number }) => m.uid), byUid);

  const changes: Array<{ seqNum: number; id: string; flags: string[] }> = [];
  for (const [seqNum, msg] of messages.entries()) {
    if (!uids.includes(msg.uid)) continue;

    let updatedFlags: string[];
    if (command === 'FLAGS' || command === 'FLAGS.SILENT') {
      updatedFlags = newFlags;
    } else if (command === '+FLAGS' || command === '+FLAGS.SILENT') {
      updatedFlags = [...new Set([...msg.flags, ...newFlags])];
    } else {
      updatedFlags = msg.flags.filter((f: string) => !newFlags.includes(f));
    }
    changes.push({ seqNum, id: msg.id, flags: updatedFlags });
  }

  // One new mailbox modSeq for the whole STORE (RFC 7162 §3.1: HIGHESTMODSEQ ≥ every MODSEQ).
  const mailboxId = session.mailboxId!;
  const stored = changes.length === 0 ? [] : await prisma.$transaction((tx) => setFlags(
    tx, changes.map((c) => ({ id: c.id, flags: c.flags })), { mailboxId },
  ));
  const modSeqById = new Map(stored.map((s) => [s.id, s.modSeq]));

  if (!command.includes('SILENT')) {
    for (const c of changes) {
      sendUntagged(session, `${c.seqNum + 1} FETCH (FLAGS ${flagList(c.flags)} MODSEQ (${modSeqById.get(c.id) ?? 0n}))`);
    }
  }

  sendOk(session, tag, 'STORE completed');
}

// ─────────────────────────────────────────────
// EXPUNGE
// ─────────────────────────────────────────────
/**
 * EXPUNGE (RFC 9051 §6.4.3) and UID EXPUNGE (RFC 4315 §2.1).
 *
 * @param uidSet  undefined → plain EXPUNGE (all \Deleted messages);
 *                a UID set → UID EXPUNGE: only \Deleted messages whose UID
 *                is in the set are removed.
 */
export async function handleExpunge(session: ImapSession, tag: string, uidSet?: string): Promise<void> {
  if (!session.selected) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }
  if (uidSet !== undefined && !isValidSequenceSet(uidSet)) {
    sendBad(session, tag, 'Invalid UID set');
    return;
  }

  // Snapshot of the current view (ascending UID = sequence-number order),
  // taken BEFORE deleting so the EXPUNGE sequence numbers can be computed.
  const allMessages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    select: { id: true, uid: true, flags: true },
  });

  const inSet = uidSet !== undefined
    ? new Set(parseSequenceSet(uidSet, allMessages.map((m: { uid: number }) => m.uid), true))
    : null;

  const toDelete = allMessages.filter(
    (m: { uid: number; flags: string[] }) =>
      m.flags.includes('\\Deleted') && (inSet === null || inSet.has(m.uid)),
  );

  if (toDelete.length > 0) {
    const mailboxId = session.mailboxId!;
    await prisma.$transaction((tx) => expunge(tx, toDelete.map((m: { id: string }) => m.id), { mailboxId }));
  }

  // RFC 9051 §7.5.1: each EXPUNGE response immediately decrements the sequence
  // numbers of all later messages, so subtract the ones already reported.
  const deletedUids = new Set(toDelete.map((m: { uid: number }) => m.uid));
  let removed = 0;
  for (const [i, msg] of allMessages.entries()) {
    if (deletedUids.has(msg.uid)) {
      sendUntagged(session, `${i + 1 - removed} EXPUNGE`);
      removed++;
    }
  }
  session.selected.exists = Math.max(0, session.selected.exists - removed);

  sendOk(session, tag, uidSet !== undefined ? 'UID EXPUNGE completed' : 'EXPUNGE completed');
}

// ─────────────────────────────────────────────
// IDLE (RFC 2177)
// ─────────────────────────────────────────────
export function handleIdle(session: ImapSession, tag: string): void {
  session.idleActive = true;
  session.idleTag = tag;
  send(session, '+ idling');
}

export function handleIdleDone(session: ImapSession): void {
  if (!session.idleActive || !session.idleTag) return;
  session.idleActive = false;
  sendOk(session, session.idleTag, 'IDLE terminated');
  session.idleTag = null;
}

// ─────────────────────────────────────────────
// NOOP
// ─────────────────────────────────────────────
export async function handleNoop(session: ImapSession, tag: string): Promise<void> {
  sendOk(session, tag, 'NOOP completed');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/**
 * Parses an IMAP sequence-set notation (RFC 3501 §9):
 *   "1,3,5:9"     — elements 1, 3, 5-9
 *   "1:*"         — everything
 *   "*"           — last element
 *
 * Returns the matching UIDs.
 *
 * @param set     sequence-set string
 * @param uids    array of all UIDs in the current folder view (sorted)
 * @param byUid   true: input is a UID set (UID FETCH/STORE/COPY/MOVE),
 *                false: input is a seq-num set (1-based positions in uids[])
 */
/** RFC 9051 §9 sequence-set syntax: seq-number / seq-range, comma-separated; "*" allowed. */
function isValidSequenceSet(set: string): boolean {
  return /^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/.test(set);
}

function parseSequenceSet(set: string, uids: number[], byUid: boolean): number[] {
  if (!uids.length) return [];

  if (byUid) {
    const maxUid = Math.max(...uids);
    const result = new Set<number>();
    for (const part of set.split(',')) {
      if (part.includes(':')) {
        const [startStr, endStr] = part.split(':') as [string, string];
        const start = startStr === '*' ? maxUid : parseInt(startStr, 10);
        const end   = endStr   === '*' ? maxUid : parseInt(endStr, 10);
        for (const uid of uids) {
          if (uid >= Math.min(start, end) && uid <= Math.max(start, end)) {
            result.add(uid);
          }
        }
      } else {
        const n = part === '*' ? maxUid : parseInt(part, 10);
        if (uids.includes(n)) result.add(n);
      }
    }
    return [...result];
  }

  // Seq-num mode: input are 1-based positions in uids[]
  const max = uids.length;
  const result = new Set<number>();
  for (const part of set.split(',')) {
    if (part.includes(':')) {
      const [startStr, endStr] = part.split(':') as [string, string];
      const start = startStr === '*' ? max : parseInt(startStr, 10);
      const end   = endStr   === '*' ? max : parseInt(endStr, 10);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (i >= 1 && i <= max) {
          const uid = uids[i - 1];
          if (uid !== undefined) result.add(uid);
        }
      }
    } else {
      const n = part === '*' ? max : parseInt(part, 10);
      if (n >= 1 && n <= max) {
        const uid = uids[n - 1];
        if (uid !== undefined) result.add(uid);
      }
    }
  }
  return [...result];
}
