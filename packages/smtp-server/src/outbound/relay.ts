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
//  ✓  SPF:         the server IP must be in the SPF record
//  ✓  DKIM:        at least a 1024-bit key (2048 recommended)
//  ✓  DMARC:       p=quarantine or p=reject recommended
//
// DKIM signing is done via nodemailer's built-in mechanism in the transport
// (option `dkim` in createTransport) — no manual prepending of headers.

// ── Timeouts (ms) ─────────────────────────────────────────────────────────────
const CONNECTION_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS   = 15_000;
const SOCKET_TIMEOUT_MS     = 60_000;
const CONFIG_CACHE_MS       = 60_000;

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

// ── Per-recipient result ──────────────────────────────────────────────────────

/** One recipient the remote side (or DNS) did not accept. */
export interface RecipientFailure {
  rcpt:       string;
  /** Basic reply code of the remote server, null for network/DNS errors. */
  code:       number | null;
  /** Enhanced status code (RFC 3463) — from the reply, else derived. */
  status:     string;
  /** Diagnostic text (remote reply or local reason, one line). */
  message:    string;
  /** 5yz / permanent DNS condition → bounce now; otherwise retry. */
  permanent:  boolean;
}

export interface RelayResult {
  delivered: string[];
  failures:  RecipientFailure[];
}

/** Error properties nodemailer sets on SMTP failures. */
interface SmtpError extends Error {
  code?:         string;
  responseCode?: number;
  response?:     string;
  recipient?:    string;
  rejectedErrors?: SmtpError[];
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Classifies an SMTP/network error. Only a real reply code counts — a number in
 * a network error ("connect ETIMEDOUT 10.0.0.5:587") never makes a failure
 * permanent; errors without a reply code are transient.
 */
export function classifySmtpError(err: unknown): Omit<RecipientFailure, 'rcpt'> {
  const e = (err ?? {}) as SmtpError;
  const response = typeof e.response === 'string' ? e.response : '';
  const code = typeof e.responseCode === 'number' && e.responseCode >= 200 && e.responseCode < 600 ? e.responseCode : null;
  const message = oneLine(response || (err instanceof Error ? err.message : String(err)));
  if (code === null) {
    return { code: null, status: '4.4.1', message, permanent: false };
  }
  const enhanced = /^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/.exec(response)?.[1];
  const klass = Math.floor(code / 100);
  const status = enhanced && enhanced.startsWith(`${klass}.`) ? enhanced : `${klass}.0.0`;
  return { code, status, message, permanent: klass === 5 };
}

function failuresFor(rcpts: string[], err: unknown): RecipientFailure[] {
  const e = err as SmtpError;
  // "all recipients were rejected": every recipient has its own reply.
  if (Array.isArray(e?.rejectedErrors) && e.rejectedErrors.length > 0) {
    const byRcpt = new Map(e.rejectedErrors.map((r) => [r.recipient ?? '', r] as const));
    return rcpts.map((rcpt) => ({ rcpt, ...classifySmtpError(byRcpt.get(rcpt) ?? err) }));
  }
  const c = classifySmtpError(err);
  return rcpts.map((rcpt) => ({ rcpt, ...c }));
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
  /** FQDN for EHLO (RFC 5321 §4.1.1.1) — ServerSettings.publicHostname. */
  heloName:             string;
}

let _cachedConfig: OutboundConfig | null = null;
let _cacheExpiresAt = 0;

function fallbackHeloName(): string {
  return process.env['SMTP_HOSTNAME'] ?? process.env['MAIL_HOSTNAME'] ?? 'mail.localhost';
}

async function getOutboundConfig(): Promise<OutboundConfig> {
  const now = Date.now();
  if (_cachedConfig && now < _cacheExpiresAt) return _cachedConfig;

  try {
    const [s, server] = await Promise.all([
      prisma.smtpSettings.findUnique({ where: { id: 'singleton' } }),
      prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }),
    ]);
    _cachedConfig = {
      mode:                  (s?.outboundMode ?? 'mx') as 'mx' | 'smarthost',
      smarthostHost:         s?.smarthostHost         ?? '',
      smarthostPort:         s?.smarthostPort         ?? 587,
      smarthostTls:          s?.smarthostTls          ?? true,
      smarthostImplicitTls:  s?.smarthostImplicitTls  ?? false,
      smarthostUsername:     s?.smarthostUsername     ?? '',
      smarthostPassword:     s?.smarthostPassword     ?? '',
      heloName:              server?.publicHostname || fallbackHeloName(),
    };
  } catch (err) {
    log.warn({ err }, 'Outbound config not loadable — falling back to MX delivery');
    _cachedConfig = {
      mode: 'mx', smarthostHost: '', smarthostPort: 587,
      smarthostTls: true, smarthostImplicitTls: false,
      smarthostUsername: '', smarthostPassword: '',
      heloName: fallbackHeloName(),
    };
  }
  _cacheExpiresAt = now + CONFIG_CACHE_MS;
  return _cachedConfig;
}

