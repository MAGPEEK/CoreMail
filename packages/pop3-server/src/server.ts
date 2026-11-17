import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import net from 'node:net';
import tls from 'node:tls';
import { createLogger, generateSelfSignedCert, tlsPemToBuffers, applyTlsToListeners, tlsMaterialEquals, installProcessGuards, startAuthInvalidationSubscriber, resolveBindAddress, listenWithRecovery, tlsServerOptions } from '@coremail/core';
import { getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD } from '@coremail/core/redis';
import { logTlsSocketError } from '@coremail/core/tls-errors';
import { prisma, loadProtocolCert, selfSignedFallbackHostname, waitForObjectStorage } from '@coremail/storage';
import { POP3Session, setPop3Hostname, pop3LiveSessions, TLS_HANDSHAKE_MS } from './session.js';
import { admitConnection, invalidExemptEntries } from './limits.js';

const log = createLogger('pop3-server');
// v6: unhandled rejections are logged instead of killing the listener; uncaught exceptions exit 1 (supervisord restarts)
installProcessGuards(log);
if (invalidExemptEntries.length) log.warn({ invalid: invalidExemptEntries }, 'ignoring invalid MAIL_CONN_EXEMPT_CIDRS entries');
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();

const PORT_PLAIN = parseInt(process.env['POP3_PORT']  ?? '110', 10);
const PORT_TLS   = parseInt(process.env['POP3S_PORT'] ?? '995', 10);

// ── TLS configuration (DB-backed) ─────────────────────────────────────────────
let _tlsConfig: { cert: Buffer; key: Buffer } | null = null;

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
async function refreshHostname(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.publicHostname) {
      setPop3Hostname(settings.publicHostname);
      log.debug({ hostname: settings.publicHostname }, 'POP3 hostname refreshed from DB');
    } else {
      const envHostname = process.env['MAIL_HOSTNAME'];
      if (envHostname) {
        setPop3Hostname(envHostname);
        log.debug({ hostname: envHostname }, 'POP3 hostname from env var');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to refresh POP3 hostname from DB');
  }
}

async function refreshTlsConfig(): Promise<void> {
  try {
    // v5.2.8: cert directly from the certificates table via services[]='POP3'
    const found = await loadProtocolCert('POP3');

    if (found) {
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      log.info({ source: found.source, certName: found.certName, certId: found.certId }, 'POP3 TLS cert loaded');
      return;
    }

    // No matching cert in DB → self-signed fallback (only useful on the very
    // first start). The admin later replaces it in the BCP with a real cert.
    // 9.3: CN = the public host name (mail.localhost only while none is configured);
    // the api-gateway's startup reconciliation replaces this with a visible
    // self-signed default row for the same name.
    const SELF_SIGNED_HOSTNAME = await selfSignedFallbackHostname();
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No protocol cert in DB — generating self-signed certificate for POP3');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', publicHostname: SELF_SIGNED_HOSTNAME, tlsCert: certPem, tlsKey: keyPem },
      update: { tlsCert: certPem, tlsKey: keyPem },
    });
    log.info('Self-signed TLS certificate generated and stored in DB (POP3)');
  } catch (err) {
    log.error({ err }, 'Failed to load/generate POP3 TLS config — port 995 will use plaintext');
  }
}

// ── Tracked server type ───────────────────────────────────────────────────────
interface TrackedPop3Server {
  server:  net.Server | tls.Server;
  sockets: Set<net.Socket>;
  ssl:     boolean;
  /** Listener accepts TLS 1.0/1.1 (kept on certificate rotation). */
  allowLegacyTls: boolean;
}

const servers = new Map<number, TrackedPop3Server>();

/** TLS material the running listeners were last given (for change detection). */
let _appliedTls: { cert: Buffer; key: Buffer } | null = null;

/**
 * v6: certificate rotation without restarting listeners — port 995 gets the
 * new cert via setSecureContext(). An ssl listener that fell back to
 * plaintext (no cert at start) is closed so the next reload recreates it.
 */
