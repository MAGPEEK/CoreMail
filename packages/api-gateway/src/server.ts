import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectDatabase, prisma } from '@coremail/storage';
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';

// ── Security Middleware (OWASP) ───────────────────────────────────────────────
import {
  requestId,
  helmetMiddleware,
  suspiciousInputGuard,
  generalRateLimit,
  authRateLimit,
  setupRateLimit,
  adminMutationRateLimit,
} from './middleware/security.js';

import { mailRouter } from './routes/mail.js';
import { calendarRouter } from './routes/calendar.js';
import { contactsRouter } from './routes/contacts.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { userRouter } from './routes/user.js';
import { categoriesRouter } from './routes/categories.js';
import { adminDashboardRouter } from './routes/admin/dashboard.js';
import { adminGlobalSettingsRouter } from './routes/admin/global-settings.js';
import { adminMailboxesRouter } from './routes/admin/mailboxes.js';
import { adminAliasesRouter } from './routes/admin/aliases.js';
import { adminDomainsRouter } from './routes/admin/domains.js';
import { adminQueuesRouter } from './routes/admin/queues.js';
import { adminLogsRouter } from './routes/admin/logs.js';
import { adminBackupsRouter } from './routes/admin/backups.js';
import { adminResourcesRouter } from './routes/admin/resources.js';
// Public Folders completely removed in v3.18.31
// eDiscovery & Legal Hold completely removed in v3.18.5
import { adminEmsRouter } from './routes/admin/ems.js';
// Journaling feature completely removed in v3.13.6
import { adminRetentionRouter } from './routes/admin/retention.js';
import { adminAuditLogRouter } from './routes/admin/audit-log.js';
import { adminServersRouter } from './routes/admin/servers.js';
import { adminServicesRouter } from './routes/admin/services.js';
import { adminCertificatesRouter, getAcmeChallenge } from './routes/admin/certificates.js';
import { startTlsProxy, setTlsUpgradeHandler } from './tls-proxy.js';
// auto-letsencrypt removed — admin requests LE manually via BCP → SSL/TLS
import { adminSharedMailboxesRouter } from './routes/admin/shared-mailboxes.js';
import { adminQuarantineRouter } from './routes/admin/quarantine.js';
import { adminTransportRulesRouter } from './routes/admin/transport-rules.js';
import { adminMobileRouter } from './routes/admin/mobile.js';
import { adminMessageTraceRouter } from './routes/admin/message-trace.js';
import { adminConnectorsRouter } from './routes/admin/connectors.js';
import { adminOrganisationRouter } from './routes/admin/organisation.js';
// adminExternalContactsRouter completely removed in v3.18.33
import { adminSecurityRouter } from './routes/admin/security.js';
import { adminSecurityAttacksRouter } from './routes/admin/security-attacks.js';
import { adminSmtpConfigRouter } from './routes/admin/smtp-config.js';
import { adminLdapRouter } from './routes/admin/ldap.js';
import { adminSsoRouter } from './routes/admin/sso.js';
import { pushRouter } from './routes/push.js';
import { smimeRouter } from './routes/smime.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { retentionTagsRouter } from './routes/retention-tags.js';
import { powershellRouter } from './routes/powershell.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';
import { auditMiddleware } from './lib/audit.js';
import { syncServerUrlsFromHostname } from './lib/server-urls.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── BigInt serialization (Prisma returns BigInt for quota fields) ─────────────
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

// ── Trust Proxy ───────────────────────────────────────────────────────────────
// When a reverse proxy (Traefik, Caddy, nginx) sits in front, enable proper
// client-IP handling so that rate limiting works on the real IP.
// Value: 1 = exactly 1 proxy in front of the app server (typical for Docker deployments).
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE STACK
// Order is critical — do not change without reading the comments!
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Request-ID — before everything else so that logs can be correlated
app.use(requestId);

// 2. Helmet — set security headers on every response
//    Must come early so that error responses carry the right headers too.
app.use(helmetMiddleware);

// 3. Suspicious-input guard — before the body parser consumes the stream
//    Blocks CRLF injection, null bytes, path traversal, oversized headers.
app.use(suspiciousInputGuard);

// 4. Global rate limiting — per IP, loopback exempt
app.use(generalRateLimit);

// v5.6.0: OIDC Discovery + JWKS removed (OAuth2 completely out of the stack).

