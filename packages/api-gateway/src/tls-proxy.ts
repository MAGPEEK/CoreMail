/**
 * Integrierter HTTPS-Reverse-Proxy (TLS-Termination)
 *
 * Startet einen Node.js-HTTPS-Server auf Port 443 (oder HTTPS_PORT), wenn
 * ein Zertifikat in der Datenbank als "isActiveHttps = true" markiert ist.
 * Ist kein HTTPS-Zertifikat aktiviert, bleibt Port 443 geschlossen.
 *
 * Hot-Reload: Redis-Channel "coremail:tls:reload" löst automatischen
 * Neustart des HTTPS-Servers mit dem aktuellen Zertifikat aus.
 * → Kein Container-Neustart nötig beim Aktivieren / Erneuern eines Certs.
 *
 * Verwendung:
 *   import { startTlsProxy } from './tls-proxy.js';
 *   await startTlsProxy(app);  // nach app.listen(HTTP_PORT)
 */
import https from 'node:https';
import type { Application } from 'express';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log  = createLogger('tls-proxy');
const PORT = parseInt(process.env['HTTPS_PORT'] ?? '443', 10);
const REDIS_CHANNEL = 'coremail:tls:reload';

let activeServer: https.Server | null = null;

// ── Öffentlicher Einstiegspunkt ──────────────────────────────────────────────

export async function startTlsProxy(app: Application): Promise<void> {
  // Initial laden
  await reloadServer(app);

  // Redis-Subscription für Hot-Reload (eigene Verbindung, kein Subscriber-Konflikt)
  const sub = getRedisClient().duplicate();
  void sub.subscribe(REDIS_CHANNEL);
  sub.on('message', (_channel, _msg) => {
    log.info('TLS hot-reload triggered via Redis');
    void reloadServer(app).catch(err =>
      log.error({ err }, 'TLS reload failed'),
    );
  });
}

// ── Interner Reload-Mechanismus ───────────────────────────────────────────────

async function reloadServer(app: Application): Promise<void> {
  // Aktives Zertifikat aus DB laden
  const cert = await prisma.certificate.findFirst({
    where: { isActiveHttps: true },
    select: { id: true, certPem: true, keyPem: true, chainPem: true, name: true },
  });

  // Laufenden HTTPS-Server stoppen (Graceful — max 5 s)
  if (activeServer) {
    await stopServer(activeServer);
    activeServer = null;
  }

  if (!cert?.certPem || !cert?.keyPem) {
    log.info('No active HTTPS certificate — HTTPS server not started');
    return;
  }

  // Neuen HTTPS-Server mit frischem TLS-Kontext starten
  const server = https.createServer(
    {
      cert: cert.certPem,
      key:  cert.keyPem,
      ...(cert.chainPem ? { ca: cert.chainPem } : {}),
    },
    app,
  );

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES') {
      log.error(
        { port: PORT },
        'HTTPS: Port 443 requires root or CAP_NET_BIND_SERVICE. ' +
        'Check docker-compose "cap_add: [NET_BIND_SERVICE]" or use HTTPS_PORT=8443.',
      );
    } else if (err.code === 'EADDRINUSE') {
      log.error({ port: PORT }, 'HTTPS: Port already in use');
    } else {
      log.error({ err }, 'HTTPS server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(PORT, () => {
      server.off('error', onError);
      log.info({ port: PORT, cert: cert.name, id: cert.id }, 'HTTPS server started');
      resolve();
    });
  });

  activeServer = server;
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function stopServer(server: https.Server): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      log.warn('HTTPS server did not close in 5 s — forcing shutdown');
      resolve();
    }, 5_000);

    server.close(() => {
      clearTimeout(timer);
      log.info('HTTPS server stopped');
      resolve();
    });
  });
}
