/**
 * SMTP Server Factory — creates net.Server or tls.Server and wires SmtpSession.
 */

import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@coremail/core';
import { SmtpSession } from './session.js';
import type { SmtpSessionConfig } from './types.js';
import {
  checkAndTrackConnection,
  releaseConnection,
  isAuthBanned,
} from './ip-limiter.js';

const log = createLogger('smtp:factory');

export interface SmtpServerHandle {
  listen(port: number, cb?: () => void): void;
  close(cb?: () => void): void;
  /** Underlying net.Server or tls.Server — for socket tracking in server.ts */
  readonly server: net.Server | tls.Server;
}

export function createSmtpServer(config: SmtpSessionConfig, implicitTls = false): SmtpServerHandle {
  function onConnection(socket: net.Socket): void {
    const ip = socket.remoteAddress ?? '0.0.0.0';

    socket.once('error', (err) => {
      log.debug({ ip, err }, 'Pre-session socket error');
    });

    // ── IP-Level-Checks (synchron + async) ─────────────────────────────────
    // 1. Per-IP connection limit + new-connection rate (in-memory, synchronous)
    if (!checkAndTrackConnection(ip)) {
      if (socket.writable) {
        socket.write('421 4.7.1 Too many connections from your IP\r\n');
      }
      socket.end();
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
          return;
        }
        return config.handlers.onConnect(ip).then((allowed) => {
          if (!allowed) {
            if (socket.writable) {
              socket.write('421 4.7.1 Access denied\r\n');
            }
            socket.end();
            log.info({ ip }, 'Connection rejected by onConnect');
            return;
          }
          new SmtpSession(socket, config).start();
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
    server = tls.createServer(
      {
        cert: config.tls.cert,
        key: config.tls.key,
        minVersion: 'TLSv1.2',
      },
      onConnection,
    );
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