// ── ACME HTTP-01 Challenge ────────────────────────────────────────────────────
// Must come before the proxies (no auth, no body parser needed).
app.get('/.well-known/acme-challenge/:token', async (req, res) => {
  const token = req.params['token'] ?? '';
  // Token may only contain alphanumerics + hyphen/underscore (ACME spec)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) {
    res.status(400).send('Invalid token');
    return;
  }
  const keyAuth = await getAcmeChallenge(token);
  if (!keyAuth) { res.status(404).send('Not found'); return; }
  res.type('text/plain').send(keyAuth);
});

// ── Internal proxies — register BEFORE express.json()! ───────────────────────
// express.json() consumes the body stream. Proxy routes must therefore come
// first so they can forward the body directly.
const EWS_URL = process.env['EWS_SERVICE_URL']  ?? 'http://localhost:8080';
const EAS_URL = process.env['EAS_SERVICE_URL']  ?? 'http://localhost:3005';
const DAV_URL = process.env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082';
const BACKUP_URL = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';
// v3.18.35: Autodiscover has its OWN service on port 8081 — do not route
// to EWS, otherwise Express answers with "Cannot POST /Autodiscover/
// Autodiscover.xml" and Outlook LTSC does not connect.
const AUTODISCOVER_URL = process.env['AUTODISCOVER_SERVICE_URL'] ?? 'http://localhost:8081';
// v5.7.1: JMAP server (RFC 8620/8621 + extensions) on port 3006
const JMAP_URL = process.env['JMAP_SERVICE_URL'] ?? 'http://localhost:3006';

function internalProxy(targetBase: string): express.RequestHandler {
  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // Express strips the mount prefix from req.url — restore originalUrl
        proxyReq.path = (req as express.Request).originalUrl;
      },
      error: (err, _req, res) => {
        log.warn({ err, target: targetBase }, 'Proxy error');
        if (!('headersSent' in res && res.headersSent)) {
          (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
        }
      },
    },
  });
  return proxy as express.RequestHandler;
}

app.use('/EWS',          internalProxy(EWS_URL));
// v5.7.0: MAPI over HTTP back in the stack — optional, toggle in BCP → Server
// (ServerSettings.mapiHttpEnabled). The ews-server returns 404 when off.
app.use('/mapi',         internalProxy(EWS_URL));
// v5.7.1: JMAP — toggle in BCP → Server → „JMAP" (jmap-server returns 404 when off).
// WebSocket upgrades (/jmap/ws, RFC 8887) are forwarded to jmapProxy.upgrade in
// start() on the HTTP server and in the TLS proxy.
const jmapProxy = createProxyMiddleware({
  target: JMAP_URL,
  changeOrigin: true,
  ws: true,
  on: {
    proxyReq: (proxyReq, req) => { proxyReq.path = (req as express.Request).originalUrl; },
    error: (err, _req, res) => {
      log.warn({ err, target: JMAP_URL }, 'JMAP proxy error');
      if ('writeHead' in res && !('headersSent' in res && res.headersSent)) {
        (res as express.Response).status(502).json({ error: 'Service temporarily unavailable' });
      }
    },
  },
});
export const jmapUpgrade = jmapProxy.upgrade;
app.use('/jmap',             jmapProxy as express.RequestHandler);
app.use('/.well-known/jmap', jmapProxy as express.RequestHandler);
app.use('/OAB',          internalProxy(EWS_URL));
// v3.18.35: Autodiscover has its own service (port 8081), not EWS.
app.use('/Autodiscover', internalProxy(AUTODISCOVER_URL));
app.use('/autodiscover', internalProxy(AUTODISCOVER_URL));
app.use('/Microsoft-Server-ActiveSync', internalProxy(EAS_URL));
app.use('/dav',          internalProxy(DAV_URL));

// Auth-service routes (MFA, app passwords, sessions) — BEFORE express.json()!
// Login/Refresh/Logout are implemented directly in authRouter (no proxy needed).
const AUTH_SERVICE_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';
app.use('/auth/mfa',           internalProxy(AUTH_SERVICE_URL));
app.use('/auth/app-passwords', internalProxy(AUTH_SERVICE_URL));
app.use('/auth/sessions',      internalProxy(AUTH_SERVICE_URL));
// v5.6.0: /oauth2/* proxy removed (OAuth2 server gone).
// v5.4.0: ADFS emulation removed (was for Outlook 2024 LTSC Modern Auth).

