/**
 * CoreMail JMAP server (v5.7.1) — port 3006
 *
 * RFC 8620 (Core), 8621 (Mail), 8887 (WebSocket), 9404 (Blob), 9425 (Quota),
 * 9670 (Sharing/Principals), 9749 (VAPID). Reachable via the api-gateway:
 *   GET  /.well-known/jmap            → 301 to the session resource
 *   GET  /jmap/session                → session (auth: Basic app password | Bearer JWT)
 *   POST /jmap/api                    → method calls
 *   POST /jmap/upload/:accountId/     → blob upload
 *   GET  /jmap/download/:accountId/:blobId/:name?accept=
 *   GET  /jmap/eventsource            → Server-Sent Events
 *   WS   /jmap/ws                     → JMAP over WebSocket (subprotocol "jmap")
 * Switch: BCP → Server → "JMAP" (ServerSettings.jmapEnabled, default on).
 */
import express from 'express';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { jmapAuthMiddleware } from './auth.js';
import { resolveAccounts } from './accounts.js';
import { parseRequest, processRequest } from './dispatcher.js';
import { RequestError } from './errors.js';
import { buildSession, sessionStateFor } from './session.js';
import { LIMITS, invalidateSettingsCache, publicBaseUrl } from './settings.js';
import { invalidateJmapFlagCache, requireJmapEnabled } from './feature-flag.js';
import { resolveBlob, storeUpload } from './blobs.js';
import { eventSourceHandler } from './push/eventsource.js';
import { attachWebSocket } from './push/websocket.js';
import { startChangeBus } from './push/bus.js';
import './methods/index.js';
import type { JmapUser } from './types.js';

// Express module augmentation does not apply reliably across package boundaries → local type
type AuthedRequest = express.Request & { jmapUser?: JmapUser };

const log = createLogger('jmap-server');
const PORT = parseInt(process.env['JMAP_PORT'] ?? '3006', 10);

function problem(res: express.Response, err: RequestError): void {
  res.status(err.status).type('application/problem+json').send(JSON.stringify(err.toJson()));
}

async function main(): Promise<void> {
  await connectDatabase();
  startChangeBus();

  try {
    const sub = getRedisClient().duplicate();
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD);
    sub.on('message', () => {
      invalidateJmapFlagCache();
      invalidateSettingsCache();
      log.info('Settings cache invalidated (Redis signal)');
    });
  } catch (err) {
    log.warn({ err }, 'Redis subscription failed — caches expire after 60s');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'jmap-server' }));

  // CORS — JMAP web clients (RFC 8620 §8.5 recommends CORS support)
  app.use(['/jmap', '/.well-known/jmap'], (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.get('Origin') ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  app.use(['/jmap', '/.well-known/jmap'], requireJmapEnabled);

  // Discovery (RFC 8620 §2.2)
  app.get('/.well-known/jmap', async (req, res) => {
    res.redirect(301, `${await publicBaseUrl(req)}/jmap/session`);
  });

  app.get('/jmap/session', jmapAuthMiddleware, async (req, res) => {
    const user = (req as AuthedRequest).jmapUser!;
    const accounts = await resolveAccounts(user);
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.json(buildSession(user, accounts, await publicBaseUrl(req)));
  });

  app.post('/jmap/api', jmapAuthMiddleware, express.json({ limit: LIMITS.maxSizeRequest, type: ['application/json', 'application/*+json'] }), async (req, res) => {
    try {
      const request = parseRequest(req.body);
      const user = (req as AuthedRequest).jmapUser!;
      const accounts = await resolveAccounts(user);
      const response = await processRequest(request, user, accounts, sessionStateFor(accounts));
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.json(response);
    } catch (err) {
      if (err instanceof RequestError) { problem(res, err); return; }
      if (err instanceof SyntaxError || (err as { type?: string }).type === 'entity.parse.failed') {
        problem(res, new RequestError('notJSON', 400, 'Request body is not valid JSON')); return;
      }
      if ((err as { type?: string }).type === 'entity.too.large') {
        problem(res, new RequestError('limit', 400, 'Request too large', { limit: 'maxSizeRequest' })); return;
      }
      log.error({ err }, 'Unhandled error in /jmap/api');
      problem(res, new RequestError('serverFail', 500));
    }
  });
  // Body parser errors (invalid JSON / too large) end up here
  app.use('/jmap/api', (err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    if (err.type === 'entity.too.large') { problem(res, new RequestError('limit', 400, 'Request too large', { limit: 'maxSizeRequest' })); return; }
    problem(res, new RequestError('notJSON', 400, 'Request body is not valid JSON'));
  });

  // Blob upload (RFC 8620 §6.1)
  app.post('/jmap/upload/:accountId', jmapAuthMiddleware, express.raw({ type: () => true, limit: LIMITS.maxSizeUpload }), async (req, res) => {
    const accounts = await resolveAccounts((req as AuthedRequest).jmapUser!);
    const account = accounts.get(String(req.params['accountId']));
    if (!account) { problem(res, new RequestError('accountNotFound', 404)); return; }
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = (req.get('Content-Type') ?? 'application/octet-stream').split(';')[0]!.trim();
    const stored = await storeUpload(account, data, type);
    res.status(201).json({ accountId: account.accountId, blobId: stored.blobId, type: stored.type, size: stored.size });
  });
  app.use('/jmap/upload', (err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    if (err.type === 'entity.too.large') { problem(res, new RequestError('limit', 413, 'Upload too large', { limit: 'maxSizeUpload' })); return; }
    next(err);
  });

  // Blob download (RFC 8620 §6.2)
  app.get('/jmap/download/:accountId/:blobId/:name?', jmapAuthMiddleware, async (req, res) => {
    const accounts = await resolveAccounts((req as AuthedRequest).jmapUser!);
    const account = accounts.get(String(req.params['accountId']));
    if (!account) { res.status(404).type('text/plain').send('Account not found'); return; }
    const blob = await resolveBlob(account, String(req.params['blobId']));
    if (!blob) { res.status(404).type('text/plain').send('Blob not found'); return; }
    const accept = typeof req.query['accept'] === 'string' && req.query['accept'] ? req.query['accept'] : blob.type;
    const name = typeof req.params['name'] === 'string' && req.params['name'] ? req.params['name'] : (blob.name ?? 'blob');
    res.setHeader('Content-Type', accept);
    res.setHeader('Content-Length', String(blob.buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(blob.buffer);
  });

  // Push (RFC 8620 §7.3)
  app.get('/jmap/eventsource', jmapAuthMiddleware, eventSourceHandler);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error({ err }, 'Unhandled error');
    if (!res.headersSent) problem(res, new RequestError('serverFail', 500));
  });

  const server = app.listen(PORT, () => log.info({ port: PORT }, 'JMAP server started'));
  attachWebSocket(server);

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
