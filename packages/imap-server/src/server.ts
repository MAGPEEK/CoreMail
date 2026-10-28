import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD, generateSelfSignedCert, tlsPemToBuffers } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma, loadProtocolCert } from '@coremail/storage';
import { createImapServer, setImapHostname, type ImapTlsConfig } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// ── TLS configuration (for port 993 / implicit TLS) ───────────────────────────
let _tlsConfig: ImapTlsConfig | null = null;

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
async function refreshHostname(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.publicHostname) {
      setImapHostname(settings.publicHostname);
      log.debug({ hostname: settings.publicHostname }, 'IMAP hostname refreshed from DB');
    } else {
      const envHostname = process.env['MAIL_HOSTNAME'] ?? process.env['IMAP_HOSTNAME'];
      if (envHostname) {
        setImapHostname(envHostname);
        log.debug({ hostname: envHostname }, 'IMAP hostname from env var');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to refresh IMAP hostname from DB');
  }
}

async function refreshTlsConfig(): Promise<void> {
  try {
    // v5.2.8: cert directly from the certificates table via services[]='IMAP'
    const found = await loadProtocolCert('IMAP');

    if (found) {
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      log.info({ source: found.source, certName: found.certName, certId: found.certId }, 'IMAP TLS cert loaded');
      return;
    }

    // No matching cert in DB → self-signed fallback with fixed CN=mail.localhost
    // (only useful on the very first start).  The admin later replaces it in the BCP
    // with a real cert; a fixed CN prevents re-issuance when publicHostname
    // is renamed.
    const SELF_SIGNED_HOSTNAME = 'mail.localhost';
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No protocol cert in DB — generating self-signed certificate for IMAP');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    // Store self-signed cert in ServerSettings.tlsCert as fallback for other services
    // during initial setup. activate-protocol overrides this later.
    await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', publicHostname: SELF_SIGNED_HOSTNAME, tlsCert: certPem, tlsKey: keyPem },
      update: { tlsCert: certPem, tlsKey: keyPem },
    });
    log.info('Self-signed TLS certificate generated and stored in DB (IMAP)');
  } catch (err) {
    log.error({ err }, 'Failed to load/generate IMAP TLS config — port 993 will use plaintext');
  }
}

// ── Tracked server type ───────────────────────────────────────────────────────
interface TrackedImapServer {
  server:  ReturnType<typeof createImapServer>;
  sockets: Set<net.Socket>;
}

const servers = new Map<number, TrackedImapServer>();

// ── Reload mutex ──────────────────────────────────────────────────────────────
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

// ── Server lifecycle ──────────────────────────────────────────────────────────

function createTrackedImapServer(ssl: boolean): TrackedImapServer {
  // Pass TLS for implicit TLS (port 993); plaintext (port 143) without TLS
  const server = createImapServer(ssl && _tlsConfig ? _tlsConfig : undefined);
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return { server, sockets };
}

/**
 * Shuts down an IMAP listener definitively:
 *
 * 1. Terminate all tracked sockets immediately via .destroy()
 * 2. Call server.close() (OS port is released synchronously)
 * 3. Close _handle directly as a safeguard
 *
 * IMAP IDLE connections have a 30-min timeout — without socket.destroy()
 * server.close() would wait forever. destroy() releases immediately.
 */
function closeImapServer(tracked: TrackedImapServer, port: number): void {
  const count = tracked.sockets.size;

  // Destroy all active connections immediately (including IDLE connections)
  for (const s of tracked.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  tracked.sockets.clear();

  // server.close() → _handle.close() → OS port released synchronously
  try {
    tracked.server.close(() =>
      log.debug({ port }, 'IMAP server.close() callback fired'));
  } catch { /* server may already be closed */ }

  // Nuclear option: close _handle directly
  const handle = (tracked.server as any)._handle;
  if (handle?.close) {
    try { handle.close(); (tracked.server as any)._handle = null; } catch { /* ignore */ }
  }

  log.info({ port, closedConnections: count }, 'IMAP listener stopped');
}

// ── Listener reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'IMAP reload');

    // Start newly active ports
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        try {
          const tracked = createTrackedImapServer(l.ssl);
          servers.set(l.port, tracked);
          tracked.server.listen(l.port, '0.0.0.0', () =>
            log.info({ port: l.port, ssl: l.ssl }, 'IMAP listener started'));
        } catch (portErr) {
          log.error({ err: portErr, port: l.port, ssl: l.ssl },
            'Failed to start IMAP listener — port skipped');
        }
      }
    }

    // Close deactivated/removed ports (synchronously)
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);   // Remove from map before closing
        closeImapServer(tracked, port);
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload IMAP listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  await connectDatabase();
  await ensureBuckets();
  await refreshHostname();
  await refreshTlsConfig();

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
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD);
  subscriber.on('message', (ch, message) => {
    if (ch === CHANNEL_SETTINGS_RELOAD) {
      void refreshHostname();
      void refreshTlsConfig().then(() => scheduleReload());
      return;
    }
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
    for (const [port, tracked] of servers) {
      servers.delete(port);
      closeImapServer(tracked, port);
    }
    await subscriber.quit();
    await getRedisClient().quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal IMAP startup error');
  process.exit(1);
});
