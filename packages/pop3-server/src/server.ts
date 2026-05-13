import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { createLogger } from '@coremail/core/logger';
import { getRedisClient } from '@coremail/core/redis';
import { POP3Session } from './session.js';

const log = createLogger('pop3-server');

const PORT_PLAIN = parseInt(process.env['POP3_PORT'] ?? '110', 10);
const PORT_TLS = parseInt(process.env['POP3S_PORT'] ?? '995', 10);
const TLS_CERT = process.env['TLS_CERT_PATH'];
const TLS_KEY = process.env['TLS_KEY_PATH'];

function createSession(socket: net.Socket | tls.TLSSocket, secure: boolean) {
  const session = new POP3Session(socket, secure);
  session.start();

  socket.on('error', (err) => log.warn({ err }, 'socket error'));
  socket.on('close', () => log.debug('connection closed'));
}

// Plain POP3 on port 110 (STLS upgrade supported)
const plainServer = net.createServer((socket) => {
  log.info({ remote: socket.remoteAddress }, 'POP3 connection');
  createSession(socket, false);
});

plainServer.listen(PORT_PLAIN, '0.0.0.0', () => {
  log.info(`POP3 listening on :${PORT_PLAIN}`);
});

// Implicit TLS on port 995
if (TLS_CERT && TLS_KEY) {
  const tlsOptions: tls.TlsOptions = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
    minVersion: 'TLSv1.2',
  };
  const tlsServer = tls.createServer(tlsOptions, (socket) => {
    log.info({ remote: socket.remoteAddress }, 'POP3S connection');
    createSession(socket, true);
  });
  tlsServer.listen(PORT_TLS, '0.0.0.0', () => {
    log.info(`POP3S listening on :${PORT_TLS}`);
  });
} else {
  log.warn('TLS_CERT_PATH/TLS_KEY_PATH not set — POP3S (port 995) disabled');
}

async function shutdown() {
  log.info('shutting down');
  plainServer.close();
  await getRedisClient().quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
