import net from 'net';
import tls from 'node:tls';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger, tlsServerOptions } from '@coremail/core';
import { logTlsSocketError } from '@coremail/core/tls-errors';
import {
  createSession, sendUntagged, refreshCapabilities,
  type ImapSession,
} from '../session/state.js';
import {
  handleCapability, handleLogin, handleLogout,
  handleList, handleSelect, handleFetch,
  handleStore, handleExpunge, handleIdle, handleIdleDone, handleNoop,
  // v5.2.18: SPECIAL-USE + LSUB + SUBSCRIBE + NAMESPACE + STATUS for Mac Mail
  handleLsub, handleSubscribe, handleUnsubscribe, handleNamespace, handleStatus,
  // v5.3.1: folder management + APPEND + COPY/MOVE + SEARCH (RFC mandatory)
  handleCreate, handleDeleteFolder, handleRename, handleAppend,
  handleCopy, handleMove, handleSearch, handleClose, handleCheck,
  // v5.5.0: RFC 9051 IMAP4rev2 + RFC 2971 + RFC 3501 §6.2.2 SASL
  handleUnselect, handleId, handleAuthenticate, handleSaslContinuation,
  appendTargetCheck,
  // v7.1.0: QUOTA (RFC 9208, read-only) + per-session mailbox view updates
  handleGetQuotaRoot, handleGetQuota, handleSetQuota, notifyMailboxChanged, stopIdleTimer,
  // SORT/THREAD (RFC 5256), ACL (RFC 4314)
  handleSort, handleThread, handleMyRights, handleGetAcl, handleListRights, handleSetAcl,
} from '../commands/index.js';
import { CommandReader, type LiteralDecision } from './command-reader.js';
import type { ConnectionLimiter } from '@coremail/core';
import {
  imapConnectionLimiter, PRE_AUTH_MAX_LINE, PRE_AUTH_MAX_LITERAL, PRE_AUTH_IDLE_MS,
  POST_AUTH_IDLE_MS, TLS_HANDSHAKE_MS, isPeerDisconnect,
} from './limits.js';
import { unregisterLiveSession } from '../session/live.js';
import { invalidateAccessCaches, revalidateSelected } from '../commands/namespaces.js';
import { CompressedSocket } from './compress.js';
import {
  tokenize, tokenizePrefix, tokenToArg, tokenString, ImapParseError,
  type Token, type CommandSegment,
} from './tokenizer.js';

const log = createLogger('imap:server');

const sessions = new Map<string, ImapSession>();

/** Commands that need a selected mailbox (RFC 9051 §6.4) — NOPERM after a revoked permission. */
const SELECTED_STATE_COMMANDS = new Set([
  'FETCH', 'UID FETCH', 'STORE', 'UID STORE', 'SEARCH', 'UID SEARCH', 'COPY', 'UID COPY', 'MOVE', 'UID MOVE',
  'EXPUNGE', 'UID EXPUNGE', 'SORT', 'UID SORT', 'THREAD', 'UID THREAD', 'CHECK',
]);

// Maximum length of an input line that has not (yet) been terminated by CRLF.
// 64 KiB matches common server defaults (e.g. Dovecot imap_max_line_length)
// and is well above the 8192 octets RFC 7162 §4 asks servers to accept.
const MAX_UNTERMINATED_LINE = 64 * 1024;

// Module-level hostname — updated via setImapHostname() when settings change
let _hostname = 'mail.localhost';

/** Update the IMAP greeting hostname (called by server.ts on DB reload). */
export function setImapHostname(hostname: string): void {
  _hostname = hostname;
}

// Maximum size of a client literal (APPEND message, LOGIN argument …).
// Follows ServerSettings.maxMessageSizeMb (default 25 MB) via setImapMaxMessageSize().
let _maxLiteralSize = 25 * 1024 * 1024;

/** Update the literal size cap (called by server.ts on DB reload). */
export function setImapMaxMessageSize(bytes: number): void {
  if (Number.isFinite(bytes) && bytes > 0) _maxLiteralSize = bytes;
}

export interface ImapTlsConfig {
  cert: Buffer;
  key: Buffer;
}

