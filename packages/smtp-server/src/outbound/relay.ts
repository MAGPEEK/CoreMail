import nodemailer from 'nodemailer';
import { promises as dns } from 'dns';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('smtp:relay');

// ── Google RFC 5322 compliance ────────────────────────────────────────────────
//
// For Gmail delivery, outgoing messages must meet the following
// requirements (https://support.google.com/a/answer/81126):
//
//  ✓  From:        exactly one RFC 5322-compliant address
//  ✓  Message-ID:  <uuid@domain> — unique per message
//  ✓  Date:        RFC 5322-compliant date
//  ✓  MIME-Version: 1.0
//  ✓  SPF:         IP 84.247.191.198 must be in the SPF record
//  ✓  DKIM:        at least a 1024-bit key (2048 recommended)
//  ✓  DMARC:       p=quarantine or p=reject recommended
//
// DKIM signing is done via nodemailer's built-in mechanism in the transport
// (option `dkim` in createTransport) — no manual prepending of headers.
// This guarantees that the signature is correct and is not invalidated by
// later header transformations.

// ── DKIM configuration ────────────────────────────────────────────────────────

export interface DkimOptions {
  dkimDomain?:      string;
  dkimSelector?:    string;
  dkimPrivateKey?:  string;
}

type NmDkim = {
  domainName:  string;
  keySelector: string;
  privateKey:  string;
};

function buildDkim(opts: DkimOptions): NmDkim | undefined {
  if (opts.dkimDomain && opts.dkimSelector && opts.dkimPrivateKey) {
    return {
      domainName:  opts.dkimDomain,
      keySelector: opts.dkimSelector,
      privateKey:  opts.dkimPrivateKey,
    };
  }
  return undefined;
}

// ── Cached outbound settings ─────────────────────────────────────────────────
// Loaded from DB on first call, cached for 60 seconds — no DB lookup per mail.

interface OutboundConfig {
  mode:                 'mx' | 'smarthost';
  smarthostHost:        string;
  smarthostPort:        number;
  smarthostTls:         boolean;     // STARTTLS
  smarthostImplicitTls: boolean;     // implicit TLS (port 465)
  smarthostUsername:    string;
  smarthostPassword:    string;
  outboundFilterEnabled: boolean;
}

let _cachedConfig: OutboundConfig | null = null;
let _cacheExpiresAt = 0;

async function getOutboundConfig(): Promise<OutboundConfig> {
  const now = Date.now();
  if (_cachedConfig && now < _cacheExpiresAt) return _cachedConfig;

  try {
    const s = await prisma.smtpSettings.findUnique({ where: { id: 'singleton' } });
    _cachedConfig = {
      mode:                  (s?.outboundMode ?? 'mx') as 'mx' | 'smarthost',
      smarthostHost:         s?.smarthostHost         ?? '',
      smarthostPort:         s?.smarthostPort         ?? 587,
      smarthostTls:          s?.smarthostTls          ?? true,
      smarthostImplicitTls:  s?.smarthostImplicitTls  ?? false,
      smarthostUsername:     s?.smarthostUsername     ?? '',
      smarthostPassword:     s?.smarthostPassword     ?? '',
      outboundFilterEnabled: s?.outboundFilterEnabled ?? true,
    };
  } catch (err) {
    log.warn({ err }, 'Outbound-Config nicht ladbar — MX-Zustellung als Fallback');
    _cachedConfig = {
      mode: 'mx', smarthostHost: '', smarthostPort: 587,
      smarthostTls: true, smarthostImplicitTls: false,
      smarthostUsername: '', smarthostPassword: '',
      outboundFilterEnabled: true,
    };
  }
  _cacheExpiresAt = now + 60_000;
  return _cachedConfig;
}