// ── Body parser ───────────────────────────────────────────────────────────────
// JSON — 10 MB limit (for mail content with inline images)
app.use(express.json({ limit: '10mb' }));
// URL-encoded (forms) — 1 MB limit
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── Auth — strict rate limiting on login/token/refresh ───────────────────────
app.use('/auth', authRateLimit, authRouter);

// ── Health ────────────────────────────────────────────────────────────────────
// No rate limit on /healthz (called by Docker every 30s)
const PKG_PATH = resolve(process.cwd(), 'packages/api-gateway/package.json');
const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(PKG_PATH, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'api-gateway', version: APP_VERSION }));

// ── Public maintenance-mode status (no auth needed) ───────────────────────────
// Queried by the OWA LoginPage to display the maintenance banner.
app.get('/api/v1/maintenance', async (_req, res) => {
  try {
    const cfg = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { maintenanceMode: true, maintenanceMessage: true },
    });
    res.json({
      maintenanceMode:    cfg?.maintenanceMode    ?? false,
      maintenanceMessage: cfg?.maintenanceMessage ?? '',
    });
  } catch {
    res.json({ maintenanceMode: false, maintenanceMessage: '' });
  }
});

// ── Changelog API ─────────────────────────────────────────────────────────────
const CHANGELOG_PATH = process.env['CHANGELOG_PATH']
  ?? resolve(process.cwd(), 'CHANGELOG.md');

app.get('/api/v1/changelog', (_req, res) => {
  try {
    const raw = readFileSync(CHANGELOG_PATH, 'utf-8');
    const versions: Array<{ version: string; date: string; sections: Record<string, string[]> }> = [];
    let current: (typeof versions)[0] | null = null;
    let currentSection = '';

    for (const line of raw.split('\n')) {
      const versionMatch = /^## \[(.+?)\](?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
      if (versionMatch) {
        if (current) versions.push(current);
        current = { version: versionMatch[1]!, date: versionMatch[2] ?? '', sections: {} };
        currentSection = '';
        continue;
      }
      const sectionMatch = /^### (.+)/.exec(line);
      if (sectionMatch && current) {
        currentSection = sectionMatch[1]!;
        current.sections[currentSection] = [];
        continue;
      }
      const itemMatch = /^[-*] (.+)/.exec(line);
      if (itemMatch && current && currentSection) {
        current.sections[currentSection]!.push(itemMatch[1]!);
      }
    }
    if (current) versions.push(current);
    res.json({ versions, raw });
  } catch {
    res.status(503).json({ error: 'Changelog not available' });
  }
});

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/v1/events', requireAuth, sseHandler);

// ── Feature Routes ────────────────────────────────────────────────────────────
app.use('/api/v1/setup', setupRateLimit, setupRouter);

app.use('/api/v1/mail',           mailRouter);
app.use('/api/v1/calendar',       calendarRouter);
app.use('/api/v1/contacts',       contactsRouter);
app.use('/api/v1/tasks',          tasksRouter);
app.use('/api/v1/notes',          notesRouter);
app.use('/api/v1/user',           userRouter);
app.use('/api/v1/categories',     categoriesRouter);
app.use('/api/v1/smime',          smimeRouter);
app.use('/api/v1/retention-tags', retentionTagsRouter);
app.use('/api/v1/push',           pushRouter);

// PowerShell Remoting
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// ── Admin Routes ──────────────────────────────────────────────────────────────
// Audit middleware for all mutating admin calls (fire-and-forget)
app.use('/api/v1/admin', auditMiddleware);
// Additional rate limit on mutating admin operations (POST/PUT/PATCH/DELETE)
app.use('/api/v1/admin', adminMutationRateLimit);

