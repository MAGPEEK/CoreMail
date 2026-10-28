import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD, generateSelfSignedCert, tlsPemToBuffers } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma, loadProtocolCert } from '@coremail/storage';
import { createSmtpServer } from './core/factory.js';
import type { SmtpServerHandle } from './core/factory.js';
import { inboundHandlers } from './inbound/handler.js';
import { submissionHandlers } from './submission/handler.js';
import { verifySmtpCredentials } from './auth/verifier.js';
import { startOutboundWorker } from './outbound/queue.js';
import { invalidateOutboundConfigCache } from './outbound/relay.js';
// Journaling feature completely removed in v3.13.6

const log = createLogger('smtp:server');

// ── Port-Defaults ─────────────────────────────────────────────────────────────
const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
// Primary source: ServerSettings.publicHostname in DB (set via Admin Panel)
// Fallback: SMTP_HOSTNAME / MAIL_HOSTNAME env vars (deprecated, for migration)
let _hostname: string = process.env['SMTP_HOSTNAME'] ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';

// ── TLS configuration (for port 465 / implicit TLS) ───────────────────────────
// Loaded from the DB at startup or generated as a self-signed certificate.
// Null = not loaded yet; undefined = no cert available (should never happen).
let _tlsConfig: { cert: Buffer; key: Buffer } | null = null;
// Self-signed certs are rejected by strict MTAs (e.g. Microsoft Exchange).
// Therefore STARTTLS is NOT advertised on port 25 (inbound) when the cert is self-signed.
let _tlsCertSelfSigned: boolean = true;

// ── Banner configuration (SmtpSettings) ───────────────────────────────────────
// Empty = default banner ("hostname ESMTP CoreMail"); set = custom.
let _bannerText: string = '';

// ── ESMTP extensions + maxSize + maxRcpt (all from SmtpSettings) ─────────────
// Passed to the session config as getters → live updates take effect without
// restarting the listeners.
import { DEFAULT_ESMTP_EXTENSIONS, type EsmtpExtensions } from './core/types.js';
let _esmtp: EsmtpExtensions = { ...DEFAULT_ESMTP_EXTENSIONS };
let _maxSize: number = 25 * 1024 * 1024; // 25 MB default (matches SmtpSettings.maxMessageSizeMb default)
let _maxRcpt: number = 100;

async function refreshSmtpSettings(): Promise<void> {
  try {
    const s = await prisma.smtpSettings.findUnique({
      where:  { id: 'singleton' },
      select: {
        bannerOverride: true, bannerText: true,
        extStarttls: true, extAuthPlain: true, extAuthLogin: true,
        extPipelining: true, extSize: true, ext8bitmime: true,
        extEnhancedStatus: true,
        // extAuthCramMd5, extSmtputf8, extDsn, extChunking no longer read — hardcoded false
        maxMessageSizeMb: true, maxRecipients: true,
      },
    });
    _bannerText = (s?.bannerOverride && s.bannerText) ? s.bannerText : '';
    _esmtp = {
      starttls:       s?.extStarttls       ?? true,
      authPlain:      s?.extAuthPlain      ?? true,
      authLogin:      s?.extAuthLogin      ?? true,
      pipelining:     s?.extPipelining     ?? true,
      size:           s?.extSize           ?? true,
      bit8mime:       s?.ext8bitmime       ?? true,
      enhancedStatus: s?.extEnhancedStatus ?? true,
      // Deliberately hardcoded false — the server has no implementation of these extensions:
      //   CRAM-MD5 (RFC 4954) — handleAuth only knows PLAIN+LOGIN, would return 504
      //   SMTPUTF8 (RFC 6531) — UTF-8 in envelope addresses not handled specially
      //   DSN (RFC 3461)      — no NOTIFY/ORCPT/ENVID/RET parsing, no multipart/report
      //   CHUNKING (RFC 3030) — BDAT command is not recognized by the parser
      authCramMd5:    false,
      smtputf8:       false,
      dsn:            false,
      chunking:       false,
    };
    _maxSize = Math.max(1, s?.maxMessageSizeMb ?? 25) * 1024 * 1024;
    _maxRcpt = Math.max(1, s?.maxRecipients ?? 100);
    log.info({ banner: _bannerText || '(default)', maxSize: _maxSize, maxRcpt: _maxRcpt, esmtp: _esmtp }, 'SMTP settings refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh SMTP settings');
  }
}

