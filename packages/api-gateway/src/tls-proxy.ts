/**
 * Integrated HTTPS reverse proxy (TLS termination) with SNI multi-cert support
 *
 * Starts a Node.js HTTPS server on port 443 (or HTTPS_PORT) as soon as at
 * least one ACTIVE certificate exists in the database. For each incoming TLS
 * connection an SNI callback selects the matching certificate based on the
 * server name sent by the client.
 *
 * v3.18.32: SNI multi-cert refactor — previously only the one cert with
 * `isActiveHttps=true` was loaded. Outlook Autodiscover (`autodiscover.<domain>`)
 * therefore always got the `mail.<domain>` cert → hostname mismatch →
 * certificate error. Now: ALL ACTIVE certs are loaded, one TLS context per
 * hostname (CN + all SANs + `domains[]`). SNICallback matches exact +
 * wildcard (`*.example.com`). The default cert (for unknown SNI) is the cert
 * with `isActiveHttps=true`, fallback: newest ACTIVE cert.
 *
 * Hot reload: the Redis channel "coremail:tls:reload" triggers a rebuild of
 * the SNI map. → No container restart needed when issuing / renewing.
 *
 * Usage:
 *   import { startTlsProxy } from './tls-proxy.js';
 *   await startTlsProxy(app);  // after app.listen(HTTP_PORT)
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
/** Wildcard patterns: '*.example.com' → SecureContext */
let wildcardContexts: Array<{ suffix: string; ctx: tls.SecureContext }> = [];
/** Fallback for unknown SNI names (or connections without SNI) */
let defaultContext: tls.SecureContext | null = null;

// ── Public entry point ───────────────────────────────────────────────────────

/** v5.7.1: upgrade handler (JMAP over WebSocket) — set by the api-gateway. */
type UpgradeHandler = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void;
let upgradeHandler: UpgradeHandler | null = null;
export function setTlsUpgradeHandler(h: UpgradeHandler): void { upgradeHandler = h; }

export async function startTlsProxy(app: Application): Promise<void> {
  // Initial load
  await reloadServer(app);

  // Redis subscription for hot reload (own connection, no subscriber conflict)
  const sub = getRedisClient().duplicate();
  void sub.subscribe(REDIS_CHANNEL);
  sub.on('message', (_channel, _msg) => {
    log.info('TLS hot-reload triggered via Redis');
    void reloadServer(app).catch(err =>
      log.error({ err }, 'TLS reload failed'),
    );
  });
}

// ── Cert loading & SNI map construction ──────────────────────────────────────

/**
 * Extracts all DNS names (CN + SANs) from a PEM certificate.
 * Returns lowercase hostnames with duplicates removed.
 */
function extractHostnames(certPem: string): string[] {
  try {
    const x509 = new X509Certificate(certPem);
    const hostnames = new Set<string>();

    // CN from subject (best-effort — format "CN=foo.example.com")
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
    orderBy: { createdAt: 'desc' }, // newest first → wins on hostname conflict
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

    // Hostnames: CN + SANs from the PEM + additionally the DB `domains[]` field
    const fromPem = extractHostnames(cert.certPem);
    const allHostnames = new Set<string>([
      ...fromPem,
      ...cert.domains.map((d) => d.toLowerCase()),
    ]);

    for (const hostname of allHostnames) {
      if (hostname.startsWith('*.')) {
        // Wildcard: matches exactly one sub-label level
        const suffix = hostname.slice(1); // '.example.com'
        wildcardContexts.push({ suffix, ctx });
      } else {
        // Exact match (newest assignment wins — Map.set overwrites; but we
        // iterate from newest to oldest, hence: only set when free)
        if (!sniContexts.has(hostname)) {
          sniContexts.set(hostname, ctx);
        }
      }
    }

    // Default cert: the one with isActiveHttps=true. If none is marked, we
    // take the newest (first in the createdAt-DESC list).
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
 * SNI callback: selects the matching TLS context based on the server name
 * sent by the client.
 *
 * Match order:
 *   1. Exact match (`hostname` in sniContexts)
 *   2. Wildcard match (`*.parent` matches one sub-label level)
 *   3. defaultContext (otherwise the connection is dropped)
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

  // 2. Wildcard (exactly one sub-label level — RFC 6125)
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

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function reloadServer(app: Application): Promise<void> {
  const certs = await loadCerts();

  // Stop the running HTTPS server (graceful — max 5 s)
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

  // HTTPS server: no primary cert/key, SNICallback instead. We still set a
  // cert/key pair as fallback (Node requires it in the TLS server in some
  // versions).
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

  // v5.7.1: forward WebSocket upgrades (JMAP /jmap/ws) to the gateway handler
  server.on('upgrade', (req, socket, head) => {
    if (upgradeHandler) upgradeHandler(req, socket, head);
    else socket.destroy();
  });

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
