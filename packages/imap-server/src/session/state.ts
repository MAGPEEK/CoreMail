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
}

export function createSession(socket: Socket | TLSSocket): ImapSession {
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
    capabilities: [
      'IMAP4rev1',
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
      'AUTH=PLAIN',
      'AUTH=LOGIN',
    ],
  };
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