function applyTlsToRunningListeners(): void {
  if (!_tlsConfig || tlsMaterialEquals(_tlsConfig, _appliedTls)) return;
  const res = applyTlsToListeners(
    [...servers].map(([port, t]) => ({ port, ssl: t.ssl, server: t.server, allowLegacyTls: t.allowLegacyTls })),
    _tlsConfig,
  );
  for (const f of res.failed) log.error({ err: f.error, port: f.port }, 'POP3 TLS context update failed — keeping old cert');
  for (const port of res.restart) {
    const tracked = servers.get(port);
    if (tracked) { servers.delete(port); closePop3Server(tracked, port); }
  }
  _appliedTls = _tlsConfig;
  if (res.updated.length || res.restart.length) {
    log.info({ updated: res.updated, restarted: res.restart }, 'POP3 TLS certificate rotated on running listeners');
  }
}

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

interface ListenerConfig { port: number; ssl: boolean; allowLegacyTls: boolean }

function createTrackedPop3Server(cfg: ListenerConfig): TrackedPop3Server {
  const sockets = new Set<net.Socket>();

  const onSocket = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // v7: plaintext listeners offer STLS with the current protocol cert
    // (read per upgrade → hot rotation); USER/PASS only after TLS.
    const session = new POP3Session(socket as net.Socket | tls.TLSSocket, cfg.ssl, {
      starttls: () => (cfg.ssl ? null : _tlsConfig),
      allowLegacyTls: cfg.allowLegacyTls,
    });
    session.start();
    socket.on('error', (err) => logTlsSocketError(log, err, { service: 'POP3', ip: socket.remoteAddress }));
  };

  // v8.1: per-IP / global connection caps on the raw TCP connection
  // (before the TLS handshake on port 995).
  let server: net.Server | tls.Server;
  if (cfg.ssl && _tlsConfig) {
    server = tls.createServer(
      { ...tlsServerOptions(_tlsConfig, cfg.allowLegacyTls), handshakeTimeout: TLS_HANDSHAKE_MS },
      onSocket as (s: tls.TLSSocket) => void,
    );
    server.on('connection', (raw: net.Socket) => { admitConnection(raw, true); });
    // 9.3: handshake failures on 995 (e.g. the client rejects the certificate)
    server.on('tlsClientError', (err: Error, s: tls.TLSSocket) => {
      logTlsSocketError(log, err, { service: 'POP3', ip: s.remoteAddress, port: s.localPort });
    });
  } else {
    if (cfg.ssl) {
      log.warn({ port: cfg.port }, 'POP3 implicit TLS requested but no TLS cert available — falling back to plaintext');
    }
    server = net.createServer((raw) => { if (admitConnection(raw, false)) onSocket(raw); });
  }

  return { server, sockets, ssl: cfg.ssl, allowLegacyTls: cfg.allowLegacyTls };
}

/**
 * Shuts down a POP3 listener definitively:
 *
 * 1. Terminate all tracked sockets immediately via .destroy()
 * 2. server.close() → _handle.close() → OS port released immediately
 * 3. Close _handle directly as the nuclear option
 *
 * Synchronous — no async/await needed.
 */
