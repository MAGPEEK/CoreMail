import { prisma } from '@coremail/storage';
import { verifyPassword, createLogger } from '@coremail/core';
import {
  type ImapSession,
  sendOk, sendNo, sendBad, sendUntagged, send,
} from '../session/state.js';

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

  const username = unquote(args[0] ?? '');
  const password = unquote(args[1] ?? '');

  const user = await prisma.user.findFirst({
    where: { email: username.toLowerCase(), active: true },
    include: { mailbox: true },
  });

  if (!user) {
    sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials');
    return;
  }

  // Check local password
  let authenticated = false;
  if (user.passwordHash) {
    authenticated = await verifyPassword(password, user.passwordHash);
  }

  // Check app password
  if (!authenticated) {
    const appPasswords = await prisma.appPassword.findMany({ where: { userId: user.id } });
    for (const ap of appPasswords) {
      if (await verifyPassword(password, ap.hash)) {
        authenticated = true;
        await prisma.appPassword.update({
          where: { id: ap.id },
          data: { lastUsedAt: new Date() },
        });
        break;
      }
    }
  }

  if (!authenticated) {
    log.warn({ email: username }, 'IMAP login failed');
    sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials');
    return;
  }

  session.state = 'AUTHENTICATED';
  session.userId = user.id;
  session.mailboxId = user.mailbox?.id ?? null;
  log.info({ email: username }, 'IMAP login success');
  sendOk(session, tag, '[CAPABILITY IMAP4rev1 IMAP4rev2 IDLE CONDSTORE MOVE UNSELECT UIDPLUS] LOGIN completed');
}

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
      const flags: string[] = ['\\HasNoChildren'];
      const special = specialUseFlag(folder.name);
      if (special) flags.push(special);
      sendUntagged(session, `LIST (${flags.join(' ')}) "." "${folder.name}"`);
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
      sendUntagged(session, `LSUB (${flags.join(' ')}) "." "${folder.name}"`);
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

  const folderName = unquote(args[0] ?? '');
  const itemsRaw = (args[1] ?? '').replace(/[()]/g, '').toUpperCase();
  const items = itemsRaw.split(/\s+/).filter(Boolean);

  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: folderName },
    include: { mailbox: true },
  });
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }

  const [messages, unseen] = await Promise.all([
    prisma.message.count({ where: { folderId: folder.id, deletedAt: null } }),
    prisma.message.count({ where: { folderId: folder.id, deletedAt: null, NOT: { flags: { has: '\\Seen' } } } }),
  ]);

  const parts: string[] = [];
  for (const item of items) {
    switch (item) {
      case 'MESSAGES':       parts.push(`MESSAGES ${messages}`); break;
      case 'UIDNEXT':        parts.push(`UIDNEXT ${folder.mailbox.uidNext}`); break;
      case 'UIDVALIDITY':    parts.push(`UIDVALIDITY ${folder.mailbox.uidValidity}`); break;
      case 'UNSEEN':         parts.push(`UNSEEN ${unseen}`); break;
      case 'RECENT':         parts.push('RECENT 0'); break;
      case 'HIGHESTMODSEQ':  parts.push(`HIGHESTMODSEQ ${folder.mailbox.highestModSeq}`); break;
      case 'SIZE':           parts.push('SIZE 0'); break;
    }
  }
  sendUntagged(session, `STATUS "${folder.name}" (${parts.join(' ')})`);
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
// Note: APPEND uses IMAP literals ({size}+) for the RFC 822 body.
// The complete body is already buffered by the server loop on the first
// call (parseLine collects it). Args[0] = folder, args[1] = (flags),
// args[2] = datetime?, last token = literal body.
export async function handleAppend(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  if (args.length < 2) { sendBad(session, tag, 'APPEND requires folder + body'); return; }
  const folderName = unquote(args[0] ?? '');
  // Body is always the last arg (literal content)
  const body = args[args.length - 1] ?? '';
  // Parse flags: between ( and )
  let flags: string[] = [];
  for (const a of args.slice(1, -1)) {
    const m = /^\((.*)\)$/.exec(a);
    if (m && m[1]) flags = m[1].split(/\s+/).filter(Boolean);
  }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: folderName },
    include: { mailbox: true },
  });
  if (!folder) {
    sendNo(session, tag, '[TRYCREATE] Mailbox does not exist');
    return;
  }

  // Minimal RFC 822 parsing — extract Subject + From + To
  const headerBlock = body.split(/\r?\n\r?\n/)[0] ?? '';
  const getHeader = (name: string): string | undefined => {
    const re = new RegExp(`^${name}:\\s*(.+)$`, 'mi');
    const m = re.exec(headerBlock);
    return m?.[1]?.trim();
  };
  const subject  = getHeader('subject')   ?? '';
  const fromAddr = getHeader('from')      ?? '';
  const toRaw    = getHeader('to')        ?? '';
  const toAddrs  = toRaw ? toRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const msgId    = getHeader('message-id') ?? '';

  // Extract body (everything after the header block)
  const bodyStart = body.indexOf('\r\n\r\n') >= 0 ? body.indexOf('\r\n\r\n') + 4 : body.indexOf('\n\n') + 2;
  const bodyText = bodyStart > 0 ? body.slice(bodyStart) : '';

  // Increment mailbox UID (atomically via increment)
  const updated = await prisma.mailbox.update({
    where: { id: folder.mailboxId },
    data:  { uidNext: { increment: 1 } },
    select: { uidNext: true, highestModSeq: true },
  });
  const newUid = updated.uidNext - 1;

  await prisma.message.create({
    data: {
      uid:       newUid,
      modSeq:    updated.highestModSeq + 1n,
      folderId:  folder.id,
      subject,
      fromAddr,
      fromName:  '',
      toAddrs,
      ccAddrs:   [],
      bccAddrs:  [],
      date:      new Date(),
      rawSize:   Buffer.byteLength(body, 'utf8'),
      bodyText,
      bodyHtml:  '',
      flags,
      messageId: msgId,
    },
  });
  // Increment the mailbox modseq
  await prisma.mailbox.update({
    where: { id: folder.mailboxId },
    data:  { highestModSeq: { increment: 1n } },
  });

  log.info({ folderId: folder.id, uid: newUid, subject }, 'IMAP APPEND stored message');
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
  // Reserve UIDs
  await prisma.mailbox.update({
    where: { id: target.mailboxId },
    data:  { uidNext: { increment: sourceMsgs.length } },
  });
  const targetStartUid = target.mailbox.uidNext;
  const newUids: number[] = [];
  for (let i = 0; i < sourceMsgs.length; i++) {
    const src = sourceMsgs[i];
    if (!src) continue;
    const newUid = targetStartUid + i;
    newUids.push(newUid);
    await prisma.message.create({
      data: {
        uid:        newUid,
        modSeq:     target.mailbox.highestModSeq + 1n,
        folderId:   target.id,
        subject:    src.subject,
        fromAddr:   src.fromAddr,
        fromName:   src.fromName,
        toAddrs:    src.toAddrs,
        ccAddrs:    src.ccAddrs,
        bccAddrs:   src.bccAddrs,
        date:       src.date,
        rawSize:    src.rawSize,
        bodyText:   src.bodyText,
        bodyHtml:   src.bodyHtml,
        flags:      src.flags,
        messageId:  src.messageId,
      },
    });
  }
  await prisma.mailbox.update({
    where: { id: target.mailboxId },
    data:  { highestModSeq: { increment: 1n } },
  });

  const copyUid = `[COPYUID ${target.mailbox.uidValidity} ${matchedUids.join(',')} ${newUids.join(',')}]`;
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
    select: { id: true },
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
  // Atomic move: only update folderId
  await prisma.message.updateMany({
    where: { id: { in: matched.map((m) => m.id) } },
    data:  { folderId: target.id },
  });
  sendOk(session, tag, 'MOVE completed');
}

