import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import express from 'express';
import {
  createLogger, installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost,
  startAuthInvalidationSubscriber,
} from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { davAuthMiddleware } from './auth.js';
import { caldavRouter } from './caldav/index.js';
import { carddavRouter } from './carddav/index.js';
import { principalRouter } from './principal/index.js';

const log = createLogger('caldav-server');
installProcessGuards(log);
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();
installAsyncErrorHandling(express);
const PORT = parseInt(process.env['CALDAV_PORT'] ?? '8082', 10);

async function main() {
  await connectDatabase();
  // v7.1.0: session revocations from other services (Bearer token checks)
  startAuthInvalidationSubscriber();
  void initRuntimeLogLevel('caldav-server', { aliases: ['caldav', 'carddav', 'dav'] }); // BCP per-service log level
  // v5.6.0: initJwtKeys() removed (back to HS256)

  const app = express();

  // Parse raw vCard / iCal bodies
  app.use(express.text({ type: ['text/calendar', 'text/vcard', 'application/xml', 'text/xml'], limit: '10mb' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'caldav-server' }));

  // Well-known URIs (RFC 6764 §5): redirect to the context path, where PROPFIND
  // answers DAV:current-user-principal (the api-gateway proxies /.well-known/{caldav,carddav})
  app.all(['/.well-known/caldav', '/.well-known/carddav'], (_req, res) => res.redirect(301, '/dav/'));

  // Discovery (context path + principals), then CalDAV + CardDAV — one mount, so the
  // credentials are verified once per request (not once per router)
  app.use('/dav', davAuthMiddleware, principalRouter, caldavRouter, carddavRouter);

  // v6: shared error middleware (registered last)
  app.use(errorMiddleware(log));

  // v6: internal service behind the api-gateway — loopback by default
  const host = resolveBindHost();
  app.listen(PORT, host, () => {
    log.info({ port: PORT, host }, 'CalDAV/CardDAV server started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
