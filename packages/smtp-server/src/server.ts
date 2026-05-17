import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createInboundServer } from './inbound/server.js';
import { startOutboundWorker } from './outbound/queue.js';

const log = createLogger('smtp:server');

const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────
// Jeder Listener bekommt eine eigene Instanz + Socket-Set für sauberes Schließen.
// net.Server.closeAllConnections() existiert NICHT auf net.Server (nur http.Server).
// Daher tracken wir Sockets manuell und rufen socket.destroy() beim Schließen.

interface TrackedSmtpServer {
  smtp:    ReturnType<typeof createInboundServer>;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedSmtpServer>();

// ── Reload-Mutex ──────────────────────────────────────────────────────────────
// Verhindert parallele Reload-Aufrufe (Redis-Signal + 10-s-Poll können sich
// überschneiden). Läuft gerade ein Reload, wird ein Pending-Flag gesetzt.
// Nach Abschluss des aktuellen Reloads wird ein weiterer sofort gestartet.

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

function createTrackedSmtpServer(): TrackedSmtpServer {
  const smtp = createInboundServer();
  const sockets = new Set<net.Socket>();
  // Connections über den internen net.Server tracken
  // (smtp-server-Wrapper legt ihn unter .server ab)
  const inner = (smtp as any).server as net.Server | undefined;
  if (inner) {
    inner.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  return { smtp, sockets };
}

function closeSmtpServer(tracked: TrackedSmtpServer, port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port, remaining: tracked.sockets.size }, 'SMTP close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };

    // Alle verfolgten Sockets sofort zerstören → server.close(done) feuert danach direkt
    for (const s of tracked.sockets) s.destroy();
    tracked.sockets.clear();
    tracked.smtp.close(done);
  });
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const tracked = createTrackedSmtpServer();
        servers.set(l.port, tracked);
        tracked.smtp.listen(l.port, () => log.info({ port: l.port }, 'SMTP listener started'));
      }
    }

    // Deaktivierte/gelöschte Ports schließen
    // Zuerst aus Map entfernen (verhindert Doppel-Close bei parallelen Aufrufen),
    // dann tatsächlich schließen.
    const toClose: Array<[number, TrackedSmtpServer]> = [];
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, tracked]);
      }
    }
    for (const [port, tracked] of toClose) {
      await closeSmtpServer(tracked, port);
      log.info({ port }, 'SMTP listener stopped');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload SMTP listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  await connectDatabase();
  await ensureBuckets();

  // Beim ersten Start: Default-Listener anlegen (falls DB noch leer)
  const existing = await prisma.serviceListener.count({ where: { service: 'SMTP_RECEIVE' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_25,  ssl: false, active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_465, ssl: true,  active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_587, ssl: true,  active: true },
      ],
    });
    log.info('Default SMTP_RECEIVE listeners seeded');
  }

  // Ports laut DB starten (respektiert Toggle-Zustand aus vorherigen Sitzungen)
  await reloadListeners();

  // Outbound-Worker starten
  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  // Redis-Subscriber für dynamischen Listener-Reload
  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'SMTP_RECEIVE') scheduleReload();
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  // Fallback-Poll alle 10 s (falls Redis-Signal verpasst wurde)
  setInterval(() => scheduleReload(), 10_000);

  // Graceful Shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server…');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, t]) => closeSmtpServer(t, p)));
    await worker.close();
    await subscriber.quit();
    await getRedisClient().quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal SMTP startup error');
  process.exit(1);
});
