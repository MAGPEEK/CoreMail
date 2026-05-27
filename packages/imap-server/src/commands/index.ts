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
  // v5.2.19: Defensive — reference auch eskapieren falls Client sie mit
  // Sonderzeichen sendet. Plus try/catch um RegExp damit ungültige Patterns
  // nicht zum 500 führen sondern alle Ordner zurückgeben.
  const escapedReference = reference.replace(/[.+^${}()|[\]\\*]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`^${escapedReference}${regexPattern}$`, 'i');
  } catch {
    // Fallback: alle Folder matchen
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
  // v5.2.19: Defensive — reference auch eskapieren falls Client sie mit
  // Sonderzeichen sendet. Plus try/catch um RegExp damit ungültige Patterns
  // nicht zum 500 führen sondern alle Ordner zurückgeben.
  const escapedReference = reference.replace(/[.+^${}()|[\]\\*]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`^${escapedReference}${regexPattern}$`, 'i');
  } catch {
    // Fallback: alle Folder matchen
    regex = /.*/;
  }

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
// CREATE — RFC 3501 §6.3.3 (Mac Mail braucht das für „Neuen Ordner" + Drafts/Sent-Upload)
// ─────────────────────────────────────────────
export async function handleCreate(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  let name = unquote(args[0] ?? '');
  if (!name) { sendBad(session, tag, 'Folder name required'); return; }
  // Trailing-Slash entfernen (Mac Mail sendet "Parent.Child." manchmal)
  name = name.replace(/[.\/]+$/, '');
  if (name.toUpperCase() === 'INBOX') {
    sendNo(session, tag, 'INBOX cannot be created');
    return;
  }
  // Doppelte Ordner verhindern
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
  // Soft-Delete der Messages, dann Folder löschen
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
  // Konflikt mit existierendem Ordner?
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
// APPEND — RFC 3501 §6.3.11 (Mac Mail lädt Drafts/Sent zum Server)
// ─────────────────────────────────────────────
// Achtung: APPEND nutzt IMAP-Literals ({size}+) für den RFC-822-Body.
// Der vollständige Body wird beim ersten Aufruf vom Server-Loop bereits
// gepuffert (parseLine sammelt ihn). Args[0] = folder, args[1] = (flags),
// args[2] = datetime?, letzter Token = literal body.
export async function handleAppend(
  session: ImapSession,
  tag: string,
  args: string[],
): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'Not authenticated'); return; }
  if (args.length < 2) { sendBad(session, tag, 'APPEND requires folder + body'); return; }
  const folderName = unquote(args[0] ?? '');
  // Body ist immer der letzte Arg (Literal-Inhalt)
  const body = args[args.length - 1] ?? '';
  // Flags-Parse: zwischen ( und )
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

  // Minimal RFC-822-Parsing — Subject + From + To extrahieren
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

  // Body extrahieren (alles nach Header-Block)
  const bodyStart = body.indexOf('\r\n\r\n') >= 0 ? body.indexOf('\r\n\r\n') + 4 : body.indexOf('\n\n') + 2;
  const bodyText = bodyStart > 0 ? body.slice(bodyStart) : '';

  // Mailbox UID hochzählen (atomar via increment)
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
  // Modseq des Mailbox erhöhen
  await prisma.mailbox.update({
    where: { id: folder.mailboxId },
    data:  { highestModSeq: { increment: 1n } },
  });

  log.info({ folderId: folder.id, uid: newUid, subject }, 'IMAP APPEND stored message');
  sendOk(session, tag, `[APPENDUID ${folder.mailbox.uidValidity} ${newUid}] APPEND completed`);
}

// ─────────────────────────────────────────────
// COPY — RFC 3501 §6.4.7 (Mac Mail "in Ordner verschieben" = COPY + STORE \Deleted + EXPUNGE)
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

  // Messages der aktuellen Folder laden
  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
  });
  // Sequence-Set parsen (UID oder Seq-Nr)
  const uids = messages.map((m) => m.uid);
  const matchedUids = parseSequenceSet(seqSet, uids, byUid);

  if (matchedUids.length === 0) {
    sendOk(session, tag, 'COPY completed (no messages matched)');
    return;
  }

  const sourceMsgs = messages.filter((m) => matchedUids.includes(m.uid));
  // UIDs reservieren
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
  // Atomic move: nur folderId updaten
  await prisma.message.updateMany({
    where: { id: { in: matched.map((m) => m.id) } },
    data:  { folderId: target.id },
  });
  sendOk(session, tag, 'MOVE completed');
}

