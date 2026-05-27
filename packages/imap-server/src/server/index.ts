import net from 'net';
import tls from 'node:tls';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import {
  createSession, sendUntagged,
  type ImapSession,
} from '../session/state.js';
import {
  handleCapability, handleLogin, handleLogout,
  handleList, handleSelect, handleFetch,
  handleStore, handleExpunge, handleIdle, handleIdleDone, handleNoop,
  // v5.2.18: SPECIAL-USE + LSUB + SUBSCRIBE + NAMESPACE + STATUS für Mac Mail
  handleLsub, handleSubscribe, handleUnsubscribe, handleNamespace, handleStatus,
  // v5.3.1: Folder-Management + APPEND + COPY/MOVE + SEARCH (RFC-Pflicht)
  handleCreate, handleDeleteFolder, handleRename, handleAppend,
  handleCopy, handleMove, handleSearch, handleClose, handleCheck,
} from '../commands/index.js';

const log = createLogger('imap:server');

const sessions = new Map<string, ImapSession>();

// Module-level hostname — updated via setImapHostname() when settings change
let _hostname = 'mail.localhost';

/** Update the IMAP greeting hostname (called by server.ts on DB reload). */
export function setImapHostname(hostname: string): void {
  _hostname = hostname;
}

export interface ImapTlsConfig {
  cert: Buffer;
  key: Buffer;
}

export function createImapServer(tlsConfig?: ImapTlsConfig): net.Server | tls.Server {
  const onSocket = (socket: net.Socket): void => {
    const session = createSession(socket);
    sessions.set(session.id, session);

    log.debug({ id: session.id, ip: socket.remoteAddress }, 'IMAP connect');
    // RFC 3501 §7.1 — greeting with hostname and capability list
    socket.write(`* OK [CAPABILITY ${session.capabilities.join(' ')}] ${_hostname} IMAP4rev1 ready\r\n`);

    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // Process complete lines
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);

        // Handle IDLE DONE
        if (session.idleActive && line.trim().toUpperCase() === 'DONE') {
          handleIdleDone(session);
          continue;
        }

        void dispatchCommand(session, line);
      }
    });

    socket.on('close', () => {
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

async function dispatchCommand(session: ImapSession, line: string): Promise<void> {
  const parts = parseLine(line);
  if (parts.length < 2) return;

  const [tag, command, ...rawArgs] = parts as [string, string, ...string[]];
  let cmd = command.toUpperCase();
  let args = rawArgs;

  // v5.3.1: IMAP UID-Variants — RFC 3501 §6.4.8. Wenn der erste Token "UID"
  // ist, gehört das nächste Wort zum Command-Namen (UID FETCH, UID STORE,
  // UID COPY, UID MOVE, UID SEARCH, UID EXPUNGE). Vorher wurde das nicht
  // erkannt → Mac Mail's UID SEARCH/COPY/MOVE schlugen mit "BAD" fehl.
  if (cmd === 'UID' && rawArgs.length > 0) {
    const sub = rawArgs[0]?.toUpperCase() ?? '';
    if (['FETCH', 'STORE', 'COPY', 'MOVE', 'SEARCH', 'EXPUNGE'].includes(sub)) {
      cmd = `UID ${sub}`;
      args = rawArgs.slice(1);
    }
  }

  log.debug({ id: session.id, cmd, tag }, 'IMAP command');

  try {
    switch (cmd) {
      case 'CAPABILITY':
        await handleCapability(session, tag);
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

      // v5.2.18: Mac Mail braucht LSUB + SUBSCRIBE + NAMESPACE + STATUS
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

      case 'FETCH':
      case 'UID FETCH':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleFetch(session, tag, args);
        }
        break;

      case 'STORE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleStore(session, tag, args);
        }
        break;

      case 'EXPUNGE':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleExpunge(session, tag);
        }
        break;

      case 'IDLE':
        if (session.state === 'NOT_AUTHENTICATED') {
          session.socket.write(`${tag} NO Not authenticated\r\n`);
        } else {
          handleIdle(session, tag);
        }
        break;

      case 'ENABLE':
        if (args[0]?.toUpperCase() === 'CONDSTORE') {
          session.condstoreEnabled = true;
          sendUntagged(session, 'ENABLED CONDSTORE');
        }
        session.socket.write(`${tag} OK ENABLE completed\r\n`);
        break;

      // v5.3.1: Vollständige IMAP-Command-Suite (RFC 3501 + RFC 6851)
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
          await handleAppend(session, tag, args);
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
          await handleSearch(session, tag, args, false);
        }
        break;

      case 'UID SEARCH':
        if (session.state !== 'SELECTED') {
          session.socket.write(`${tag} NO No mailbox selected\r\n`);
        } else {
          await handleSearch(session, tag, args, true);
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

function parseLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  // v5.2.19: track whether quotes were opened in this token. Empty quoted
  // strings ("") müssen als leerer Token gepusht werden — Mac Mail sendet
  // LIST "" "*" wo args[0] = '' und args[1] = '*'. Vorher: '""' wurde
  // verworfen weil current leer war → reference wurde '*' → Regex ungültig.
  let quotedToken = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      quotedToken = true;
    } else if (ch === ' ' && !inQuote) {
      if (current || quotedToken) {
        tokens.push(current);
        current = '';
        quotedToken = false;
      }
    } else {
      current += ch;
    }
  }

  if (current || quotedToken) tokens.push(current);
  return tokens;
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