/** Invalidates the config cache — called after PUT /admin/smtp-config/settings. */
export function invalidateOutboundConfigCache(): void {
  _cachedConfig = null;
  _cacheExpiresAt = 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Delivers an outgoing message.
 *
 * @param rawBuffer  Complete RFC 5322 message as a buffer (incl. all headers).
 *                   Must contain From, Message-ID and Date — api-gateway and the SMTP
 *                   submission handler ensure this.
 * @param from       SMTP envelope sender (MAIL FROM)
 * @param to         SMTP envelope recipients (RCPT TO) — external addresses only
 * @param dkim       Optional DKIM key data of the sender domain
 */
export async function relayMessage(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  dkim: DkimOptions,
): Promise<void> {
  const cfg    = await getOutboundConfig();
  const dkimCfg = buildDkim(dkim);

  if (dkimCfg) {
    log.debug({ domain: dkimCfg.domainName, selector: dkimCfg.keySelector },
      'DKIM-Signierung aktiv');
  } else {
    log.warn({ from }, 'Kein DKIM-Schlüssel konfiguriert — Nachricht wird unsigniert versendet');
  }

  if (cfg.outboundFilterEnabled) {
    log.debug({ from, to }, 'Ausgehender Filter aktiviert — Mail wurde vorab geprüft');
  }

  if (cfg.mode === 'smarthost' && cfg.smarthostHost) {
    await deliverViaSmarthost(rawBuffer, from, to, cfg, dkimCfg);
  } else {
    // Direct MX delivery — group recipients by domain
    const byDomain = groupByDomain(to);
    for (const [domain, recipients] of byDomain) {
      await deliverToDomain(rawBuffer, from, recipients, domain, dkimCfg);
    }
  }
}

// ── Smarthost delivery ────────────────────────────────────────────────────────

async function deliverViaSmarthost(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  cfg: OutboundConfig,
  dkimCfg: NmDkim | undefined,
): Promise<void> {
  const auth = cfg.smarthostUsername
    ? { user: cfg.smarthostUsername, pass: cfg.smarthostPassword }
    : undefined;

  // nodemailer DKIM signing configured directly in the transport.
  // In raw mode the buffer is passed as a stream and piped through the
  // DKIM transform — no manual prepending of headers.
  const transporter = nodemailer.createTransport({
    host:             cfg.smarthostHost,
    port:             cfg.smarthostPort,
    secure:           cfg.smarthostImplicitTls,
    requireTLS:       cfg.smarthostTls && !cfg.smarthostImplicitTls,
    opportunisticTLS: cfg.smarthostTls && !cfg.smarthostImplicitTls,
    auth,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     60_000,
    ...(dkimCfg ? { dkim: dkimCfg } : {}),
  });

  await transporter.sendMail({
    envelope: { from, to },
    raw: rawBuffer,
  });

  log.info({
    smarthost: cfg.smarthostHost,
    port: cfg.smarthostPort,
    tls: cfg.smarthostTls || cfg.smarthostImplicitTls,
    dkim: !!dkimCfg,
    to,
  }, 'Zugestellt via Smarthost');
}

// ── Direct MX delivery ────────────────────────────────────────────────────────

async function deliverToDomain(
  rawBuffer: Buffer,
  from: string,
  recipients: string[],
  domain: string,
  dkimCfg: NmDkim | undefined,
): Promise<void> {
  const mxRecords = await resolveMx(domain);
  if (mxRecords.length === 0) {
    throw new Error(`Keine MX-Records für ${domain} gefunden`);
  }

  let lastError: Error | null = null;

  for (const mx of mxRecords) {
    try {
      // DKIM is signed by the transport's own DKIM mechanism.
      // The rawBuffer passes through the DKIM transform stream before SMTP transmission.
      const transporter = nodemailer.createTransport({
        host: mx.exchange,
        port: 25,
        secure: false,
        requireTLS: false,
        opportunisticTLS: true,   // opportunistic STARTTLS (Gmail, etc.)
        tls: { rejectUnauthorized: false },
        connectionTimeout: 30_000,
        greetingTimeout:   15_000,
        socketTimeout:     60_000,
        ...(dkimCfg ? { dkim: dkimCfg } : {}),
      });

      await transporter.sendMail({
        envelope: { from, to: recipients },
        raw: rawBuffer,
      });

      log.info({ domain, mx: mx.exchange, dkim: !!dkimCfg, to: recipients },
        'Zugestellt via MX');
      return;

    } catch (err) {
      lastError = err as Error;
      log.warn({ domain, mx: mx.exchange, err }, 'MX-Zustellung fehlgeschlagen — nächster MX');
    }
  }

  throw lastError ?? new Error(`Zustellung fehlgeschlagen für ${domain}`);
}

// ── Helper functions ──────────────────────────────────────────────────────────

async function resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]> {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

function groupByDomain(addresses: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const addr of addresses) {
    const domain = addr.split('@')[1]?.toLowerCase() ?? '';
    const existing = map.get(domain) ?? [];
    existing.push(addr);
    map.set(domain, existing);
  }
  return map;
}