// ─────────────────────────────────────────────
// SEARCH — RFC 3501 §6.4.4 — Mac Mail nutzt das auf jedem Folder-Open!
// ─────────────────────────────────────────────
// Minimal-Implementierung: SEARCH ALL, SEARCH UNSEEN, SEARCH SEEN,
// SEARCH FLAGGED, SEARCH UNFLAGGED, SEARCH DELETED, SEARCH UNDELETED,
// SEARCH NEW (UNSEEN+RECENT), SEARCH OLD (NOT RECENT), SEARCH RECENT.
// Ohne SEARCH zeigt Mac Mail Folders als leer an, weil es zuerst SEARCH ALL
// macht um die UID-Liste zu holen.
export async function handleSearch(
  session: ImapSession,
  tag: string,
  args: string[],
  byUid = false,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }

  // Sehr einfacher Filter-Parser
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
  // NEW/RECENT: wir tracken RECENT nicht — interpretieren als UNSEEN (gleicher Effekt für Mac Mail)
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
    // SEARCH ohne UID liefert Sequenz-Nummern (1-basiert in sortierter Folder-Reihenfolge)
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
// CLOSE — RFC 3501 §6.4.2 (Mailbox abwählen + implizit EXPUNGE)
// ─────────────────────────────────────────────
export async function handleClose(
  session: ImapSession,
  tag: string,
): Promise<void> {
  if (!session.selected) { sendNo(session, tag, 'No mailbox selected'); return; }
  // Implizit Messages mit \Deleted-Flag entfernen
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
// CHECK — RFC 3501 §6.4.1 (Server-Sync, im Wesentlichen NOOP für uns)
// ─────────────────────────────────────────────
export function handleCheck(session: ImapSession, tag: string): void {
  sendOk(session, tag, 'CHECK completed');
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
  // Auch zusammengesetzte Items wie BODY[HEADER] etc. erkennen
  const requestedBodyParts = [...dataItemsRaw.matchAll(/BODY(?:\.PEEK)?(\[[^\]]*\])/gi)]
    .map((m) => ({ raw: m[0], part: (m[1] ?? '').toUpperCase(), peek: /\.PEEK/i.test(m[0]) }));

  const messages = await prisma.message.findMany({
    where: { folderId: session.selected.folderId, deletedAt: null },
    orderBy: { uid: 'asc' },
    include: { attachments: { select: { filename: true, mimeType: true, size: true } } },
  });

  // v5.3.5: parseSequenceSet jetzt mit byUid-Parameter
  const isUidFetch = /UID FETCH/i.test(args.join(' ')) || false;
  const uids = parseSequenceSet(sequenceSet, messages.map((m) => m.uid), isUidFetch);

  for (const [seqNum, msg] of messages.entries()) {
    if (!uids.includes(msg.uid)) continue;
    const num = seqNum + 1;
    const items: string[] = [];

    // UID — Mac Mail braucht das immer für UID FETCH
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

    // BODYSTRUCTURE / BODY (ohne Argument) — RFC 3501 §7.4.2 MIME structure
    if (dataItems.has('BODYSTRUCTURE') || dataItems.has('FULL')) {
      items.push(`BODYSTRUCTURE ${buildBodyStructure(msg)}`);
    } else if (dataItems.has('BODY')) {
      // BODY ohne Argument = nicht-extensible BODYSTRUCTURE
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
        // BODY[HEADER.FIELDS (FROM TO SUBJECT)] etc. — wir liefern alle Header
        content = buildRfc5322Headers(msg);
      } else {
        content = buildRfc5322(msg);
      }
      const bodyKey = bp.peek ? `BODY${bp.part}` : `BODY${bp.part}`;
      // Beim non-PEEK setzen wir \Seen
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
// FETCH-Helpers (v5.3.5)
// ─────────────────────────────────────────────

/** RFC 3501 §6.4.5 INTERNALDATE-Format: "01-Jan-2026 12:34:56 +0000" */
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
 * Baut einen RFC-5322 / RFC-2822 konformen Mail-Body inkl. Headern.
 * Wenn HTML vorhanden ist, multipart/alternative; sonst text/plain.
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

/** RFC-5322 Header-Block (endet mit \r\n\r\n — Header-Body-Separator NICHT enthalten). */
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
 * Format für text/plain: ("text" "plain" ("charset" "utf-8") NIL NIL "8bit" SIZE LINES)
 * Wir liefern ein vereinfachtes single-part text/plain — Mac Mail akzeptiert das,
 * auch wenn der Body eigentlich HTML enthält (Body[TEXT] liefert dann den Plain-Text-
 * Anteil).
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
 * Parst eine IMAP-Sequenz-Set-Notation (RFC 3501 §9):
 *   "1,3,5:9"     — Elemente 1, 3, 5-9
 *   "1:*"         — alles
 *   "*"           — letztes Element
 *
 * Liefert die matching UIDs zurück.
 *
 * @param set     Sequence-Set-String
 * @param uids    Array aller UIDs in der aktuellen Folder-View (sortiert)
 * @param byUid   true: input ist UID-Set (UID FETCH/STORE/COPY/MOVE),
 *                false: input ist Seq-Num-Set (1-basierte Positions in uids[])
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

  // Seq-Num-Modus: input sind 1-basierte Positionen in uids[]
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
 * RFC 3501 §7.4.2 — Envelope-Structure.
 *
 * Fields (in order): date, subject, from, sender, reply-to, to, cc, bcc,
 * in-reply-to, message-id.
 *
 * KRITISCH: Address-Listen (from/sender/reply-to/to/cc/bcc) sind ENTWEDER
 *   - NIL (ohne Klammern!) wenn leer/null
 *   - (addr1 addr2 …) wenn nicht-leer — Klammern UMGEBEN die Liste
 *
 * Vorher v5.3.5 (Bug): `(${replyTo})` lieferte `(NIL)` für leere reply-to.
 * Mac Mail's ENVELOPE-Parser bricht bei `(NIL)` ab und verwirft den
 * ganzen FETCH-Response → User sieht 0 Mails im Posteingang obwohl
 * Server `* 1 EXISTS` annonciert.
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
  // String mit IMAP-Escaping (RFC 3501 §4.3 "quoted")
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const date    = q(msg.date.toUTCString());
  const subject = q(msg.subject);
  const from    = formatAddrList([{ name: msg.fromName, email: msg.fromAddr }]);
  const sender  = from;  // wenn nicht explizit gesetzt, sender = from (RFC 5322 §3.6.2)
  const replyTo = msg.replyTo ? formatAddrList([{ name: '', email: msg.replyTo }]) : 'NIL';
  const to      = msg.toAddrs.length > 0 ? formatAddrList(msg.toAddrs.map((e) => ({ name: '', email: e }))) : 'NIL';
  const cc      = 'NIL';
  const bcc     = 'NIL';
  const msgId   = msg.messageId ? q(msg.messageId) : 'NIL';
  const inReply = msg.inReplyTo ? q(msg.inReplyTo) : 'NIL';

  return `(${date} ${subject} ${from} ${sender} ${replyTo} ${to} ${cc} ${bcc} ${inReply} ${msgId})`;
}

/**
 * Formatiert eine Liste von Mail-Adressen als IMAP-Address-Struct-List.
 * Leere Liste → `NIL`. Nicht-leer → `(addr1 addr2 …)` mit umschließenden Klammern.
 */
function formatAddrList(addresses: { name: string; email: string }[]): string {
  if (addresses.length === 0) return 'NIL';
  const formatted = addresses.map(({ name, email }) => formatAddr(name, email)).join(' ');
  return `(${formatted})`;
}

function formatAddr(name: string, email: string): string {
  // RFC 3501 §7.4.2 — address structure: (personal source-route mailbox host)
  // Werte sind nstring (NIL oder "quoted") — niemals leere String-Literals "".
  const [local = '', domain = ''] = email.split('@');
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const personal = name ? q(name) : 'NIL';
  const mailbox  = local  ? q(local)  : 'NIL';
  const host     = domain ? q(domain) : 'NIL';
  return `(${personal} NIL ${mailbox} ${host})`;
}
