import nodemailer from 'nodemailer';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { promises as dns } from 'dns';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('smtp:relay');

export interface DkimOptions {
  dkimDomain?: string;
  dkimSelector?: string;
  dkimPrivateKey?: string;
}

// ── Cached outbound settings ─────────────────────────────────────────────────
// Wird beim ersten Aufruf geladen und für 60s gecacht — kein DB-Lookup pro Mail.

interface OutboundConfig {
  mode:                 'mx' | 'smarthost';
  smarthostHost:        string;
  smarthostPort:        number;
  smarthostTls:         boolean;     // STARTTLS
  smarthostImplicitTls: boolean;     // Implizites TLS (secure: true)
  smarthostUsername:    string;
  smarthostPassword:    string;
  outboundFilterEnabled: boolean;    // Spam-/Virenfilter vor Weiterleitung
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
    log.warn({ err }, 'Could not load outbound config — falling back to MX delivery');
    _cachedConfig = {
      mode: 'mx', smarthostHost: '', smarthostPort: 587,
      smarthostTls: true, smarthostImplicitTls: false,
      smarthostUsername: '', smarthostPassword: '',
      outboundFilterEnabled: true,
    };
  }
  _cacheExpiresAt = now + 60_000; // 60s TTL
  return _cachedConfig;
}

/** Invalidiert den Config-Cache — wird nach PUT /admin/smtp-config/settings aufgerufen. */
export function invalidateOutboundConfigCache(): void {
  _cachedConfig = null;
  _cacheExpiresAt = 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function relayMessage(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  dkim: DkimOptions,
): Promise<void> {
  // DKIM-sign the message if key is available
  let signedBuffer = rawBuffer;
  if (dkim.dkimDomain && dkim.dkimSelector && dkim.dkimPrivateKey) {
    try {
      signedBuffer = await signMessage(rawBuffer, dkim);
    } catch (err) {
      log.warn({ err }, 'DKIM signing failed — sending unsigned');
    }
  }

  const cfg = await getOutboundConfig();

  if (cfg.outboundFilterEnabled) {
    log.debug({ from, to }, 'Outbound filter enabled — mail was pre-screened by security-filter');
  }

  if (cfg.mode === 'smarthost' && cfg.smarthostHost) {
    await deliverViaSmarthost(signedBuffer, from, to, cfg);
  } else {
    // MX direct delivery — group recipients by domain
    const byDomain = groupByDomain(to);
    for (const [domain, recipients] of byDomain) {
      await deliverToDomain(signedBuffer, from, recipients, domain);
    }
  }
}

// ── Smarthost delivery ────────────────────────────────────────────────────────

async function deliverViaSmarthost(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  cfg: OutboundConfig,
): Promise<void> {
  const auth = cfg.smarthostUsername
    ? { user: cfg.smarthostUsername, pass: cfg.smarthostPassword }
    : undefined;

  const transporter = nodemailer.createTransport({
    host:               cfg.smarthostHost,
    port:               cfg.smarthostPort,
    secure:             cfg.smarthostImplicitTls,   // true = implizites TLS (Port 465)
    requireTLS:         cfg.smarthostTls && !cfg.smarthostImplicitTls, // STARTTLS erzwingen
    opportunisticTLS:   cfg.smarthostTls && !cfg.smarthostImplicitTls,
    auth,
    tls: { rejectUnauthorized: false }, // Self-signed Certs tolerieren
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     60_000,
  });

  await transporter.sendMail({
    envelope: { from, to },
    raw:      rawBuffer,
  });

  log.info({
    smarthost: cfg.smarthostHost,
    port:      cfg.smarthostPort,
    tls:       cfg.smarthostTls || cfg.smarthostImplicitTls,
    to,
  }, 'Delivered via smarthost');
}

// ── MX direct delivery ────────────────────────────────────────────────────────

async function signMessage(rawBuffer: Buffer, dkim: DkimOptions): Promise<Buffer> {
  const signed = await dkimSign(rawBuffer, {
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
    signingDomain: dkim.dkimDomain!,
    selector: dkim.dkimSelector!,
    privateKey: dkim.dkimPrivateKey!,
  });

  // dkimSign returns the DKIM-Signature header — prepend to original message
  return Buffer.concat([Buffer.from(signed.signatures), rawBuffer]);
}

async function deliverToDomain(
  rawBuffer: Buffer,
  from: string,
  recipients: string[],
  domain: string,
): Promise<void> {
  const mxRecords = await resolveMx(domain);
  if (mxRecords.length === 0) {
    throw new Error(`No MX records found for ${domain}`);
  }

  // Try MX hosts in priority order
  let lastError: Error | null = null;
  for (const mx of mxRecords) {
    try {
      const transporter = nodemailer.createTransport({
        host: mx.exchange,
        port: 25,
        secure: false,
        requireTLS: false,
        opportunisticTLS: true,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
      });

      await transporter.sendMail({
        envelope: { from, to: recipients },
        raw: rawBuffer,
      });

      log.info({ domain, mx: mx.exchange, to: recipients }, 'Delivered via MX');
      return;
    } catch (err) {
      lastError = err as Error;
      log.warn({ domain, mx: mx.exchange, err }, 'MX delivery failed, trying next');
    }
  }

  throw lastError ?? new Error(`Delivery failed to ${domain}`);
}

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
