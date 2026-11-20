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
 * `isActiveHttps=true` was loaded. Autodiscover (`autodiscover.<domain>`)
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
import { createLogger, getRedisClient, stripForwardedHeaders, tlsProtocolOptions, type TlsProtocolOptions } from '@coremail/core';
import { prisma, decryptPrivateKey, selfSignedReplacement } from '@coremail/storage';
import {
  selectProxyCerts, planSni, matchSni, resolveSni, buildFullChainPem, needsHttpsReplacement, replacementProxyCert,
  type SelectedProxyCert, type SniPlan,
} from './lib/cert-lifecycle.js';
import { httpHardening, httpsServerOptions, hardenHttpServer } from './lib/http-hardening.js';

const log  = createLogger('tls-proxy');
const PORT = parseInt(process.env['HTTPS_PORT'] ?? '443', 10);
const REDIS_CHANNEL = 'coremail:tls:reload';

let activeServer: https.Server | null = null;

/** Hostname → certificate assignment (exact, wildcard, default) — lib/cert-lifecycle.ts planSni. */
let sniPlan: SniPlan = { exact: new Map(), wildcards: [], defaultId: null };
/** Certificate id → SecureContext for every certificate in the plan. */
let contextsById: Map<string, tls.SecureContext> = new Map();

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
async function loadCerts(): Promise<{ certs: LoadedCert[]; unreadableKeys: number }> {
  const rows = await prisma.certificate.findMany({
    where: { certPem: { not: null }, keyPem: { not: null } },
    select: {
      id: true, name: true, certPem: true, keyPem: true, chainPem: true,
      domains: true, isActiveHttps: true, createdAt: true, acmeStaging: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const plain = rows.map(withPlainKey);
  return { certs: selectProxyCerts(plain), unreadableKeys: plain.filter((r) => r.keyPem === null).length };
}

/**
 * keyPem is stored encrypted (private-key-crypto in @coremail/storage). A key that
 * cannot be decrypted (key material lost) removes only that certificate from the
 * SNI map; the error names the certificate, never the key. When none is left,
 * reloadServer() serves the self-signed replacement so 443 keeps TLS.
 */
function withPlainKey<T extends { id: string; name: string; keyPem: string | null }>(row: T): T {
  if (!row.keyPem) return row;
  try {
    return { ...row, keyPem: decryptPrivateKey(row.keyPem) };
  } catch (err) {
    log.error({ certId: row.id, name: row.name, error: err instanceof Error ? err.message : String(err) },
      `Private key of certificate "${row.name}" is unreadable — certificate not served on HTTPS; re-issue or upload the certificate`);
    return { ...row, keyPem: null };
  }
}

/** The self-signed replacement as the only proxy certificate (null when it cannot be created). */
async function replacementCerts(): Promise<LoadedCert[]> {
  try {
    const cert = replacementProxyCert(await selfSignedReplacement());
    if (cert) log.warn({ certName: cert.name }, 'HTTPS: no readable certificate left — serving the self-signed replacement certificate');
    return cert ? [cert] : [];
  } catch (err) {
    log.error({ err }, 'HTTPS: self-signed replacement certificate could not be created');
    return [];
  }
}

/**
 * BCP → Dienste → HTTPS: "Zusätzlich veraltete TLS-Versionen 1.0/1.1 zulassen (optional)"
 * (ServerSettings.httpsAllowLegacyTls). Read on every reload; an unreadable
 * setting keeps the secure default (TLS 1.2+).
 */
async function loadHttpsLegacyTls(): Promise<boolean> {
  try {
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { httpsAllowLegacyTls: true } });
    return s?.httpsAllowLegacyTls === true;
  } catch (err) {
    log.error({ err }, 'HTTPS legacy-TLS setting not readable — TLS 1.2+ only');
    return false;
  }
}

/** The TLS policy is applied to every SNI context and to the server itself. */
function buildSniMaps(certs: LoadedCert[], policy: TlsProtocolOptions): LoadedCert[] {
  const contexts = new Map<string, tls.SecureContext>();
  const usable: LoadedCert[] = [];
  for (const cert of certs) {
    try {
      // Leaf + intermediates in `cert` (9.2.x: the chain used to go to `ca`,
      // which is the trust store, not the chain sent to clients).
      contexts.set(cert.id, tls.createSecureContext({
        cert: buildFullChainPem(cert.certPem, cert.chainPem),
        key:  cert.keyPem,
        ...policy,
      }));
      usable.push(cert);
    } catch (err) {
      log.error({ err, certId: cert.id, name: cert.name },
        'Failed to create SecureContext for cert — skipping');
    }
  }

  // Hostnames: CN + SANs from the PEM + the DB `domains[]` field; first
  // (= newest) cert claiming a hostname wins. Default: isActiveHttps, else newest.
  sniPlan = planSni(usable);
  contextsById = contexts;
  return usable;
}

/**
 * SNI callback: selects the TLS context of the certificate the plan names for
 * the server name sent by the client — exact → wildcard (one sub-label level)
 * → default (resolveSni); without one the connection is dropped.
 */
function sniCallback(
  servername: string,
  cb: (err: Error | null, ctx?: tls.SecureContext) => void,
): void {
  const certId = resolveSni(sniPlan, servername);
  const ctx = certId ? contextsById.get(certId) : undefined;
  if (ctx) cb(null, ctx);
  else cb(new Error('No matching certificate'));
}

/** true while the HTTPS server listens with a certificate marked isActiveHttps (redirect only; see httpsServerState). */
let httpsActive = false;

/** Does one of the loaded certificates cover `host` (exact or one-level wildcard)? */
function coversHost(host: string): boolean {
  return matchSni(sniPlan, host) !== null;
}

/**
 * State for the HTTP → HTTPS redirect (lib/https-redirect.ts): `active` only
 * while a certificate is explicitly marked isActiveHttps — the redirect stays
 * opt-in, a listening server alone does not start redirecting.
 */
export function httpsRedirectState(): { active: boolean; port: number; covers: (host: string) => boolean } {
  return { active: httpsActive && activeServer !== null, port: PORT, covers: coversHost };
}

/** Whether the integrated HTTPS server listens, and on which port. */
export interface HttpsServerState { listening: boolean; port: number }

/**
 * Whether the integrated HTTPS server actually listens (any loaded certificate,
 * with or without isActiveHttps — the proxy then serves by SNI / newest ACTIVE).
 * Used for the BCP state (protocol overview, served-certificate probe), not for
 * the redirect. Test seam: globalThis.__httpsServerState.
 */
export function httpsServerState(): HttpsServerState {
  const seam = (globalThis as { __httpsServerState?: HttpsServerState }).__httpsServerState;
  if (seam) return seam;
  return { listening: activeServer !== null, port: PORT };
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

  const legacyTls = await loadHttpsLegacyTls();
  const policy = tlsProtocolOptions(legacyTls);
  let certs = buildSniMaps(loaded.certs, policy);
  if (needsHttpsReplacement(certs.length, loaded.unreadableKeys)) {
    certs = buildSniMaps(await replacementCerts(), policy);
  }
  if (certs.length === 0) {
    log.info('No certificate with a currently valid PEM — HTTPS server not started');
    return;
  }

  const hostnameCount = sniPlan.exact.size + sniPlan.wildcards.length;
  log.info(
    {
      certs: certs.length,
      hostnames: hostnameCount,
      names: Array.from(sniPlan.exact.keys()),
      wildcards: sniPlan.wildcards.map((w) => `*${w.suffix}`),
    },
    'TLS SNI map built',
  );

  // HTTPS server: no primary cert/key, SNICallback instead. We still set a
  // cert/key pair as fallback (Node requires it in the TLS server in some
  // versions).
  const fallbackCert = certs.find((c) => c.isActiveHttps) ?? certs[0]!;
  // 10.5: TLS handshake + header/request/keep-alive timeouts, and the per-IP /
  // global connection cap shared with port 3000 (counted on the raw TCP socket,
  // before the handshake; TRUST_PROXY never applies here) — lib/http-hardening.ts.
  const hardening = httpHardening();
  const server = https.createServer(
    {
      ...httpsServerOptions(hardening.config),
      cert: buildFullChainPem(fallbackCert.certPem, fallbackCert.chainPem),
      key:  fallbackCert.keyPem,
      ...policy,
      SNICallback: sniCallback,
    },
    // v6: TLS clients connect directly — any X-Forwarded-*/Forwarded header
    // is client-forged here, whatever TRUST_PROXY says for port 3000.
    (req, res) => {
      stripForwardedHeaders(req);
      app(req, res);
    },
  );
  hardenHttpServer(server, { kind: 'https', guard: hardening.guard, config: hardening.config, stallWatcher: hardening.stallWatcher });

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
        { port: PORT, defaultCert: fallbackCert.name, defaultId: fallbackCert.id, allowLegacyTls: legacyTls },
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
