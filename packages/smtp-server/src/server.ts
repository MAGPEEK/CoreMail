import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import {
  createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD,
  generateSelfSignedCert, tlsPemToBuffers, applyTlsToListeners, tlsMaterialEquals, installProcessGuards,
  startAuthInvalidationSubscriber, resolveBindAddress, listenWithRecovery,
} from '@coremail/core';
import { connectDatabase, waitForObjectStorage, prisma, loadProtocolTls, selfSignedReplacement, selfSignedFallbackHostname, encryptPrivateKey, invalidateQueueSettingsCache, maxMessageBytesFrom } from '@coremail/storage';
import { createSmtpServer } from './core/factory.js';
import { smtpLiveSessions } from './core/live-sessions.js';
import { inboundTarpitMaxDelayMs } from './core/session.js';
import type { SmtpServerHandle } from './core/factory.js';
import { inboundHandlers } from './inbound/handler.js';
import { withDeviceRelay, invalidateDeviceRelayCache } from './inbound/device-relay.js';
import { submissionHandlers } from './submission/handler.js';
import { verifySmtpCredentials } from './auth/verifier.js';
import { startOutboundWorker } from './outbound/queue.js';
import { invalidateOutboundConfigCache } from './outbound/relay.js';
import { inboundMaxSize } from './inbound/connection-filter.js';
// Journaling feature completely removed in v3.13.6

const log = createLogger('smtp:server');
// v6: unhandled rejections are logged instead of killing the listener; uncaught exceptions exit 1 (supervisord restarts)
installProcessGuards(log);
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();

// ── Port-Defaults ─────────────────────────────────────────────────────────────
const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
// Primary source: ServerSettings.publicHostname in DB (set via Admin Panel)
// Fallback: SMTP_HOSTNAME / MAIL_HOSTNAME env vars (deprecated, for migration)
let _hostname: string = process.env['SMTP_HOSTNAME']?.trim() || process.env['MAIL_HOSTNAME']?.trim() || 'mail.localhost';

// ── TLS configuration (for port 465 / implicit TLS) ───────────────────────────
// Loaded from the DB at startup or generated as a self-signed certificate.
// Null = not loaded yet; undefined = no cert available (should never happen).
let _tlsConfig: { cert: Buffer; key: Buffer } | null = null;

// ── Banner configuration (SmtpSettings) ───────────────────────────────────────
// Empty = default banner ("hostname ESMTP CoreMail"); set = custom.
let _bannerText: string = '';

// ── ESMTP extensions + maxSize + maxRcpt (all from SmtpSettings) ─────────────
// Passed to the session config as getters → live updates take effect without
// restarting the listeners.
import { DEFAULT_ESMTP_EXTENSIONS, type EsmtpExtensions } from './core/types.js';
import { esmtpEnvFlags } from './core/esmtp-env.js';
import { smtpConnectionLimits, type SmtpConnectionLimits } from './core/connection-limits.js';
let _esmtp: EsmtpExtensions = { ...DEFAULT_ESMTP_EXTENSIONS };
let _maxSize: number = 25 * 1024 * 1024; // 25 MB default (matches SmtpSettings.maxMessageSizeMb default)
let _maxRcpt: number = 100;
// Connection settings (BCP → SMTP → Connection), schema defaults until loaded.
let _limits: SmtpConnectionLimits = smtpConnectionLimits(null);

async function refreshSmtpSettings(): Promise<void> {
  try {
    const s = await prisma.smtpSettings.findUnique({
      where:  { id: 'singleton' },
      select: {
        bannerOverride: true, bannerText: true,
        extStarttls: true, extAuthPlain: true, extAuthLogin: true,
        extPipelining: true, extSize: true, ext8bitmime: true,
        extEnhancedStatus: true,
        // extAuthCramMd5, extSmtputf8, extDsn, extChunking are not read: the BCP no longer
        // exposes them (their stored values are stale). v8.1: SMTPUTF8/DSN/CHUNKING are
        // controlled by SMTP_EXT_* env vars (default on), CRAM-MD5 stays off.
        maxMessageSizeMb: true, maxRecipients: true,
        maxConnections: true, maxConnectionsPerIp: true, connectionTimeoutSec: true,
        greetingDelaySec: true, maxAuthFailures: true,
      },
    });
    _limits = smtpConnectionLimits(s);
    _bannerText = (s?.bannerOverride && s.bannerText) ? s.bannerText : '';
    _esmtp = {
      starttls:       s?.extStarttls       ?? true,
      authPlain:      s?.extAuthPlain      ?? true,
      authLogin:      s?.extAuthLogin      ?? true,
      pipelining:     s?.extPipelining     ?? true,
      size:           s?.extSize           ?? true,
      bit8mime:       s?.ext8bitmime       ?? true,
      enhancedStatus: s?.extEnhancedStatus ?? true,
      // CRAM-MD5 (RFC 4954) — handleAuth only knows PLAIN+LOGIN, would return 504
      authCramMd5:    false,
      ...esmtpEnvFlags(),
    };
    _maxSize = maxMessageBytesFrom([s?.maxMessageSizeMb]); // port 25 + submission follow the SMTP setting
    _maxRcpt = Math.max(1, s?.maxRecipients ?? 100);
    if (inboundMaxSize(_maxSize) < _maxSize) {
      log.warn({ configured: _maxSize, inbound: inboundMaxSize(_maxSize) },
        'maxMessageSizeMb exceeds what the content filter can scan — inbound (port 25) is limited to the filter size');
    }
    log.info({ banner: _bannerText || '(default)', maxSize: _maxSize, maxRcpt: _maxRcpt, esmtp: _esmtp, limits: _limits }, 'SMTP settings refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh SMTP settings');
  }
}


