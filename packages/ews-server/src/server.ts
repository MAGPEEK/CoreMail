import express from 'express';
import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { ewsAuthMiddleware } from './auth/middleware.js';
import { handleEwsRequest } from './handler.js';
// v5.4.0: MAPI/HTTP entfernt. v5.6.0: OAuth2/JWT-Bearer entfernt
// (siehe core/auth/jwt.ts und ews-server/auth/middleware.ts).

const log = createLogger('ews-server');
const PORT = parseInt(process.env['EWS_PORT'] ?? '8080', 10);

async function main() {
  await connectDatabase();
  // v5.6.0: initJwtKeys() entfernt

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

  // v3.18.38: Outlook LTSC probt mit GET /EWS/Exchange.asmx BEVOR es überhaupt
  // einen Authorization-Header sendet. Bisher haben wir 200 OK + WSDL-Stub
  // zurückgegeben → Outlook nahm an, dass keine Auth nötig ist, schickte nie
  // Credentials, und das Setup endete mit "Private Ordner" statt der Mailbox.
  // KRITISCH: jeder EWS-Request (GET wie POST) MUSS bei fehlendem Auth-Header
  // 401 + WWW-Authenticate: Basic realm="..." zurückgeben, damit Outlook den
  // Credential-Prompt zeigt.
  app.post('/EWS/Exchange.asmx', ewsAuthMiddleware, handleEwsRequest);
  app.get('/EWS/Exchange.asmx', ewsAuthMiddleware, (_req, res) => {
    // WSDL stub for Outlook service discovery (nur für authentifizierte Clients)
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  targetNamespace="http://schemas.microsoft.com/exchange/services/2006/messages"
  name="ExchangeServices">
  <wsdl:documentation>CoreMail Exchange Web Services</wsdl:documentation>
</wsdl:definitions>`);
  });

  // OAB (Offline Address Book) — v3.18.38: 401 statt 404, damit Outlook das
  // Profil nicht als incomplete markiert.
  app.use('/OAB', ewsAuthMiddleware, (_req, res) => {
    res.status(404).set('Content-Type', 'text/plain').send('OAB not implemented');
  });

  // v5.4.0: /mapi/* endpoints entfernt (siehe Header-Kommentar)

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'EWS server started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
