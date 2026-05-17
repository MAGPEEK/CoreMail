import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createInboundServer } from './inbound/server.js';
import { createSubmissionServer } from './submission/server.js';
import { startOutboundWorker } from './outbound/queue.js';

const log = createLogger('smtp:server');

// ── Port-Defaults ─────────────────────────────────────────────────────────────
const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

/** Submission-Ports (Auth erforderlich) */
const SUBMISSION_PORTS = new Set([SMTP_PORT_465, SMTP_PORT_587]);

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────
type AnySmtpServer = ReturnType<typeof createInboundServer> | ReturnType<typeof createSubmissionServer>;

interface TrackedSmtpServer {
  smtp:    AnySmtpServer;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedSmtpServer>();

// ── Reload-Mutex ──────────────────────────────────────────────────────────────
let _reloading    = false;
let _pendingReload = false;

function scheduleReload(): void {
  if (_reloading) { _pendingReload = true; return; }
  _reloading    = true;
  _pendingReload = false;
  void reloadListeners().finally(() => {
    _reloading = false;
    if (_pendingReload) { _pendingReload = false; scheduleReload(); }
  });
}

// ── Server-Lifecycle ──────────────────────────────────────────────────────────

/**
 * Erzeugt den passenden SMTP-Server für den gegebenen Port:
 *  - Port 25  → Inbound (authOptional, empfängt Mail von anderen MTAs)
 *  - Port 465 → Submission mit implizitem TLS (authRequired)
 *  - Port 587 → Submission mit STARTTLS (authRequired)
 */
function createTrackedSmtpServer(port: number, ssl: boolean): TrackedSmtpServer {
  const smtp = SUBMISSION_PORTS.has(port)
    ? createSubmissionServer(ssl /* implicitTls */)
    : createInboundServer();

  const sockets = new Set<net.Socket>();
  const inner   = (smtp as any).server as net.Server | undefined;
  if (inner) {
    inner.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  return { smtp, sockets };
}

/**
 * Schließt einen SMTP-Listener definitiv:
 * 1. Alle Sockets per .destroy() sofort beenden
 * 2. server.close() → _handle.close() → OS-Port synchron freigegeben
 * 3. _handle direkt schließen als Nuklear-Option
 */
function closeSmtpServer(tracked: TrackedSmtpServer, port: number): void {
  const count = tracked.sockets.size;

  for (const s of tracked.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  tracked.sockets.clear();

  try {
    tracked.smtp.close(() =>
      log.debug({ port }, 'SMTP server.close() callback fired'));
  } catch { /* server may already be closed */ }

  const inner = (tracked.smtp as any).server as any;
  if (inner?._handle?.close) {
    try { inner._handle.close(); inner._handle = null; } catch { /* ignore */ }
  }

  log.info({ port, closedConnections: count }, 'SMTP listener stopped');
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners   = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'SMTP reload');

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const tracked = createTrackedSmtpServer(l.port, l.ssl);
        servers.set(l.port, tracked);
        tracked.smtp.listen(l.port, () =>
          log.info(
            { port: l.port, ssl: l.ssl, mode: SUBMISSION_PORTS.has(l.port) ? 'submission' : 'inbound' },
            'SMTP listener started',
          ));
      }
    }

    // Deaktivierte/gelöschte Ports schließen (synchron)
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        closeSmtpServer(tracked, port);
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload SMTP listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  await connectDatabase();
  await ensureBuckets();

  const existing = await prisma.serviceListener.count({ where: { service: 'SMTP_RECEIVE' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_25,  ssl: false, active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_465, ssl: true,  active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_587, ssl: false, active: true },
      ],
    });
    log.info('Default SMTP_RECEIVE listeners seeded');
  }

  await reloadListeners();

  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

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

  setInterval(() => scheduleReload(), 10_000);

  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server…');
    for (const [port, tracked] of servers) {
      servers.delete(port);
      closeSmtpServer(tracked, port);
    }
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
