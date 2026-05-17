import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { createLogger } from '@coremail/core/logger';
import { getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core/redis';
import { prisma } from '@coremail/storage';
import { POP3Session } from './session.js';

const log = createLogger('pop3-server');

const PORT_PLAIN = parseInt(process.env['POP3_PORT']  ?? '110', 10);
const PORT_TLS   = parseInt(process.env['POP3S_PORT'] ?? '995', 10);
const TLS_CERT   = process.env['TLS_CERT_PATH'];
const TLS_KEY    = process.env['TLS_KEY_PATH'];

function createSession(socket: net.Socket | tls.TLSSocket, secure: boolean) {
  const session = new POP3Session(socket, secure);
  session.start();
  socket.on('error', (err) => log.warn({ err }, 'socket error'));
  socket.on('close', () => log.debug('connection closed'));
}

// Map port → laufende Server-Instanz
const servers = new Map<number, net.Server | tls.Server>();

async function reloadListeners() {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'POP3' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        let server: net.Server | tls.Server;
        if (l.ssl && TLS_CERT && TLS_KEY) {
          const tlsOptions: tls.TlsOptions = {
            cert: fs.readFileSync(TLS_CERT),
            key:  fs.readFileSync(TLS_KEY),
            minVersion: 'TLSv1.2',
          };
          server = tls.createServer(tlsOptions, (socket) => createSession(socket, true));
        } else {
          server = net.createServer((socket) => createSession(socket, false));
        }
        servers.set(l.port, server);
        server.listen(l.port, '0.0.0.0', () => log.info({ port: l.port }, 'POP3 listener started'));
      }
    }

    // Deaktivierte Ports: sofort aus Map entfernen, dann schließen
    const toClose: Array<[number, net.Server | tls.Server]> = [];
    for (const [port, srv] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, srv]);
      }
    }
    for (const [port, srv] of toClose) {
      await closePop3Server(srv, port);
      log.info({ port }, 'POP3 listener stopped');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload POP3 listeners');
  }
}

function closePop3Server(server: net.Server | tls.Server, port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port }, 'POP3 close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };
    server.close(done);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  });
}

async function main() {
  // Beim ersten Start: Default-Listener anlegen (falls DB noch leer)
  const existing = await prisma.serviceListener.count({ where: { service: 'POP3' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'POP3', address: '0.0.0.0', port: PORT_PLAIN, ssl: false, active: true },
        { service: 'POP3', address: '0.0.0.0', port: PORT_TLS,   ssl: true,  active: true },
      ],
    });
    log.info('Default POP3 listener seeded');
  }

  // Ports laut DB starten (respektiert Toggle-Zustand aus vorherigen Sitzungen)
  await reloadListeners();

  // Redis-Subscriber für dynamischen Listener-Reload
  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'POP3') {
        void reloadListeners();
      }
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  // Fallback-Poll alle 10 s (falls Redis-Signal verpasst wurde)
  setInterval(() => { void reloadListeners(); }, 10_000);

  async function shutdown() {
    log.info('shutting down');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, s]) => closePop3Server(s, p)));
    await subscriber.quit();
    await getRedisClient().quit();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'Fatal POP3 startup error');
  process.exit(1);
});