async function refreshHostname(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.publicHostname) {
      _hostname = settings.publicHostname;
      log.debug({ hostname: _hostname }, 'SMTP hostname refreshed from DB');
    } else {
      // Seed env fallback into DB on first run so admin panel shows correct value
      const envHostname = process.env['MAIL_HOSTNAME']?.trim() || process.env['SMTP_HOSTNAME']?.trim() || undefined;
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

/**
 * Loads the TLS certificate from the DB.
 * If none exists, a self-signed certificate is generated
 * and stored in the DB for subsequent starts.
 */
/**
 * Detects whether a PEM certificate is self-signed (Issuer == Subject).
 * Self-signed certs are rejected by strict MTAs (Microsoft Exchange, Google)
 * → in that case we do not advertise STARTTLS on port 25 so MTAs deliver in plain.
 */
function isCertSelfSigned(certPem: string): boolean {
  try {
    // v6: static import — `require()` does not exist in ESM, so this check
    // (and certMatchesHostname) always fell into the catch branch before.
    const cert = new X509Certificate(certPem);
    // X509Certificate.issuer and subject are RFC2253 strings — compare exactly
    return cert.issuer === cert.subject;
  } catch {
    // On error, pessimistically assume self-signed (safe default)
    return true;
  }
}

/**
 * Checks whether the cert was issued for `expectedHostname` (CN or SAN match).
 * If not: cert hostname mismatch → strict MTAs (Outlook 365) reject.
 * Returns true on match, false on mismatch.
 */
function certMatchesHostname(certPem: string, expectedHostname: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    const lower = expectedHostname.toLowerCase();
    // Extract subject CN (e.g. "CN=mail.example.com, O=...")
    const subjectMatch = /CN=([^,]+)/i.exec(cert.subject);
    if (subjectMatch && subjectMatch[1]?.toLowerCase().trim() === lower) return true;
    // Search SANs (X509Certificate.subjectAltName: "DNS:foo.com, DNS:bar.com")
    const san = cert.subjectAltName ?? '';
    const sanEntries = san.split(',').map((s) => s.trim().toLowerCase());
    if (sanEntries.includes(`dns:${lower}`)) return true;
    return false;
  } catch {
    return false;
  }
}

async function refreshTlsConfig(): Promise<void> {
  try {
    // v5.2.8: cert directly from the certificates table via the services[] array
    // by service name (here: 'SMTP'). Fallback to legacy
    // ServerSettings.tlsCert for pre-v5.2.8 setups.
    const found = await loadProtocolTls('SMTP', generateSelfSignedCert);

    if (found) {
      if (found.unreadable) {
        // w1: an unreadable private key never drops TLS — the self-signed
        // replacement for the public host name is served until the admin acts.
        log.error({ certId: found.unreadable.certId, certName: found.unreadable.certName },
          `Private key of certificate "${found.unreadable.certName}" is unreadable — SMTP serves the self-signed replacement certificate; re-issue or upload the certificate`);
      }
      const isSelfSigned = isCertSelfSigned(found.certPem);
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      if (isSelfSigned && !certMatchesHostname(found.certPem, _hostname)) {
        log.warn({ hostname: _hostname }, 'SMTP self-signed cert subject != publicHostname — admin should activate a matching cert in BCP');
      }
      log.info({
        selfSigned: isSelfSigned, hostname: _hostname,
        source: found.source, certName: found.certName, certId: found.certId,
      }, 'SMTP TLS cert loaded');
      return;
    }

    // No certificate in the DB → generate a self-signed default cert. The admin
    // later replaces it in the BCP with a real cert.
    // 9.3: CN = the public host name (mail.localhost only while none is configured);
    // the api-gateway's startup reconciliation replaces this with a visible
    // self-signed default row for the same name.
    const SELF_SIGNED_HOSTNAME = await selfSignedFallbackHostname();
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No TLS cert in DB — generating self-signed certificate');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);

    // Store in DB so that all other mail protocols use the same certificate
    await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', publicHostname: _hostname, tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem) },
      update: { tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem) },
    });
    log.info('Self-signed TLS certificate generated and stored in DB');
  } catch (err) {
    log.error({ err }, 'Failed to load/generate TLS config — serving the self-signed replacement');
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
    log.warn({ hostname: r.hostname }, 'SMTP TLS: serving the self-signed replacement certificate');
  } catch (err) {
    log.error({ err }, 'SMTP TLS: self-signed replacement certificate could not be created');
  }
}

