import net from 'node:net';
import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD, CHANNEL_SETTINGS_RELOAD, generateSelfSignedCert, tlsPemToBuffers } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createSmtpServer } from './core/factory.js';
import type { SmtpServerHandle } from './core/factory.js';
import { inboundHandlers } from './inbound/handler.js';
import { submissionHandlers } from './submission/handler.js';
import { verifySmtpCredentials } from './auth/verifier.js';
import { startOutboundWorker } from './outbound/queue.js';
import { invalidateOutboundConfigCache } from './outbound/relay.js';
// Journaling-Feature komplett entfernt in v3.13.6

const log = createLogger('smtp:server');

// ── Port-Defaults ─────────────────────────────────────────────────────────────
const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// ── Hostname (DB-backed, env var as migration fallback) ───────────────────────
// Primary source: ServerSettings.publicHostname in DB (set via Admin Panel)
// Fallback: SMTP_HOSTNAME / MAIL_HOSTNAME env vars (deprecated, for migration)
let _hostname: string = process.env['SMTP_HOSTNAME'] ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';

// ── TLS-Konfiguration (für Ports 465 / implizites TLS) ────────────────────────
// Wird beim Start aus der DB geladen oder als selbstsigniertes Zertifikat generiert.
// Null = noch nicht geladen; undefined = kein Cert verfügbar (soll nie vorkommen).
let _tlsConfig: { cert: Buffer; key: Buffer } | null = null;
// Self-signed Certs werden von strikten MTAs (z.B. Microsoft Exchange) abgelehnt.
// Auf Port 25 (Inbound) wird STARTTLS deshalb NICHT beworben wenn Cert self-signed.
let _tlsCertSelfSigned: boolean = true;

// ── Banner-Konfiguration (SmtpSettings) ───────────────────────────────────────
// Leer = Standard-Banner ("hostname ESMTP CoreMail"); gesetzt = benutzerdefiniert.
let _bannerText: string = '';

// ── ESMTP-Erweiterungen + maxSize + maxRcpt (alle aus SmtpSettings) ──────────
// Werden als Getter an die Session-Config übergeben → Live-Updates ohne
// Listener-Neustart wirken.
import { DEFAULT_ESMTP_EXTENSIONS, type EsmtpExtensions } from './core/types.js';
let _esmtp: EsmtpExtensions = { ...DEFAULT_ESMTP_EXTENSIONS };
let _maxSize: number = 25 * 1024 * 1024; // 25 MB Default (matched SmtpSettings.maxMessageSizeMb default)
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
        // extAuthCramMd5, extSmtputf8, extDsn, extChunking nicht mehr gelesen — hardcoded false
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
      // Bewusst hardcoded false — Server hat keine Implementierung dieser Extensions:
      //   CRAM-MD5 (RFC 4954) — handleAuth kennt nur PLAIN+LOGIN, würde 504 zurückgeben
      //   SMTPUTF8 (RFC 6531) — UTF-8 in Envelope-Adressen nicht gesondert behandelt
      //   DSN (RFC 3461)      — kein NOTIFY/ORCPT/ENVID/RET-Parsing, kein multipart/report
      //   CHUNKING (RFC 3030) — BDAT-Command wird vom Parser nicht erkannt
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

// Backwards-Compat-Alias — alte Aufrufer im server.ts unten
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
 * Lädt das TLS-Zertifikat aus der DB.
 * Falls keines vorhanden ist, wird ein selbstsigniertes Zertifikat generiert
 * und für spätere Starts in der DB gespeichert.
 */
/**
 * Erkennt ob ein PEM-Zertifikat self-signed ist (Issuer == Subject).
 * Self-signed Certs werden von strikten MTAs (Microsoft Exchange, Google) abgelehnt
 * → wir bewerben STARTTLS dann nicht auf Port 25 damit MTAs in Plain zustellen.
 */