/** Invalidates the config cache — called after PUT /admin/smtp-config/settings. */
export function invalidateOutboundConfigCache(): void {
  _cachedConfig = null;
  _cacheExpiresAt = 0;
}

// ── Transport options (pure) ──────────────────────────────────────────────────

/**
 * Smarthost transport. Whenever TLS is required (STARTTLS or implicit TLS) or
 * credentials are sent, the certificate is verified against the host name
 * (RFC 8314 §4.1, RFC 3207 §4.1) — otherwise an on-path attacker could harvest
 * the provider credentials. `SMARTHOST_TLS_INSECURE=true` is the explicit
 * opt-out for smarthosts with self-signed certificates.
 */
export function smarthostTransportOptions(
  cfg: OutboundConfig,
  dkimCfg?: NmDkim,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const auth = cfg.smarthostUsername ? { user: cfg.smarthostUsername, pass: cfg.smarthostPassword } : undefined;
  const tlsWanted = cfg.smarthostTls || cfg.smarthostImplicitTls || !!auth;
  const insecure = env['SMARTHOST_TLS_INSECURE'] === 'true';
  return {
    host:             cfg.smarthostHost,
    port:             cfg.smarthostPort,
    name:             cfg.heloName,
    secure:           cfg.smarthostImplicitTls,
    requireTLS:       cfg.smarthostTls && !cfg.smarthostImplicitTls,
    opportunisticTLS: cfg.smarthostTls && !cfg.smarthostImplicitTls,
    ...(auth ? { auth } : {}),
    tls: tlsWanted && !insecure
      ? { rejectUnauthorized: true, servername: cfg.smarthostHost, minVersion: 'TLSv1.2' }
      : { rejectUnauthorized: false },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout:   GREETING_TIMEOUT_MS,
    socketTimeout:     SOCKET_TIMEOUT_MS,
    ...(dkimCfg ? { dkim: dkimCfg } : {}),
  };
}

/** Direct MX transport: opportunistic STARTTLS without verification (RFC 7435). */
export function mxTransportOptions(host: string, heloName: string, dkimCfg?: NmDkim): Record<string, unknown> {
  return {
    host,
    port: 25,
    name: heloName,
    secure: false,
    requireTLS: false,
    opportunisticTLS: true,
    tls: { rejectUnauthorized: false },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout:   GREETING_TIMEOUT_MS,
    socketTimeout:     SOCKET_TIMEOUT_MS,
    ...(dkimCfg ? { dkim: dkimCfg } : {}),
  };
}

// ── Injectable I/O (tests) ────────────────────────────────────────────────────

export interface SendInfo { accepted?: unknown[]; rejected?: unknown[]; rejectedErrors?: SmtpError[] }

export interface RelayDeps {
  config(): Promise<OutboundConfig>;
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  send(transportOptions: Record<string, unknown>, envelope: { from: string; to: string[] }, raw: Buffer): Promise<SendInfo>;
}

const defaultRelayDeps: RelayDeps = {
  config: getOutboundConfig,
  resolveMx: (domain) => dns.resolveMx(domain),
  send: async (options, envelope, raw) => {
    const transporter = nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0]);
    return await transporter.sendMail({ envelope, raw }) as SendInfo;
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Delivers an outgoing message and reports the outcome per recipient.
 * Never throws for delivery failures: every recipient ends up in `delivered`
 * or in `failures` (permanent → bounce, transient → retry). A recipient that
 * the remote server rejects while others are accepted is never lost.
 *
 * @param rawBuffer  Complete RFC 5322 message (incl. From, Message-ID, Date).
 * @param from       SMTP envelope sender (MAIL FROM), '' = null sender
 * @param to         SMTP envelope recipients (RCPT TO) — external addresses only
 * @param dkim       Optional DKIM key data of the sender domain
 */
export async function relayMessage(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  dkim: DkimOptions,
  deps: RelayDeps = defaultRelayDeps,
): Promise<RelayResult> {
  const cfg     = await deps.config();
  const dkimCfg = buildDkim(dkim);

  if (dkimCfg) {
    log.debug({ domain: dkimCfg.domainName, selector: dkimCfg.keySelector }, 'DKIM signing active');
  } else {
    log.warn({ from }, 'No DKIM key configured — sending message unsigned');
  }

  if (cfg.mode === 'smarthost' && cfg.smarthostHost) {
    const result = await sendAndCollect(deps, smarthostTransportOptions(cfg, dkimCfg), from, to, rawBuffer);
    log.info({ smarthost: cfg.smarthostHost, port: cfg.smarthostPort, dkim: !!dkimCfg, delivered: result.delivered, failed: result.failures.length },
      'Delivered via smarthost');
    return result;
  }

  // Direct MX delivery — group recipients by domain
  const result: RelayResult = { delivered: [], failures: [] };
  for (const [domain, recipients] of groupByDomain(to)) {
    const r = await deliverToDomain(deps, rawBuffer, from, recipients, domain, cfg.heloName, dkimCfg);
    result.delivered.push(...r.delivered);
    result.failures.push(...r.failures);
  }
  return result;
}

