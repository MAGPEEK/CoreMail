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
  // v5.5.0: SASL state für AUTHENTICATE multi-step Mechanismen (LOGIN, PLAIN)
  saslMech: 'PLAIN' | 'LOGIN' | null;
  saslStep: number;
  saslUser: string;
  saslPendingTag: string | null;  // tag des AUTHENTICATE-Commands (für continuation)
  // v5.5.0: tracks whether socket already TLS-upgraded (via STARTTLS) or
  // is implicit TLS from port 993
  isTls: boolean;
}

function buildCapabilities(isTls: boolean, isAuthenticated: boolean): string[] {
  const caps: string[] = [
    'IMAP4rev1',
    // v5.5.0: IMAP4rev2 (RFC 9051) Pflicht-Features sind bereits implementiert
    // (ENABLE, UTF8=ACCEPT, LITERAL+, IDLE, SASL-IR, ESEARCH, LIST-EXTENDED,
    //  LIST-STATUS, MOVE, NAMESPACE, SPECIAL-USE, UNSELECT, CONDSTORE)
    'IMAP4rev2',
    'LITERAL+',
    'SASL-IR',
    'LOGIN-REFERRALS',
    'ID',
    'ENABLE',
    'IDLE',
    'CONDSTORE',
    'ESEARCH',
    'UTF8=ACCEPT',
    'QUOTA',
    'NAMESPACE',
    // v5.2.18: SPECIAL-USE (RFC 6154) + LIST-EXTENDED (RFC 5258) — Mac Mail
    // braucht SPECIAL-USE-Flags um Drafts/Sent/Trash/Junk/Archive zu erkennen.
    'SPECIAL-USE',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'CHILDREN',
    // v5.5.0: RFC 9051 Features
    'MOVE',           // RFC 6851
    'UNSELECT',       // RFC 3691
    'UIDPLUS',        // RFC 4315 (APPENDUID/COPYUID)
    'STATUS=SIZE',    // RFC 8438
  ];
  if (isTls || !isAuthenticated) {
    // STARTTLS nur annoncieren wenn nicht-TLS-Verbindung (Port 143).
    // Implizites TLS (Port 993) braucht es nicht.
    if (!isTls) caps.push('STARTTLS', 'LOGINDISABLED');
  }
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
    saslMech: null,
    saslStep: 0,
    saslUser: '',
    saslPendingTag: null,
    isTls,
    capabilities: buildCapabilities(isTls, false),
  };
}

/**
 * Aktualisiert die Capabilities einer Session — z.B. nach STARTTLS-Upgrade
 * oder nach erfolgreichem Login (LOGINDISABLED wird entfernt).
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
