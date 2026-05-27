import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD, generateSelfSignedCert, tlsPemToBuffers } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma, loadProtocolCert } from '@coremail/storage';
import { createImapServer, setImapHostname, type ImapTlsConfig } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// ── TLS-Konfiguration (für Port 993 / implizites TLS) ─────────────────────────
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
    // v5.2.8: Cert direkt aus certificates-Tabelle via services[]='IMAP'
    const found = await loadProtocolCert('IMAP');

    if (found) {
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      log.info({ source: found.source, certName: found.certName, certId: found.certId }, 'IMAP TLS cert loaded');
      return;
    }

    // Kein passendes Cert in DB → self-signed Fallback mit fixem CN=mail.localhost
    // (nur beim allerersten Start sinnvoll).  Der Admin tauscht es später im BCP
    // gegen ein echtes Cert; ein fixer CN verhindert Neuausstellung beim Umbenennen
    // des publicHostname.
    const SELF_SIGNED_HOSTNAME = 'mail.localhost';
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No protocol cert in DB — generating self-signed certificate for IMAP');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    // Self-signed in ServerSettings.tlsCert speichern als Fallback für andere Services
    // beim erstmaligen Setup. activate-protocol überschreibt das später.
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

// ── Tracked-Server-Typ ────────────────────────────────────────────────────────
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

function createTrackedImapServer(ssl: boolean): TrackedImapServer {
  // TLS für implizites TLS (Port 993) übergeben; Plaintext (Port 143) ohne TLS
  const server = createImapServer(ssl && _tlsConfig ? _tlsConfig : undefined);
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return { server, sockets };
}

/**
 * Schließt einen IMAP-Listener definitiv:
 *
 * 1. Alle verfolgten Sockets per .destroy() sofort beenden
 * 2. server.close() aufrufen (OS-Port wird synchron freigegeben)
 * 3. _handle direkt schließen als Absicherung
 *
 * IMAP IDLE-Verbindungen haben 30-min-Timeout — ohne socket.destroy()
 * würde server.close() ewig warten. Durch destroy() sofortige Freigabe.
 */
function closeImapServer(tracked: TrackedImapServer, port: number): void {
  const count = tracked.sockets.size;

  // Alle aktiven Verbindungen sofort zerstören (auch IDLE-Verbindungen)
  for (const s of tracked.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  tracked.sockets.clear();

  // server.close() → _handle.close() → OS-Port synchron freigegeben
  try {
    tracked.server.close(() =>
      log.debug({ port }, 'IMAP server.close() callback fired'));
  } catch { /* server may already be closed */ }

  // Nuklear-Option: _handle direkt schließen
  const handle = (tracked.server as any)._handle;
  if (handle?.close) {
    try { handle.close(); (tracked.server as any)._handle = null; } catch { /* ignore */ }
  }

  log.info({ port, closedConnections: count }, 'IMAP listener stopped');
}

// ── Listener-Reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'IMAP reload');

    // Neu aktive Ports starten
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

    // Deaktivierte/gelöschte Ports schließen (synchron)
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);   // Vor dem Close aus Map entfernen
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
