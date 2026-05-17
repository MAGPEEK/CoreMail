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

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────
// net.Server.closeAllConnections() existiert NICHT auf net.Server (nur http.Server).
// Daher tracken wir Sockets manuell und rufen socket.destroy() beim Schließen.

interface TrackedPop3Server {
  server:  net.Server | tls.Server;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedPop3Server>();

// ── Reload-Mutex ──────────────────────────────────────────────────────────────

let _reloading = false;
let _pendingReload = false;

function scheduleReload(): void {
  if (_reloading) { _pendingReload = true; return; }
  _reloading = true;
  _pendingReload = false;
  void reloadListeners().finally(() => {
    _reloading = false;
    if (_pendingReload) { _pendingReload = false; scheduleReload(); }
  });
}

// ── Server-Lifecycle ──────────────────────────────────────────────────────────

interface ListenerConfig {
  port: number;
  ssl:  boolean;
}

function createTrackedPop3Server(cfg: ListenerConfig): TrackedPop3Server {
  const sockets = new Set<net.Socket>();

  const onSocket = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const session = new POP3Session(socket as net.Socket | tls.TLSSocket, cfg.ssl);
    session.start();
    socket.on('error', (err) => log.warn({ err }, 'POP3 socket error'));
    socket.on('close', () => log.debug('POP3 connection closed'));
  };

  let server: net.Server | tls.Server;
  if (cfg.ssl && TLS_CERT && TLS_KEY) {
    const tlsOptions: tls.TlsOptions = {
      cert:       fs.readFileSync(TLS_CERT),
      key:        fs.readFileSync(TLS_KEY),
      minVersion: 'TLSv1.2',
    };
    server = tls.createServer(tlsOptions, onSocket as (socket: tls.TLSSocket) => void);
  } else {
    server = net.createServer(onSocket);
  }

  return { server, sockets };
}

function closePop3Server(tracked: TrackedPop3Server, port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port, remaining: tracked.sockets.size }, 'POP3 close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };

    // Alle verfolgten Sockets sofort zerstören → server.close(done) feuert danach direkt.
    for (const s of tracked.sockets) s.destroy();
    tracked.sockets.clear();
    tracked.server.close(done);
  });
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'POP3' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const tracked = createTrackedPop3Server({ port: l.port, ssl: l.ssl });
        servers.set(l.port, tracked);
        tracked.server.listen(l.port, '0.0.0.0', () =>
          log.info({ port: l.port, ssl: l.ssl }, 'POP3 listener started'));
      }
    }

    // Deaktivierte/gelöschte Ports schließen
    const toClose: Array<[number, TrackedPop3Server]> = [];
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, tracked]);
      }
    }
    for (const [port, tracked] of toClose) {
      await closePop3Server(tracked, port);
      log.info({ port }, 'POP3 listener stopped');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload POP3 listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  const existing = await prisma.serviceListener.count({ where: { service: 'POP3' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'POP3', address: '0.0.0.0', port: PORT_PLAIN, ssl: false, active: true },
        { service: 'POP3', address: '0.0.0.0', port: PORT_TLS,   ssl: true,  active: true },
      ],
    });
    log.info('Default POP3 listeners seeded');
  }

  await reloadListeners();

  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'POP3') scheduleReload();
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  setInterval(() => scheduleReload(), 10_000);

  async function shutdown() {
    log.info('Shutting down POP3 server…');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, t]) => closePop3Server(t, p)));
    await subscriber.quit();
    await getRedisClient().quit();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch((err) => {
  log.error({ err }, 'Fatal POP3 startup error');
  process.exit(1);
});