// ─────────────────────────────────────────────
// SEARCH — RFC 3501 §6.4.4 — Mac Mail uses this on every folder open!
// ─────────────────────────────────────────────
// Minimal implementation: SEARCH ALL, SEARCH UNSEEN, SEARCH SEEN,
// SEARCH FLAGGED, SEARCH UNFLAGGED, SEARCH DELETED, SEARCH UNDELETED,
// SEARCH NEW (UNSEEN+RECENT), SEARCH OLD (NOT RECENT), SEARCH RECENT.
// Without SEARCH, Mac Mail shows folders as empty because it first runs SEARCH ALL
// to fetch the UID list.
export async function handleSearch(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }

  // Very simple filter parser
  const criteria = args.map((a) => a.toUpperCase());
  const where: Record<string, unknown> = {
    folderId:  session.selected.folderId,
    deletedAt: null,
  };
  if (criteria.includes('UNSEEN'))    Object.assign(where, { NOT: { flags: { has: '\\Seen' } } });
  if (criteria.includes('SEEN'))      Object.assign(where, { flags: { has: '\\Seen' } });
  if (criteria.includes('FLAGGED'))   Object.assign(where, { flags: { has: '\\Flagged' } });
  if (criteria.includes('UNFLAGGED')) Object.assign(where, { NOT: { flags: { has: '\\Flagged' } } });
  if (criteria.includes('DELETED'))   Object.assign(where, { flags: { has: '\\Deleted' } });
  if (criteria.includes('UNDELETED')) Object.assign(where, { NOT: { flags: { has: '\\Deleted' } } });
  // NEW/RECENT: we do not track RECENT — interpret as UNSEEN (same effect for Mac Mail)
  if (criteria.includes('NEW') || criteria.includes('RECENT')) {
    Object.assign(where, { NOT: { flags: { has: '\\Seen' } } });
  }

  const messages = await prisma.message.findMany({
    where,
    select: { uid: true },
    orderBy: { uid: 'asc' },
  });

  if (byUid) {
    const uids = messages.map((m) => m.uid);
    sendUntagged(session, `SEARCH${uids.length ? ' ' + uids.join(' ') : ''}`);
    sendOk(session, tag, 'UID SEARCH completed');
  } else {
    // SEARCH without UID returns sequence numbers (1-based in sorted folder order)
    const allMessages = await prisma.message.findMany({
      where: { folderId: session.selected.folderId, deletedAt: null },
      select: { uid: true },
      orderBy: { uid: 'asc' },
    });
    const matchedUids = new Set(messages.map((m) => m.uid));
    const seqNums: number[] = [];
    allMessages.forEach((m, idx) => {
      if (matchedUids.has(m.uid)) seqNums.push(idx + 1);
    });
    sendUntagged(session, `SEARCH${seqNums.length ? ' ' + seqNums.join(' ') : ''}`);
    sendOk(session, tag, 'SEARCH completed');
  }
}