function isCertSelfSigned(certPem: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { X509Certificate } = require('node:crypto') as typeof import('node:crypto');
    const cert = new X509Certificate(certPem);
    // X509Certificate.issuer und subject sind RFC2253 strings — vergleichen sich exakt
    return cert.issuer === cert.subject;
  } catch {
    // Im Fehlerfall pessimistisch annehmen self-signed (sicherer Default)
    return true;
  }
}

async function refreshTlsConfig(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { tlsCert: true, tlsKey: true },
    });

    if (settings?.tlsCert && settings?.tlsKey) {
      _tlsConfig = tlsPemToBuffers(settings.tlsCert, settings.tlsKey);
      _tlsCertSelfSigned = isCertSelfSigned(settings.tlsCert);
      log.debug({ selfSigned: _tlsCertSelfSigned }, 'SMTP TLS cert loaded from DB');
      return;
    }

    // Kein Zertifikat in der DB → selbstsigniertes generieren
    log.info({ hostname: _hostname }, 'No TLS cert in DB — generating self-signed certificate');
    const { certPem, keyPem } = generateSelfSignedCert(_hostname);
    _tlsConfig = tlsPemToBuffers(certPem, keyPem);
    _tlsCertSelfSigned = true;

    // In DB speichern damit alle anderen Mail-Protokolle dasselbe Zertifikat verwenden
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

  // Hostname, Banner, maxSize, maxRcpt und ESMTP-Flags als Getter — jede neue
  // Session bekommt den aktuellen Wert aus _esmtp / _maxSize / _bannerText.
  // Ermöglicht Live-Updates ohne Listener-Neustart.
  const config = Object.defineProperties(
    {
      requireAuth: isSubmission,
      handlers:    isSubmission ? submissionHandlers : inboundHandlers,
      ...(isSubmission ? { verifyCredentials: verifySmtpCredentials } : {}),
      // TLS aus dem DB-backed _tlsConfig — zum Erstellungszeitpunkt des Listeners gesetzt.
      // Für Zertifikat-Rotation werden die betroffenen Listener neu gestartet.
      tls: _tlsConfig ?? undefined,
    } as Parameters<typeof createSmtpServer>[0],
    {
      hostname:   { get: () => _hostname,   enumerable: true, configurable: true },
      bannerText: { get: () => _bannerText, enumerable: true, configurable: true },
      maxSize:    { get: () => _maxSize,    enumerable: true, configurable: true },
      maxRcpt:    { get: () => _maxRcpt,    enumerable: true, configurable: true },
      esmtp:      { get: () => _esmtp,      enumerable: true, configurable: true },
      // Port 25 (Inbound) mit self-signed Cert: STARTTLS NICHT bewerben — strikte MTAs
      // (Microsoft Exchange, Google) brechen sonst am TLS-Handshake ab → 503 Bad sequence.
      // Submission-Ports (465/587) bieten STARTTLS immer an (Clients akzeptieren self-signed).
      advertiseStarttls: { get: () => isSubmission || !_tlsCertSelfSigned, enumerable: true, configurable: true },
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
    const activePorts = new Set(listeners.filter((l: typeof listeners[0]) => l.active).map((l: typeof listeners[0]) => l.port));

    log.debug({ activePorts: [...activePorts], runningPorts: [...servers.keys()] }, 'SMTP reload');

    // Start newly active ports — per-listener error isolation:
    // Ein Fehler bei einem Port (z.B. fehlendes TLS-Cert) darf andere Ports nicht blockieren.
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
  await refreshTlsConfig(); // Zertifikat laden oder self-signed generieren
  await refreshBanner();    // Banner-Text aus SmtpSettings laden

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
      void refreshBanner(); // alle SMTP-Settings (Banner, ESMTP-Flags, maxSize, maxRcpt)
      // Outbound-Smarthost/Relay-Cache invalidieren — neue Provider-Credentials
      // wirken so direkt beim nächsten Send-Versuch (statt erst nach 60s TTL).
      invalidateOutboundConfigCache();
      // TLS-Zertifikat neu laden — bei Cert-Rotation müssen laufende Listener
      // neu gestartet werden (scheduleReload räumt Server aus servers-Map und erstellt neue).
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