app.use('/api/v1/admin/dashboard',       adminDashboardRouter);
app.use('/api/v1/admin/settings',        adminGlobalSettingsRouter);
app.use('/api/v1/admin/mailboxes',       adminMailboxesRouter);
// Alias router mounts on /admin — the internal routes are /mailboxes/:id/aliases,
// /shared-mailboxes/:id/aliases, /aliases, /aliases/:id. Appended after the more
// specific routers — Express falls through when the others have no match.
app.use('/api/v1/admin',                 adminAliasesRouter);
app.use('/api/v1/admin/domains',         adminDomainsRouter);
app.use('/api/v1/admin/queues',          adminQueuesRouter);
app.use('/api/v1/admin/backups',         adminBackupsRouter);
app.use('/api/v1/admin/logs',            adminLogsRouter);
// v5.6.1: /api/v1/admin/groups removed (DistributionGroups gone)
app.use('/api/v1/admin/resources',       adminResourcesRouter);
// Public-Folders route removed in v3.18.31
// eDiscovery route removed in v3.18.5
app.use('/api/v1/admin/ems',             adminEmsRouter);
// Journaling route removed in v3.13.6
app.use('/api/v1/admin/compliance/retention',  adminRetentionRouter);
app.use('/api/v1/admin/audit-log',        adminAuditLogRouter);
// v5.6.0: /api/v1/admin/oauth removed (OAuth2 clients admin gone)
app.use('/api/v1/admin/servers',          adminServersRouter);
app.use('/api/v1/admin/services',         adminServicesRouter);
app.use('/api/v1/admin/certificates',     adminCertificatesRouter);
app.use('/api/v1/admin/shared-mailboxes', adminSharedMailboxesRouter);
app.use('/api/v1/admin/quarantine',       adminQuarantineRouter);
app.use('/api/v1/admin/transport-rules',  adminTransportRulesRouter);
app.use('/api/v1/admin/mobile',           adminMobileRouter);
app.use('/api/v1/admin/message-trace',    adminMessageTraceRouter);
app.use('/api/v1/admin/connectors',       adminConnectorsRouter);
app.use('/api/v1/admin/organisation',     adminOrganisationRouter);
// /api/v1/admin/contacts (external contacts) completely removed in v3.18.33
app.use('/api/v1/admin/security',         adminSecurityRouter);
app.use('/api/v1/admin/security/attacks', adminSecurityAttacksRouter);
app.use('/api/v1/admin/smtp-config',      adminSmtpConfigRouter);
app.use('/api/v1/admin/ldap',             adminLdapRouter);
app.use('/api/v1/admin/sso',              adminSsoRouter);

// ── Static frontend files (OWA under root + BCP under /bcp) ──────────────────
const WWW_DIR = process.env['WWW_DIR'] ?? '/app/www';
const owaDir  = join(WWW_DIR, 'owa');
const bcpDir  = join(WWW_DIR, 'bcp');

// Legacy: redirect old /owa/* URLs to the root path (backwards compat for
// saved bookmarks from earlier versions)
app.get('/owa', (_req, res) => res.redirect(301, '/'));
app.get('/owa/*', (req, res) => {
  const stripped = req.originalUrl.replace(/^\/owa\/?/, '/');
  res.redirect(301, stripped);
});