// ─────────────────────────────────────────────
// CLOSE — RFC 3501 §6.4.2 (deselect mailbox + implicit EXPUNGE)
// ─────────────────────────────────────────────
export async function handleClose(
  session: ImapSession,
  tag: string,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  // Implicitly remove messages with the \Deleted flag
  await prisma.message.updateMany({
    where: {
      folderId:  session.selected.folderId,
      deletedAt: null,
      flags:     { has: '\\Deleted' },
    },
    data: { deletedAt: new Date() },
  });
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
 * Internal login verification for AUTHENTICATE PLAIN/LOGIN.
 * Reuses handleLogin-style verification but doesn't go through args parsing.
 */
async function loginUser(session: ImapSession, tag: string, username: string, password: string): Promise<void> {
  let email = username.trim().toLowerCase();
  // Bare username → @primary-domain
  if (!email.includes('@')) {
    const primaryDomain = await prisma.domain.findFirst({
      where: { primary: true, active: true }, select: { name: true },
    }).catch(() => null);
    if (primaryDomain) email = `${email}@${primaryDomain.name}`;
  }
  const user = await prisma.user.findFirst({
    where: { email, active: true },
    include: { mailbox: true },
  });
  if (!user) { sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials'); return; }

  let authenticated = false;
  if (user.passwordHash) {
    authenticated = await verifyPassword(password, user.passwordHash).catch(() => false);
  }
  if (!authenticated) {
    const apps = await prisma.appPassword.findMany({ where: { userId: user.id } });
    for (const ap of apps) {
      if (await verifyPassword(password, ap.hash).catch(() => false)) {
        authenticated = true;
        void prisma.appPassword.update({
          where: { id: ap.id }, data: { lastUsedAt: new Date() },
        }).catch(() => { /* ignore */ });
        break;
      }
    }
  }
  if (!authenticated) {
    log.warn({ email }, 'IMAP AUTHENTICATE failed');
    sendNo(session, tag, '[AUTHENTICATIONFAILED] Invalid credentials');
    return;
  }
  session.state = 'AUTHENTICATED';
  session.userId = user.id;
  session.mailboxId = user.mailbox?.id ?? null;
  log.info({ email }, 'IMAP AUTHENTICATE success');
  sendOk(session, tag, '[CAPABILITY IMAP4rev1 IMAP4rev2 IDLE CONDSTORE MOVE UNSELECT] AUTHENTICATE completed');
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
// FETCH (simplified — returns envelope + flags)
// ─────────────────────────────────────────────
export async function handleFetch(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.selected) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const sequenceSet = args[0] ?? '1:*';
  const dataItemsRaw = args.slice(1).join(' ');
  // Tokenize data items: split on whitespace, strip parens, uppercase
  const dataItems = new Set(
    dataItemsRaw.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean).map((s) => s.toUpperCase())
  );
  // Also recognize compound items like BODY[HEADER] etc.
  const requestedBodyParts = [...dataItemsRaw.matchAll(/BODY(?:\.PEEK)?(\[[^\]]*\])/gi)]
    .map((m) => ({ raw: m[0], part: (m[1] ?? '').toUpperCase(), peek: /\.PEEK/i.test(m[0]) }));

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    include: { attachments: { select: { filename: true, mimeType: true, size: true } } },
  });

  // v5.3.5: parseSequenceSet now takes a byUid parameter
  const isUidFetch = /UID FETCH/i.test(args.join(' ')) || false;
  const uids = parseSequenceSet(sequenceSet, messages.map((m) => m.uid), isUidFetch);

  for (const [seqNum, msg] of messages.entries()) {
    if (!uids.includes(msg.uid)) continue;
    const num = seqNum + 1;
    const items: string[] = [];

    // UID — Mac Mail always needs this for UID FETCH
    items.push(`UID ${msg.uid}`);

    // FLAGS
    if (dataItems.has('FLAGS') || dataItems.has('FAST') || dataItems.has('ALL') || dataItems.has('FULL')) {
      items.push(`FLAGS (${msg.flags.join(' ')})`);
    }

    // INTERNALDATE — RFC 3501 §6.4.5 "DD-Mon-YYYY HH:MM:SS +ZZZZ"
    if (dataItems.has('INTERNALDATE') || dataItems.has('ALL') || dataItems.has('FAST') || dataItems.has('FULL')) {
      items.push(`INTERNALDATE "${formatInternalDate(msg.createdAt ?? msg.date)}"`);
    }

    // RFC822.SIZE
    if (dataItems.has('RFC822.SIZE') || dataItems.has('ALL') || dataItems.has('FAST') || dataItems.has('FULL')) {
      items.push(`RFC822.SIZE ${msg.rawSize}`);
    }

    // ENVELOPE
    if (dataItems.has('ENVELOPE') || dataItems.has('ALL') || dataItems.has('FULL')) {
      items.push(`ENVELOPE ${buildEnvelope(msg)}`);
    }

    // BODYSTRUCTURE / BODY (without argument) — RFC 3501 §7.4.2 MIME structure
    if (dataItems.has('BODYSTRUCTURE') || dataItems.has('FULL')) {
      items.push(`BODYSTRUCTURE ${buildBodyStructure(msg)}`);
    } else if (dataItems.has('BODY')) {
      // BODY without argument = non-extensible BODYSTRUCTURE
      items.push(`BODY ${buildBodyStructure(msg, false)}`);
    }

    // BODY[*] / BODY.PEEK[*] / RFC822 / RFC822.HEADER / RFC822.TEXT
    for (const bp of requestedBodyParts) {
      const partName = bp.part.replace(/\[|\]/g, '').toUpperCase();
      let content = '';
      if (partName === '' || partName === '0') {
        content = buildRfc5322(msg);
      } else if (partName === 'HEADER') {
        content = buildRfc5322Headers(msg);
      } else if (partName === 'TEXT') {
        content = msg.bodyText || '';
      } else if (partName.startsWith('HEADER.FIELDS')) {
        // BODY[HEADER.FIELDS (FROM TO SUBJECT)] etc. — we return all headers
        content = buildRfc5322Headers(msg);
      } else {
        content = buildRfc5322(msg);
      }
      const bodyKey = bp.peek ? `BODY${bp.part}` : `BODY${bp.part}`;
      // For non-PEEK we set \Seen
      if (!bp.peek && !msg.flags.includes('\\Seen')) {
        void prisma.message.update({
          where: { id: msg.id },
          data:  { flags: [...msg.flags, '\\Seen'] },
        }).catch(() => { /* ignore */ });
      }
      items.push(`${bodyKey} {${Buffer.byteLength(content, 'utf8')}}\r\n${content}`);
    }
    // RFC822 / RFC822.HEADER / RFC822.TEXT (legacy aliases)
    if (dataItems.has('RFC822')) {
      const full = buildRfc5322(msg);
      items.push(`RFC822 {${Buffer.byteLength(full, 'utf8')}}\r\n${full}`);
    }
    if (dataItems.has('RFC822.HEADER')) {
      const hdr = buildRfc5322Headers(msg);
      items.push(`RFC822.HEADER {${Buffer.byteLength(hdr, 'utf8')}}\r\n${hdr}`);
    }
    if (dataItems.has('RFC822.TEXT')) {
      const txt = msg.bodyText || '';
      items.push(`RFC822.TEXT {${Buffer.byteLength(txt, 'utf8')}}\r\n${txt}`);
    }

    // MODSEQ (CONDSTORE)
    if (dataItems.has('MODSEQ') || session.condstoreEnabled) {
      items.push(`MODSEQ (${msg.modSeq})`);
    }

    sendUntagged(session, `${num} FETCH (${items.join(' ')})`);
  }

  sendOk(session, tag, 'FETCH completed');
}

