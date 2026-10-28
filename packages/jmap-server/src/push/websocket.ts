/**
 * JMAP over WebSocket (RFC 8887): subprotocol "jmap", request/response
 * framing with "@type", RequestError, push via WebSocketPushEnable/Disable.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@coremail/core';
import { authenticateCredentials } from '../auth.js';
import { resolveAccounts } from '../accounts.js';
import { parseRequest, processRequest } from '../dispatcher.js';
import { RequestError } from '../errors.js';
import { sessionStateFor } from '../session.js';
import { isJmapEnabled } from '../feature-flag.js';
import { LIMITS } from '../settings.js';
import { accountsOf, buildStateChange, changeBus } from './bus.js';
import type { JmapUser, JsonObject } from '../types.js';

const log = createLogger('jmap:ws');

export function attachWebSocket(server: Server, path = '/jmap/ws'): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxSizeRequest,
    handleProtocols: (protocols) => (protocols.has('jmap') ? 'jmap' : false),
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return; // ignore other upgrades (socket stays open for other handlers)
    void (async () => {
      if (!(await isJmapEnabled())) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      const token = url.searchParams.get('access_token') ?? url.searchParams.get('token') ?? undefined;
      const user = await authenticateCredentials(req.headers.authorization ?? '', token);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="CoreMail JMAP", Bearer realm="CoreMail JMAP"\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, user));
    })().catch((err) => { log.error({ err }, 'WS upgrade failed'); socket.destroy(); });
  });
}

function handleConnection(ws: WebSocket, user: JmapUser): void {
  let pushTypes: Set<string> | undefined;
  let pushEnabled = false;
  let timer: NodeJS.Timeout | null = null;
  const dirty = new Set<string>();

  const send = (obj: unknown): void => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const flush = async (): Promise<void> => {
    timer = null;
    if (!pushEnabled) return;
    const accounts = await resolveAccounts(user);
    const list = accountsOf(accounts).filter((a) => dirty.has(a.accountId));
    dirty.clear();
    if (!list.length) return;
    const change = await buildStateChange(list, pushTypes);
    if (Object.keys(change.changed).length) send(change);
  };
  const onChange = (accountId: string): void => {
    if (!pushEnabled) return;
    dirty.add(accountId);
    if (!timer) timer = setTimeout(() => void flush().catch((err) => log.warn({ err }, 'ws flush')), 300);
  };
  changeBus.on('change', onChange);

  const alive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30_000);

  ws.on('message', (data) => {
    void (async () => {
      let msg: JsonObject;
      try {
        msg = JSON.parse(data.toString()) as JsonObject;
        if (!msg || typeof msg !== 'object') throw new Error('not an object');
      } catch {
        send({ '@type': 'RequestError', requestId: null, type: 'urn:ietf:params:jmap:error:notJSON', status: 400, detail: 'Message is not valid JSON' });
        return;
      }
      const requestId = typeof msg['id'] === 'string' ? msg['id'] : null;
      switch (msg['@type']) {
        case 'Request': {
          try {
            const req = parseRequest({ using: msg['using'], methodCalls: msg['methodCalls'], ...(msg['createdIds'] ? { createdIds: msg['createdIds'] } : {}) });
            const accounts = await resolveAccounts(user);
            const resp = await processRequest(req, user, accounts, sessionStateFor(accounts));
            send({ '@type': 'Response', requestId, ...resp });
          } catch (err) {
            if (err instanceof RequestError) send({ '@type': 'RequestError', requestId, ...err.toJson() });
            else { log.error({ err }, 'WS request failed'); send({ '@type': 'RequestError', requestId, type: 'urn:ietf:params:jmap:error:serverFail', status: 500 }); }
          }
          return;
        }
        case 'WebSocketPushEnable': {
          pushEnabled = true;
          const dt = msg['dataTypes'];
          pushTypes = Array.isArray(dt) && dt.length ? new Set((dt as unknown[]).map(String)) : undefined;
          // pushState: client has state → send the current StateChange immediately
          if (typeof msg['pushState'] === 'string') {
            const accounts = await resolveAccounts(user);
            send(await buildStateChange(accountsOf(accounts), pushTypes));
          }
          return;
        }
        case 'WebSocketPushDisable':
          pushEnabled = false;
          return;
        default:
          send({ '@type': 'RequestError', requestId, type: 'urn:ietf:params:jmap:error:notRequest', status: 400, detail: 'Unknown @type' });
      }
    })().catch((err) => log.error({ err }, 'WS message handler error'));
  });

  ws.on('close', () => {
    changeBus.off('change', onChange);
    clearInterval(alive);
    if (timer) clearTimeout(timer);
  });
  ws.on('error', (err) => log.debug({ err }, 'WS error'));
}
