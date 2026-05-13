import express from 'express';
import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { ewsAuthMiddleware } from './auth/middleware.js';
import { handleEwsRequest } from './handler.js';
import { mapiRouter } from './mapi/handler.js';

const log = createLogger('ews-server');
const PORT = parseInt(process.env['EWS_PORT'] ?? '8080', 10);

async function main() {
  await connectDatabase();

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

  // EWS SOAP endpoint — all operations via POST
  app.post('/EWS/Exchange.asmx', ewsAuthMiddleware, handleEwsRequest);
  app.get('/EWS/Exchange.asmx', (_req, res) => {
    // WSDL stub for Outlook service discovery
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  targetNamespace="http://schemas.microsoft.com/exchange/services/2006/messages"
  name="ExchangeServices">
  <wsdl:documentation>CoreMail Exchange Web Services</wsdl:documentation>
</wsdl:definitions>`);
  });

  // OAB (Offline Address Book) stub
  app.get('/OAB/', (_req, res) => {
    res.status(404).json({ error: 'OAB not implemented' });
  });

  // MAPI over HTTP — Phase 8
  // Provides Connect/Execute/Disconnect for Outlook 2013 SP1+ and Outlook 365
  app.use('/mapi', mapiRouter);

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'EWS server started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
