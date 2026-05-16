import { createLogger, getRedisClient } from '@coremail/core';
import { connectDatabase, ensureBuckets } from '@coremail/storage';
import { createInboundServer } from './inbound/server.js';
import { startOutboundWorker } from './outbound/queue.js';

const log = createLogger('smtp:server');

const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

async function main() {
  await connectDatabase();
  await ensureBuckets();

  // SMTPServer (smtp-server npm) kann nur auf EINEM Port gleichzeitig lauschen.
  // Für jeden Port eine eigene Instanz erzeugen.

  // Port 25 — Inbound (MX-Empfang, kein AUTH erforderlich)
  const inbound25 = createInboundServer();
  inbound25.listen(SMTP_PORT_25, () => {
    log.info({ port: SMTP_PORT_25 }, 'SMTP inbound (port 25) started');
  });

  // Port 465 — SMTPS (Submission, implizites TLS)
  const inbound465 = createInboundServer();
  inbound465.listen(SMTP_PORT_465, () => {
    log.info({ port: SMTP_PORT_465 }, 'SMTP submission (port 465, SMTPS) started');
  });

  // Port 587 — Submission (STARTTLS + AUTH)
  // Gleicher Handler wie 25; separate Instanz nötig wegen net.Server-Beschränkung.
  const submission587 = createInboundServer();
  submission587.listen(SMTP_PORT_587, () => {
    log.info({ port: SMTP_PORT_587 }, 'SMTP submission (port 587) started');
  });

  // Start outbound delivery worker
  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server...');
    inbound25.close();
    inbound465.close();
    submission587.close(() => log.info('SMTP servers closed'));
    await worker.close();
    const redis = getRedisClient();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
