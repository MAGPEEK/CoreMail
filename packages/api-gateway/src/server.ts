import express from 'express';
import * as http from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectDatabase } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';

import { mailRouter } from './routes/mail.js';
import { calendarRouter } from './routes/calendar.js';
import { contactsRouter } from './routes/contacts.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { userRouter } from './routes/user.js';
import { adminMailboxesRouter } from './routes/admin/mailboxes.js';
import { adminDomainsRouter } from './routes/admin/domains.js';
import { adminQueuesRouter } from './routes/admin/queues.js';
import { adminLogsRouter } from './routes/admin/logs.js';
import { adminGroupsRouter } from './routes/admin/groups.js';
import { adminResourcesRouter } from './routes/admin/resources.js';
import { adminPublicFoldersRouter } from './routes/admin/public-folders.js';
import { adminEDiscoveryRouter } from './routes/admin/ediscovery.js';
import { adminEmsRouter } from './routes/admin/ems.js';
import { adminJournalingRouter } from './routes/admin/journaling.js';
import { adminRetentionRouter } from './routes/admin/retention.js';
// Phase 10
import { adminAuditLogRouter } from './routes/admin/audit-log.js';
import { adminOAuthClientsRouter } from './routes/admin/oauth-clients.js';
import { adminGatewayRouter } from './routes/admin/gateway.js';
import { pushRouter } from './routes/push.js';
import { smimeRouter } from './routes/smime.js';
import { setupRouter } from './routes/setup.js';
import { publicFoldersRouter } from './routes/public-folders.js';
import { powershellRouter } from './routes/powershell.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';
import { auditMiddleware } from './lib/audit.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── Interner HTTP-Proxy (kein nginx nötig) ───────────────────────────────────
// Leitet Anfragen an interne Services weiter (alles im gleichen Container).
function internalProxy(targetBase: string): express.RequestHandler {
  // http-proxy-middleware kümmert sich korrekt um:
  // - Body-Streaming (auch nach express.json())
  // - Hop-by-hop Header
  // - Content-Length Neuberechnung
  // - Fehlerbehandlung
  const proxy = createProxyMiddleware({
    target: targetBase,
    changeOrigin: true,
    // Pfad NICHT rewriten — /auth/login soll als /auth/login ankommen
    // (auth-service hat app.use('/auth', authRouter))
    on: {
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

app.use(express.json({ limit: '10mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Powered-By', 'CoreMail');
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'api-gateway' }));

// ── Changelog API — Phase 10 ──────────────────────────────────────────────────
// GET /api/v1/changelog — returns parsed CHANGELOG.md content
// The file is embedded at build time from the repo root.
const CHANGELOG_PATH = process.env['CHANGELOG_PATH']
  ?? resolve(process.cwd(), 'CHANGELOG.md');

app.get('/api/v1/changelog', (_req, res) => {
  try {
    const raw = readFileSync(CHANGELOG_PATH, 'utf-8');
    // Parse Keep-a-Changelog format into structured versions
    const versions: Array<{ version: string; date: string; sections: Record<string, string[]> }> = [];
    let current: (typeof versions)[0] | null = null;
    let currentSection = '';

    for (const line of raw.split('\n')) {
      // Match version headers: ## [0.11.0] — 2026-05-14
      const versionMatch = /^## \[(.+?)\](?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
      if (versionMatch) {
        if (current) versions.push(current);
        current = { version: versionMatch[1]!, date: versionMatch[2] ?? '', sections: {} };
        currentSection = '';
        continue;
      }
      // Match section headers: ### Added
      const sectionMatch = /^### (.+)/.exec(line);
      if (sectionMatch && current) {
        currentSection = sectionMatch[1]!;
        current.sections[currentSection] = [];
        continue;
      }
      // Match bullet items
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

// ── SSE live-events ───────────────────────────────────────────────────────────
app.get('/api/v1/events', requireAuth, sseHandler);

// ── Feature routes ────────────────────────────────────────────────────────────
// Setup — öffentlich, kein Auth (nur wenn noch kein User existiert)
app.use('/api/v1/setup', setupRouter);

app.use('/api/v1/mail', mailRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/user', userRouter);
app.use('/api/v1/smime', smimeRouter);
app.use('/api/v1/public-folders', publicFoldersRouter);
// Phase 10 — Push notifications
app.use('/api/v1/push', pushRouter);

// PowerShell Remoting stub
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// ── Admin routes ──────────────────────────────────────────────────────────────
// Phase 10 — Audit middleware for all mutating admin calls (fire-and-forget)
app.use('/api/v1/admin', auditMiddleware);

app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
app.use('/api/v1/admin/domains', adminDomainsRouter);
app.use('/api/v1/admin/queues', adminQueuesRouter);
app.use('/api/v1/admin/logs', adminLogsRouter);
app.use('/api/v1/admin/groups', adminGroupsRouter);
app.use('/api/v1/admin/resources', adminResourcesRouter);
app.use('/api/v1/admin/public-folders', adminPublicFoldersRouter);
app.use('/api/v1/admin/ediscovery', adminEDiscoveryRouter);
app.use('/api/v1/admin/ems', adminEmsRouter);
// Phase 9 — Compliance
app.use('/api/v1/admin/compliance/journaling', adminJournalingRouter);
app.use('/api/v1/admin/compliance/retention', adminRetentionRouter);
// Phase 10
app.use('/api/v1/admin/audit-log', adminAuditLogRouter);
app.use('/api/v1/admin/oauth', adminOAuthClientsRouter);
app.use('/api/v1/admin/gateway', adminGatewayRouter);

// ── Interne Service-Proxies (ersetzt nginx) ───────────────────────────────────
// Alle HTTP-Dienste sind über den api-gateway auf einem einzigen Port erreichbar.
// Kein externer Proxy nötig — perfekt für Heimserver, NAS und einfache Setups.

const AUTH_URL = process.env['AUTH_SERVICE_URL'] ?? 'http://localhost:3003';
const EWS_URL  = process.env['EWS_SERVICE_URL']  ?? 'http://localhost:8080';
const EAS_URL  = process.env['EAS_SERVICE_URL']  ?? 'http://localhost:3005';
const DAV_URL  = process.env['CALDAV_SERVICE_URL'] ?? 'http://localhost:8082';

// Auth (login, logout, refresh, MFA, OIDC-Callbacks …)
app.use('/auth', internalProxy(AUTH_URL));

// Exchange Web Services + MAPI over HTTP + OAB
app.use('/EWS',          internalProxy(EWS_URL));
app.use('/mapi',         internalProxy(EWS_URL));
app.use('/OAB',          internalProxy(EWS_URL));

// Autodiscover v1 + v2
app.use('/Autodiscover', internalProxy(EWS_URL));
app.use('/autodiscover', internalProxy(EWS_URL));

// ActiveSync EAS
app.use('/Microsoft-Server-ActiveSync', internalProxy(EAS_URL));

// CalDAV / CardDAV
app.use('/dav',          internalProxy(DAV_URL));

// ── Statische Frontend-Dateien (OWA + ECP) ───────────────────────────────────
// Im monolithischen Container sind die Frontend-Bundles unter /app/www abgelegt.
const WWW_DIR = process.env['WWW_DIR'] ?? '/app/www';
const owaDir  = join(WWW_DIR, 'owa');
const ecpDir  = join(WWW_DIR, 'ecp');

if (existsSync(owaDir)) {
  app.use('/owa', express.static(owaDir));
  app.get('/owa/*', (_req, res) => res.sendFile(join(owaDir, 'index.html')));
  log.info({ dir: owaDir }, 'Serving OWA static files');
}
if (existsSync(ecpDir)) {
  app.use('/ecp', express.static(ecpDir));
  app.get('/ecp/*', (_req, res) => res.sendFile(join(ecpDir, 'index.html')));
  log.info({ dir: ecpDir }, 'Serving ECP static files');
}

// Root → OWA
app.get('/', (_req, res) => res.redirect(302, '/owa/'));

// ── 404 + Error-Handler ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDatabase();
  getRedisClient();
  app.listen(PORT, () => log.info({ port: PORT }, 'API Gateway listening (proxy-free mode)'));
}

start().catch((err) => { log.error({ err }, 'Startup failed'); process.exit(1); });
