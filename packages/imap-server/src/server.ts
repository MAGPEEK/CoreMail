import { createLogger, getRedisClient, CHANNEL_SERVICE_LISTENERS_RELOAD } from '@coremail/core';
import { connectDatabase, ensureBuckets, prisma } from '@coremail/storage';
import { createImapServer } from './server/index.js';

const log = createLogger('imap:main');

const IMAP_PORT     = parseInt(process.env['IMAP_PORT']     ?? '143', 10);
const IMAP_PORT_TLS = parseInt(process.env['IMAP_PORT_TLS'] ?? '993', 10);

// Map port → laufende Server-Instanz
const servers = new Map<number, ReturnType<typeof createImapServer>>();

function closeImapServer(server: ReturnType<typeof createImapServer>, port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port }, 'IMAP close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };
    server.close(done);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  });
}

async function reloadListeners() {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'IMAP' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const srv = createImapServer();
        servers.set(l.port, srv);
        srv.listen(l.port, () => log.info({ port: l.port }, 'IMAP listener started'));
      }
    }

    // Deaktivierte Ports: sofort aus Map entfernen, dann schließen
    const toClose: Array<[number, ReturnType<typeof createImapServer>]> = [];
    for (const [port, srv] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, srv]);
      }
    }
    for (const [port, srv] of toClose) {
      await closeImapServer(srv, port);
      log.info({ port }, 'IMAP listener stopped');
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
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'IMAP') {
        void reloadListeners();
      }
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  // Fallback-Poll alle 10 s (falls Redis-Signal verpasst wurde)
  setInterval(() => { void reloadListeners(); }, 10_000);

  process.on('SIGTERM', async () => {
    log.info('Shutting down IMAP server...');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, s]) => closeImapServer(s, p)));
    await subscriber.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
