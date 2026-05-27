import express from 'express';
import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { davAuthMiddleware } from './auth.js';
import { caldavRouter } from './caldav/index.js';
import { carddavRouter } from './carddav/index.js';

const log = createLogger('caldav-server');
const PORT = parseInt(process.env['CALDAV_PORT'] ?? '8082', 10);

async function main() {
  await connectDatabase();
  // v5.6.0: initJwtKeys() entfernt (HS256 zurück)

  const app = express();

  // Parse raw vCard / iCal bodies
  app.use(express.text({ type: ['text/calendar', 'text/vcard', 'application/xml', 'text/xml'], limit: '10mb' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'caldav-server' }));

  // Well-known redirects (RFC 6764)
  app.all('/.well-known/caldav', (_req, res) => res.redirect(308, '/dav/calendars'));
  app.all('/.well-known/carddav', (_req, res) => res.redirect(308, '/dav/addressbooks'));

  // DAV principal discovery
  app.all('/dav', davAuthMiddleware, (req, res) => {
    const userId = (req as any).davUser?.userId ?? '';
    res.redirect(301, `/dav/calendars/${userId}`);
  });

  // CalDAV + CardDAV routes (all require auth)
  app.use('/dav', davAuthMiddleware, caldavRouter);
  app.use('/dav', davAuthMiddleware, carddavRouter);

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'CalDAV/CardDAV server started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
