import nodemailer from 'nodemailer';
import { promises as dns } from 'dns';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('smtp:relay');

// ── Google-RFC-5322-Compliance ────────────────────────────────────────────────
//
// Ausgehende Nachrichten müssen für Gmail-Zustellung folgende Bedingungen
// erfüllen (https://support.google.com/a/answer/81126):
//
//  ✓  From:        Genau eine RFC-5322-konforme Adresse
//  ✓  Message-ID:  <uuid@domain> — jede Nachricht eindeutig
//  ✓  Date:        RFC-5322-konformes Datum
//  ✓  MIME-Version: 1.0
//  ✓  SPF:         IP 84.247.191.198 muss im SPF-Record stehen
//  ✓  DKIM:        Mindestens 1024-Bit-Schlüssel (2048 empfohlen)
//  ✓  DMARC:       p=quarantine oder p=reject empfohlen
//
// DKIM-Signierung erfolgt über nodemailer's eingebauten Mechanismus im Transport
// (Option `dkim` in createTransport) — kein manuelles Voranstellen von Headern.
// Dies garantiert, dass die Signatur korrekt ist und nicht durch spätere
// Header-Transformationen ungültig wird.

// ── DKIM-Konfiguration ────────────────────────────────────────────────────────

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
// Beim ersten Aufruf aus DB geladen, 60 Sekunden gecacht — kein DB-Lookup pro Mail.

interface OutboundConfig {
  mode:                 'mx' | 'smarthost';
  smarthostHost:        string;
  smarthostPort:        number;
  smarthostTls:         boolean;     // STARTTLS
  smarthostImplicitTls: boolean;     // Implizites TLS (port 465)
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

/** Invalidiert den Config-Cache — wird nach PUT /admin/smtp-config/settings aufgerufen. */
export function invalidateOutboundConfigCache(): void {
  _cachedConfig = null;
  _cacheExpiresAt = 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stellt eine ausgehende Nachricht zu.
 *
 * @param rawBuffer  Vollständige RFC-5322-Nachricht als Buffer (inkl. aller Header).
 *                   Muss From, Message-ID und Date enthalten — api-gateway und SMTP-
 *                   Submission-Handler stellen dies sicher.
 * @param from       SMTP-Envelope-Absender (MAIL FROM)
 * @param to         SMTP-Envelope-Empfänger (RCPT TO) — nur externe Adressen
 * @param dkim       Optionale DKIM-Schlüsseldaten der Absender-Domain
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
    // MX-Direktzustellung — Empfänger nach Domain gruppieren
    const byDomain = groupByDomain(to);
    for (const [domain, recipients] of byDomain) {
      await deliverToDomain(rawBuffer, from, recipients, domain, dkimCfg);
    }
  }
}

// ── Smarthost-Zustellung ──────────────────────────────────────────────────────

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

  // nodemailer DKIM-Signierung direkt im Transport konfiguriert.
  // Bei raw-Modus wird der Buffer als Stream übergeben und durch den
  // DKIM-Transform geleitet — kein manuelles Voranstellen von Headern.
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

// ── MX-Direktzustellung ───────────────────────────────────────────────────────

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
      // DKIM wird durch den Transport-eigenen DKIM-Mechanismus signiert.
      // Der rawBuffer durchläuft den DKIM-Transform-Stream vor der SMTP-Übertragung.
      const transporter = nodemailer.createTransport({
        host: mx.exchange,
        port: 25,
        secure: false,
        requireTLS: false,
        opportunisticTLS: true,   // STARTTLS opportunistisch (Gmail, etc.)
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

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

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
