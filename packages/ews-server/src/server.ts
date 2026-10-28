import express from 'express';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { ewsAuthMiddleware } from './auth/middleware.js';
import { handleEwsRequest } from './handler.js';
import { mapiRouter } from './mapi/handler.js';
import { requireMapiEnabled, invalidateMapiFlagCache } from './mapi/feature-flag.js';
// v5.6.0: OAuth2/JWT Bearer removed (see core/auth/jwt.ts and
// ews-server/auth/middleware.ts). v5.7.0: MAPI/HTTP back as optional.

const log = createLogger('ews-server');
const PORT = parseInt(process.env['EWS_PORT'] ?? '8080', 10);

async function main() {
  await connectDatabase();
  // v5.6.0: initJwtKeys() removed

  const app = express();

  // Parse raw XML body
  app.use(
    express.text({
      type: ['text/xml', 'application/xml', 'application/soap+xml'],
      limit: '50mb',
    }),
  );
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ews-server' }));

  // v3.18.38: Outlook LTSC probes with GET /EWS/Exchange.asmx BEFORE it sends
  // any Authorization header at all. Previously we returned 200 OK + WSDL stub
  // → Outlook assumed no auth was needed, never sent credentials, and the
  // setup ended with "Personal Folders" instead of the mailbox.
  // CRITICAL: every EWS request (GET as well as POST) MUST return
  // 401 + WWW-Authenticate: Basic realm="..." when the auth header is missing,
  // so Outlook shows the credential prompt.
  //
  // v5.8.0: EWS is no longer a standalone client path (Outlook 2024 LTSC /
  // M365 do not speak Basic-auth EWS against third-party servers). EWS remains
  // only as a companion protocol to MAPI over HTTP (free/busy, OOF, OAB,
  // Autodiscover follow-up calls) and hangs off the same switch
  // (ServerSettings.mapiHttpEnabled). Off → 404, like /mapi.
  app.use('/EWS', requireMapiEnabled);
  app.post('/EWS/Exchange.asmx', ewsAuthMiddleware, handleEwsRequest);
  app.get('/EWS/Exchange.asmx', ewsAuthMiddleware, (_req, res) => {
    // WSDL stub for Outlook service discovery (authenticated clients only)
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  targetNamespace="http://schemas.microsoft.com/exchange/services/2006/messages"
  name="ExchangeServices">
  <wsdl:documentation>CoreMail Exchange Web Services</wsdl:documentation>
</wsdl:definitions>`);
  });

  // OAB (Offline Address Book) — v3.18.38: 401 instead of 404 so Outlook does
  // not mark the profile as incomplete.
  app.use('/OAB', requireMapiEnabled, ewsAuthMiddleware, (_req, res) => {
    res.status(404).set('Content-Type', 'text/plain').send('OAB not implemented');
  });

  // MAPI over HTTP — v5.7.0 optional (BCP → Server → "MAPI over HTTP").
  // Gate first: 404 when disabled (including /healthcheck.htm, so Outlook
  // does not even detect the endpoint as Exchange). Then the v3.18.38 rule:
  // ewsAuthMiddleware before the router so Outlook sends credentials on
  // connect — exception /healthcheck.htm (anonymous connectivity probe).
  app.use('/mapi', requireMapiEnabled, (req, res, next) => {
    if (req.path === '/healthcheck.htm') return next();
    return ewsAuthMiddleware(req, res, next);
  }, mapiRouter);

  // Pick up settings changes from the BCP immediately (otherwise up to 60s cache).
  try {
    const sub = getRedisClient().duplicate();
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD);
    sub.on('message', () => {
      invalidateMapiFlagCache();
      log.info('MAPI-Flag-Cache invalidiert (Redis-Signal)');
    });
  } catch (err) {
    log.warn({ err }, 'Redis-Subscription fehlgeschlagen — MAPI-Flag läuft nach 60s ab');
  }

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'EWS server started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
