import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createInboundServer } from './inbound/server.js';
import { startOutboundWorker } from './outbound/queue.js';

const log = createLogger('smtp:server');

const SMTP_PORT_25  = parseInt(process.env['SMTP_PORT_25']  ?? '25',  10);
const SMTP_PORT_465 = parseInt(process.env['SMTP_PORT_465'] ?? '465', 10);
const SMTP_PORT_587 = parseInt(process.env['SMTP_PORT_587'] ?? '587', 10);

// Map port → laufende Server-Instanz
const servers = new Map<number, ReturnType<typeof createInboundServer>>();

async function reloadListeners() {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const server = createInboundServer();
        servers.set(l.port, server);
        server.listen(l.port, () => log.info({ port: l.port }, 'SMTP listener started'));
      }
    }

    // Deaktivierte Ports stoppen
    for (const [port, server] of servers) {
      if (!activePorts.has(port)) {
        // Forcefully close all open connections (Node.js 18.2+)
        // smtp-server wraps net.Server internally as _server
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const netSrv = (server as any)._server as { closeAllConnections?(): void } | undefined;
        netSrv?.closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
        servers.delete(port);
        log.info({ port }, 'SMTP listener stopped');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload SMTP listeners');
  }
}

async function main() {
  await connectDatabase();
  await ensureBuckets();

  // Initiale Server starten
  const inbound25 = createInboundServer();
  inbound25.listen(SMTP_PORT_25, () => {
    log.info({ port: SMTP_PORT_25 }, 'SMTP inbound (port 25) started');
  });
  servers.set(SMTP_PORT_25, inbound25);

  const inbound465 = createInboundServer();
  inbound465.listen(SMTP_PORT_465, () => {
    log.info({ port: SMTP_PORT_465 }, 'SMTP submission (port 465, SMTPS) started');
  });
  servers.set(SMTP_PORT_465, inbound465);

  const submission587 = createInboundServer();
  submission587.listen(SMTP_PORT_587, () => {
    log.info({ port: SMTP_PORT_587 }, 'SMTP submission (port 587) started');
  });
  servers.set(SMTP_PORT_587, submission587);

  // Outbound-Worker starten
  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  // Redis-Subscriber für dynamischen Listener-Reload
  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    const payload = JSON.parse(message) as { service: string };
    if (payload.service === 'SMTP_RECEIVE') {
      void reloadListeners();
    }
  });

  // Graceful Shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server...');
    for (const server of servers.values()) server.close();
    servers.clear();
    await worker.close();
    await subscriber.quit();
    const redis = getRedisClient();
    await redis.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