// BCP keeps the /bcp prefix (admin panel has its own Vite base)
if (existsSync(bcpDir)) {
  app.use('/bcp', express.static(bcpDir, {
    maxAge: '1y',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('/bcp/*', (_req, res) => res.sendFile(join(bcpDir, 'index.html')));
  log.info({ dir: bcpDir }, 'Serving BCP static files');
}

// OWA frontend under root — must come AFTER all API routes so that
// /auth/* /api/* /EWS/* etc. take precedence. Catch-all `app.get('*')` sends
// all unknown routes back to index.html (SPA routing).
if (existsSync(owaDir)) {
  app.use(express.static(owaDir, {
    maxAge: '1y',
    index: false, // we serve index.html manually so the catch-all applies
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA catch-all: everything not matched so far that is NOT a known
  // API/proxy route is an OWA route → return index.html.
  const API_PREFIXES = [
    '/api/', '/auth/', '/.well-known/', '/EWS', '/mapi', '/jmap', '/OAB', '/Autodiscover', '/autodiscover',
    '/Microsoft-Server-ActiveSync', '/dav', '/PowerShell', '/bcp',
  ];
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) {
      return next();
    }
    res.sendFile(join(owaDir, 'index.html'));
  });
  log.info({ dir: owaDir }, 'Serving OWA static files (root)');
} else {
  // No OWA bundle mounted — root redirects to /bcp or plain info
  app.get('/', (_req, res) => res.redirect(302, '/bcp/'));
}

// ── 404 + error handler ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  // Never send the stack trace to the client (OWASP A05: Security Misconfiguration)
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDatabase();
  // v5.6.0: initJwtKeys() removed (RS256 keys were for OAuth2 — completely gone)
  getRedisClient();
  log.info({ port: PORT }, 'API Gateway listening');
  const httpServer = app.listen(PORT);
  // v5.7.1: JMAP over WebSocket (RFC 8887) — pass upgrade requests through to the jmap-server
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/jmap/ws') && jmapUpgrade) jmapUpgrade(req, socket as never, head);
    else socket.destroy();
  });

  // Integrated HTTPS reverse proxy — starts automatically once a certificate
  // has been set in BCP → SSL/TLS → "Als HTTPS aktivieren".
  // Hot-reload on certificate activation via Redis (no restart needed).
  setTlsUpgradeHandler((req, socket, head) => {
    if (req.url?.startsWith('/jmap/ws') && jmapUpgrade) jmapUpgrade(req, socket as never, head);
    else socket.destroy();
  });
  void startTlsProxy(app).catch(err =>
    log.warn({ err }, 'TLS proxy startup failed — HTTPS not available'),
  );

  // ── Startup consistency check: reconcile server_settings.tlsCert with certificates table ──
  // If server_settings.tlsCert is set but no cert with isActiveProtocol: true
  // exists in the certificates table (e.g. after manual deletion without the API),
  // server_settings.tlsCert/tlsKey are set to NULL → self-signed fallback.
  void syncProtocolCertState().catch(err =>
    log.warn({ err }, 'Protocol cert state sync failed — check certificates manually'),
  );

  // v3.18.35+36: URL synchronization. When the admin changed publicHostname
  // (e.g. from mail.local to mail.<real-domain>), the derived URLs were not
  // migrated along. Outlook Autodiscover then returns stale addresses →
  // Outlook cannot connect. This migration fixes all URL fields at container
  // start (in addition to the synchronous updates on domain-create /
  // make-primary / settings-PUT).
  void syncServerUrlsFromHostname().catch(err =>
    log.warn({ err }, 'Server-URL sync failed — check Outlook Autodiscover'),
  );

  // ── Clean up stale PENDING/RENEWING certificates ──────────────────────────
  // After a container restart certs can be stuck in PENDING or RENEWING
  // (the ACME background process was killed by the restart).
  // All certs in this state for >10 minutes are set to ERROR.
  void (async () => {
    try {
      const staleThreshold = new Date(Date.now() - 10 * 60_000);
      const cleaned = await prisma.certificate.updateMany({
        where: {
          status: { in: ['PENDING', 'RENEWING'] },
          updatedAt: { lt: staleThreshold },
        },
        data: {
          status:    'ERROR',
          lastError: 'Prozess durch Server-Neustart unterbrochen — bitte Zertifikat erneut anfordern.',
        },
      });
      if (cleaned.count > 0) {
        log.warn({ count: cleaned.count }, 'Stale PENDING/RENEWING certificates reset to ERROR on startup');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to cleanup stale pending certificates (non-fatal)');
    }
  })();

  // No auto-LE — admin requests Let's Encrypt manually via BCP → SSL/TLS.
}

async function syncProtocolCertState(): Promise<void> {
  try {
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { tlsCert: true },
    });

    // No TLS cert in ServerSettings → nothing to do
    if (!settings?.tlsCert) return;

    // Is there a cert with isActiveProtocol: true?
    const activeProtocolCert = await prisma.certificate.findFirst({
      where:  { isActiveProtocol: true },
      select: { id: true, name: true },
    });

    if (activeProtocolCert) {
      // Everything consistent
      log.debug({ certId: activeProtocolCert.id }, 'Protocol TLS cert state: consistent');
      return;
    }

    // Orphaned: server_settings has TLS data but no isActiveProtocol cert → clean up
    await prisma.serverSettings.update({
      where: { id: 'singleton' },
      data:  { tlsCert: null, tlsKey: null },
    });
    await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
    log.info('Startup sync: orphaned server_settings.tlsCert cleared — SMTP/IMAP/POP3 using self-signed');
  } catch (err) {
    log.error({ err }, 'syncProtocolCertState failed');
  }
}

// v3.18.36: inline implementation of syncAutodiscoverUrls() extracted to lib/server-urls.ts
// (now syncServerUrlsFromHostname). Shared by domain-create / make-primary
// and settings-PUT.

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
