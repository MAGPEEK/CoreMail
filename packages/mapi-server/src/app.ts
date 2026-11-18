/**
 * The HTTP application of the MAPI server (reached through the api-gateway):
 *   POST /mapi/emsmdb[/] — mailbox endpoint     POST /mapi/nspi[/] — address book endpoint
 *   GET  /health         — liveness for the gateway / supervisor
 * Bodies are binary (application/mapi-http), at most MAX_BODY bytes
 * (Execute: 256 KB ROP buffer + 4 KB auxiliary buffer + framing).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { readMapiHeaders, ResponseCode } from './http/envelope.js';
import { respondFailure } from './http/responder.js';
import { emsmdbHandler, type EmsmdbDeps } from './emsmdb/handler.js';
import { nspiHandler } from './nspi/handler.js';

export const MAX_BODY = 0x40000 + 0x1008 + 64;

export function createApp(deps: EmsmdbDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.get('/health', (_req, res) => { res.json({ ok: true, service: 'mapi-server', sessions: deps.sessions.size }); });

  const raw = express.raw({ type: () => true, limit: MAX_BODY });
  const safe = (h: express.RequestHandler): express.RequestHandler => (req, res, next) => {
    Promise.resolve(h(req, res, next)).catch(next);
  };
  app.all(['/mapi/emsmdb', '/mapi/emsmdb/'], raw, safe(emsmdbHandler(deps)));
  app.all(['/mapi/nspi', '/mapi/nspi/'], raw, safe(nspiHandler(deps)));

  app.use((err: Error & { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const h = readMapiHeaders((n) => req.get(n));
    if (err.type === 'entity.too.large') { respondFailure(res, h, ResponseCode.TooLarge, 'request too large'); return; }
    respondFailure(res, h, ResponseCode.UnknownFailure, 'internal error', 500);
  });
  return app;
}