export interface ImapServerOptions {
  /**
   * v7: certificate provider for STARTTLS on a plaintext listener (port 143).
   * Read per STARTTLS so a rotated certificate is used immediately. Without a
   * certificate the listener stays plaintext and refuses authentication.
   */
  starttls?: () => ImapTlsConfig | null | undefined;
  /** Accept TLS 1.0/1.1 on this listener (implicit TLS and STARTTLS). Default TLS 1.2+. */
  allowLegacyTls?: boolean;
  /** v8.1: connection limiter (default: the process-wide one from limits.ts). */
  limiter?: ConnectionLimiter;
  /** v8.1: timeouts (tests). */
  preAuthIdleMs?: number;
  tlsHandshakeMs?: number;
}

const preAuth = (session: ImapSession): boolean => session.state === 'NOT_AUTHENTICATED';

export function createImapServer(tlsConfig?: ImapTlsConfig, options: ImapServerOptions = {}): net.Server | tls.Server {
  // v5.5.0: isTls flag — on port 993 (implicit TLS) the connection is secure
  // immediately; on port 143 the client must send STARTTLS to upgrade.
  const isImplicitTls = !!tlsConfig;
  const limiter = options.limiter ?? imapConnectionLimiter;
  const preAuthIdleMs = options.preAuthIdleMs ?? PRE_AUTH_IDLE_MS;
  const tlsHandshakeMs = options.tlsHandshakeMs ?? TLS_HANDSHAKE_MS;
  const legacyTls = options.allowLegacyTls === true;
  const onSocket = (socket: net.Socket): void => {
    const starttlsCert = (): ImapTlsConfig | null => (isImplicitTls ? null : options.starttls?.() ?? null);
    const session = createSession(socket, isImplicitTls, !!starttlsCert());
    sessions.set(session.id, session);
    const ip = socket.remoteAddress;

    log.debug({ id: session.id, ip }, 'IMAP connect');
    // RFC 3501 §7.1 — greeting with hostname and capability list
    socket.write(`* OK [CAPABILITY ${session.capabilities.join(' ')}] ${_hostname} IMAP4rev1 ready\r\n`);

    // v8.1: idle timeout — 60 s before authentication, 30 min afterwards
    // (switched by loginUser via session.onAuthenticated).
    const armIdleTimeout = (s: net.Socket): void => {
      s.setTimeout(preAuth(session) ? preAuthIdleMs : POST_AUTH_IDLE_MS);
      s.on('timeout', () => {
        sendUntagged(session, 'BYE Autologout; idle for too long');
        s.destroy();
      });
    };
    session.onAuthenticated = () => { session.socket.setTimeout(POST_AUTH_IDLE_MS); };

    // Byte-oriented reader: literals ({n} / {n+}) are read as raw octets and
    // commands are executed strictly in order (one at a time).
    // v8.1: before authentication lines and literals are capped at 8 KiB.
    const createReader = (): CommandReader => {
      const reader: CommandReader = new CommandReader({
        maxLineLength: () => (preAuth(session) ? PRE_AUTH_MAX_LINE : MAX_UNTERMINATED_LINE),
        maxLiteralSize: () => (preAuth(session) ? PRE_AUTH_MAX_LITERAL : _maxLiteralSize),
        // During IDLE and SASL exchanges the client sends raw lines, not commands.
        literalsAllowed: () => !session.idleActive && !session.saslMech,
        sendContinuation: () => { session.socket.write('+ Ready for literal data\r\n'); },
        onLineTooLong: () => {
          session.socket.end('* BYE Line too long\r\n');
          log.warn({ id: session.id, ip }, 'IMAP line exceeds hard limit — connection closed');
        },
        onLiteral: (segments, size, sync, tooLarge) => checkLiteral(session, segments, size, sync, tooLarge),
        onCommand: async (segments) => {
          // v7.1.0: after a credential-change BYE nothing is executed any more.
          if (isLoggedOut(session)) { reader.close(); return; }
          session.busy = true;
          try {
            await runCommand(session, segments);
          } finally {
            session.busy = false;
            const after = session.afterCommand;
            session.afterCommand = null;
            after?.();
          }
          if (isLoggedOut(session)) reader.close();
        },
        pause: () => session.socket.pause(),
        resume: () => session.socket.resume(),
      });
      return reader;
    };
    let reader = createReader();
    // Where transport octets go: the command reader, or the inflate stream
    // once COMPRESS=DEFLATE is active.
    let feed = (chunk: Buffer): void => reader.push(chunk);
    const onData = (chunk: Buffer): void => feed(chunk);
    socket.on('data', onData);
    // The socket that currently carries the IMAP stream (TCP, or TLS after STARTTLS).
    let transport: net.Socket = socket;

    // RFC 4978: COMPRESS=DEFLATE. Called by the dispatcher after its checks;
    // the tagged OK is the last uncompressed response.
    session.beginCompress = (tag: string): void => {
      const carrier = transport;
      carrier.write(`${tag} OK DEFLATE active\r\n`);
      // Octets the client pipelined after "COMPRESS DEFLATE" are already compressed.
      const leftover = reader.detach();
      const compressed = new CompressedSocket(carrier, (chunk) => reader.push(chunk), (err) => {
        log.warn({ err, id: session.id, ip }, 'IMAP COMPRESS stream error — connection closed');
        carrier.destroy();
      });
      session.socket = compressed;
      session.compressActive = true;
      refreshCapabilities(session);
      reader = createReader();
      feed = (chunk) => compressed.input(chunk);
      // The old reader paused the transport for this command; input resumes
      // after the command has completed (dispatcher bookkeeping first).
      setImmediate(() => {
        if (leftover.length > 0) compressed.input(leftover);
        if (!reader.isClosed) compressed.resume();
      });
      log.debug({ id: session.id }, 'IMAP COMPRESS=DEFLATE active');
    };

    // v7: STARTTLS (RFC 9051 §6.2.1). Called by the dispatcher after the
    // checks; sends the tagged OK and upgrades the socket.
    session.beginTls = (tag: string): void => {
      const material = starttlsCert();
      if (!material) {
        session.socket.write(`${tag} NO [UNAVAILABLE] STARTTLS is not available\r\n`);
        return;
      }
      // Discard everything the client pipelined after STARTTLS (CVE-2011-0411
      // class): the old reader and its buffer are dropped, nothing more is
      // read from the plaintext stream.
      reader.close();
      socket.removeListener('data', onData);
      socket.write(`${tag} OK Begin TLS negotiation now\r\n`);
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext(tlsServerOptions(material, legacyTls)),
      });
      socket.resume();
      // v8.1: a client that never completes the handshake must not hold the
      // connection (the plaintext idle timer is disabled below).
      const handshakeTimer = setTimeout(() => {
        log.info({ id: session.id, ip }, 'IMAP STARTTLS handshake timed out');
        secure.destroy();
        socket.destroy();
      }, tlsHandshakeMs);
      handshakeTimer.unref();
      secure.once('secure', () => {
        clearTimeout(handshakeTimer);
        session.socket = secure;
        transport = secure;
        session.isTls = true;
        session.starttlsAvailable = false;
        refreshCapabilities(session); // re-advertised on the next CAPABILITY
        reader = createReader();
        feed = (chunk) => reader.push(chunk);
        secure.on('data', (chunk: Buffer) => feed(chunk));
        armIdleTimeout(secure);
        log.debug({ id: session.id }, 'IMAP STARTTLS upgrade complete');
      });
      secure.on('error', (err) => {
        clearTimeout(handshakeTimer);
        logTlsSocketError(log, err, { service: 'IMAP STARTTLS', id: session.id, ip });
        secure.destroy();
      });
      secure.on('close', () => { clearTimeout(handshakeTimer); reader.close(); sessions.delete(session.id); stopIdleTimer(session); unregisterLiveSession(session); });
      socket.setTimeout(0);
    };

    socket.on('close', () => {
      reader.close();
      sessions.delete(session.id);
      stopIdleTimer(session);
      unregisterLiveSession(session);
      log.debug({ id: session.id }, 'IMAP disconnect');
    });

    socket.on('error', (err) => {
      if (isPeerDisconnect(err)) log.debug({ err, id: session.id }, 'IMAP client disconnected abruptly');
      else logTlsSocketError(log, err, { service: 'IMAP', id: session.id, ip: socket.remoteAddress });
      sessions.delete(session.id);
      stopIdleTimer(session);
      unregisterLiveSession(session);
    });

    armIdleTimeout(socket);
  };

  /**
   * v8.1: per-IP and global connection caps, checked on the raw TCP
   * connection (before the TLS handshake on port 993). The slot is released
   * when the TCP connection closes.
   */
  const admit = (raw: net.Socket): boolean => {
    const result = limiter.acquire(raw.remoteAddress);
    if (!result.ok) {
      log.warn({ ip: raw.remoteAddress, reason: result.reason, limit: result.limit }, 'IMAP connection rejected — connection limit reached');
      if (!isImplicitTls) raw.end('* BYE [UNAVAILABLE] Too many connections, try again later\r\n');
      else raw.destroy();
      setTimeout(() => raw.destroy(), 2000).unref();
      return false;
    }
    raw.once('close', result.release);
    return true;
  };

  let server: net.Server | tls.Server;
  if (tlsConfig) {
    server = tls.createServer(
      { ...tlsServerOptions(tlsConfig, legacyTls), handshakeTimeout: tlsHandshakeMs },
      onSocket as (s: tls.TLSSocket) => void,
    );
    server.on('connection', (raw: net.Socket) => { admit(raw); });
    // 9.3: handshake failures on 993 (e.g. the client rejects the certificate)
    server.on('tlsClientError', (err: Error, s: tls.TLSSocket) => {
      logTlsSocketError(log, err, { service: 'IMAP', ip: s.remoteAddress, port: s.localPort });
    });
  } else {
    server = net.createServer((raw) => { if (admit(raw)) onSocket(raw); });
  }

  // Subscribe to Redis for real-time IDLE push notifications
  setupIdlePush();

  return server;
}

