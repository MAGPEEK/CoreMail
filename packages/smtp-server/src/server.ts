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

  // Inbound SMTP server (port 25 — no auth required for incoming)
  const inbound = createInboundServer();
  inbound.listen(SMTP_PORT_25, () => {
    log.info({ port: SMTP_PORT_25 }, 'SMTP inbound (port 25) started');
  });

  // Submission server (port 587 — STARTTLS + AUTH required)
  // In the full implementation, port 587 authenticates the sender
  // and enqueues to the outbound queue instead of receiving.
  // For now, the same inbound server handles both.
  inbound.listen(SMTP_PORT_587, () => {
    log.info({ port: SMTP_PORT_587 }, 'SMTP submission (port 587) started');
  });

  // Start outbound delivery worker
  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server...');
    inbound.close(() => log.info('Inbound server closed'));
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