// ─────────────────────────────────────────────
// FETCH helpers (v5.3.5)
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

/**
 * Builds an RFC 5322 / RFC 2822 compliant mail body including headers.
 * If HTML is present, multipart/alternative; otherwise text/plain.
 */
function buildRfc5322(msg: {
  date: Date; subject: string; fromAddr: string; fromName: string;
  toAddrs: string[]; ccAddrs: string[]; bccAddrs: string[];
  bodyText: string; bodyHtml: string;
  messageId: string | null; inReplyTo: string | null; replyTo: string | null;
}): string {
  const headers = buildRfc5322Headers(msg);
  const hasHtml = !!msg.bodyHtml && msg.bodyHtml.length > 0;
  const hasText = !!msg.bodyText && msg.bodyText.length > 0;

  if (hasHtml && hasText) {
    // multipart/alternative
    const boundary = `----=_CoreMail_${Date.now().toString(36)}`;
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.bodyText,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.bodyHtml,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return `${headers}MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${parts}`;
  }
  if (hasHtml) {
    return `${headers}MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${msg.bodyHtml}`;
  }
  return `${headers}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${msg.bodyText || ''}`;
}

/** RFC 5322 header block (ends with \r\n\r\n — header/body separator NOT included). */
function buildRfc5322Headers(msg: {
  date: Date; subject: string; fromAddr: string; fromName: string;
  toAddrs: string[]; ccAddrs: string[]; bccAddrs: string[];
  messageId: string | null; inReplyTo: string | null; replyTo: string | null;
}): string {
  const fromHeader = msg.fromName ? `"${msg.fromName}" <${msg.fromAddr}>` : msg.fromAddr;
  const lines: string[] = [
    `Date: ${msg.date.toUTCString().replace('GMT', '+0000')}`,
    `From: ${fromHeader}`,
    `Subject: ${msg.subject}`,
  ];
  if (msg.toAddrs.length > 0)  lines.push(`To: ${msg.toAddrs.join(', ')}`);
  if (msg.ccAddrs.length > 0)  lines.push(`Cc: ${msg.ccAddrs.join(', ')}`);
  if (msg.replyTo)             lines.push(`Reply-To: ${msg.replyTo}`);
  if (msg.messageId)           lines.push(`Message-ID: ${msg.messageId}`);
  if (msg.inReplyTo)           lines.push(`In-Reply-To: ${msg.inReplyTo}`);
  return lines.join('\r\n') + '\r\n';
}

