/**
 * LIST (RFC 9051 §6.3.9 with LIST-EXTENDED, RFC 5258), LIST-STATUS (RFC 5819),
 * SPECIAL-USE (RFC 6154), LSUB, STATUS (RFC 9051 §6.3.11, RFC 8438) and the
 * read-only QUOTA commands (RFC 9208).
 *
 * Subscriptions are not stored: every existing mailbox counts as subscribed
 * (SUBSCRIBE/UNSUBSCRIBE are accepted as no-ops).
 */
import { prisma } from '@coremail/storage';
import { tokenString, type Token } from '../server/tokenizer.js';
import { type ImapSession, sendOk, sendNo, sendBad, sendUntagged } from '../session/state.js';
import { displayNames, formatName, fromClient, resolveStoredName, toClient } from './mailbox-name.js';

const DELIMITER = '.';

/**
 * Maps a folder name (case-insensitive) to its SPECIAL-USE attribute.
 * Supports English names and typical German aliases.
 */
export function specialUseFlag(name: string): string | null {
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

/** Longest accepted LIST/LSUB pattern (reference + pattern, in characters). */
export const MAX_PATTERN_LENGTH = 1024;
/** Most patterns in one LIST-EXTENDED pattern list. */
export const MAX_PATTERNS = 32;

/**
 * Wildcard match in O(name × pattern) time and O(name) space (RFC 9051 §6.3.9):
 * "*" matches any run of characters, "%" any run without the hierarchy
 * delimiter. A dynamic programme over the name instead of a regular expression,
 * so no input can make it backtrack exponentially (e.g. "*a*a*a…X" against
 * "aaaa…" — a service-wide DoS with the former regex translation).
 */
export function wildcardMatch(pattern: string, name: string, foldCase = false): boolean {
  const p = foldCase ? pattern.toLowerCase() : pattern;
  const n = foldCase ? name.toLowerCase() : name;
  // reach[j] = 1: the pattern prefix processed so far matches the first j characters of the name.
  let reach = new Uint8Array(n.length + 1);
  let next = new Uint8Array(n.length + 1);
  reach[0] = 1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    next.fill(0);
    let alive = 0;
    if (c === '*') {
      let run = 0;
      for (let j = 0; j <= n.length; j++) { run |= reach[j] as number; next[j] = run; alive |= run; }
    } else if (c === '%') {
      let run = 0;
      for (let j = 0; j <= n.length; j++) {
        if (j > 0 && n[j - 1] === DELIMITER) run = 0;
        run |= reach[j] as number;
        next[j] = run;
        alive |= run;
      }
    } else {
      for (let j = 1; j <= n.length; j++) {
        const v = reach[j - 1] === 1 && n[j - 1] === c ? 1 : 0;
        next[j] = v;
        alive |= v;
      }
    }
    [reach, next] = [next, reach];
    if (!alive) return false;
  }
  return reach[n.length] === 1;
}

/**
 * Mailbox pattern (RFC 9051 §6.3.9): "*" matches everything, "%" everything
 * except the hierarchy delimiter. Names are case-sensitive except INBOX.
 */
export function patternMatcher(pattern: string): (name: string) => boolean {
  // A run of wildcards is one wildcard: "*" when it contains a "*", else "%".
  const p = pattern.replace(/[*%]{2,}/g, (run) => (run.includes('*') ? '*' : '%'));
  // Patterns that spell out INBOX were already canonicalised (fromClient);
  // INBOX itself also matches wildcard patterns in any letter case ("in*").
  return (name: string): boolean => wildcardMatch(p, name) || (name === 'INBOX' && wildcardMatch(p, name, true));
}

interface FolderRow { id: string; name: string }

interface ListOptions {
  subscribedOnly: boolean;
  recursiveMatch: boolean;
  specialUseOnly: boolean;
  returnSubscribed: boolean;
  returnStatus: string[] | null;
  extended: boolean;
}

const STATUS_ITEMS = ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN', 'DELETED', 'RECENT', 'HIGHESTMODSEQ', 'SIZE'];

