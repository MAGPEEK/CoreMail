import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectDatabase, prisma } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';

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
import { adminGroupsRouter } from './routes/admin/groups.js';
import { adminResourcesRouter } from './routes/admin/resources.js';
import { adminPublicFoldersRouter } from './routes/admin/public-folders.js';
import { adminEDiscoveryRouter } from './routes/admin/ediscovery.js';
import { adminEmsRouter } from './routes/admin/ems.js';
// Journaling-Feature komplett entfernt in v3.13.6
import { adminRetentionRouter } from './routes/admin/retention.js';
import { adminAuditLogRouter } from './routes/admin/audit-log.js';
import { adminOAuthClientsRouter } from './routes/admin/oauth-clients.js';
import { adminServersRouter } from './routes/admin/servers.js';
import { adminServicesRouter } from './routes/admin/services.js';
import { adminCertificatesRouter, getAcmeChallenge } from './routes/admin/certificates.js';
import { startTlsProxy } from './tls-proxy.js';
import { adminSharedMailboxesRouter } from './routes/admin/shared-mailboxes.js';
import { adminQuarantineRouter } from './routes/admin/quarantine.js';
import { adminTransportRulesRouter } from './routes/admin/transport-rules.js';
import { adminMobileRouter } from './routes/admin/mobile.js';
import { adminMessageTraceRouter } from './routes/admin/message-trace.js';
import { adminConnectorsRouter } from './routes/admin/connectors.js';
import { adminOrganisationRouter } from './routes/admin/organisation.js';
import { adminExternalContactsRouter } from './routes/admin/external-contacts.js';
import { adminSecurityRouter } from './routes/admin/security.js';
import { adminSecurityAttacksRouter } from './routes/admin/security-attacks.js';
import { adminSmtpConfigRouter } from './routes/admin/smtp-config.js';
import { adminLdapRouter } from './routes/admin/ldap.js';
import { adminSsoRouter } from './routes/admin/sso.js';
import { pushRouter } from './routes/push.js';
import { smimeRouter } from './routes/smime.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { publicFoldersRouter } from './routes/public-folders.js';
import { powershellRouter } from './routes/powershell.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';
import { auditMiddleware } from './lib/audit.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── BigInt-Serialisierung (Prisma gibt BigInt für Quota-Felder zurück) ────────
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

// ── Trust Proxy ───────────────────────────────────────────────────────────────
// Wenn ein Reverse Proxy (Traefik, Caddy, nginx) vorgelagert ist, das richtige
// Client-IP-Handling aktivieren, damit Rate-Limiting auf die echte IP arbeitet.
// Wert: 1 = genau 1 Proxy vor dem App-Server (typisch bei Docker-Deployments).
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE STACK
// Reihenfolge ist kritisch — nicht verändern ohne Kommentar zu lesen!
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Request-ID — vor allem anderen, damit Logs korrelierbar sind
app.use(requestId);

// 2. Helmet — Security-Header auf jede Antwort setzen
//    Muss früh kommen damit auch Fehlerantworten die richtigen Header haben.
app.use(helmetMiddleware);

// 3. Suspicious-Input-Guard — bevor Body-Parser den Stream konsumiert
//    Blockt CRLF-Injection, Null-Bytes, Path-Traversal, Oversized-Headers.
app.use(suspiciousInputGuard);

// 4. Globales Rate-Limiting — pro IP, Loopback ausgenommen
app.use(generalRateLimit);

// ── ACME HTTP-01 Challenge ────────────────────────────────────────────────────
// Muss vor den Proxies stehen (kein Auth, kein Body-Parser nötig).
app.get('/.well-known/acme-challenge/:token', async (req, res) => {
  const token = req.params['token'] ?? '';
  // Token darf nur alphanum + Bindestrich/Unterstrich sein (ACME-Spec)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) {
    res.status(400).send('Invalid token');
    return;
  }
  const keyAuth = await getAcmeChallenge(token);
  if (!keyAuth) { res.status(404).send('Not found'); return; }
  res.type('text/plain').send(keyAuth);
});

// ── Interne Proxies — VOR express.json() registrieren! ───────────────────────
// express.json() konsumiert den Body-Stream. Proxy-Routen müssen daher vorher
// kommen, damit sie den Body direkt weiterleiten können.
const EWS_URL = process.env['EWS_SERVICE_URL']  ?? 'http://localhost:8080';
const EAS_URL = process.env['EAS_SERVICE_URL']  ?? 'http://localhost:3005';
const DAV_URL = process.env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082';