/**
 * RFC 3501 §7.4.2 BODYSTRUCTURE.
 * Format for text/plain: ("text" "plain" ("charset" "utf-8") NIL NIL "8bit" SIZE LINES)
 * We return a simplified single-part text/plain — Mac Mail accepts this,
 * even if the body actually contains HTML (Body[TEXT] then returns the plain-text
 * part).
 */
function buildBodyStructure(msg: { bodyText: string; bodyHtml: string; rawSize: number },
                            _extensible = true): string {
  const hasHtml = !!msg.bodyHtml && msg.bodyHtml.length > 0;
  const hasText = !!msg.bodyText && msg.bodyText.length > 0;

  if (hasHtml && hasText) {
    const textSize  = Buffer.byteLength(msg.bodyText, 'utf8');
    const textLines = msg.bodyText.split('\n').length;
    const htmlSize  = Buffer.byteLength(msg.bodyHtml, 'utf8');
    const htmlLines = msg.bodyHtml.split('\n').length;
    return `(("text" "plain" ("charset" "utf-8") NIL NIL "8bit" ${textSize} ${textLines})("text" "html" ("charset" "utf-8") NIL NIL "8bit" ${htmlSize} ${htmlLines}) "alternative")`;
  }
  if (hasHtml) {
    const size  = Buffer.byteLength(msg.bodyHtml, 'utf8');
    const lines = msg.bodyHtml.split('\n').length;
    return `("text" "html" ("charset" "utf-8") NIL NIL "8bit" ${size} ${lines})`;
  }
  const text  = msg.bodyText || '';
  const size  = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n').length;
  return `("text" "plain" ("charset" "utf-8") NIL NIL "8bit" ${size} ${lines})`;
}

