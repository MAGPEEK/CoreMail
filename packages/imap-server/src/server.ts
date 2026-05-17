import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createImapServer } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// Map port → laufende Server-Instanz
const servers = new Map<number, ReturnType<typeof createImapServer>>();

async function reloadListeners() {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const server = createImapServer();
        servers.set(l.port, server);
        server.listen(l.port, () => log.info({ port: l.port }, 'IMAP listener started'));
      }
    }

    // Deaktivierte Ports stoppen
    for (const [port, server] of servers) {
      if (!activePorts.has(port)) {
        // Forcefully close all open connections so server.close() resolves immediately
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).closeAllConnections?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
        servers.delete(port);
        log.info({ port }, 'IMAP listener stopped');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload IMAP listeners');
  }
}

async function main() {
  await connectDatabase();
  await ensureBuckets();

  const server143 = createImapServer();
  const server993 = createImapServer();

  server143.listen(IMAP_PORT, () => {
    log.info({ port: IMAP_PORT }, 'IMAP server started (STARTTLS)');
  });
  servers.set(IMAP_PORT, server143);

  server993.listen(IMAP_PORT_TLS, () => {
    log.info({ port: IMAP_PORT_TLS }, 'IMAPS server started (TLS)');
  });
  servers.set(IMAP_PORT_TLS, server993);

  // Redis-Subscriber für dynamischen Listener-Reload
  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    const payload = JSON.parse(message) as { service: string };
    if (payload.service === 'IMAP') {
      void reloadListeners();
    }
  });

  process.on('SIGTERM', async () => {
    log.info('Shutting down IMAP server...');
    for (const server of servers.values()) server.close();
    servers.clear();
    await subscriber.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
