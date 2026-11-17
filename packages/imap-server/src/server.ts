import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import net from 'node:net';
import {
  createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD,
  generateSelfSignedCert, tlsPemToBuffers, applyTlsToListeners, tlsMaterialEquals, installProcessGuards,
  startAuthInvalidationSubscriber, onAuthInvalidation, resolveBindAddress, listenWithRecovery,
} from '@coremail/core';
import { namespaceConfig } from './commands/namespaces.js';
import { connectDatabase, waitForObjectStorage, prisma, loadProtocolTls, selfSignedReplacement, selfSignedFallbackHostname, encryptPrivateKey } from '@coremail/storage';
import { applyAuthInvalidation, createImapServer, setImapHostname, setImapMaxMessageSize, type ImapTlsConfig } from './server/index.js';
import { imapLiveSessions } from './session/live.js';
import { invalidExemptEntries } from './server/limits.js';

const log = createLogger('imap:main');
// v6: unhandled rejections are logged instead of killing the listener; uncaught exceptions exit 1 (supervisord restarts)
installProcessGuards(log);
if (invalidExemptEntries.length) log.warn({ invalid: invalidExemptEntries }, 'ignoring invalid MAIL_CONN_EXEMPT_CIDRS entries');
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// ── TLS configuration (for port 993 / implicit TLS) ───────────────────────────
let _tlsConfig: ImapTlsConfig | null = null;

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
async function refreshHostname(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.maxMessageSizeMb) setImapMaxMessageSize(settings.maxMessageSizeMb * 1024 * 1024);
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
    const found = await loadProtocolTls('IMAP', generateSelfSignedCert);

    if (found) {
      if (found.unreadable) {
        // w1: an unreadable private key never drops TLS — the self-signed
        // replacement for the public host name is served until the admin acts.
        log.error({ certId: found.unreadable.certId, certName: found.unreadable.certName },
          `Private key of certificate "${found.unreadable.certName}" is unreadable — IMAP serves the self-signed replacement certificate; re-issue or upload the certificate`);
      }
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      log.info({ source: found.source, certName: found.certName, certId: found.certId }, 'IMAP TLS cert loaded');
      return;
    }

    // No matching cert in DB → self-signed fallback (only useful on the very
    // first start). The admin later replaces it in the BCP with a real cert.
    // 9.3: CN = the public host name (mail.localhost only while none is configured);
    // the api-gateway's startup reconciliation replaces this with a visible
    // self-signed default row for the same name.
    const SELF_SIGNED_HOSTNAME = await selfSignedFallbackHostname();
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No protocol cert in DB — generating self-signed certificate for IMAP');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    // Store self-signed cert in ServerSettings.tlsCert as fallback for other services
    // during initial setup. activate-protocol overrides this later.
    await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', publicHostname: SELF_SIGNED_HOSTNAME, tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem) },
      update: { tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem) },
    });
    log.info('Self-signed TLS certificate generated and stored in DB (IMAP)');
  } catch (err) {
    log.error({ err }, 'Failed to load/generate IMAP TLS config — serving the self-signed replacement');
    await keepTlsOn();
  }
}

/**
 * w1: without a loaded certificate the implicit-TLS port would start in
 * plaintext — serve the self-signed replacement instead (a previously loaded
 * certificate stays in use).
 */
async function keepTlsOn(): Promise<void> {
  if (_tlsConfig) return;
  try {
    const r = await selfSignedReplacement(generateSelfSignedCert);
    _tlsConfig = tlsPemToBuffers(r.certPem, r.keyPem);
    log.warn({ hostname: r.hostname }, 'IMAP TLS: serving the self-signed replacement certificate');
  } catch (err) {
    log.error({ err }, 'IMAP TLS: self-signed replacement certificate could not be created');
  }
}

// ── Tracked server type ───────────────────────────────────────────────────────
interface TrackedImapServer {
  server:  ReturnType<typeof createImapServer>;
  sockets: Set<net.Socket>;
  ssl:     boolean;
  /** Listener accepts TLS 1.0/1.1 (kept on certificate rotation). */
  allowLegacyTls: boolean;
}

const servers = new Map<number, TrackedImapServer>();

/** TLS material the running listeners were last given (for change detection). */
let _appliedTls: ImapTlsConfig | null = null;

