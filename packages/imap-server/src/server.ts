import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createImapServer } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────
// net.Server.closeAllConnections() existiert NICHT auf net.Server (nur http.Server).
// Daher tracken wir Sockets manuell und rufen socket.destroy() beim Schließen.

interface TrackedImapServer {
  server:  ReturnType<typeof createImapServer>;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedImapServer>();

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

function createTrackedImapServer(): TrackedImapServer {
  const server = createImapServer();
  const sockets = new Set<net.Socket>();
  // Listener auf dem net.Server hinzufügen um alle Sockets zu tracken.
  // createImapServer registriert seinen eigenen Handler via net.createServer((socket) => ...)
  // — beide 'connection'-Listener werden der Reihe nach aufgerufen, kein Konflikt.
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return { server, sockets };
}

function closeImapServer(tracked: TrackedImapServer, port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port, remaining: tracked.sockets.size }, 'IMAP close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };

    // Alle verfolgten Sockets sofort zerstören → server.close(done) feuert danach direkt.
    // IMAP IDLE-Verbindungen hätten sonst bis zu 30 Minuten Idle-Timeout.
    for (const s of tracked.sockets) s.destroy();
    tracked.sockets.clear();
    tracked.server.close(done);
  });
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const tracked = createTrackedImapServer();
        servers.set(l.port, tracked);
        tracked.server.listen(l.port, '0.0.0.0', () =>
          log.info({ port: l.port }, 'IMAP listener started'));
      }
    }

    // Deaktivierte/gelöschte Ports schließen
    const toClose: Array<[number, TrackedImapServer]> = [];
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, tracked]);
      }
    }
    for (const [port, tracked] of toClose) {
      await closeImapServer(tracked, port);
      log.info({ port }, 'IMAP listener stopped');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload IMAP listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  await connectDatabase();
  await ensureBuckets();

  const existing = await prisma.serviceListener.count({ where: { service: 'IMAP' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'IMAP', address: '0.0.0.0', port: IMAP_PORT,     ssl: false, active: true },
        { service: 'IMAP', address: '0.0.0.0', port: IMAP_PORT_TLS, ssl: true,  active: true },
      ],
    });
    log.info('Default IMAP listeners seeded');
  }

  await reloadListeners();

  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'IMAP') scheduleReload();
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  setInterval(() => scheduleReload(), 10_000);

  process.on('SIGTERM', async () => {
    log.info('Shutting down IMAP server…');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, t]) => closeImapServer(t, p)));
    await subscriber.quit();
    await getRedisClient().quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal IMAP startup error');
  process.exit(1);
});