function atomList(token: Token | undefined): string[] | null {
  if (!token || token.type !== 'list') return null;
  const out: string[] = [];
  for (const item of token.items) {
    if (item.type !== 'atom') return null;
    out.push(item.value.toUpperCase());
  }
  return out;
}

/**
 * LIST [(selection-options)] reference (pattern / "(" patterns ")") [RETURN (return-options)]
 */
export async function handleList(session: ImapSession, tag: string, tokens: Token[]): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  const opts: ListOptions = {
    subscribedOnly: false, recursiveMatch: false, specialUseOnly: false,
    returnSubscribed: false, returnStatus: null, extended: false,
  };
  let i = 0;
  if (tokens[0]?.type === 'list') {
    const selection = atomList(tokens[0]);
    if (!selection) { sendBad(session, tag, 'Invalid LIST selection options'); return; }
    opts.extended = true;
    for (const o of selection) {
      if (o === 'SUBSCRIBED') opts.subscribedOnly = true;
      else if (o === 'RECURSIVEMATCH') opts.recursiveMatch = true;
      else if (o === 'SPECIAL-USE') opts.specialUseOnly = true;
      else if (o !== 'REMOTE') { sendBad(session, tag, `Unknown LIST selection option ${o}`); return; }
    }
    // RFC 5258 §3.1: RECURSIVEMATCH needs another selection option.
    if (opts.recursiveMatch && !opts.subscribedOnly && !opts.specialUseOnly) {
      sendBad(session, tag, 'RECURSIVEMATCH requires another selection option');
      return;
    }
    i = 1;
  }
  const reference = tokenString(tokens[i]);
  const patternToken = tokens[i + 1];
  if (reference === null || !patternToken) { sendBad(session, tag, 'LIST requires a reference and a mailbox pattern'); return; }
  let patterns: string[];
  if (patternToken.type === 'list') {
    opts.extended = true;
    const list = patternToken.items.map(tokenString);
    if (list.length === 0 || list.some((p) => p === null)) { sendBad(session, tag, 'Invalid LIST pattern list'); return; }
    patterns = list as string[];
  } else {
    patterns = [tokenString(patternToken) as string];
  }
  if (patterns.length > MAX_PATTERNS || patterns.some((p) => reference.length + p.length > MAX_PATTERN_LENGTH)) {
    sendBad(session, tag, 'LIST pattern too long');
    return;
  }
  const rest = tokens.slice(i + 2);
  if (rest.length > 0) {
    if (rest[0]?.type !== 'atom' || rest[0].value.toUpperCase() !== 'RETURN' || rest[1]?.type !== 'list' || rest.length !== 2) {
      sendBad(session, tag, 'Invalid LIST arguments');
      return;
    }
    opts.extended = true;
    const items = rest[1].items;
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      const name = item?.type === 'atom' ? item.value.toUpperCase() : '';
      if (name === 'SUBSCRIBED') opts.returnSubscribed = true;
      else if (name === 'CHILDREN' || name === 'SPECIAL-USE') { /* always returned */ }
      else if (name === 'STATUS') {
        const status = atomList(items[k + 1]);
        if (!status || status.length === 0 || status.some((s) => !STATUS_ITEMS.includes(s))) {
          sendBad(session, tag, 'Invalid STATUS return option');
          return;
        }
        opts.returnStatus = status;
        k++;
      } else {
        sendBad(session, tag, `Unknown LIST return option ${name || '?'}`);
        return;
      }
    }
  }

  // RFC 9051 §6.3.9: an empty pattern asks for the hierarchy delimiter.
  if (patterns.length === 1 && patterns[0] === '') {
    sendUntagged(session, `LIST (\\Noselect) "${DELIMITER}" ""`);
    sendOk(session, tag, 'LIST completed');
    return;
  }

  const folders: FolderRow[] = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  await listFolders(session, folders, patterns.map((p) => fromClient(session, reference + p)), opts);
  sendOk(session, tag, 'LIST completed');
}