/** One SMTP transaction; accepted/rejected recipients are taken from the reply. */
async function sendAndCollect(
  deps: RelayDeps,
  options: Record<string, unknown>,
  from: string,
  to: string[],
  raw: Buffer,
): Promise<RelayResult> {
  try {
    const info = await deps.send(options, { from, to }, raw);
    const rejected = new Set((info.rejected ?? []).map(String));
    const errors = new Map((info.rejectedErrors ?? []).map((e) => [e.recipient ?? '', e] as const));
    return {
      delivered: to.filter((r) => !rejected.has(r)),
      failures: to.filter((r) => rejected.has(r)).map((rcpt) => ({ rcpt, ...classifySmtpError(errors.get(rcpt) ?? new Error('Recipient rejected')) })),
    };
  } catch (err) {
    return { delivered: [], failures: failuresFor(to, err) };
  }
}

// ── Direct MX delivery ────────────────────────────────────────────────────────

type MxLookup =
  | { kind: 'hosts'; hosts: string[] }
  | { kind: 'fail'; failure: Omit<RecipientFailure, 'rcpt'> };

/**
 * RFC 5321 §5.1: MX records sorted by preference; without MX records the
 * domain itself is the implicit MX (A/AAAA). RFC 7505: a null MX ("." / "")
 * means the domain accepts no mail → permanent 5.1.10. NXDOMAIN → 5.1.2.
 * Any other DNS error (SERVFAIL, timeout) is temporary.
 */
export async function lookupMx(domain: string, resolve: RelayDeps['resolveMx']): Promise<MxLookup> {
  try {
    const records = await resolve(domain);
    if (records.length === 0) return { kind: 'hosts', hosts: [domain] };
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    if (sorted.length === 1 && (sorted[0]!.exchange === '' || sorted[0]!.exchange === '.')) {
      return { kind: 'fail', failure: { code: 556, status: '5.1.10', message: `${domain} does not accept mail (null MX)`, permanent: true } };
    }
    return { kind: 'hosts', hosts: sorted.map((r) => r.exchange).filter((h) => h !== '' && h !== '.') };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENODATA') return { kind: 'hosts', hosts: [domain] };
    if (code === 'ENOTFOUND') {
      return { kind: 'fail', failure: { code: null, status: '5.1.2', message: `Domain ${domain} does not exist`, permanent: true } };
    }
    return { kind: 'fail', failure: { code: null, status: '4.4.3', message: `DNS lookup for ${domain} failed (${code ?? 'error'})`, permanent: false } };
  }
}

async function deliverToDomain(
  deps: RelayDeps,
  rawBuffer: Buffer,
  from: string,
  recipients: string[],
  domain: string,
  heloName: string,
  dkimCfg: NmDkim | undefined,
): Promise<RelayResult> {
  const mx = await lookupMx(domain, deps.resolveMx);
  if (mx.kind === 'fail') {
    return { delivered: [], failures: recipients.map((rcpt) => ({ rcpt, ...mx.failure })) };
  }

  let last: RelayResult | null = null;
  for (const host of mx.hosts) {
    const result = await sendAndCollect(deps, mxTransportOptions(host, heloName, dkimCfg), from, recipients, rawBuffer);
    // A permanent reply or a (partial) acceptance is authoritative. When
    // nothing was accepted and every failure is temporary (connection error,
    // 421 greeting, 4yz), the next MX is tried (§5.1).
    const tryNext = result.delivered.length === 0 && result.failures.every((f) => !f.permanent);
    if (!tryNext) {
      log.info({ domain, mx: host, dkim: !!dkimCfg, delivered: result.delivered, failed: result.failures.length }, 'Delivered via MX');
      return result;
    }
    log.warn({ domain, mx: host, reason: result.failures[0]?.message }, 'MX delivery failed — trying next MX');
    last = result;
  }
  return last ?? { delivered: [], failures: recipients.map((rcpt) => ({ rcpt, code: null, status: '4.4.1', message: `Delivery failed for ${domain}`, permanent: false })) };
}

// ── Helper functions ──────────────────────────────────────────────────────────

function groupByDomain(addresses: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const addr of addresses) {
    const domain = addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();
    const existing = map.get(domain) ?? [];
    existing.push(addr);
    map.set(domain, existing);
  }
  return map;
}
