import nodemailer from 'nodemailer';
import { promises as dns } from 'dns';
import { isIP } from 'net';
import { createLogger, isBlockedAddress, normalizeIp } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { hasDsnRequest, rcptDsn, type EnvelopeDsn } from '../core/dsn-params.js';
import { envelopeNeedsSmtputf8, toAsciiDomainAddress } from '../core/idn.js';

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
  /**
   * Delivered recipients whose next hop advertised DSN and received the
   * NOTIFY/ORCPT/RET/ENVID parameters — it now owns their notifications
   * (RFC 3461 §5.2). Delivered recipients not listed here were "relayed".
   */
  dsnPassedOn?: string[];
}

/** Per-message envelope extras for one relay call. */
export interface RelayOptions {
  /** RFC 3461 DSN request of the transaction (passed on when the next hop supports DSN). */
  dsn?: EnvelopeDsn;
}

/** nodemailer `dsn` message option (applies to MAIL FROM and every RCPT TO of the transaction). */
export interface NmDsn { ret?: string; envid?: string; notify?: string; orcpt?: string }

/** RFC 6531 §3.2: the next hop must support SMTPUTF8 for a UTF-8 envelope. */
export const SMTPUTF8_UNSUPPORTED: Omit<RecipientFailure, 'rcpt'> = {
  code: null,
  status: '5.6.7',
  message: 'Next-hop server does not support SMTPUTF8; the address requires it (RFC 6531)',
  permanent: true,
};

/**
 * Pure: splits recipients into SMTP transactions with one NOTIFY/ORCPT each —
 * nodemailer applies its `dsn` option to every RCPT of a transaction, so
 * recipients with different requests (or an ORCPT of their own) need their
 * own transaction. Without a DSN request: one group, no `dsn`.
 */
export function dsnGroups(rcpts: string[], dsn?: EnvelopeDsn): Array<{ rcpts: string[]; dsn?: NmDsn }> {
  if (!hasDsnRequest(dsn)) return [{ rcpts }];
  const groups = new Map<string, { rcpts: string[]; dsn: NmDsn }>();
  for (const rcpt of rcpts) {
    const r = rcptDsn(dsn, rcpt);
    const notify = r?.notify ? (r.notify.length > 0 ? r.notify.join(',') : 'NEVER') : undefined;
    const orcpt = r?.orcpt ? `${r.orcpt.type};${r.orcpt.address}` : undefined;
    const key = `${notify ?? ''}\0${orcpt ?? ''}`;
    const group = groups.get(key) ?? {
      rcpts: [],
      dsn: {
        ...(dsn?.ret ? { ret: dsn.ret } : {}),
        ...(dsn?.envid !== undefined ? { envid: dsn.envid } : {}),
        ...(notify ? { notify } : {}),
        ...(orcpt ? { orcpt } : {}),
      },
    };
    group.rcpts.push(rcpt);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => (Object.keys(g.dsn).length > 0 ? g : { rcpts: g.rcpts }));
}

/** True when an EHLO keyword list advertises `keyword`. */
export function ehloHas(lines: string[] | undefined, keyword: string): boolean {
  return !!lines?.some((l) => l.trim().split(/\s+/)[0]?.toUpperCase() === keyword);
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
  const requireStartTls = (cfg.smarthostTls || !!auth) && !cfg.smarthostImplicitTls;
  return {
    host:             cfg.smarthostHost,
    port:             cfg.smarthostPort,
    name:             cfg.heloName,
    secure:           cfg.smarthostImplicitTls,
    // Credentials are never sent over a connection whose STARTTLS could be
    // stripped: with auth, STARTTLS is mandatory even when the TLS box is off.
    // opportunisticTLS would let nodemailer continue in plaintext after a failed
    // STARTTLS reply (an attacker's "454") — only where TLS is not required.
    requireTLS:       requireStartTls,
    opportunisticTLS: !requireStartTls && !cfg.smarthostImplicitTls,
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

/** Remedy shown when the smarthost certificate is rejected (since v8.0 verified by default). */
export const SMARTHOST_TLS_HINT =
  'smarthost TLS certificate verification failed: install a certificate valid for the smarthost host name, '
  + 'or set SMARTHOST_TLS_INSECURE=true for a smarthost with a self-signed certificate or an IP address';

const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE',
]);