async function listFolders(session: ImapSession, folders: FolderRow[], patterns: string[], opts: ListOptions): Promise<void> {
  const matchers = patterns.map(patternMatcher);
  const matches = (name: string): boolean => matchers.some((m) => m(name));
  // Matching, hierarchy and output work on display names (legacy modified
  // UTF-7 rows decoded, see mailbox-name.ts); the stored rows stay untouched.
  const display = displayNames(folders.map((f) => f.name));
  const existing = new Map(folders.map((f) => [display.get(f.name) ?? f.name, f]));
  const names = new Set(existing.keys());
  // Parents of hierarchical names that do not exist themselves.
  for (const name of existing.keys()) {
    const parts = name.split(DELIMITER);
    for (let n = 1; n < parts.length; n++) names.add(parts.slice(0, n).join(DELIMITER));
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const descendants = (name: string): string[] => [...existing.keys()].filter((n) => n.startsWith(`${name}${DELIMITER}`));

  for (const name of sorted) {
    if (!matches(name)) continue;
    const folder = existing.get(name);
    const children = descendants(name);
    const special = specialUseFlag(name);
    const attrs: string[] = [];
    let childInfo = false;
    if (folder) {
      const selected = (!opts.specialUseOnly || special !== null);
      if (!selected) {
        if (!(opts.recursiveMatch && children.some((c) => specialUseFlag(c) !== null))) continue;
        childInfo = true;
      } else if (opts.recursiveMatch && children.length > 0) {
        childInfo = true;
      }
      if (opts.subscribedOnly || opts.returnSubscribed) attrs.push('\\Subscribed');
    } else {
      // A non-existent parent is listed only when no descendant matches the
      // pattern itself (e.g. "%" for "a.b"), or with RECURSIVEMATCH.
      if (opts.subscribedOnly && !opts.recursiveMatch) continue;
      if (opts.specialUseOnly && !opts.recursiveMatch) continue;
      if (!opts.recursiveMatch && children.some((c) => matches(c))) continue;
      if (opts.recursiveMatch) childInfo = true;
      attrs.push(opts.extended || session.imap4rev2Enabled ? '\\NonExistent' : '\\Noselect');
    }
    attrs.push(children.length > 0 || !folder ? '\\HasChildren' : '\\HasNoChildren');
    if (folder && special) attrs.push(special);
    const extra = childInfo && opts.subscribedOnly ? ' ("CHILDINFO" ("SUBSCRIBED"))' : '';
    sendUntagged(session, `LIST (${attrs.join(' ')}) "${DELIMITER}" ${formatName(session, name)}${extra}`);
    if (folder && opts.returnStatus) {
      const status = await statusLine(session, folder.id, opts.returnStatus, name);
      if (status) sendUntagged(session, status);
    }
  }
}

/** LSUB (RFC 3501 §6.3.9) — every mailbox counts as subscribed. */
export async function handleLsub(session: ImapSession, tag: string, tokens: Token[]): Promise<void> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return; }
  const reference = tokenString(tokens[0]);
  const pattern = tokenString(tokens[1]);
  if (reference === null || pattern === null || tokens.length !== 2) {
    sendBad(session, tag, 'LSUB requires a reference and a mailbox pattern');
    return;
  }
  const folders: FolderRow[] = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (reference.length + pattern.length > MAX_PATTERN_LENGTH) { sendBad(session, tag, 'LSUB pattern too long'); return; }
  const matches = patternMatcher(fromClient(session, reference + pattern));
  const display = displayNames(folders.map((f) => f.name));
  for (const folder of folders) {
    const name = display.get(folder.name) ?? folder.name;
    if (!matches(name)) continue;
    // SPECIAL-USE attributes in LSUB as well — Mac Mail validates them.
    const flags: string[] = ['\\HasNoChildren'];
    const special = specialUseFlag(name);
    if (special) flags.push(special);
    sendUntagged(session, `LSUB (${flags.join(' ')}) "${DELIMITER}" ${formatName(session, name)}`);
  }
  sendOk(session, tag, 'LSUB completed');
}