/**
 * Decides whether an announced literal is read (RFC 9051 §4.3, RFC 7888).
 * Before the continuation request of a synchronizing APPEND literal the target
 * mailbox is checked, so the client does not upload a message that is then
 * rejected with [TRYCREATE].
 */
async function checkLiteral(
  session: ImapSession,
  segments: CommandSegment[],
  size: number,
  sync: boolean,
  tooLarge: boolean,
): Promise<LiteralDecision> {
  const tokens = tokenizePrefix(segments);
  const tag = tokens[0]?.type === 'atom' ? tokens[0].value : '*';
  if (tooLarge) {
    const unauthenticated = preAuth(session);
    log.warn({ id: session.id, size, limit: unauthenticated ? PRE_AUTH_MAX_LITERAL : _maxLiteralSize, unauthenticated }, 'IMAP literal exceeds maximum size');
    session.socket.write(unauthenticated
      ? `${tag} NO [TOOBIG] Literal too large before authentication\r\n`
      : `${tag} NO [TOOBIG] Literal exceeds the maximum message size\r\n`);
    if (sync) return 'drop';
    // A non-synchronizing literal is already on its way — close the connection.
    session.socket.end('* BYE Literal too large\r\n');
    return 'close';
  }
  const command = tokens[1]?.type === 'atom' ? tokens[1].value.toUpperCase() : '';
  // v7: never read credentials sent as a literal over a plaintext connection.
  if (!session.isTls && (command === 'LOGIN' || command === 'AUTHENTICATE')) {
    session.socket.write(`${tag} NO [PRIVACYREQUIRED] Authentication requires TLS - use STARTTLS or port 993\r\n`);
    if (sync) return 'drop';
    session.socket.end('* BYE Credentials over plaintext\r\n');
    return 'close';
  }
  if (sync && command === 'APPEND' && tokens.length >= 3) {
    if (session.state === 'NOT_AUTHENTICATED') {
      session.socket.write(`${tag} NO Not authenticated\r\n`);
      return 'drop';
    }
    const mailbox = tokenString(tokens[2]);
    // v9.1: also refuses a read-only shared / delegated target before the literal.
    const refusal = mailbox === null ? null : await appendTargetCheck(session, mailbox);
    if (refusal !== null) {
      session.socket.write(`${tag} NO ${refusal}\r\n`);
      return 'drop';
    }
  }
  return 'continue';
}

