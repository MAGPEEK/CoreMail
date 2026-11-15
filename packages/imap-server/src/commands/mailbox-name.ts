/**
 * Mailbox names at the protocol boundary.
 *
 * Folder names are stored as UTF-8. An IMAP4rev1 client exchanges them in
 * modified UTF-7 (RFC 3501 §5.1.3); after "ENABLE IMAP4rev2" names are sent
 * and accepted as UTF-8 (RFC 9051 §5.1). INBOX is case-insensitive
 * (RFC 9051 §5.1), so any spelling — also as the first level of a
 * hierarchical name ("inbox.Sub") — maps to "INBOX".
 * Rows written by ≤ 7.0.0 may hold the modified UTF-7 form; they are never
 * rewritten and are resolved/displayed through legacyDecoded() below.
 */
import type { ImapSession } from '../session/state.js';
import { prisma } from '@coremail/storage';
import { mailboxName } from '../fetch/imap-string.js';

const DELIMITER = '.';

/** Encodes a name in modified UTF-7 (RFC 3501 §5.1.3). */
export function encodeMutf7(name: string): string {
  let out = '';
  let pending = '';
  const flush = (): void => {
    if (!pending) return;
    const utf16 = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) utf16.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    pending = '';
  };
  for (const ch of name) {
    const code = ch.codePointAt(0) as number;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else {
      pending += ch;
    }
  }
  flush();
  return out;
}

/** Decodes modified UTF-7; null when the input is not valid modified UTF-7. */
export function decodeMutf7(name: string): string | null {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string;
    if (ch !== '&') {
      out += ch;
      continue;
    }
    const end = name.indexOf('-', i + 1);
    if (end === -1) return null;
    const b64 = name.slice(i + 1, end);
    i = end;
    if (b64 === '') { out += '&'; continue; }
    if (!/^[A-Za-z0-9+,]+$/.test(b64)) return null;
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
    for (let j = 0; j < bytes.length; j += 2) out += String.fromCharCode(bytes.readUInt16BE(j));
  }
  return out;
}

/** Maps every spelling of INBOX (also as the first hierarchy level) to "INBOX". */
export function canonicalInbox(name: string): string {
  if (name.length >= 5 && name.slice(0, 5).toUpperCase() === 'INBOX' && (name.length === 5 || name[5] === DELIMITER)) {
    return `INBOX${name.slice(5)}`;
  }
  return name;
}

/** Converts a mailbox name sent by the client into the stored (UTF-8) form. */
export function fromClient(session: ImapSession, raw: string): string {
  // A rev1 client sends modified UTF-7; names that are not valid modified
  // UTF-7 (e.g. raw UTF-8 from a lenient client) are taken as they are.
  const decoded = session.imap4rev2Enabled ? raw : (decodeMutf7(raw) ?? raw);
  return canonicalInbox(decoded);
}

/**
 * Legacy rows: up to v7.0.0 IMAP CREATE/RENAME stored the name exactly as a
 * rev1 client sent it, i.e. non-ASCII names in modified UTF-7
 * ("Entw&APw-rfe"). Those rows are never rewritten: a stored name that is the
 * canonical modified UTF-7 encoding of a different name is shown as that name,
 * so a rev1 client sees exactly the mailbox name it saw before the upgrade
 * (encoding the decoded name gives back the stored octets) and a rev2 client
 * sees UTF-8. Returns null for every other stored name.
 */
export function legacyDecoded(stored: string): string | null {
  if (!stored.includes('&') || !/^[\x20-\x7e]*$/.test(stored)) return null;
  const decoded = decodeMutf7(stored);
  if (decoded === null || decoded === stored || encodeMutf7(decoded) !== stored) return null;
  return decoded;
}

/** The mailbox name a stored folder name stands for (see {@link legacyDecoded}). */
export function displayName(stored: string): string {
  return legacyDecoded(stored) ?? stored;
}

/**
 * Display names of all folders of a mailbox. When a legacy row would show the
 * same name as another row (e.g. "Entw&APw-rfe" next to "Entwürfe"), the legacy
 * row keeps its stored name, so both stay listed and reachable.
 */
export function displayNames(stored: string[]): Map<string, string> {
  const all = new Set(stored);
  const out = new Map<string, string>();
  for (const name of stored) {
    const decoded = legacyDecoded(name);
    out.set(name, decoded !== null && !all.has(decoded) ? decoded : name);
  }
  return out;
}

/** Stored names a (decoded) mailbox name may have: itself and, for legacy rows, its modified UTF-7 form. */
export function storedCandidates(name: string): string[] {
  const encoded = encodeMutf7(name);
  return encoded !== name && legacyDecoded(encoded) === name ? [name, encoded] : [name];
}

/**
 * The stored name of the folder a client means by `raw`: the UTF-8 row when it
 * exists, else a legacy modified UTF-7 row, else the UTF-8 name (new folders
 * are always stored in UTF-8).
 */
export async function resolveStoredName(session: ImapSession, raw: string): Promise<string> {
  const name = fromClient(session, raw);
  const candidates = storedCandidates(name);
  if (candidates.length === 1 || !session.mailboxId) return name;
  const rows: Array<{ name: string }> = await prisma.folder.findMany({
    where: { mailboxId: session.mailboxId, name: { in: candidates } },
    select: { name: true },
  });
  if (rows.some((r) => r.name === name)) return name;
  return rows[0]?.name ?? name;
}

/** Renders a mailbox (display) name for a response (quoted string or literal). */
export function formatName(session: ImapSession, display: string): string {
  return mailboxName(session.imap4rev2Enabled ? display : encodeMutf7(display));
}

/** Renders a stored mailbox name for a response (quoted string or literal). */
export function toClient(session: ImapSession, name: string): string {
  return formatName(session, displayName(name));
}
