/**
 * Mailbox names at the protocol boundary.
 *
 * Folder names are stored as UTF-8. An IMAP4rev1 client exchanges them in
 * modified UTF-7 (RFC 3501 §5.1.3); after "ENABLE IMAP4rev2" names are sent
 * and accepted as UTF-8 (RFC 9051 §5.1). INBOX is case-insensitive
 * (RFC 9051 §5.1), so any spelling — also as the first level of a
 * hierarchical name ("inbox.Sub") — maps to "INBOX".
 */
import type { ImapSession } from '../session/state.js';
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

/** Renders a stored mailbox name for a response (quoted string or literal). */
export function toClient(session: ImapSession, name: string): string {
  return mailboxName(session.imap4rev2Enabled ? name : encodeMutf7(name));
}
