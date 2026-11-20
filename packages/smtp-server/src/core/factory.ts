/**
 * SMTP Server Factory — creates net.Server or tls.Server and wires SmtpSession.
 */

import net from 'node:net';
import tls from 'node:tls';
import { createLogger, tlsServerOptions } from '@coremail/core';
import { logTlsSocketError } from '@coremail/core/tls-errors';
import { SmtpSession } from './session.js';
import type { SmtpSessionConfig } from './types.js';
import { connectGuard, type ConnectGuard, type TraceStage } from '@coremail/storage';
import {
  checkAndTrackConnection,
  releaseConnection,
  acquireGlobalSlot,
  releaseGlobalSlot,
  connectionCaps,
  isAuthBanned,
  publishConnectionLimitEvent,
} from './ip-limiter.js';

const log = createLogger('smtp:factory');

export interface SmtpServerHandle {
  listen(port: number, cb?: () => void): void;
  close(cb?: () => void): void;
  /** Underlying net.Server or tls.Server — for socket tracking in server.ts */
  readonly server: net.Server | tls.Server;
}

/** 10.5: the permanent block list (BCP → Angriffsschutz) — checked before anything else. */
export const SMTP_BLOCKED_REPLY = '554 5.7.1 Access denied — your IP address is blocked\r\n';

export function createSmtpServer(config: SmtpSessionConfig, implicitTls = false, guard: ConnectGuard = connectGuard): SmtpServerHandle {
  function onConnection(socket: net.Socket): void {
    const ip = socket.remoteAddress ?? '0.0.0.0';

    socket.once('error', (err) => {
      log.debug({ ip, err }, 'Pre-session socket error');
    });

    // 0a. 10.5: permanent block list (plaintext listeners; 465 is refused on the raw socket below)
    if (guard.isBlocked(ip)) {
      if (socket.writable) socket.write(SMTP_BLOCKED_REPLY);
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
      guard.refused(ip, 'smtp', 'blocked', { port: socket.localPort ?? 0 });
      return;
    }

    // ── IP-Level-Checks (synchron + async) ─────────────────────────────────
    // Submission listeners (requireAuth: 587/465) and private/loopback clients are
    // exempt from the global cap; the BCP per-IP cap is for port 25 only (connectionCaps).
    const caps = connectionCaps({
      submission: config.requireAuth,
      ip,
      maxConnections: config.maxConnections,
      maxConnectionsPerIp: config.maxConnectionsPerIp,
    });

    // 0. Global connection limit for inbound MX traffic (SmtpSettings.maxConnections)
    if (caps.global !== null) {
      if (!acquireGlobalSlot(caps.global)) {
        if (socket.writable) {
          socket.write('421 4.3.2 Too many connections, try again later\r\n');
        }
        socket.end();
        return;
      }
      socket.once('close', () => releaseGlobalSlot());
    }

    // 1. Per-IP connection limit + new-connection rate (in-memory, synchronous)
    if (!checkAndTrackConnection(ip, Date.now(), caps.perIp)) {
      if (socket.writable) {
        socket.write('421 4.7.1 Too many connections from your IP\r\n');
      }
      socket.end();
      publishConnectionLimitEvent(ip, { reason: 'connection_limit', port: (socket.localPort ?? 0) });
      return;
    }

    // Track connection release on socket close
    socket.once('close', () => releaseConnection(ip));

    // 2. Auth-ban check (Redis, async) — runs before onConnect handler
    isAuthBanned(ip)
      .then((banned) => {
        if (banned) {
          if (socket.writable) {
            socket.write('421 4.7.1 Your IP is temporarily blocked due to too many failed authentication attempts\r\n');
          }
          socket.end();
          guard.refused(ip, 'smtp', 'locked', { port: socket.localPort ?? 0 });
          return;
        }
        // 10.2: the connect-stage verdict travels with the session into the message trace.
        const connectedAt = new Date();
        const notes: TraceStage[] = [];
        return config.handlers.onConnect(ip, (n) => { if (notes.length < 4) notes.push(n); }).then((allowed) => {
          if (!allowed) {
            if (socket.writable) {
              socket.write('421 4.7.1 Access denied\r\n');
            }
            socket.end();
            log.info({ ip }, 'Connection rejected by onConnect');
            return;
          }
          new SmtpSession(socket, config, { connectedAt, connectNotes: notes }).start();
        });
      })
      .catch((err) => {
        log.error({ ip, err }, 'onConnect handler threw — rejecting connection');
        if (socket.writable) {
          socket.write('421 4.3.0 Temporary failure\r\n');
        }
        socket.end();
      });
  }

  let server: net.Server | tls.Server;

  if (implicitTls) {
    if (!config.tls) {
      throw new Error('createSmtpServer: implicitTls=true but config.tls is not set');
    }
    // TLS 1.2+ unless this listener allows old clients (TLS 1.0/1.1).
    server = tls.createServer(tlsServerOptions(config.tls, config.allowLegacyTls === true), onConnection);
    // 10.5: a blocked IP is dropped on the raw TCP socket — before the TLS handshake.
    server.on('connection', (raw: net.Socket) => {
      if (!guard.isBlocked(raw.remoteAddress)) return;
      raw.destroy();
      guard.refused(raw.remoteAddress, 'smtp', 'blocked', { port: raw.localPort ?? 0 });
    });
    // 9.3: handshake failures on 465 (e.g. the client rejects the certificate)
    server.on('tlsClientError', (err: Error, s: tls.TLSSocket) => {
      logTlsSocketError(log, err, { service: 'SMTP', ip: s.remoteAddress, port: s.localPort });
    });
  } else {
    server = net.createServer(onConnection);
  }

  return {
    get server() {
      return server;
    },
    listen(port: number, cb?: () => void): void {
      server.listen(port, '0.0.0.0', cb);
    },
    close(cb?: () => void): void {
      server.close(cb);
    },
  };
}