/** State check that is not narrowed away across awaits (the state changes asynchronously). */
function isLoggedOut(session: ImapSession): boolean {
  return session.state === 'LOGOUT';
}

/** One complete client line: IDLE "DONE", a SASL continuation or a tagged command. */
async function runCommand(session: ImapSession, segments: CommandSegment[]): Promise<void> {
  const first = segments[0];
  if (segments.length === 1 && typeof first === 'string') {
    // IDLE is terminated by a bare "DONE" line (RFC 2177).
    if (session.idleActive && first.trim().toUpperCase() === 'DONE') {
      await handleIdleDone(session);
      return;
    }
    // v5.5.0: SASL continuation (AUTHENTICATE PLAIN/LOGIN multi-step):
    // a base64-encoded data line (or "*" to abort), not a tagged command.
    if (session.saslMech) {
      await handleSaslContinuation(session, session.saslPendingTag ?? '*', first);
      return;
    }
  }
  await dispatchCommand(session, segments);
}

async function dispatchCommand(session: ImapSession, segments: CommandSegment[]): Promise<void> {
  const firstLine = typeof segments[0] === 'string' ? segments[0] : '';
  let tokens: Token[];
  try {
    tokens = tokenize(segments);
  } catch (err) {
    const tag = /^[^\s(){%*"\\\]]+/.exec(firstLine)?.[0] ?? '*';
    session.socket.write(`${tag} BAD ${err instanceof ImapParseError ? err.message : 'Syntax error'}\r\n`);
    return;
  }
  if (tokens.length === 0) return; // empty line — ignore

  const tagToken = tokens[0];
  if (tagToken?.type !== 'atom' || /[*+]/.test(tagToken.value)) {
    session.socket.write('* BAD Invalid tag\r\n');
    return;
  }
  const tag = tagToken.value;
  const commandToken = tokens[1];
  if (commandToken?.type !== 'atom') {
    // RFC 9051 §7.1.3: a protocol-level error in the client's command → BAD.
    session.socket.write(`${tag} BAD Missing or invalid command name\r\n`);
    return;
  }

  let cmd = commandToken.value.toUpperCase();
  let argTokens = tokens.slice(2);

  // v5.3.1: IMAP UID variants — RFC 3501 §6.4.8. If the first token is "UID",
  // the next word belongs to the command name (UID FETCH, UID STORE,
  // UID COPY, UID MOVE, UID SEARCH, UID EXPUNGE). Previously this was not
  // recognized → Mac Mail's UID SEARCH/COPY/MOVE failed with "BAD".
  if (cmd === 'UID' && argTokens[0]?.type === 'atom') {
    const sub = argTokens[0].value.toUpperCase();
    if (['FETCH', 'STORE', 'COPY', 'MOVE', 'SEARCH', 'EXPUNGE', 'SORT', 'THREAD'].includes(sub)) {
      cmd = `UID ${sub}`;
      argTokens = argTokens.slice(1);
    }
  }
  const args = argTokens.map(tokenToArg);

  log.debug({ id: session.id, cmd, tag }, 'IMAP command');

  try {
    // v9.1: the permission for a selected shared / delegated mailbox is re-checked
    // before every command (cached ≤ 30 s; writes re-read it). Revoked → the
    // mailbox is closed ("* OK [CLOSED]") and commands that need it get NOPERM.
    if (session.selected?.foreign && cmd !== 'LOGOUT' && cmd !== 'CAPABILITY'
      && !(await revalidateSelected(session, false))) {
      if (cmd === 'CLOSE' || cmd === 'UNSELECT') {
        session.socket.write(`${tag} OK ${cmd} completed\r\n`);
        return;
      }
      if (SELECTED_STATE_COMMANDS.has(cmd)) {
        session.socket.write(`${tag} NO [NOPERM] Access to the selected mailbox was revoked\r\n`);
        return;
      }
    }
    switch (cmd) {
      case 'CAPABILITY':
        await handleCapability(session, tag);
        break;

      // v5.5.0: STARTTLS — RFC 3501 §6.2.1
      // On port 143 (plaintext) the client upgrades the connection to TLS.
      // On port 993 (implicit TLS) we return BAD because TLS is already active.
      // v7: real upgrade on port 143 (see createImapServer → session.beginTls).
      case 'STARTTLS':
        if (session.isTls) {
          session.socket.write(`${tag} BAD STARTTLS not available on TLS connection\r\n`);
        } else if (session.state !== 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} BAD STARTTLS is only valid in the not authenticated state\r\n`);
        } else if (args.length > 0) {
          session.socket.write(`${tag} BAD STARTTLS takes no arguments\r\n`);
        } else if (!session.beginTls) {
          session.socket.write(`${tag} NO [UNAVAILABLE] STARTTLS is not available\r\n`);
        } else {
          session.beginTls(tag);
        }
        break;

      // v5.5.0: AUTHENTICATE — RFC 3501 §6.2.2 with PLAIN/LOGIN SASL
      case 'AUTHENTICATE':
        if (session.state !== 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Already authenticated\r\n`);
        } else {
          session.saslPendingTag = tag;
          await handleAuthenticate(session, tag, args);
        }
        break;

      // v5.5.0: ID — RFC 2971
      case 'ID':
        handleId(session, tag, args);
        break;

      // v5.5.0: UNSELECT — RFC 3691 / RFC 9051 IMAP4rev2 mandatory
      case 'UNSELECT':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          handleUnselect(session, tag);
        }
        break;

      case 'NOOP':
        await handleNoop(session, tag);
        break;

      case 'LOGOUT':
        await handleLogout(session, tag);
        break;

      // RFC 9051 §6.2.3: LOGIN is only valid in the not authenticated state.
      case 'LOGIN':
        if (session.state !== 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} BAD Already authenticated\r\n`);
        } else {
          await handleLogin(session, tag, args);
        }
        break;

      case 'LIST':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleList(session, tag, argTokens);
        }
        break;

      // v5.2.18: Mac Mail needs LSUB + SUBSCRIBE + NAMESPACE + STATUS
      case 'LSUB':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleLsub(session, tag, argTokens);
        }
        break;

      // v7.1.0: QUOTA (RFC 9208), read-only
      case 'GETQUOTAROOT':
      case 'GETQUOTA':
      case 'SETQUOTA':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else if (cmd === 'GETQUOTAROOT') {
          await handleGetQuotaRoot(session, tag, args);
        } else if (cmd === 'GETQUOTA') {
          await handleGetQuota(session, tag, args);
        } else {
          handleSetQuota(session, tag);
        }
        break;

      case 'SUBSCRIBE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleSubscribe(session, tag, args);
        }
        break;

      case 'UNSUBSCRIBE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleUnsubscribe(session, tag, args);
        }
        break;

      case 'NAMESPACE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          handleNamespace(session, tag);
        }
        break;

      case 'STATUS':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleStatus(session, tag, args);
        }
        break;

      case 'SELECT':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleSelect(session, tag, args, false);
        }
        break;

      case 'EXAMINE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleSelect(session, tag, args, true);
        }
        break;

      // The UID flag is passed explicitly: the "UID" token has already been
      // stripped from args above, so handlers cannot detect it themselves.
      case 'FETCH':
      case 'UID FETCH':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleFetch(session, tag, args, cmd === 'UID FETCH');
        }
        break;

      case 'STORE':
      case 'UID STORE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleStore(session, tag, args, cmd === 'UID STORE');
        }
        break;

      case 'EXPUNGE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleExpunge(session, tag);
        }
        break;

      // RFC 4315 §2.1 — UID EXPUNGE <uid-set>: only \Deleted messages in the set.
      case 'UID EXPUNGE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else if (args.length !== 1 || !args[0]) {
          session.socket.write(`${tag} BAD UID EXPUNGE requires a UID set\r\n`);
        } else {
          await handleExpunge(session, tag, args[0]);
        }
        break;

      case 'IDLE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleIdle(session, tag);
        }
        break;

      // RFC 5161: the ENABLED response lists the extensions that were enabled.
      // ENABLE is only valid after authentication (RFC 5161 §3.1).
      case 'ENABLE': {
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} BAD ENABLE is only valid in the authenticated state\r\n`);
          break;
        }
        const enabled: string[] = [];
        for (const ext of args) {
          const name = ext.toUpperCase();
          if (name === 'CONDSTORE' && !enabled.includes('CONDSTORE')) {
            session.condstoreEnabled = true;
            enabled.push('CONDSTORE');
          } else if (name === 'IMAP4REV2' && !enabled.includes('IMAP4rev2')) {
            session.imap4rev2Enabled = true;
            enabled.push('IMAP4rev2');
          } else if (name === 'QRESYNC' && !enabled.includes('QRESYNC')) {
            // RFC 7162 §3.2.3: QRESYNC implies CONDSTORE.
            session.qresyncEnabled = true;
            session.condstoreEnabled = true;
            enabled.push('QRESYNC');
          }
        }
        sendUntagged(session, `ENABLED${enabled.length ? ' ' + enabled.join(' ') : ''}`);
        session.socket.write(`${tag} OK ENABLE completed\r\n`);
        break;
      }

      // v5.3.1: complete IMAP command suite (RFC 3501 + RFC 6851)
      case 'CREATE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleCreate(session, tag, args);
        }
        break;

      case 'DELETE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleDeleteFolder(session, tag, args);
        }
        break;

      case 'RENAME':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          await handleRename(session, tag, args);
        }
        break;

      case 'APPEND':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          const last = argTokens[argTokens.length - 1];
          await handleAppend(session, tag, args, last?.type === 'literal' ? last.value : undefined);
        }
        break;

      case 'COPY':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleCopy(session, tag, args, false);
        }
        break;

      case 'UID COPY':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleCopy(session, tag, args, true);
        }
        break;

      case 'MOVE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleMove(session, tag, args, false);
        }
        break;

      case 'UID MOVE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleMove(session, tag, args, true);
        }
        break;

      case 'SEARCH':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleSearch(session, tag, argTokens, false);
        }
        break;

      case 'UID SEARCH':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleSearch(session, tag, argTokens, true);
        }
        break;

      // RFC 5256 SORT / THREAD
      case 'SORT':
      case 'UID SORT':
      case 'THREAD':
      case 'UID THREAD':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else if (cmd.endsWith('SORT')) {
          await handleSort(session, tag, argTokens, cmd === 'UID SORT');
        } else {
          await handleThread(session, tag, argTokens, cmd === 'UID THREAD');
        }
        break;

      // RFC 4314 ACL (read-only)
      case 'MYRIGHTS':
      case 'GETACL':
      case 'LISTRIGHTS':
      case 'SETACL':
      case 'DELETEACL':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else if (cmd === 'MYRIGHTS') {
          await handleMyRights(session, tag, args);
        } else if (cmd === 'GETACL') {
          await handleGetAcl(session, tag, args);
        } else if (cmd === 'LISTRIGHTS') {
          await handleListRights(session, tag, args);
        } else {
          await handleSetAcl(session, tag, args, cmd);
        }
        break;

      // RFC 4978 COMPRESS=DEFLATE — authenticated / selected state only
      case 'COMPRESS':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} BAD COMPRESS is only valid after authentication\r\n`);
        } else if (args.length !== 1 || args[0]?.toUpperCase() !== 'DEFLATE') {
          session.socket.write(`${tag} BAD Unsupported compression mechanism (DEFLATE)\r\n`);
        } else if (session.compressActive) {
          session.socket.write(`${tag} NO [COMPRESSIONACTIVE] DEFLATE is already active\r\n`);
        } else if (!session.beginCompress) {
          session.socket.write(`${tag} NO [UNAVAILABLE] COMPRESS is not available\r\n`);
        } else {
          session.beginCompress(tag);
        }
        break;

      case 'CLOSE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleClose(session, tag);
        }
        break;

      case 'CHECK':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleCheck(session, tag);
        }
        break;

      default:
        session.socket.write(`${tag} BAD Command not recognized\r\n`);
    }
  } catch (err) {
    log.error({ err, cmd, tag }, 'Command handler error');
    session.socket.write(`${tag} NO Internal error\r\n`);
  }
}

/**
 * v9.1: an auth invalidation event (credential change, deactivation, or a
 * `permission-change` of a shared mailbox / delegation) for `event.userId`:
 * drops every session's cached shared-mailbox access list and re-checks the
 * selected foreign mailbox of that user's IDLE sessions right away (a revoked
 * one is closed with `* OK [CLOSED]`). Other sessions re-check it before
 * their next command.
 */
export function applyAuthInvalidation(event: { userId: string }): void {
  invalidateAccessCaches();
  for (const session of sessions.values()) {
    if (session.userId === event.userId && session.idleActive && session.selected?.foreign) {
      notifyMailboxChanged(session);
    }
  }
}

function setupIdlePush(): void {
  const subscriber = getRedisClient().duplicate();

  void subscriber.subscribe(CHANNEL_MAIL_NEW);
  subscriber.on('message', (_channel, message) => {
    try {
      const event = JSON.parse(message) as {
        userId: string;
        folderId: string;
        messageId: string;
        uid: number;
        subject: string;
      };

      // IDLE sessions watching the same folder compare their view with the
      // database and report the difference (EXISTS, and anything else that
      // changed meanwhile) — never a blind "EXISTS + 1".
      // v9.1: matched by folder only — a shared / delegated folder is watched by
      // other users than the event's mailbox owner. The folder was access-checked
      // on SELECT and the sync re-checks the permission (namespaces.ts).
      for (const session of sessions.values()) {
        if (
          session.idleActive &&
          session.selected?.folderId === event.folderId &&
          (session.userId === event.userId || !!session.selected.foreign)
        ) {
          notifyMailboxChanged(session);
          log.debug({ userId: event.userId, uid: event.uid }, 'IDLE push: new message');
        }
      }
    } catch (err) {
      log.error({ err }, 'IDLE push error');
    }
  });
}