function internalProxy(targetBase: string): express.RequestHandler {
  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // Express strippt den Mount-Prefix aus req.url — originalUrl wiederherstellen
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
app.use('/mapi',         internalProxy(EWS_URL));
app.use('/OAB',          internalProxy(EWS_URL));
app.use('/Autodiscover', internalProxy(EWS_URL));
app.use('/autodiscover', internalProxy(EWS_URL));
app.use('/Microsoft-Server-ActiveSync', internalProxy(EAS_URL));
app.use('/dav',          internalProxy(DAV_URL));

// Auth-Service-Routen (MFA, App-Passwörter, Sessions) — VOR express.json()!
// Login/Refresh/Logout sind direkt im authRouter implementiert (kein Proxy nötig).
const AUTH_SERVICE_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';
app.use('/auth/mfa',           internalProxy(AUTH_SERVICE_URL));
app.use('/auth/app-passwords', internalProxy(AUTH_SERVICE_URL));
app.use('/auth/sessions',      internalProxy(AUTH_SERVICE_URL));

// ── Body-Parser ───────────────────────────────────────────────────────────────
// JSON — 10 MB Limit (für Mail-Inhalte mit Inline-Bildern)
app.use(express.json({ limit: '10mb' }));
// URL-encoded (Formulare) — 1 MB Limit
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── Auth — strenges Rate-Limiting auf Login/Token/Refresh ────────────────────
app.use('/auth', authRateLimit, authRouter);

// ── Health ────────────────────────────────────────────────────────────────────
// Kein Rate-Limit auf /healthz (wird von Docker alle 30s aufgerufen)
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

// ── Öffentlicher Wartungsmodus-Status (kein Auth nötig) ───────────────────────
// Wird von OWA LoginPage abgefragt, um den Wartungsbanner anzuzeigen.
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
app.use('/api/v1/public-folders', publicFoldersRouter);
app.use('/api/v1/push',           pushRouter);

// PowerShell Remoting
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// ── Admin Routes ──────────────────────────────────────────────────────────────
// Audit-Middleware für alle mutierenden Admin-Calls (fire-and-forget)
app.use('/api/v1/admin', auditMiddleware);
// Zusätzliches Rate-Limit auf mutierende Admin-Operationen (POST/PUT/PATCH/DELETE)
app.use('/api/v1/admin', adminMutationRateLimit);

app.use('/api/v1/admin/dashboard',       adminDashboardRouter);
app.use('/api/v1/admin/settings',        adminGlobalSettingsRouter);
app.use('/api/v1/admin/mailboxes',       adminMailboxesRouter);
// Alias-Router mountet auf /admin — die internen Routes sind /mailboxes/:id/aliases,
// /shared-mailboxes/:id/aliases, /aliases, /aliases/:id. Wird nach den spezifischeren
// Routern angehängt — Express fällt durch, wenn die anderen keine Treffer haben.
app.use('/api/v1/admin',                 adminAliasesRouter);
app.use('/api/v1/admin/domains',         adminDomainsRouter);
app.use('/api/v1/admin/queues',          adminQueuesRouter);
app.use('/api/v1/admin/logs',            adminLogsRouter);
app.use('/api/v1/admin/groups',          adminGroupsRouter);
app.use('/api/v1/admin/resources',       adminResourcesRouter);
app.use('/api/v1/admin/public-folders',  adminPublicFoldersRouter);
app.use('/api/v1/admin/ediscovery',      adminEDiscoveryRouter);
app.use('/api/v1/admin/ems',             adminEmsRouter);
// Journaling-Route entfernt in v3.13.6
app.use('/api/v1/admin/compliance/retention',  adminRetentionRouter);
app.use('/api/v1/admin/audit-log',        adminAuditLogRouter);
app.use('/api/v1/admin/oauth',            adminOAuthClientsRouter);
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
app.use('/api/v1/admin/contacts',         adminExternalContactsRouter);
app.use('/api/v1/admin/security',         adminSecurityRouter);
app.use('/api/v1/admin/security/attacks', adminSecurityAttacksRouter);
app.use('/api/v1/admin/smtp-config',      adminSmtpConfigRouter);
app.use('/api/v1/admin/ldap',             adminLdapRouter);
app.use('/api/v1/admin/sso',              adminSsoRouter);

// ── Statische Frontend-Dateien (OWA unter Root + BCP unter /bcp) ─────────────
const WWW_DIR = process.env['WWW_DIR'] ?? '/app/www';
const owaDir  = join(WWW_DIR, 'owa');
const bcpDir  = join(WWW_DIR, 'bcp');

// Legacy: alte /owa/*-URLs auf den Root-Pfad umlenken (Backwards-Compat für
// gespeicherte Lesezeichen aus früheren Versionen)
app.get('/owa', (_req, res) => res.redirect(301, '/'));
app.get('/owa/*', (req, res) => {
  const stripped = req.originalUrl.replace(/^\/owa\/?/, '/');
  res.redirect(301, stripped);
});

// BCP behält /bcp-Prefix (Admin-Panel hat eigenes Vite-Base)
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

// OWA-Frontend unter Root — muss NACH allen API-Routen kommen, damit
// /auth/* /api/* /EWS/* etc. Vorrang haben. Catch-All `app.get('*')` schickt
// alle unbekannten Routen zurück an index.html (SPA-Routing).
if (existsSync(owaDir)) {
  app.use(express.static(owaDir, {
    maxAge: '1y',
    index: false, // wir machen index.html manuell, damit der Catch-All greift
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA-Catch-All: alles, was nicht bisher zugeordnet wurde und KEINE
  // bekannte API-/Proxy-Route ist, ist eine OWA-Route → index.html zurück.
  const API_PREFIXES = [
    '/api/', '/auth/', '/EWS', '/mapi', '/OAB', '/Autodiscover', '/autodiscover',
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
  // Kein OWA-Bundle gemountet — Root auf /bcp oder schlichte Info
  app.get('/', (_req, res) => res.redirect(302, '/bcp/'));
}

// ── 404 + Fehler-Handler ──────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  // Stack-Trace niemals an den Client senden (OWASP A05: Security Misconfiguration)
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDatabase();
  getRedisClient();
  log.info({ port: PORT }, 'API Gateway listening');
  app.listen(PORT);

  // Integrierter HTTPS-Reverse-Proxy — startet automatisch wenn ein Zertifikat
  // in BCP → SSL/TLS → "Als HTTPS aktivieren" gesetzt wurde.
  // Hot-Reload bei Zertifikats-Aktivierung über Redis (kein Neustart nötig).
  void startTlsProxy(app).catch(err =>
    log.warn({ err }, 'TLS proxy startup failed — HTTPS not available'),
  );
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