/** Untagged STATUS line for a folder (null when the folder vanished). */
async function statusLine(session: ImapSession, folderId: string, items: string[], shownName?: string): Promise<string | null> {
  const folder = await prisma.folder.findFirst({ where: { id: folderId }, include: { mailbox: true } });
  if (!folder) return null;
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
  const name = shownName !== undefined ? formatName(session, shownName) : toClient(session, folder.name);
  return `STATUS ${name} (${parts.join(' ')})`;
}

/**
 * STATUS <mailbox> (<items>) — RFC 9051 §6.3.11. Returns false when the
 * command failed (the caller completes a successful STATUS).
 */
export async function runStatus(session: ImapSession, tag: string, args: string[]): Promise<boolean> {
  if (!session.mailboxId) { sendNo(session, tag, 'No mailbox'); return false; }
  // The tokenizer groups the parenthesised list into one argument.
  const list = /^\((.*)\)$/s.exec(args[1] ?? '');
  if (!args[0] || !list || args.length !== 2) {
    sendBad(session, tag, 'STATUS requires a mailbox and a parenthesised item list');
    return false;
  }
  const items = (list[1] ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  const unknown = items.find((i) => !STATUS_ITEMS.includes(i));
  if (items.length === 0 || unknown) {
    sendBad(session, tag, unknown ? `Unknown STATUS item ${unknown}` : 'Empty STATUS item list');
    return false;
  }
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: session.mailboxId, name: await resolveStoredName(session, args[0]) },
    select: { id: true },
  });
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return false; }
  // RFC 7162 §3.1: STATUS HIGHESTMODSEQ is a CONDSTORE-enabling command.
  if (items.includes('HIGHESTMODSEQ')) session.condstoreEnabled = true;
  // The response names the mailbox the way the client asked for it.
  const line = await statusLine(session, folder.id, items, fromClient(session, args[0]));
  if (!line) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return false; }
  sendUntagged(session, line);
  return true;
}

// ─── QUOTA (RFC 9208, read-only) ────────────────────────────────────────────
// One quota root "" per account with the STORAGE resource (KiB): usage is the
// size of all messages, the limit the user's quotaBytes.

async function quotaLine(session: ImapSession): Promise<string> {
  const user = await prisma.user.findFirst({ where: { id: session.userId ?? '' }, select: { quotaBytes: true } });
  const folders = await prisma.folder.findMany({ where: { mailboxId: session.mailboxId ?? '' }, select: { id: true } });
  const rows = await prisma.message.findMany({
    where: { folderId: { in: folders.map((f) => f.id) }, deletedAt: null },
    select: { rawSize: true },
  });
  const used = rows.reduce((sum, m) => sum + m.rawSize, 0);
  const limit = user?.quotaBytes ? BigInt(user.quotaBytes) : 0n;
  const usedKb = Math.ceil(used / 1024);
  return limit <= 0n
    ? `QUOTA "" ()`
    : `QUOTA "" (STORAGE ${usedKb} ${limit / 1024n})`;
}

export async function handleGetQuotaRoot(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1 || !session.mailboxId) { sendBad(session, tag, 'GETQUOTAROOT requires a mailbox'); return; }
  const name = await resolveStoredName(session, args[0] as string);
  const folder = await prisma.folder.findFirst({ where: { mailboxId: session.mailboxId, name }, select: { id: true } });
  if (!folder) { sendNo(session, tag, '[NONEXISTENT] Mailbox does not exist'); return; }
  sendUntagged(session, `QUOTAROOT ${toClient(session, name)} ""`);
  sendUntagged(session, await quotaLine(session));
  sendOk(session, tag, 'GETQUOTAROOT completed');
}

export async function handleGetQuota(session: ImapSession, tag: string, args: string[]): Promise<void> {
  if (args.length !== 1) { sendBad(session, tag, 'GETQUOTA requires a quota root'); return; }
  if (args[0] !== '') { sendNo(session, tag, '[NONEXISTENT] No such quota root'); return; }
  sendUntagged(session, await quotaLine(session));
  sendOk(session, tag, 'GETQUOTA completed');
}

export function handleSetQuota(session: ImapSession, tag: string): void {
  sendNo(session, tag, '[NOPERM] Quotas are managed by the administrator');
}