// Backwards-compat alias — legacy callers further down in server.ts
const refreshBanner = refreshSmtpSettings;

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { X509Certificate } = require('node:crypto') as typeof import('node:crypto');
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { X509Certificate } = require('node:crypto') as typeof import('node:crypto');
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
    const found = await loadProtocolCert('SMTP');

    if (found) {
      const isSelfSigned = isCertSelfSigned(found.certPem);
      _tlsConfig = tlsPemToBuffers(found.certPem, found.keyPem);
      _tlsCertSelfSigned = isSelfSigned;
      if (isSelfSigned && !certMatchesHostname(found.certPem, _hostname)) {
        log.warn({ hostname: _hostname }, 'SMTP self-signed cert subject != publicHostname — admin should activate a matching cert in BCP');
      }
      log.info({
        selfSigned: _tlsCertSelfSigned, hostname: _hostname,
        source: found.source, certName: found.certName, certId: found.certId,
      }, 'SMTP TLS cert loaded');
      return;
    }

    // No certificate in the DB → generate a self-signed default cert with a fixed
    // CN=mail.localhost.  The admin later replaces it in the BCP
    // with a real cert; a fixed CN prevents the self-signed cert from being
    // re-issued whenever publicHostname is renamed.
    const SELF_SIGNED_HOSTNAME = 'mail.localhost';
    log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'No TLS cert in DB — generating self-signed certificate');
    const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    _tlsCertSelfSigned = true;

    // Store in DB so that all other mail protocols use the same certificate
    await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', publicHostname: _hostname, tlsCert: certPem, tlsKey: keyPem },
      update: { tlsCert: certPem, tlsKey: keyPem },
    });
    log.info('Self-signed TLS certificate generated and stored in DB');
  } catch (err) {
    log.error({ err }, 'Failed to load/generate TLS config — implicit TLS ports (465) will be skipped');
  }
}

/** Submission ports (auth required) */
const SUBMISSION_PORTS = new Set([SMTP_PORT_465, SMTP_PORT_587]);

// ── Tracked server type ───────────────────────────────────────────────────────

interface TrackedSmtpServer {
  handle:  SmtpServerHandle;
  sockets: Set<net.Socket>;
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
function createTrackedSmtpServer(port: number, ssl: boolean): TrackedSmtpServer {
  const isSubmission = SUBMISSION_PORTS.has(port);

  // Hostname, banner, maxSize, maxRcpt and ESMTP flags as getters — every new
  // session gets the current value from _esmtp / _maxSize / _bannerText.
  // Enables live updates without restarting listeners.
  const config = Object.defineProperties(
    {
      requireAuth: isSubmission,
      handlers:    isSubmission ? submissionHandlers : inboundHandlers,
      ...(isSubmission ? { verifyCredentials: verifySmtpCredentials } : {}),
      // TLS from the DB-backed _tlsConfig — fixed at listener creation time.
      // For certificate rotation the affected listeners are restarted.
      tls: _tlsConfig ?? undefined,
    } as Parameters<typeof createSmtpServer>[0],
    {
      hostname:   { get: () => _hostname,   enumerable: true, configurable: true },
      bannerText: { get: () => _bannerText, enumerable: true, configurable: true },
      maxSize:    { get: () => _maxSize,    enumerable: true, configurable: true },
      maxRcpt:    { get: () => _maxRcpt,    enumerable: true, configurable: true },
      esmtp:      { get: () => _esmtp,      enumerable: true, configurable: true },
      // ALWAYS advertise STARTTLS (on all ports incl. 25 inbound). MX-Tools scoring
      // rewards TLS availability. Opportunistic TLS works for most MTAs.
      // Prerequisite: the self-signed cert has the CORRECT hostname CN (checked automatically
      // in refreshTlsConfig and regenerated on mismatch). For full Outlook 365
      // compatibility: request a Let's Encrypt cert via BCP → SSL/TLS.
      advertiseStarttls: { get: () => true, enumerable: true, configurable: true },
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

// ── Listener reload ───────────────────────────────────────────────────────────

async function reloadListeners(): Promise<void> {
  try {
    const listeners   = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter((l: typeof listeners[0]) => l.active).map((l: typeof listeners[0]) => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'SMTP reload');

    // Start newly active ports — per-listener error isolation:
    // A failure on one port (e.g. missing TLS cert) must not block the other ports.
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        try {
          const tracked = createTrackedSmtpServer(l.port, l.ssl);
          servers.set(l.port, tracked);
          const mode = SUBMISSION_PORTS.has(l.port) ? 'submission' : 'inbound';
          tracked.handle.listen(l.port, () =>
            log.info({ port: l.port, ssl: l.ssl, mode }, 'SMTP listener started'));
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
  await refreshTlsConfig(); // load certificate or generate self-signed
  await refreshBanner();    // load banner text from SmtpSettings

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
      void refreshBanner(); // all SMTP settings (banner, ESMTP flags, maxSize, maxRcpt)
      // Invalidate outbound smarthost/relay cache — new provider credentials
      // thus take effect on the next send attempt (instead of after the 60s TTL).
      invalidateOutboundConfigCache();
      // Reload TLS certificate — on cert rotation, running listeners must be
      // restarted (scheduleReload removes servers from the servers map and creates new ones).
      void refreshTlsConfig().then(() => scheduleReload());
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
