import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createSmtpServer } from './core/factory.js';
import type { SmtpServerHandle } from './core/factory.js';
import { inboundHandlers } from './inbound/handler.js';
import { submissionHandlers } from './submission/handler.js';
import { verifySmtpCredentials } from './auth/verifier.js';
import { startOutboundWorker } from './outbound/queue.js';

const log = createLogger('smtp:server');

// ── Port-Defaults ─────────────────────────────────────────────────────────────
const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
// Primary source: ServerSettings.publicHostname in DB (set via Admin Panel)
// Fallback: SMTP_HOSTNAME / MAIL_HOSTNAME env vars (deprecated, for migration)
let _hostname: string = process.env['SMTP_HOSTNAME'] ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';

async function refreshHostname(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.publicHostname) {
      _hostname = settings.publicHostname;
      log.debug({ hostname: _hostname }, 'SMTP hostname refreshed from DB');
    } else {
      // Seed env fallback into DB on first run so admin panel shows correct value
      const envHostname = process.env['MAIL_HOSTNAME'] ?? process.env['SMTP_HOSTNAME'];
      if (envHostname) {
        await prisma.serverSettings.upsert({
          where:  { id: 'singleton' },
          create: { id: 'singleton', publicHostname: envHostname },
          update: { publicHostname: envHostname },
        });
        _hostname = envHostname;
        log.info({ hostname: _hostname }, 'SMTP hostname seeded from env var into DB');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to refresh SMTP hostname from DB');
  }
}

/** Submission-Ports (Auth required) */
const SUBMISSION_PORTS = new Set([SMTP_PORT_465, SMTP_PORT_587]);

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────

interface TrackedSmtpServer {
  handle:  SmtpServerHandle;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedSmtpServer>();

// ── Reload-Mutex ──────────────────────────────────────────────────────────────
let _reloading     = false;
let _pendingReload = false;

function scheduleReload(): void {
  if (_reloading) { _pendingReload = true; return; }
  _reloading     = true;
  _pendingReload = false;
  void reloadListeners().finally(() => {
    _reloading = false;
    if (_pendingReload) { _pendingReload = false; scheduleReload(); }
  });
}

// ── Server-Lifecycle ──────────────────────────────────────────────────────────

/**
 * Creates the appropriate SMTP server for a given port:
 *  - Port 25  → Inbound (no auth required, receives from other MTAs)
 *  - Port 465 → Submission with implicit TLS (auth required)
 *  - Port 587 → Submission with STARTTLS (auth required)
 */
function createTrackedSmtpServer(port: number, ssl: boolean): TrackedSmtpServer {
  const isSubmission = SUBMISSION_PORTS.has(port);

  // Use a getter so that each new session picks up the current hostname.
  // This allows live hostname updates without restarting listeners.
  const config = Object.defineProperties(
    {
      maxSize:     52_428_800, // 50 MB
      maxRcpt:     100,
      requireAuth: isSubmission,
      handlers:    isSubmission ? submissionHandlers : inboundHandlers,
      ...(isSubmission ? { verifyCredentials: verifySmtpCredentials } : {}),
      tls: undefined as { cert: Buffer; key: Buffer } | undefined,
    } as Parameters<typeof createSmtpServer>[0],
    {
      hostname: { get: () => _hostname, enumerable: true, configurable: true },
    },
  );

  const handle = createSmtpServer(config, ssl);

  const sockets = new Set<net.Socket>();
  handle.server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return { handle, sockets };
}

/**
 * Shuts down an SMTP listener definitively:
 * 1. Destroy all tracked sockets immediately
 * 2. server.close() → OS port released
 * 3. _handle nuclear option as fallback
 */
function closeSmtpServer(tracked: TrackedSmtpServer, port: number): void {
  const count = tracked.sockets.size;

  for (const s of tracked.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  tracked.sockets.clear();

  try {
    tracked.handle.close(() =>
      log.debug({ port }, 'SMTP server.close() callback fired'));
  } catch { /* server may already be closed */ }

  const inner = (tracked.handle.server as any)._handle;
  if (inner?.close) {
    try { inner.close(); (tracked.handle.server as any)._handle = null; } catch { /* ignore */ }
  }

  log.info({ port, closedConnections: count }, 'SMTP listener stopped');
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners   = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter((l) => l.active).map((l) => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'SMTP reload');

    // Start newly active ports
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const tracked = createTrackedSmtpServer(l.port, l.ssl);
        servers.set(l.port, tracked);
        const mode = SUBMISSION_PORTS.has(l.port) ? 'submission' : 'inbound';
        tracked.handle.listen(l.port, () =>
          log.info({ port: l.port, ssl: l.ssl, mode }, 'SMTP listener started'));
      }
    }

    // Stop deactivated / removed ports
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

async function main(): Promise<void> {
  await connectDatabase();
  await ensureBuckets();
  await refreshHostname();

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
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD);
  subscriber.on('message', (ch, message) => {
    if (ch === CHANNEL_SETTINGS_RELOAD) {
      void refreshHostname();
      return;
    }
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
