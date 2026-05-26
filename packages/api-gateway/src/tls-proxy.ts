/**
 * Integrierter HTTPS-Reverse-Proxy (TLS-Termination) mit SNI-Multi-Cert-Support
 *
 * Startet einen Node.js-HTTPS-Server auf Port 443 (oder HTTPS_PORT), sobald
 * mindestens ein ACTIVE-Zertifikat in der Datenbank existiert. Pro eingehender
 * TLS-Verbindung wählt ein SNI-Callback anhand des vom Client gesendeten
 * Servernames das passende Zertifikat aus.
 *
 * v3.18.32: SNI-Multi-Cert-Refactor — vorher wurde nur das eine Cert mit
 * `isActiveHttps=true` geladen. Outlook-Autodiscover (`autodiscover.<domain>`)
 * bekam dadurch immer das `mail.<domain>`-Cert → Hostname-Mismatch →
 * Zertifikatsfehler. Jetzt: ALLE ACTIVE-Certs werden geladen, pro Hostname
 * (CN + alle SANs + `domains[]`) ein eigener TLS-Context. SNICallback matcht
 * exact + wildcard (`*.example.com`). Default-Cert (für unbekannte SNI) ist
 * das Cert mit `isActiveHttps=true`, fallback: neuestes ACTIVE-Cert.
 *
 * Hot-Reload: Redis-Channel "coremail:tls:reload" löst Neuaufbau der
 * SNI-Map aus. → Kein Container-Neustart nötig beim Ausstellen / Erneuern.
 *
 * Verwendung:
 *   import { startTlsProxy } from './tls-proxy.js';
 *   await startTlsProxy(app);  // nach app.listen(HTTP_PORT)
 */
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { Application } from 'express';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log  = createLogger('tls-proxy');
const PORT = parseInt(process.env['HTTPS_PORT'] ?? '443', 10);
const REDIS_CHANNEL = 'coremail:tls:reload';

let activeServer: https.Server | null = null;

/** Map: hostname (lowercase) → SecureContext */
let sniContexts: Map<string, tls.SecureContext> = new Map();
/** Wildcard-Patterns: '*.example.com' → SecureContext */
let wildcardContexts: Array<{ suffix: string; ctx: tls.SecureContext }> = [];
/** Fallback für unbekannte SNI-Namen (oder Verbindungen ohne SNI) */
let defaultContext: tls.SecureContext | null = null;

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

// ── Cert-Loading & SNI-Map-Aufbau ────────────────────────────────────────────

/**
 * Extrahiert alle DNS-Namen (CN + SANs) aus einem PEM-Zertifikat.
 * Gibt lowercase-Hostnames zurück, Duplikate entfernt.
 */
function extractHostnames(certPem: string): string[] {
  try {
    const x509 = new X509Certificate(certPem);
    const hostnames = new Set<string>();

    // CN aus Subject (best-effort — Format "CN=foo.example.com")
    const cnMatch = /CN=([^,/]+)/i.exec(x509.subject);
    if (cnMatch?.[1]) hostnames.add(cnMatch[1].trim().toLowerCase());

    // SubjectAltName: "DNS:foo.example.com, DNS:*.example.com, IP:..."
    const san = x509.subjectAltName;
    if (san) {
      for (const part of san.split(',')) {
        const [type, value] = part.trim().split(':');
        if (type?.trim().toUpperCase() === 'DNS' && value) {
          hostnames.add(value.trim().toLowerCase());
        }
      }
    }

    return Array.from(hostnames);
  } catch (err) {
    log.warn({ err }, 'Failed to extract hostnames from cert PEM');
    return [];
  }
}

interface LoadedCert {
  id: string;
  name: string;
  certPem: string;
  keyPem: string;
  chainPem: string | null;
  domains: string[];
  isActiveHttps: boolean;
}

async function loadCerts(): Promise<LoadedCert[]> {
  const rows = await prisma.certificate.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true, name: true, certPem: true, keyPem: true, chainPem: true,
      domains: true, isActiveHttps: true,
    },
    orderBy: { createdAt: 'desc' }, // neueste zuerst → gewinnt bei Hostname-Konflikt
  });

  return rows
    .filter((c): c is LoadedCert =>
      typeof c.certPem === 'string' && c.certPem.length > 0 &&
      typeof c.keyPem  === 'string' && c.keyPem.length  > 0,
    );
}