// ─────────────────────────────────────────────
// STORE — set/add/remove flags
// ─────────────────────────────────────────────
export async function handleStore(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.selected) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const sequenceSet = args[0] ?? '';
  const command     = (args[1] ?? '').toUpperCase();
  const flagsStr    = args.slice(2).join(' ').replace(/[()]/g, '');
  const newFlags    = flagsStr.split(/\s+/).filter(Boolean);

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    select: { id: true, uid: true, flags: true, modSeq: true },
    orderBy: { uid: 'asc' },
  });

  const uids = parseSequenceSet(sequenceSet, messages.map((m: { uid: number }) => m.uid));

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

    const updatedMsg = await prisma.message.update({
      where: { id: msg.id },
      data: { flags: updatedFlags, modSeq: { increment: 1 } },
    });

    if (!command.includes('SILENT')) {
      const num = seqNum + 1;
      sendUntagged(session, `${num} FETCH (FLAGS (${updatedFlags.join(' ')}) MODSEQ (${updatedMsg.modSeq}))`);
    }
  }

  sendOk(session, tag, 'STORE completed');
}

// ─────────────────────────────────────────────
// EXPUNGE
// ─────────────────────────────────────────────
export async function handleExpunge(session: ImapSession, tag: string): Promise<void> {
  if (!session.selected) {
    sendBad(session, tag, 'No mailbox selected');
    return;
  }

  const toDelete = await prisma.message.findMany({
    where: {
      folderId: session.selected.folderId,
      flags: { has: '\\Deleted' },
      deletedAt: null,
    },
    orderBy: { uid: 'desc' },
    select: { id: true, uid: true },
  });

  for (const msg of toDelete) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { deletedAt: new Date() },
    });
  }

  const allMessages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    select: { uid: true },
  });

  for (const [i, msg] of allMessages.entries()) {
    if (toDelete.some((d: { uid: number }) => d.uid === msg.uid)) {
      sendUntagged(session, `${i + 1} EXPUNGE`);
    }
  }

  sendOk(session, tag, 'EXPUNGE completed');
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
function parseSequenceSet(set: string, uids: number[], byUid = true): number[] {
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

/**
 * RFC 3501 §7.4.2 — envelope structure.
 *
 * Fields (in order): date, subject, from, sender, reply-to, to, cc, bcc,
 * in-reply-to, message-id.
 *
 * CRITICAL: address lists (from/sender/reply-to/to/cc/bcc) are EITHER
 *   - NIL (without parentheses!) when empty/null
 *   - (addr1 addr2 …) when non-empty — parentheses SURROUND the list
 *
 * Before v5.3.5 (bug): `(${replyTo})` yielded `(NIL)` for an empty reply-to.
 * Mac Mail's ENVELOPE parser aborts on `(NIL)` and discards the
 * whole FETCH response → user sees 0 mails in the inbox although the
 * server announces `* 1 EXISTS`.
 */
function buildEnvelope(msg: {
  date: Date;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
}): string {
  // String with IMAP escaping (RFC 3501 §4.3 "quoted")
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const date    = q(msg.date.toUTCString());
  const subject = q(msg.subject);
  const from    = formatAddrList([{ name: msg.fromName, email: msg.fromAddr }]);
  const sender  = from;  // if not set explicitly, sender = from (RFC 5322 §3.6.2)
  const replyTo = msg.replyTo ? formatAddrList([{ name: '', email: msg.replyTo }]) : 'NIL';
  const to      = msg.toAddrs.length > 0 ? formatAddrList(msg.toAddrs.map((e) => ({ name: '', email: e }))) : 'NIL';
  const cc      = 'NIL';
  const bcc     = 'NIL';
  const msgId   = msg.messageId ? q(msg.messageId) : 'NIL';
  const inReply = msg.inReplyTo ? q(msg.inReplyTo) : 'NIL';

  return `(${date} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReply} ${msgId})`;
}

/**
 * Formats a list of mail addresses as an IMAP address-struct list.
 * Empty list → `NIL`. Non-empty → `(addr1 addr2 …)` with surrounding parentheses.
 */
function formatAddrList(addresses: { name: string; email: string }[]): string {
  if (addresses.length === 0) return 'NIL';
  const formatted = addresses.map(({ name, email }) => formatAddr(name, email)).join(' ');
  return `(${formatted})`;
}

function formatAddr(name: string, email: string): string {
  // RFC 3501 §7.4.2 — address structure: (personal source-route mailbox host)
  // Values are nstring (NIL or "quoted") — never empty string literals "".
  const [local = '', domain = ''] = email.split('@');
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const personal = name ? q(name) : 'NIL';
  const mailbox  = local  ? q(local)  : 'NIL';
  const host     = domain ? q(domain) : 'NIL';
  return `(${personal} NIL ${mailbox} ${host})`;
}
