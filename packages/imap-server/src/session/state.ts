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
  // v7: a certificate is available for STARTTLS on this (plaintext) listener
  starttlsAvailable: boolean;
  // v7: set by the server — performs the STARTTLS upgrade after the tagged OK
  beginTls?: (tag: string) => void;
}

function buildCapabilities(isTls: boolean, _isAuthenticated: boolean, starttlsAvailable = false): string[] {
  // Only capabilities that are actually implemented are advertised. Removed
  // (not implemented): LOGIN-REFERRALS, UTF8=ACCEPT, QUOTA, LIST-EXTENDED,
  // LIST-STATUS.
  // v7: credentials only over TLS — on a plaintext connection the server
  // advertises LOGINDISABLED (+ STARTTLS when a certificate is available) and
  // no AUTH= mechanisms (RFC 9051 §6.2.3, §11.1).
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
  } else {
    if (starttlsAvailable) caps.push('STARTTLS');
    caps.push('LOGINDISABLED');
  }
  return caps;
}

export function createSession(socket: Socket | TLSSocket, isTls: boolean, starttlsAvailable = false): ImapSession {
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
    starttlsAvailable: !isTls && starttlsAvailable,
    capabilities: buildCapabilities(isTls, false, !isTls && starttlsAvailable),
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
    !session.isTls && session.starttlsAvailable,
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
