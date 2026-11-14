import net from 'net';
import tls from 'node:tls';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
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
  appendTargetExists,
} from '../commands/index.js';
import { CommandReader, type LiteralDecision } from './command-reader.js';
import {
  tokenize, tokenizePrefix, tokenToArg, tokenString, ImapParseError,
  type Token, type CommandSegment,
} from './tokenizer.js';

const log = createLogger('imap:server');

const sessions = new Map<string, ImapSession>();

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
}

export function createImapServer(tlsConfig?: ImapTlsConfig, options: ImapServerOptions = {}): net.Server | tls.Server {
  // v5.5.0: isTls flag — on port 993 (implicit TLS) the connection is secure
  // immediately; on port 143 the client must send STARTTLS to upgrade.
  const isImplicitTls = !!tlsConfig;
  const onSocket = (socket: net.Socket): void => {
    const starttlsCert = (): ImapTlsConfig | null => (isImplicitTls ? null : options.starttls?.() ?? null);
    const session = createSession(socket, isImplicitTls, !!starttlsCert());
    sessions.set(session.id, session);
    const ip = socket.remoteAddress;

    log.debug({ id: session.id, ip }, 'IMAP connect');
    // RFC 3501 §7.1 — greeting with hostname and capability list
    socket.write(`* OK [CAPABILITY ${session.capabilities.join(' ')}] ${_hostname} IMAP4rev1 ready\r\n`);

    // Byte-oriented reader: literals ({n} / {n+}) are read as raw octets and
    // commands are executed strictly in order (one at a time).
    const createReader = (): CommandReader => {
      const reader: CommandReader = new CommandReader({
        maxLineLength: MAX_UNTERMINATED_LINE,
        maxLiteralSize: () => _maxLiteralSize,
        // During IDLE and SASL exchanges the client sends raw lines, not commands.
        literalsAllowed: () => !session.idleActive && !session.saslMech,
        sendContinuation: () => { session.socket.write('+ Ready for literal data\r\n'); },
        onLineTooLong: () => {
          session.socket.end('* BYE Line too long\r\n');
          log.warn({ id: session.id, ip }, 'IMAP line exceeds hard limit — connection closed');
        },
        onLiteral: (segments, size, sync, tooLarge) => checkLiteral(session, segments, size, sync, tooLarge),
        onCommand: async (segments) => {
          const first = segments[0];
          if (segments.length === 1 && typeof first === 'string') {
            // IDLE is terminated by a bare "DONE" line (RFC 2177).
            if (session.idleActive && first.trim().toUpperCase() === 'DONE') {
              handleIdleDone(session);
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
          if (session.state === 'LOGOUT') reader.close();
        },
        pause: () => session.socket.pause(),
        resume: () => session.socket.resume(),
      });
      return reader;
    };
    let reader = createReader();
    const onData = (chunk: Buffer): void => reader.push(chunk);
    socket.on('data', onData);

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
        secureContext: tls.createSecureContext({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2' }),
      });
      socket.resume();
      secure.once('secure', () => {
        session.socket = secure;
        session.isTls = true;
        session.starttlsAvailable = false;
        refreshCapabilities(session); // re-advertised on the next CAPABILITY
        reader = createReader();
        secure.on('data', (chunk: Buffer) => reader.push(chunk));
        secure.setTimeout(1800_000);
        secure.on('timeout', () => {
          sendUntagged(session, 'BYE Autologout; idle for too long');
          secure.destroy();
        });
        log.debug({ id: session.id }, 'IMAP STARTTLS upgrade complete');
      });
      secure.on('error', (err) => {
        log.warn({ err, id: session.id, ip }, 'IMAP STARTTLS handshake/socket error');
        secure.destroy();
      });
      secure.on('close', () => { reader.close(); sessions.delete(session.id); });
      socket.setTimeout(0);
    };

    socket.on('close', () => {
      reader.close();
      sessions.delete(session.id);
      log.debug({ id: session.id }, 'IMAP disconnect');
    });

    socket.on('error', (err) => {
      log.error({ err, id: session.id }, 'IMAP socket error');
      sessions.delete(session.id);
    });

    socket.setTimeout(1800_000); // 30 min idle timeout
    socket.on('timeout', () => {
      sendUntagged(session, 'BYE Autologout; idle for too long');
      socket.destroy();
    });
  };

  let server: net.Server | tls.Server;
  if (tlsConfig) {
    server = tls.createServer(
      { cert: tlsConfig.cert, key: tlsConfig.key, minVersion: 'TLSv1.2' },
      onSocket as (s: tls.TLSSocket) => void,
    );
  } else {
    server = net.createServer(onSocket);
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
    log.warn({ id: session.id, size, limit: _maxLiteralSize }, 'IMAP literal exceeds maximum size');
    session.socket.write(`${tag} NO [TOOBIG] Literal exceeds the maximum message size\r\n`);
    if (sync) return 'drop';
    // A non-synchronizing literal is already on its way — close the connection.
    session.socket.end('* BYE Literal too large\r\n');
    return 'close';
  }
  const command = tokens[1]?.type === 'atom' ? tokens[1].value.toUpperCase() : '';
  // v7: never read credentials sent as a literal over a plaintext connection.
  if (!session.isTls && (command === 'LOGIN' || command === 'AUTHENTICATE')) {
    session.socket.write(`${tag} NO [PRIVACYREQUIRED] Authentication requires TLS — use STARTTLS or port 993\r\n`);
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
    if (mailbox !== null && !(await appendTargetExists(session, mailbox))) {
      session.socket.write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      return 'drop';
    }
  }
  return 'continue';
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
    if (['FETCH', 'STORE', 'COPY', 'MOVE', 'SEARCH', 'EXPUNGE'].includes(sub)) {
      cmd = `UID ${sub}`;
      argTokens = argTokens.slice(1);
    }
  }
  const args = argTokens.map(tokenToArg);

  log.debug({ id: session.id, cmd, tag }, 'IMAP command');

  try {
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

      case 'LOGIN':
        await handleLogin(session, tag, args);
        break;

      case 'LIST':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO [AUTHENTICATIONFAILED] Not authenticated\r\n`);
        } else {
          await handleList(session, tag, args);
        }
        break;

      // v5.2.18: Mac Mail needs LSUB + SUBSCRIBE + NAMESPACE + STATUS
      case 'LSUB':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO [AUTHENTICATIONFAILED] Not authenticated\r\n`);
        } else {
          await handleLsub(session, tag, args);
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
          handleIdle(session, tag);
        }
        break;

      // RFC 5161: the ENABLED response lists the extensions that were enabled.
      case 'ENABLE': {
        const enabled: string[] = [];
        for (const ext of args) {
          const name = ext.toUpperCase();
          if (name === 'CONDSTORE' && !enabled.includes('CONDSTORE')) {
            session.condstoreEnabled = true;
            enabled.push('CONDSTORE');
          } else if (name === 'IMAP4REV2' && !enabled.includes('IMAP4rev2')) {
            session.imap4rev2Enabled = true;
            enabled.push('IMAP4rev2');
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
          handleCheck(session, tag);
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

      // Notify all IDLE sessions watching the same folder
      for (const session of sessions.values()) {
        if (
          session.idleActive &&
          session.userId === event.userId &&
          session.selected?.folderId === event.folderId
        ) {
          sendUntagged(session, `${session.selected.exists + 1} EXISTS`);
          sendUntagged(session, '1 RECENT');
          session.selected.exists += 1;
          log.debug({ userId: event.userId, uid: event.uid }, 'IDLE push: new message');
        }
      }
    } catch (err) {
      log.error({ err }, 'IDLE push error');
    }
  });
}