function buildSniMaps(certs: LoadedCert[]): void {
  sniContexts = new Map();
  wildcardContexts = [];
  defaultContext = null;

  for (const cert of certs) {
    let ctx: tls.SecureContext;
    try {
      ctx = tls.createSecureContext({
        cert: cert.certPem,
        key:  cert.keyPem,
        ...(cert.chainPem ? { ca: cert.chainPem } : {}),
      });
    } catch (err) {
      log.error({ err, certId: cert.id, name: cert.name },
        'Failed to create SecureContext for cert — skipping');
      continue;
    }

    // Hostnames: CN + SANs aus dem PEM + zusätzlich `domains[]`-Feld der DB
    const fromPem = extractHostnames(cert.certPem);
    const allHostnames = new Set<string>([
      ...fromPem,
      ...cert.domains.map((d) => d.toLowerCase()),
    ]);

    for (const hostname of allHostnames) {
      if (hostname.startsWith('*.')) {
        // Wildcard: matcht genau eine Sub-Label-Ebene
        const suffix = hostname.slice(1); // '.example.com'
        wildcardContexts.push({ suffix, ctx });
      } else {
        // Exact match (neueste Belegung gewinnt — Map.set überschreibt; wir
        // iterieren aber von neuesten zu ältesten, daher: nur setzen wenn frei)
        if (!sniContexts.has(hostname)) {
          sniContexts.set(hostname, ctx);
        }
      }
    }

    // Default-Cert: das mit isActiveHttps=true. Falls keines markiert, nehmen
    // wir das neueste (erste in der createdAt-DESC-Liste).
    if (cert.isActiveHttps && !defaultContext) {
      defaultContext = ctx;
    }
  }

  if (!defaultContext && certs.length > 0) {
    const fallback = certs[0];
    if (fallback) {
      defaultContext = tls.createSecureContext({
        cert: fallback.certPem,
        key:  fallback.keyPem,
        ...(fallback.chainPem ? { ca: fallback.chainPem } : {}),
      });
    }
  }
}

/**
 * SNI-Callback: wählt anhand des vom Client gesendeten Servernames den
 * passenden TLS-Context aus.
 *
 * Match-Reihenfolge:
 *   1. Exact match (`hostname` in sniContexts)
 *   2. Wildcard match (`*.parent` matcht eine Sub-Label-Ebene)
 *   3. defaultContext (sonst Verbindung verworfen)
 */
function sniCallback(
  servername: string,
  cb: (err: Error | null, ctx?: tls.SecureContext) => void,
): void {
  const lower = servername.toLowerCase();

  // 1. Exact
  const exact = sniContexts.get(lower);
  if (exact) {
    cb(null, exact);
    return;
  }

  // 2. Wildcard (genau eine Sub-Label-Ebene — RFC 6125)
  for (const w of wildcardContexts) {
    if (lower.endsWith(w.suffix)) {
      const prefix = lower.slice(0, -w.suffix.length);
      if (prefix.length > 0 && !prefix.includes('.')) {
        cb(null, w.ctx);
        return;
      }
    }
  }

  // 3. Default
  if (defaultContext) {
    cb(null, defaultContext);
    return;
  }

  cb(new Error('No matching certificate'));
}

// ── Server-Lifecycle ──────────────────────────────────────────────────────────

async function reloadServer(app: Application): Promise<void> {
  const certs = await loadCerts();

  // Laufenden HTTPS-Server stoppen (Graceful — max 5 s)
  if (activeServer) {
    await stopServer(activeServer);
    activeServer = null;
  }

  if (certs.length === 0) {
    log.info('No active certificates — HTTPS server not started');
    return;
  }

  buildSniMaps(certs);

  const hostnameCount = sniContexts.size + wildcardContexts.length;
  log.info(
    {
      certs: certs.length,
      hostnames: hostnameCount,
      names: Array.from(sniContexts.keys()),
      wildcards: wildcardContexts.map((w) => `*${w.suffix}`),
    },
    'TLS SNI map built',
  );

  // HTTPS-Server: kein primäres cert/key, statt dessen SNICallback. Wir setzen
  // dennoch ein cert/key-Paar als Fallback (Node erfordert es im Tls-Server
  // bei manchen Versionen).
  const fallbackCert = certs.find((c) => c.isActiveHttps) ?? certs[0]!;
  const server = https.createServer(
    {
      cert: fallbackCert.certPem,
      key:  fallbackCert.keyPem,
      ...(fallbackCert.chainPem ? { ca: fallbackCert.chainPem } : {}),
      SNICallback: sniCallback,
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
      log.info(
        { port: PORT, defaultCert: fallbackCert.name, defaultId: fallbackCert.id },
        'HTTPS server started with SNI',
      );
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
