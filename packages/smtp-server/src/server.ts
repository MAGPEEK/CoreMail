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

/**
 * Schließt einen SMTPServer zuverlässig:
 * - Stoppt neue Verbindungen (server.close)
 * - Zerstört alle bestehenden Verbindungen (closeAllConnections) gleichzeitig
 * - Timeout nach 3 s als Fallback (falls kein Callback kommt)
 */
function closeSmtpServer(server: ReturnType<typeof createInboundServer>, port: number): Promise<void> {
  // smtp-server (nodemailer) legt den internen net.Server unter .server ab
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const netSrv = (server as any).server as { closeAllConnections?(): void } | undefined;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn({ port }, 'SMTP close timeout (3 s) — forced');
      resolve();
    }, 3_000);
    const done = () => { clearTimeout(timer); resolve(); };
    // close() und closeAllConnections() GLEICHZEITIG aufrufen:
    // close() allein wartet auf alle Verbindungen → hängt ewig wenn aktive Verbindungen da sind.
    // closeAllConnections() zerstört sofort alle Sockets → close()-Callback feuert danach direkt.
    server.close(done);
    netSrv?.closeAllConnections?.();
  });
}

async function reloadListeners() {
  try {
    const listeners = await prisma.serviceListener.findMany({ where: { service: 'SMTP_RECEIVE' } });
    const activePorts = new Set(listeners.filter(l => l.active).map(l => l.port));

    // Neu aktive Ports starten
    for (const l of listeners) {
      if (l.active && !servers.has(l.port)) {
        const srv = createInboundServer();
        servers.set(l.port, srv);
        srv.listen(l.port, () => log.info({ port: l.port }, 'SMTP listener started'));
      }
    }

    // Deaktivierte Ports: zuerst aus Map entfernen (verhindert Doppel-Close
    // bei parallelen reload-Aufrufen), dann schließen
    const toClose: Array<[number, ReturnType<typeof createInboundServer>]> = [];
    for (const [port, srv] of servers) {
      if (!activePorts.has(port)) {
        servers.delete(port);
        toClose.push([port, srv]);
      }
    }
    for (const [port, srv] of toClose) {
      await closeSmtpServer(srv, port);
      log.info({ port }, 'SMTP listener stopped');
    }
  } catch (err) {
    log.error({ err }, 'Failed to reload SMTP listeners');
  }
}

async function main() {
  await connectDatabase();
  await ensureBuckets();

  // Beim ersten Start: Default-Listener anlegen (falls DB noch leer)
  const existing = await prisma.serviceListener.count({ where: { service: 'SMTP_RECEIVE' } });
  if (existing === 0) {
    await prisma.serviceListener.createMany({
      data: [
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_25,  ssl: false, active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_465, ssl: true,  active: true },
        { service: 'SMTP_RECEIVE', address: '0.0.0.0', port: SMTP_PORT_587, ssl: true,  active: true },
      ],
    });
    log.info('Default SMTP_RECEIVE listener seeded');
  }

  // Ports laut DB starten (respektiert Toggle-Zustand aus vorherigen Sitzungen)
  await reloadListeners();

  // Outbound-Worker starten
  const worker = startOutboundWorker();
  log.info('Outbound queue worker started');

  // Redis-Subscriber für dynamischen Listener-Reload
  const subscriber = getRedisClient().duplicate();
  subscriber.on('error', (err) => log.error({ err }, 'Subscriber Redis error'));
  void subscriber.subscribe(CHANNEL_SERVICE_LISTENERS_RELOAD);
  subscriber.on('message', (_ch, message) => {
    try {
      const payload = JSON.parse(message) as { service: string };
      if (payload.service === 'SMTP_RECEIVE') {
        void reloadListeners();
      }
    } catch (err) {
      log.error({ err }, 'Invalid listener reload message');
    }
  });

  // Fallback-Poll alle 10 s (falls Redis-Signal verpasst wurde)
  setInterval(() => { void reloadListeners(); }, 10_000);

  // Graceful Shutdown
  process.on('SIGTERM', async () => {
    log.info('Shutting down SMTP server...');
    const all = [...servers.entries()];
    servers.clear();
    await Promise.all(all.map(([p, s]) => closeSmtpServer(s, p)));
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