/** True for TLS certificate verification failures (also wrapped by nodemailer as ESOCKET/ETLS). */
export function isCertificateError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && CERT_ERROR_CODES.has(e.code)) return true;
  if (typeof e.message === 'string'
    && /self[- ]signed certificate|unable to verify the first certificate|certificate has expired|does not match certificate's altnames|unable to get (local )?issuer certificate/i.test(e.message)) {
    return true;
  }
  return isCertificateError(e.cause, depth + 1);
}

let lastCertWarning = 0;

/**
 * Smarthost sends whose certificate is rejected fail with a message that names
 * the remedy (it ends up in the queue/mail-flow log), plus a throttled ERROR log
 * line — an upgrade from ≤ 7.0.0 (no verification) otherwise only shows mail
 * piling up in the queue.
 */
function withCertificateHint(deps: RelayDeps, host: string): RelayDeps {
  return {
    ...deps,
    send: async (options, envelope, raw) => {
      try {
        return await deps.send(options, envelope, raw);
      } catch (err) {
        if (!isCertificateError(err)) throw err;
        const now = Date.now();
        if (now - lastCertWarning > 10 * 60_000) {
          lastCertWarning = now;
          log.error({ err, smarthost: host }, SMARTHOST_TLS_HINT);
        }
        const message = `${err instanceof Error ? err.message : String(err)} (${SMARTHOST_TLS_HINT})`;
        throw Object.assign(new Error(message), { code: (err as { code?: unknown }).code });
      }
    },
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

/** `ehlo`: the next hop's EHLO keywords (nodemailer reports them on success). */
export interface SendInfo { accepted?: unknown[]; rejected?: unknown[]; rejectedErrors?: SmtpError[]; ehlo?: string[] }

export interface RelayDeps {
  config(): Promise<OutboundConfig>;
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  send(transportOptions: Record<string, unknown>, envelope: { from: string; to: string[] }, raw: Buffer, dsn?: NmDsn): Promise<SendInfo>;
  /** A/AAAA of an MX host (SSRF check before connecting); absent = no check. */
  resolveHost?: (host: string) => Promise<string[]>;
  /**
   * EHLO keywords of a next hop (connect + EHLO + QUIT), used only before
   * sending a UTF-8 envelope; null when unknown. Absent = no check.
   */
  probe?: (transportOptions: Record<string, unknown>) => Promise<string[] | null>;
}

/** Connects, reads the EHLO keywords (after STARTTLS when offered) and quits. */
async function probeEhlo(options: Record<string, unknown>): Promise<string[] | null> {
  const { default: SMTPConnection } = await import('nodemailer/lib/smtp-connection/index.js');
  const { dkim: _dkim, ...connOptions } = options;
  const conn = new SMTPConnection(connOptions as ConstructorParameters<typeof SMTPConnection>[0]);
  return new Promise<string[] | null>((resolve) => {
    let done = false;
    const finish = (lines: string[] | null): void => {
      if (done) return;
      done = true;
      try { if (lines) conn.quit(); else conn.close(); } catch { /* already closed */ }
      resolve(lines);
    };
    conn.once('error', () => finish(null));
    conn.connect((err?: unknown) => {
      if (err) { finish(null); return; }
      const lines = (conn as unknown as { _ehloLines?: unknown })._ehloLines;
      finish(Array.isArray(lines) ? lines.map(String) : null);
    });
  });
}

const defaultRelayDeps: RelayDeps = {
  config: getOutboundConfig,
  resolveMx: (domain) => dns.resolveMx(domain),
  resolveHost: async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  probe: probeEhlo,
  send: async (options, envelope, raw, dsn) => {
    const transporter = nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0]);
    // `dsn`: nodemailer adds RET/ENVID/NOTIFY/ORCPT only when the next hop advertises DSN.
    return await transporter.sendMail({ envelope, raw, ...(dsn ? { dsn } : {}) }) as SendInfo;
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
 * @param opts       DSN request to pass on (RFC 3461)
 *
 * v8.1: IDN domains go out as A-labels (MX lookup + envelope); an envelope
 * that still needs SMTPUTF8 (UTF-8 local-part) is only sent to a next hop
 * that advertises SMTPUTF8 — otherwise the recipients fail with 5.6.7
 * (RFC 6531 §3.2). With a DSN request the parameters are passed on when the
 * next hop advertises DSN (`dsnPassedOn`).
 */
export async function relayMessage(
  rawBuffer: Buffer,
  from: string,
  to: string[],
  dkim: DkimOptions,
  deps: RelayDeps = defaultRelayDeps,
  opts: RelayOptions = {},
): Promise<RelayResult> {
  const cfg     = await deps.config();
  const dkimCfg = buildDkim(dkim);

  if (dkimCfg) {
    log.debug({ domain: dkimCfg.domainName, selector: dkimCfg.keySelector }, 'DKIM signing active');
  } else {
    log.warn({ from }, 'No DKIM key configured — sending message unsigned');
  }

  // Wire form: A-label domains; results are reported with the original spelling.
  const original = new Map<string, string>();
  const wireFrom = toAsciiDomainAddress(from);
  const wire = (rcpt: string): string => {
    const w = toAsciiDomainAddress(rcpt);
    if (!original.has(w)) original.set(w, rcpt);
    return w;
  };
  const back = (r: RelayResult): RelayResult => ({
    delivered: r.delivered.map((w) => original.get(w) ?? w),
    failures: r.failures.map((f) => ({ ...f, rcpt: original.get(f.rcpt) ?? f.rcpt })),
    ...(r.dsnPassedOn ? { dsnPassedOn: r.dsnPassedOn.map((w) => original.get(w) ?? w) } : {}),
  });

  const result: RelayResult = { delivered: [], failures: [] };
  const add = (r: RelayResult): void => {
    result.delivered.push(...r.delivered);
    result.failures.push(...r.failures);
    if (r.dsnPassedOn?.length) (result.dsnPassedOn ??= []).push(...r.dsnPassedOn);
  };

  for (const group of dsnGroups(to, opts.dsn)) {
    const rcpts = group.rcpts.map(wire);
    const extra: SendExtra = {
      ...(group.dsn ? { dsn: group.dsn } : {}),
      needsUtf8: envelopeNeedsSmtputf8(wireFrom, rcpts),
    };
    if (cfg.mode === 'smarthost' && cfg.smarthostHost) {
      const r = await sendAndCollect(withCertificateHint(deps, cfg.smarthostHost), smarthostTransportOptions(cfg, dkimCfg), wireFrom, rcpts, rawBuffer, extra);
      log.info({ smarthost: cfg.smarthostHost, port: cfg.smarthostPort, dkim: !!dkimCfg, delivered: r.delivered, failed: r.failures.length },
        'Delivered via smarthost');
      add(back(r));
      continue;
    }
    // Direct MX delivery — group recipients by domain
    for (const [domain, recipients] of groupByDomain(rcpts)) {
      add(back(await deliverToDomain(deps, rawBuffer, wireFrom, recipients, domain, cfg.heloName, dkimCfg, extra)));
    }
  }
  return result;
}

interface SendExtra {
  dsn?: NmDsn;
  /** The envelope has a UTF-8 local-part: the next hop must advertise SMTPUTF8. */
  needsUtf8?: boolean;
}

/** One SMTP transaction; accepted/rejected recipients are taken from the reply. */
async function sendAndCollect(
  deps: RelayDeps,
  options: Record<string, unknown>,
  from: string,
  to: string[],
  raw: Buffer,
  extra: SendExtra = {},
): Promise<RelayResult> {
  if (extra.needsUtf8 && deps.probe) {
    const ehlo = await deps.probe(options).catch(() => null);
    if (ehlo && !ehloHas(ehlo, 'SMTPUTF8')) {
      log.warn({ host: options['host'], to }, 'Next hop does not support SMTPUTF8 — UTF-8 envelope not sent');
      return { delivered: [], failures: to.map((rcpt) => ({ rcpt, ...SMTPUTF8_UNSUPPORTED })) };
    }
  }
  try {
    const info = await deps.send(options, { from, to }, raw, extra.dsn);
    const rejected = new Set((info.rejected ?? []).map(String));
    const errors = new Map((info.rejectedErrors ?? []).map((e) => [e.recipient ?? '', e] as const));
    const delivered = to.filter((r) => !rejected.has(r));
    return {
      delivered,
      failures: to.filter((r) => rejected.has(r)).map((rcpt) => ({ rcpt, ...classifySmtpError(errors.get(rcpt) ?? new Error('Recipient rejected')) })),
      ...(extra.dsn && ehloHas(info.ehlo, 'DSN') ? { dsnPassedOn: delivered } : {}),
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

type MxTarget =
  | { kind: 'ok'; address: string | null }
  | { kind: 'fail'; failure: Omit<RecipientFailure, 'rcpt'> };

/**
 * Resolves an MX (or implicit MX) host and refuses loopback / private /
 * link-local / reserved targets (RFC 3463 5.4.4 — unroutable): a remote domain
 * must not make us connect to an internal port 25. The connection then goes
 * to the checked address (no second DNS answer — no rebinding). Without a
 * resolver (unit tests) or with `OUTBOUND_ALLOW_PRIVATE_MX=true` (lab setups
 * with internal MX hosts) the host name is used as before. The admin-set
 * smarthost is not subject to this check.
 */
export async function resolveMxTarget(
  host: string,
  resolveHost: RelayDeps['resolveHost'],
  env: Record<string, string | undefined> = process.env,
): Promise<MxTarget> {
  if (!resolveHost || (env['OUTBOUND_ALLOW_PRIVATE_MX'] ?? '').toLowerCase() === 'true') return { kind: 'ok', address: null };
  let addrs: string[];
  if (isIP(normalizeIp(host)) !== 0) {
    addrs = [normalizeIp(host)];
  } else {
    try {
      addrs = await resolveHost(host);
    } catch (err) {
      const code = (err as { code?: string }).code;
      return { kind: 'fail', failure: { code: null, status: '4.4.3', message: `DNS lookup for MX ${host} failed (${code ?? 'error'})`, permanent: false } };
    }
  }
  if (addrs.length === 0) {
    return { kind: 'fail', failure: { code: null, status: '4.4.3', message: `MX ${host} has no address`, permanent: false } };
  }
  if (addrs.some((a) => isBlockedAddress(a))) {
    return { kind: 'fail', failure: { code: null, status: '5.4.4', message: `MX ${host} resolves to a non-public address`, permanent: true } };
  }
  return { kind: 'ok', address: addrs[0]! };
}

async function deliverToDomain(
  deps: RelayDeps,
  rawBuffer: Buffer,
  from: string,
  recipients: string[],
  domain: string,
  heloName: string,
  dkimCfg: NmDkim | undefined,
  extra: SendExtra = {},
): Promise<RelayResult> {
  const mx = await lookupMx(domain, deps.resolveMx);
  if (mx.kind === 'fail') {
    return { delivered: [], failures: recipients.map((rcpt) => ({ rcpt, ...mx.failure })) };
  }

  let last: RelayResult | null = null;
  for (const host of mx.hosts) {
    // SSRF guard: never connect to an internal address chosen by remote DNS.
    const target = await resolveMxTarget(host, deps.resolveHost);
    if (target.kind === 'fail') {
      log.warn({ domain, mx: host, reason: target.failure.message }, 'MX host refused');
      last = { delivered: [], failures: recipients.map((rcpt) => ({ rcpt, ...target.failure })) };
      continue;
    }
    const options = mxTransportOptions(target.address ?? host, heloName, dkimCfg);
    if (target.address) options['tls'] = { ...(options['tls'] as object), servername: host };
    const result = await sendAndCollect(deps, options, from, recipients, rawBuffer, extra);
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
