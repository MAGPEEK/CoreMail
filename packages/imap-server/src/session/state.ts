import type { AccessibleMailbox } from '@coremail/storage';

/**
 * The transport a session writes to: a plain TCP socket, a TLS socket, or the
 * COMPRESS=DEFLATE wrapper around either (server/compress.ts).
 */
export interface ImapSocket {
  write(data: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(data?: string | Uint8Array): unknown;
  destroy(): unknown;
  pause(): unknown;
  resume(): unknown;
  setTimeout(ms: number): unknown;
  readonly remoteAddress?: string | undefined;
  readonly writable: boolean;
}

export type ImapState = 'NOT_AUTHENTICATED' | 'AUTHENTICATED' | 'SELECTED' | 'LOGOUT';

export interface SelectedMailbox {
  folderId: string;
  folderName: string;
  uidValidity: number;
  readOnly: boolean;
  /**
   * Per-session message sequence map (RFC 9051 §2.3.1.2): sequence number n
   * is uids[n - 1], ascending. It changes only through EXISTS (append) and
   * EXPUNGE responses the client has seen — see session/view.ts.
   */
  uids: number[];
  /** Last modSeq reported to the client per UID (unsolicited FETCH FLAGS on change). */
  known: Map<number, bigint>;
  /** SEARCHRES (RFC 5182): UIDs saved by SEARCH RETURN (SAVE), referenced as "$". */
  searchRes: number[];
  /**
   * Mailbox highestModSeq + message count of the folder at the last full
   * comparison (session/view.ts syncView); unchanged → nothing to report.
   */
  syncStamp?: string | undefined;
  /** v9.1: mailbox the folder belongs to (the own one, a Shared Mailbox or a delegated one). */
  mailboxId?: string | undefined;
  /** v9.1: set when the folder belongs to a foreign mailbox (Shared / Other Users namespace). */
  foreign?: { kind: 'shared' | 'delegated'; email: string } | null | undefined;
  /** v9.1: the mailbox name as the client sees it (decoded) and its hierarchy delimiter. */
  clientName?: string | undefined;
  delimiter?: string | undefined;
  /** v9.1: the user's rights do not permit changes (read-only permission) → NO [NOPERM]. */
  noWrite?: boolean | undefined;
}

export interface ImapSession {
  id: string;
  socket: ImapSocket;
  state: ImapState;
  userId: string | null;
  mailboxId: string | null;
  selected: SelectedMailbox | null;
  idleActive: boolean;
  idleTag: string | null;
  capabilities: string[];
  // CONDSTORE (RFC 7162): enabled by ENABLE or by a CONDSTORE-enabling command
  condstoreEnabled: boolean;
  // RFC 9051 §6.3.1: set by "ENABLE IMAP4rev2" — ESEARCH-only SEARCH responses,
  // UTF-8 mailbox names, no \Recent
  imap4rev2Enabled: boolean;
  // QRESYNC (RFC 7162 §3.2): set by "ENABLE QRESYNC" (implies CONDSTORE) —
  // VANISHED instead of EXPUNGE, SELECT (QRESYNC …), UID FETCH … VANISHED
  qresyncEnabled: boolean;
  // COMPRESS=DEFLATE (RFC 4978) is active on this connection
  compressActive: boolean;
  // set by the server — switches the connection to DEFLATE after the tagged OK
  beginCompress?: (tag: string) => void;
  // login address of the authenticated user (ACL identifier, RFC 4314)
  userEmail?: string | null;
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
  // v7.1.0: a command is being executed (deferred termination waits for it)
  busy?: boolean;
  // v7.1.0: runs once the current command has finished (credential change)
  afterCommand?: (() => void) | null;
  // v7.1.0: removes the session from the live-connection registry
  unregisterLive?: (() => void) | null;
  // v7.1.0: serialises unsolicited mailbox updates during IDLE with "DONE"
  updateLock?: Promise<void>;
  // v7.1.0: periodic mailbox check while idling (expunges/flag changes by other clients)
  idleTimer?: ReturnType<typeof setInterval> | null;
  // v8.1: set by the server — switches the idle timeout to the post-login value
  onAuthenticated?: () => void;
  // v9.1: cached foreign mailbox permissions (commands/namespaces.ts, ≤ 30 s)
  foreignAccess?: { userId: string; at: number; gen: number; list: AccessibleMailbox[] } | undefined;
}

function buildCapabilities(isTls: boolean, starttlsAvailable = false, authenticated = false, compressActive = false): string[] {
  // Only capabilities that are actually implemented are advertised. Not
  // implemented: LOGIN-REFERRALS, UTF8=ACCEPT.
  // v7.1.0: IMAP4rev2 is backed by the extensions it includes — BINARY,
  // SEARCHRES, LIST-EXTENDED, LIST-STATUS — plus ESEARCH-only SEARCH responses,
  // UTF-8 mailbox names and no \Recent after "ENABLE IMAP4rev2".
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
    'BINARY',         // RFC 3516 — FETCH BINARY[] / BINARY.SIZE[], APPEND literal8
    'SEARCHRES',      // RFC 5182 — SEARCH RETURN (SAVE) and the "$" message set
    'LIST-EXTENDED',  // RFC 5258
    'LIST-STATUS',    // RFC 5819 — LIST … RETURN (STATUS (…))
    'QUOTA',          // RFC 9208 — read-only: GETQUOTAROOT / GETQUOTA
    'QUOTA=RES-STORAGE',
    'QRESYNC',        // RFC 7162 §3.2 — active after "ENABLE QRESYNC"
    'SORT',           // RFC 5256
    'THREAD=ORDEREDSUBJECT',
    'THREAD=REFERENCES',
    'ACL',            // RFC 4314 — read-only (permissions are managed in the BCP)
    'RIGHTS=texk',
  ];
  // RFC 4978 §3: COMPRESS is only valid after authentication, so it is only
  // advertised then (and no longer once compression is active).
  if (authenticated && !compressActive) caps.push('COMPRESS=DEFLATE');
  if (isTls) {
    caps.push('AUTH=PLAIN', 'AUTH=LOGIN');
  } else {
    if (starttlsAvailable) caps.push('STARTTLS');
    caps.push('LOGINDISABLED');
  }
  return caps;
}

export function createSession(socket: ImapSocket,isTls: boolean, starttlsAvailable = false): ImapSession {
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
    qresyncEnabled: false,
    compressActive: false,
    saslMech: null,
    saslStep: 0,
    saslUser: '',
    saslPendingTag: null,
    isTls,
    starttlsAvailable: !isTls && starttlsAvailable,
    capabilities: buildCapabilities(isTls, !isTls && starttlsAvailable),
  };
}

/**
 * Updates a session's capabilities — e.g. after a STARTTLS upgrade
 * or after a successful login (LOGINDISABLED is removed).
 */
export function refreshCapabilities(session: ImapSession): void {
  session.capabilities = buildCapabilities(
    session.isTls, !session.isTls && session.starttlsAvailable,
    session.state !== 'NOT_AUTHENTICATED', session.compressActive,
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
