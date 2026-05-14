import express from 'express';
import * as http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { smimeRouter } from './routes/smime.js';
import { publicFoldersRouter } from './routes/public-folders.js';
import { powershellRouter } from './routes/powershell.js';
import { requireAuth } from './middleware/auth.js';
import { sseHandler } from './sse.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = parseInt(process.env['API_PORT'] ?? '3000', 10);

// ── Interner HTTP-Proxy (kein nginx nötig) ───────────────────────────────────
// Leitet Anfragen an interne Services weiter (alles im gleichen Container).
function internalProxy(targetBase: string): express.RequestHandler {
  const url = new URL(targetBase);
  return (req: express.Request, res: express.Response) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: parseInt(url.port || '80', 10),
      path: req.path + qs,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    };
    const proxy = http.request(options, (upstream) => {
      res.writeHead(upstream.statusCode ?? 200, upstream.headers);
      upstream.pipe(res, { end: true });
    });
    proxy.on('error', (err) => {
      log.warn({ err, target: targetBase }, 'Internal proxy error');
      if (!res.headersSent) res.status(502).json({ error: 'Service temporarily unavailable' });
    });
    req.pipe(proxy, { end: true });
  };
}

app.use(express.json({ limit: '10mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Powered-By', 'CoreMail');
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'api-gateway' }));

// ── SSE live-events ───────────────────────────────────────────────────────────
app.get('/api/v1/events', requireAuth, sseHandler);

// ── Feature routes ────────────────────────────────────────────────────────────
app.use('/api/v1/mail', mailRouter);
app.use('/api/v1/calendar', calendarRouter);
app.use('/api/v1/contacts', contactsRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/user', userRouter);
app.use('/api/v1/smime', smimeRouter);
app.use('/api/v1/public-folders', publicFoldersRouter);

// PowerShell Remoting stub
app.use(express.text({ type: 'application/soap+xml', limit: '5mb' }));
app.use('/PowerShell', powershellRouter);

// ── Admin routes ──────────────────────────────────────────────────────────────
app.use('/api/v1/admin/mailboxes', adminMailboxesRouter);
app.use('/api/v1/admin/domains', adminDomainsRouter);
app.use('/api/v1/admin/queues', adminQueuesRouter);
app.use('/api/v1/admin/logs', adminLogsRouter);
app.use('/api/v1/admin/groups', adminGroupsRouter);
app.use('/api/v1/admin/resources', adminResourcesRouter);
app.use('/api/v1/admin/public-folders', adminPublicFoldersRouter);
app.use('/api/v1/admin/ediscovery', adminEDiscoveryRouter);
app.use('/api/v1/admin/ems', adminEmsRouter);

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