/** Submission ports (auth required) */
const SUBMISSION_PORTS = new Set([SMTP_PORT_465, SMTP_PORT_587]);

// ── Tracked server type ───────────────────────────────────────────────────────

interface TrackedSmtpServer {
  handle:  SmtpServerHandle;
  sockets: Set<net.Socket>;
  ssl:     boolean;
  /** Listener accepts TLS 1.0/1.1 (kept on certificate rotation). */
  allowLegacyTls: boolean;
}

/** TLS material the running listeners were last given (for change detection). */
let _appliedTls: { cert: Buffer; key: Buffer } | null = null;

/**
 * v6: certificate rotation without restarting listeners. Implicit-TLS
 * listeners (465) get the new cert via setSecureContext(); STARTTLS (25/587)
 * reads `_tlsConfig` per session through the config getter. An ssl listener
 * without a TLS server is closed so the next reload recreates it.
 */
function applyTlsToRunningListeners(): void {
  if (!_tlsConfig || tlsMaterialEquals(_tlsConfig, _appliedTls)) return;
  const res = applyTlsToListeners(
    [...servers].map(([port, t]) => ({ port, ssl: t.ssl, server: t.handle.server, allowLegacyTls: t.allowLegacyTls })),
    _tlsConfig,
  );
  for (const f of res.failed) log.error({ err: f.error, port: f.port }, 'SMTP TLS context update failed — keeping old cert');
  for (const port of res.restart) {
    const tracked = servers.get(port);
    if (tracked) { servers.delete(port); closeSmtpServer(tracked, port); }
  }
  _appliedTls = _tlsConfig;
  if (res.updated.length || res.restart.length) {
    log.info({ updated: res.updated, restarted: res.restart }, 'SMTP TLS certificate rotated on running listeners');
  }
}

const servers = new Map<number, TrackedSmtpServer>();

// ── Reload mutex ──────────────────────────────────────────────────────────────
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

// ── Server lifecycle ──────────────────────────────────────────────────────────

/**
 * Creates the appropriate SMTP server for a given port:
 *  - Port 25  → Inbound (no auth required, receives from other MTAs)
 *  - Port 465 → Submission with implicit TLS (auth required)
 *  - Port 587 → Submission with STARTTLS (auth required)
 */
function createTrackedSmtpServer(port: number, ssl: boolean, allowLegacyTls: boolean): TrackedSmtpServer {
  const isSubmission = SUBMISSION_PORTS.has(port);

  // Hostname, banner, maxSize, maxRcpt and ESMTP flags as getters — every new
  // session gets the current value from _esmtp / _maxSize / _bannerText.
  // Enables live updates without restarting listeners.
  const config = Object.defineProperties(
    {
      requireAuth: isSubmission,
      // Inbound listeners: the device relay (BCP → SMTP → Geräte-Relay) applies
      // only to configured networks on its configured port.
      handlers:    isSubmission ? submissionHandlers : withDeviceRelay(inboundHandlers, port),
      allowLegacyTls,
      // Tarpit only for inbound MTA traffic (port 25); SMTP_TARPIT_MAX_DELAY_MS=0 disables it.
      ...(isSubmission ? {} : { tarpitMaxDelayMs: inboundTarpitMaxDelayMs() }),
      ...(isSubmission ? { verifyCredentials: verifySmtpCredentials } : {}),
    } as Parameters<typeof createSmtpServer>[0],
    {
      // v6: TLS as a getter — STARTTLS sessions always use the current cert;
      // implicit TLS (465) is rotated via setSecureContext().
      tls:        { get: () => _tlsConfig ?? undefined, enumerable: true, configurable: true },
      hostname:   { get: () => _hostname,   enumerable: true, configurable: true },
      bannerText: { get: () => _bannerText, enumerable: true, configurable: true },
      // Inbound mail is scanned by the content filter (52 MB body limit):
      // advertise and enforce what can actually be accepted.
      maxSize:    { get: () => (isSubmission ? _maxSize : inboundMaxSize(_maxSize)), enumerable: true, configurable: true },
      maxRcpt:    { get: () => _maxRcpt,    enumerable: true, configurable: true },
      esmtp:      { get: () => _esmtp,      enumerable: true, configurable: true },
      // BCP → SMTP → Connection (live, per new connection/session)
      maxConnections:      { get: () => _limits.maxConnections,      enumerable: true, configurable: true },
      maxConnectionsPerIp: { get: () => _limits.maxConnectionsPerIp, enumerable: true, configurable: true },
      commandTimeoutMs:    { get: () => _limits.commandTimeoutMs,    enumerable: true, configurable: true },
      maxAuthFailures:     { get: () => _limits.maxAuthFailures,     enumerable: true, configurable: true },
      // The greeting delay only applies to MTA traffic on port 25, never to submission clients.
      greetingDelayMs:     { get: () => (isSubmission ? 0 : _limits.greetingDelayMs), enumerable: true, configurable: true },
      // ALWAYS advertise STARTTLS (on all ports incl. 25 inbound) — opportunistic TLS
      // (RFC 7435) works for most MTAs even with a self-signed cert. A cert whose name
      // does not match publicHostname is only logged (refreshTlsConfig), never
      // regenerated; for strict peers request a CA cert via BCP → SSL/TLS.
      advertiseStarttls: { get: () => true, enumerable: true, configurable: true },
    },
  );

  const handle = createSmtpServer(config, ssl);

  const sockets = new Set<net.Socket>();
  handle.server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return { handle, sockets, ssl, allowLegacyTls };
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
      closeSmtpServer(running, port);
      restarted.add(port);
    }
  }
  if (restarted.size > 0) {
    log.info({ ports: [...restarted] }, 'SMTP listener settings changed — restarting');
    setTimeout(scheduleReload, 500).unref?.();
  }
  return restarted;
}

