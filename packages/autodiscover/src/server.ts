import express from 'express';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
import { handleAutodiscoverV1 } from './v1.js';
import { handleAutodiscoverV2 } from './v2.js';
import { invalidateSettingsCache } from './settings.js';

const log = createLogger('autodiscover');
const PORT = parseInt(process.env['AUTODISCOVER_PORT'] ?? '8081', 10);

async function main() {
  await connectDatabase();

  // v3.18.35: Bei Settings-Änderungen (z.B. publicHostname-Update via BCP)
  // den Settings-Cache invalidieren — sonst liefert Autodiscover für bis zu
  // 60s veraltete URLs. Outlook-Clients könnten sich dann nicht verbinden.
  try {
    const sub = getRedisClient().duplicate();
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD);
    sub.on('message', () => {
      invalidateSettingsCache();
      log.info('Settings-Cache invalidiert (Redis-Signal)');
    });
  } catch (err) {
    log.warn({ err }, 'Redis-Subscription fehlgeschlagen — Cache läuft nach 60s automatisch ab');
  }

  const app = express();
  app.use(express.text({ type: 'text/xml' }));
  app.use(express.text({ type: 'application/xml' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'autodiscover' }));

  // Autodiscover v1 — Outlook 2010–2016 and older clients
  app.post('/Autodiscover/Autodiscover.xml', handleAutodiscoverV1);
  app.get('/Autodiscover/Autodiscover.xml', handleAutodiscoverV1);

  // Autodiscover v2 — Outlook 2019/365 Modern Auth
  // GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol=EWS
  app.get(
    '/autodiscover/autodiscover.json/v1.0/:email',
    handleAutodiscoverV2,
  );

  // SRV record redirect compatibility
  app.get('/', (_req, res) => {
    res.redirect('/Autodiscover/Autodiscover.xml');
  });

  app.listen(PORT, () => {
    log.info({ port: PORT }, 'Autodiscover service started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
