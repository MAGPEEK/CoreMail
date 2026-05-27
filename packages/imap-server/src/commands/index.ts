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
  sendOk(session, tag, '[CAPABILITY IMAP4rev1 IDLE CONDSTORE] LOGIN completed');
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
// LIST — v5.2.18 mit SPECIAL-USE-Flags (RFC 6154)
// ─────────────────────────────────────────────
//
// Mac Mail / Apple Mail erkennt die System-Ordner nur über SPECIAL-USE-Flags:
//   \Drafts, \Sent, \Trash, \Junk, \Archive, \Flagged, \All
// Ohne diese Flags zeigt Mac Mail nur INBOX an — die anderen Ordner sind
// zwar im LIST enthalten, werden aber von Mac Mail nicht als "Standardordner"
// erkannt und daher ausgeblendet.

/**
 * Mappt einen Folder-Namen (case-insensitive) auf das SPECIAL-USE-Flag.
 * Unterstützt sowohl englische (INBOX, Drafts, Sent, …) als auch typische
 * deutsche Aliase (Entwürfe, Gesendet, …) — falls jemand sein Schema mal
 * umbenennt.
 */
function specialUseFlag(name: string): string | null {
  const n = name.toLowerCase();
  if (n === 'inbox' || n === 'posteingang') return null; // INBOX hat KEIN SPECIAL-USE
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
  const regex = new RegExp(`^${reference}${regexPattern}$`, 'i');

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
// LSUB — Mac Mail erste Abfrage nach Login (RFC 3501 §6.3.9)
// ─────────────────────────────────────────────
// Ohne LSUB-Handler antwortet unser Server mit "BAD" → Mac Mail nimmt an,
// dass nur INBOX existiert. Wir behandeln alle Standard-Ordner als
// automatisch subscribed.
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
  const regex = new RegExp(`^${reference}${regexPattern}$`, 'i');

  const folders = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId },
    orderBy: { name: 'asc' },
  });

  for (const folder of folders) {
    if (pattern === '*' || pattern === '%' || regex.test(folder.name)) {
      // SPECIAL-USE-Flags auch im LSUB ausgeben — Mac Mail validiert
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
// Wir akzeptieren beides als no-op (alle Standard-Folder sind immer
// subscribed). Mac Mail ruft SUBSCRIBE oft selbständig auf nach LIST.
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
  // Wir erlauben Unsubscribe (no-op) — bei nächstem LSUB ist alles wieder
  // subscribed. Mac Mail kann mit dem Verhalten umgehen.
  sendOk(session, tag, 'UNSUBSCRIBE completed');
}

// ─────────────────────────────────────────────
// NAMESPACE — RFC 2342
// ─────────────────────────────────────────────
// Personal namespace mit "." als Hierarchy-Delimiter. Keine Other-User
// oder Shared-Namespaces (würden CoreMail-Shared-Mailboxes brauchen —
// folgt evtl. später).
export function handleNamespace(session: ImapSession, tag: string): void {
  sendUntagged(session, 'NAMESPACE (("" ".")) NIL NIL');
  sendOk(session, tag, 'NAMESPACE completed');
}

// ─────────────────────────────────────────────
// STATUS — RFC 3501 §6.3.10
// ─────────────────────────────────────────────
// Mac Mail nutzt STATUS um Folder-Übersicht zu refreshen ohne SELECT.
// Liefert MESSAGES, UIDNEXT, UIDVALIDITY, UNSEEN, RECENT, HIGHESTMODSEQ.
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
  const dataItems   = args.slice(1).join(' ');

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    include: { attachments: { select: { filename: true, mimeType: true, size: true } } },
  });

  const uids = parseSequenceSet(sequenceSet, messages.map((m: { uid: number }) => m.uid));

  for (const [seqNum, msg] of messages.entries()) {
    if (!uids.includes(msg.uid)) continue;
    const num = seqNum + 1;

    const envelope = buildEnvelope(msg);
    const flags = `(${msg.flags.join(' ')})`;
    const size = msg.rawSize;

    let response = `${num} FETCH (UID ${msg.uid} FLAGS ${flags} RFC822.SIZE ${size}`;

    if (dataItems.includes('ENVELOPE')) {
      response += ` ENVELOPE ${envelope}`;
    }
    if (dataItems.includes('BODYSTRUCTURE') || dataItems.includes('BODY')) {
      response += ` BODY[TEXT] {${msg.bodyText.length}}\r\n${msg.bodyText}`;
    }
    if (dataItems.includes('MODSEQ') || session.condstoreEnabled) {
      response += ` MODSEQ (${msg.modSeq})`;
    }

    response += ')';
    sendUntagged(session, response);
  }

  sendOk(session, tag, 'FETCH completed');
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

function parseSequenceSet(set: string, uids: number[]): number[] {
  if (!uids.length) return [];
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
  const date    = `"${msg.date.toUTCString()}"`;
  const subject = `"${msg.subject.replace(/"/g, '\\"')}"`;
  const from    = formatAddr(msg.fromName, msg.fromAddr);
  const replyTo = msg.replyTo ? formatAddr('', msg.replyTo) : 'NIL';
  const to      = msg.toAddrs.map((a) => formatAddr('', a)).join(' ');
  const msgId   = msg.messageId ? `"${msg.messageId}"` : 'NIL';
  const inReply = msg.inReplyTo ? `"${msg.inReplyTo}"` : 'NIL';

  return `(${date} ${subject} (${from}) (${from}) (${replyTo}) (${to}) NIL NIL ${inReply} ${msgId})`;
}

function formatAddr(name: string, email: string): string {
  const [local, domain] = email.split('@');
  return `("${name}" NIL "${local}" "${domain}")`;
}