/**
 * v6: certificate rotation without restarting listeners — port 993 gets the
 * new cert via setSecureContext(). An ssl listener that fell back to
 * plaintext (no cert at start) is closed so the next reload recreates it.
 */
function applyTlsToRunningListeners(): void {
  if (!_tlsConfig || tlsMaterialEquals(_tlsConfig, _appliedTls)) return;
  const res = applyTlsToListeners(
    [...servers].map(([port, t]) => ({ port, ssl: t.ssl, server: t.server, allowLegacyTls: t.allowLegacyTls })),
    _tlsConfig,
  );
  for (const f of res.failed) log.error({ err: f.error, port: f.port }, 'IMAP TLS context update failed — keeping old cert');
  for (const port of res.restart) {
    const tracked = servers.get(port);
    if (tracked) { servers.delete(port); closeImapServer(tracked, port); }
  }
  _appliedTls = _tlsConfig;
  if (res.updated.length || res.restart.length) {
    log.info({ updated: res.updated, restarted: res.restart }, 'IMAP TLS certificate rotated on running listeners');
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

function createTrackedImapServer(ssl: boolean, allowLegacyTls: boolean): TrackedImapServer {
  // Pass TLS for implicit TLS (port 993); plaintext (port 143) offers STARTTLS
  // with the current protocol cert (read per upgrade → hot rotation). v7:
  // without a cert the plaintext port refuses authentication.
  const server = createImapServer(
    ssl && _tlsConfig ? _tlsConfig : undefined,
    { starttls: () => _tlsConfig, allowLegacyTls },
  );
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return { server, sockets, ssl, allowLegacyTls };
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
      closeImapServer(running, port);
      restarted.add(port);
    }
  }
  if (restarted.size > 0) {
    log.info({ ports: [...restarted] }, 'IMAP listener settings changed — restarting');
    setTimeout(scheduleReload, 500).unref?.();
  }
  return restarted;
}

async function reloadListeners(): Promise<void> {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'IMAP reload');

    // Start newly active ports
    const restarted = stopChangedListeners(listeners);
    for (const l of listeners) {
      if (l.active && !servers.has(l.port) && !restarted.has(l.port)) {
        try {
          const tracked = createTrackedImapServer(l.ssl, l.allowLegacyTls);
          servers.set(l.port, tracked);
          appliedListener.set(l.port, listenerSignature(l));
          // Bind errors (address not in the container, port still in use after a
          // restart) are logged and recovered — never an uncaught 'error' event.
          listenWithRecovery(tracked.server, {
            port: l.port, address: l.address, label: 'IMAP', log,
            isCurrent: () => servers.get(l.port) === tracked,
            onListening: (address) => log.info({ port: l.port, ssl: l.ssl, address, allowLegacyTls: l.allowLegacyTls }, 'IMAP listener started'),
            onGiveUp: () => {
              if (servers.get(l.port) !== tracked) return;
              servers.delete(l.port);
              appliedListener.delete(l.port);
            },
          });
        } catch (portErr) {
          log.error({ err: portErr, port: l.port, ssl: l.ssl },
            'Failed to start IMAP listener — port skipped');
        }
      }
    }

    // Close deactivated/removed ports (synchronously)
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        appliedListener.delete(port);   // Remove from map before closing
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
  void initRuntimeLogLevel('imap-server', { aliases: ['imap'] }); // BCP per-service log level
  // v7.1.0: credential changes (password, MFA, app password, deactivation …)
  // end the user's live IMAP connections (incl. IDLE) with * BYE.
  imapLiveSessions.attachInvalidation();
  // v9.1: any auth change (e.g. a delegating owner deactivated, or a
  // `permission-change` published by the admin API) drops the cached shared /
  // delegated mailbox permissions of all sessions (re-read on next use) and
  // re-checks the selected foreign mailbox of the user's IDLE sessions at once.
  onAuthInvalidation((e) => applyAuthInvalidation(e));
  startAuthInvalidationSubscriber();
  const ns = namespaceConfig();
  log.info({ otherUsers: ns.otherUsers, shared: ns.shared, accessCacheMs: ns.cacheMs }, 'IMAP namespaces');
  // v7.1: refuses to open listeners while the object storage misses the referenced objects
  await waitForObjectStorage('imap-server');
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