async function reloadListeners(): Promise<void> {
  try {
    const listeners   = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter((l: typeof listeners[0]) => l.active).map((l: typeof listeners[0]) => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'SMTP reload');

    // Start newly active ports — per-listener error isolation:
    // A failure on one port (e.g. missing TLS cert) must not block the other ports.
    const restarted = stopChangedListeners(listeners);
    for (const l of listeners) {
      if (l.active && !servers.has(l.port) && !restarted.has(l.port)) {
        try {
          const tracked = createTrackedSmtpServer(l.port, l.ssl, l.allowLegacyTls);
          servers.set(l.port, tracked);
          const mode = SUBMISSION_PORTS.has(l.port) ? 'submission' : 'inbound';
          appliedListener.set(l.port, listenerSignature(l));
          // Bind errors (address not in the container, port still in use after a
          // restart) are logged and recovered — never an uncaught 'error' event.
          listenWithRecovery(tracked.handle.server, {
            port: l.port, address: l.address, label: 'SMTP', log,
            isCurrent: () => servers.get(l.port) === tracked,
            onListening: (address) => log.info({ port: l.port, ssl: l.ssl, mode, address, allowLegacyTls: l.allowLegacyTls }, 'SMTP listener started'),
            onGiveUp: () => {
              if (servers.get(l.port) !== tracked) return;
              servers.delete(l.port);
              appliedListener.delete(l.port);
            },
          });
        } catch (portErr) {
          log.error({ err: portErr, port: l.port, ssl: l.ssl },
            'Failed to start SMTP listener — port skipped, others continue');
        }
      }
    }

    // Stop deactivated / removed ports
    for (const [port, tracked] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        appliedListener.delete(port);
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
  void initRuntimeLogLevel('smtp-server', { aliases: ['smtp'] }); // BCP per-service log level
  // v7.1.0: credential changes end the user's authenticated submission sessions (421).
  smtpLiveSessions.attachInvalidation();
  startAuthInvalidationSubscriber();
  // v7.1: refuses to open listeners while the object storage misses the referenced objects
  await waitForObjectStorage('smtp-server');
  await refreshHostname();
  await refreshTlsConfig(); // load certificate or generate self-signed
  await refreshSmtpSettings(); // banner, ESMTP flags, maxSize, maxRcpt from SmtpSettings

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
  _appliedTls = _tlsConfig;

  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD);
  subscriber.on('message', (ch, message) => {
    if (ch === CHANNEL_SETTINGS_RELOAD) {
      void refreshHostname();
      void refreshSmtpSettings(); // all SMTP settings (banner, ESMTP flags, maxSize, maxRcpt)
      // Invalidate outbound smarthost/relay cache — new provider credentials
      // thus take effect on the next send attempt (instead of after the 60s TTL).
      invalidateOutboundConfigCache();
      // BCP → SMTP → Geräte-Relay takes effect for the next transaction.
      invalidateDeviceRelayCache();
      // BCP → Queues → Settings (retry/backoff/retention) take effect at once.
      invalidateQueueSettingsCache();
      // Reload TLS certificate and swap it into running listeners
      // (setSecureContext), then start any listener that is missing.
      void refreshTlsConfig().then(() => { applyTlsToRunningListeners(); scheduleReload(); });
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