function closePop3Server(tracked: TrackedPop3Server, port: number): void {
  const count = tracked.sockets.size;

  // Destroy all active connections immediately
  for (const s of tracked.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  tracked.sockets.clear();

  // server.close() → _handle.close() → OS port released synchronously
  try {
    tracked.server.close(() =>
      log.debug({ port }, 'POP3 server.close() callback fired'));
  } catch { /* server may already be closed */ }

  // Nuclear option: close _handle directly
  const handle = (tracked.server as any)._handle;
  if (handle?.close) {
    try { handle.close(); (tracked.server as any)._handle = null; } catch { /* ignore */ }
  }

  log.info({ port, closedConnections: count }, 'POP3 listener stopped');
}

// ── Listener reload ───────────────────────────────────────────────────────────

/**
 * Bind address of a listener ('' → all interfaces). Only IP literals are used;
 * a host name (the field used to be ignored free text) means 0.0.0.0 —
 * listenWithRecovery() logs it and recovers from bind errors.
 */
function bindAddress(address: string | null | undefined): string {
  return resolveBindAddress(address);
}

/** SSL flag + bind address (9.1.x) + legacy-TLS policy a running port was started with. */
const appliedListener = new Map<number, string>();
const listenerSignature = (l: { ssl: boolean; address: string; allowLegacyTls: boolean }): string =>
  `${l.ssl ? 'ssl' : 'plain'}|${bindAddress(l.address)}|${l.allowLegacyTls ? 'legacy-tls' : 'tls12'}`;

/**
 * 9.1.x: a changed SSL flag / bind address of a RUNNING port used to be ignored
 * until the next restart. Such ports are closed here and started again by a
 * follow-up reload once the socket is released. Returns the closed ports.
 */
function stopChangedListeners(listeners: Array<{ port: number; ssl: boolean; address: string; active: boolean; allowLegacyTls: boolean }>): Set<number> {
  const wanted = new Map<number, string>();
  for (const l of listeners) if (l.active && !wanted.has(l.port)) wanted.set(l.port, listenerSignature(l));
  const restarted = new Set<number>();
  for (const [port, sig] of wanted) {
    const running = servers.get(port);
    const applied = appliedListener.get(port);
    if (running && applied !== undefined && applied !== sig) {
      servers.delete(port);
      appliedListener.delete(port);
      closePop3Server(running, port);
      restarted.add(port);
    }
  }
  if (restarted.size > 0) {
    log.info({ ports: [...restarted] }, 'POP3 listener settings changed — restarting');
    setTimeout(scheduleReload, 500).unref?.();
  }
  return restarted;
}

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'POP3' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'POP3 reload');

    // Start newly active ports — per-listener error isolation
    const restarted = stopChangedListeners(listeners);
    for (const l of listeners) {
      if (l.active && !servers.has(l.port) && !restarted.has(l.port)) {
        try {
          const tracked = createTrackedPop3Server({ port: l.port, ssl: l.ssl, allowLegacyTls: l.allowLegacyTls });
          servers.set(l.port, tracked);
          appliedListener.set(l.port, listenerSignature(l));
          // Bind errors (address not in the container, port still in use after a
          // restart) are logged and recovered — never an uncaught 'error' event.
          listenWithRecovery(tracked.server, {
            port: l.port, address: l.address, label: 'POP3', log,
            isCurrent: () => servers.get(l.port) === tracked,
            onListening: (address) => log.info({ port: l.port, ssl: l.ssl, address, allowLegacyTls: l.allowLegacyTls }, 'POP3 listener started'),
            onGiveUp: () => {
              if (servers.get(l.port) !== tracked) return;
              servers.delete(l.port);
              appliedListener.delete(l.port);
            },
          });
        } catch (portErr) {
          log.error({ err: portErr, port: l.port, ssl: l.ssl },
            'Failed to start POP3 listener — port skipped');
        }
      }
    }

    // Close deactivated/removed ports (synchronously)
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        appliedListener.delete(port);   // Remove from map before closing
        closePop3Server(tracked, port);
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload POP3 listeners');
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  void initRuntimeLogLevel('pop3-server', { aliases: ['pop3'] }); // BCP per-service log level
  // v7.1.0: credential changes end the user's live POP3 sessions (-ERR [AUTH]).
  pop3LiveSessions.attachInvalidation();
  startAuthInvalidationSubscriber();
  // v7.1: never serve mails whose raw objects are missing (OBJECT_STORAGE switched without migration)
  await waitForObjectStorage('pop3-server');
  await refreshHostname();
  await refreshTlsConfig();

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
  _appliedTls = _tlsConfig;

  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD);
  subscriber.on('message', (ch, message) => {
    if (ch === CHANNEL_SETTINGS_RELOAD) {
      void refreshHostname();
      void refreshTlsConfig().then(() => { applyTlsToRunningListeners(); scheduleReload(); });
      return;
    }
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
    for (const [port, tracked] of servers) {
      servers.delete(port);
      closePop3Server(tracked, port);
    }
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
