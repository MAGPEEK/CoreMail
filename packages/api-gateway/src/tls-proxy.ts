/**
 * Integrated HTTPS reverse proxy (TLS termination) with SNI multi-cert support
 *
 * Starts a Node.js HTTPS server on port 443 (or HTTPS_PORT) as soon as at
 * least one certificate with a currently valid PEM exists in the database
 * (v6: selection by PEM validity, not by DB status). For each incoming TLS
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
import type { Application } from 'express';
import { createLogger, getRedisClient, stripForwardedHeaders } from '@coremail/core';
import { prisma, decryptPrivateKey } from '@coremail/storage';
import { selectProxyCerts, planSni, buildFullChainPem, type SelectedProxyCert } from './lib/cert-lifecycle.js';

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

type LoadedCert = SelectedProxyCert;

/**
 * Loads every certificate whose PEM is currently valid (notBefore <= now <=
 * notAfter), independent of its DB status — an EXPIRING, RENEWING or ERROR
 * (failed renewal) cert with a still-valid PEM keeps serving HTTPS.
 * Ordered newest first (notBefore, then createdAt) so the newest cert wins
 * per hostname (see selectProxyCerts / planSni in lib/cert-lifecycle.ts).
 */
async function loadCerts(): Promise<LoadedCert[]> {
  const rows = await prisma.certificate.findMany({
    where: { certPem: { not: null }, keyPem: { not: null } },
    select: {
      id: true, name: true, certPem: true, keyPem: true, chainPem: true,
      domains: true, isActiveHttps: true, createdAt: true, acmeStaging: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return selectProxyCerts(rows.map(withPlainKey));
}

/**
 * keyPem is stored encrypted (private-key-crypto in @coremail/storage). A key that
 * cannot be decrypted (key material lost) removes only that certificate from the
 * SNI map; the error names the certificate, never the key.
 */
function withPlainKey<T extends { id: string; name: string; keyPem: string | null }>(row: T): T {
  if (!row.keyPem) return row;
  try {
    return { ...row, keyPem: decryptPrivateKey(row.keyPem) };
  } catch (err) {
    log.error({ certId: row.id, name: row.name, error: err instanceof Error ? err.message : String(err) },
      'Certificate private key unreadable — certificate not served on HTTPS');
    return { ...row, keyPem: null };
  }
}

function buildSniMaps(certs: LoadedCert[]): LoadedCert[] {
  sniContexts = new Map();
  wildcardContexts = [];
  defaultContext = null;

  const contexts = new Map<string, tls.SecureContext>();
  const usable: LoadedCert[] = [];
  for (const cert of certs) {
    try {
      // Leaf + intermediates in `cert` (9.2.x: the chain used to go to `ca`,
      // which is the trust store, not the chain sent to clients).
      contexts.set(cert.id, tls.createSecureContext({
        cert: buildFullChainPem(cert.certPem, cert.chainPem),
        key:  cert.keyPem,
      }));
      usable.push(cert);
    } catch (err) {
      log.error({ err, certId: cert.id, name: cert.name },
        'Failed to create SecureContext for cert — skipping');
    }
  }

  // Hostnames: CN + SANs from the PEM + the DB `domains[]` field; first
  // (= newest) cert claiming a hostname wins. Default: isActiveHttps, else newest.
  const plan = planSni(usable);
  for (const [hostname, certId] of plan.exact) {
    const ctx = contexts.get(certId);
    if (ctx) sniContexts.set(hostname, ctx);
  }
  for (const w of plan.wildcards) {
    const ctx = contexts.get(w.certId);
    if (ctx) wildcardContexts.push({ suffix: w.suffix, ctx });
  }
  defaultContext = plan.defaultId ? contexts.get(plan.defaultId) ?? null : null;
  return usable;
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

/** true while the HTTPS server listens with a certificate marked isActiveHttps. */
let httpsActive = false;

/** Does one of the loaded certificates cover `host` (exact or one-level wildcard)? */
function coversHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (sniContexts.has(lower)) return true;
  return wildcardContexts.some((w) => {
    if (!lower.endsWith(w.suffix)) return false;
    const prefix = lower.slice(0, -w.suffix.length);
    return prefix.length > 0 && !prefix.includes('.');
  });
}

/** State for the HTTP → HTTPS redirect (lib/https-redirect.ts). */
export function httpsRedirectState(): { active: boolean; port: number; covers: (host: string) => boolean } {
  return { active: httpsActive && activeServer !== null, port: PORT, covers: coversHost };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function reloadServer(app: Application): Promise<void> {
  const loaded = await loadCerts();

  // Stop the running HTTPS server (graceful — max 5 s)
  httpsActive = false;
  if (activeServer) {
    await stopServer(activeServer);
    activeServer = null;
  }

  const certs = buildSniMaps(loaded);
  if (certs.length === 0) {
    log.info('No certificate with a currently valid PEM — HTTPS server not started');
    return;
  }

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
      cert: buildFullChainPem(fallbackCert.certPem, fallbackCert.chainPem),
      key:  fallbackCert.keyPem,
      SNICallback: sniCallback,
    },
    // v6: TLS clients connect directly — any X-Forwarded-*/Forwarded header
    // is client-forged here, whatever TRUST_PROXY says for port 3000.
    (req, res) => {
      stripForwardedHeaders(req);
      app(req, res);
    },
  );

  // v5.7.1: forward WebSocket upgrades (JMAP /jmap/ws) to the gateway handler
  server.on('upgrade', (req, socket, head) => {
    stripForwardedHeaders(req);
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
  httpsActive = certs.some((c) => c.isActiveHttps);
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
