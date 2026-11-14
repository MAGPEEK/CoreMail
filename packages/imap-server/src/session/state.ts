import type { Socket } from 'net';
import type { TLSSocket } from 'tls';

export type ImapState = 'NOT_AUTHENTICATED' | 'AUTHENTICATED' | 'SELECTED' | 'LOGOUT';

export interface SelectedMailbox {
  folderId: string;
  folderName: string;
  uidValidity: number;
  exists: number;
  recent: number;
  unseen: number;
  uidNext: number;
  readOnly: boolean;
  highestModSeq: bigint;
}

export interface ImapSession {
  id: string;
  socket: Socket | TLSSocket;
  state: ImapState;
  userId: string | null;
  mailboxId: string | null;
  selected: SelectedMailbox | null;
  idleActive: boolean;
  idleTag: string | null;
  capabilities: string[];
  // CONDSTORE: track per-session modseq
  condstoreEnabled: boolean;
  // RFC 9051 §6.3.1: set by "ENABLE IMAP4rev2"
  imap4rev2Enabled: boolean;
  // v5.5.0: SASL state for AUTHENTICATE multi-step mechanisms (LOGIN, PLAIN)
  saslMech: 'PLAIN' | 'LOGIN' | null;
  saslStep: number;
  saslUser: string;
  saslPendingTag: string | null;  // tag of the AUTHENTICATE command (for continuation)
  // v5.5.0: tracks whether socket already TLS-upgraded (via STARTTLS) or
  // is implicit TLS from port 993
  isTls: boolean;
}

function buildCapabilities(isTls: boolean, _isAuthenticated: boolean): string[] {
  // Only capabilities that are actually implemented are advertised. Removed
  // (not implemented): LOGIN-REFERRALS, UTF8=ACCEPT, QUOTA, LIST-EXTENDED,
  // LIST-STATUS, and on the plaintext listener STARTTLS (the command answers
  // NO) and LOGINDISABLED (LOGIN is accepted).
  const caps: string[] = [
    'IMAP4rev1',
    'IMAP4rev2',
    'LITERAL+',       // RFC 7888 — non-synchronizing literals (server/command-reader.ts)
    'SASL-IR',        // RFC 4959
    'ID',             // RFC 2971
    'ENABLE',         // RFC 5161
    'IDLE',           // RFC 2177
    'CONDSTORE',      // RFC 7162
    'ESEARCH',        // RFC 4731 — SEARCH RETURN (MIN MAX COUNT ALL)
    'NAMESPACE',      // RFC 2342
    // v5.2.18: SPECIAL-USE (RFC 6154) — Mac Mail needs SPECIAL-USE flags to
    // recognize Drafts/Sent/Trash/Junk/Archive.
    'SPECIAL-USE',
    'CHILDREN',       // RFC 3348 — \HasChildren / \HasNoChildren in LIST
    'MOVE',           // RFC 6851
    'UNSELECT',       // RFC 3691
    'UIDPLUS',        // RFC 4315 (APPENDUID/COPYUID)
    'STATUS=SIZE',    // RFC 8438
  ];
  if (isTls) {
    caps.push('AUTH=PLAIN', 'AUTH=LOGIN');
  }
  return caps;
}

export function createSession(socket: Socket | TLSSocket, isTls: boolean): ImapSession {
  return {
    id: crypto.randomUUID(),
    socket,
    state: 'NOT_AUTHENTICATED',
    userId: null,
    mailboxId: null,
    selected: null,
    idleActive: false,
    idleTag: null,
    condstoreEnabled: false,
    imap4rev2Enabled: false,
    saslMech: null,
    saslStep: 0,
    saslUser: '',
    saslPendingTag: null,
    isTls,
    capabilities: buildCapabilities(isTls, false),
  };
}

/**
 * Updates a session's capabilities — e.g. after a STARTTLS upgrade
 * or after a successful login (LOGINDISABLED is removed).
 */
export function refreshCapabilities(session: ImapSession): void {
  session.capabilities = buildCapabilities(
    session.isTls,
    session.state !== 'NOT_AUTHENTICATED',
  );
}

export function send(session: ImapSession, line: string): void {
  session.socket.write(`${line}\r\n`);
}

export function sendUntagged(session: ImapSession, data: string): void {
  send(session, `* ${data}`);
}

export function sendTagged(session: ImapSession, tag: string, status: string, text: string): void {
  send(session, `${tag} ${status} ${text}`);
}

export function sendOk(session: ImapSession, tag: string, text = 'completed'): void {
  sendTagged(session, tag, 'OK', text);
}

export function sendNo(session: ImapSession, tag: string, text: string): void {
  sendTagged(session, tag, 'NO', text);
}

export function sendBad(session: ImapSession, tag: string, text: string): void {
  sendTagged(session, tag, 'BAD', text);
}
