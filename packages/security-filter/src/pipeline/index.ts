import { BlockList, isIP } from 'node:net';
import { createLogger } from '@coremail/core';
import { parseRawMessage } from '@coremail/storage';
import { checkDnsbl } from '../dnsbl/index.js';
import { checkGreylist } from '../greylisting/index.js';
import { checkCountry, type CountryConfig } from '../geoip/index.js';
import { prisma } from '@coremail/storage';
import {
  authenticateMail, dmarcDisposition, applyDmarcPct, isDomainAuthenticated, addressDomain, type AuthResult,
} from '../spf-dkim/index.js';
import { scanBuffer as clamavScan, classifySignature, type ClamavResult, type ScanOptions } from '../clamav/index.js';
import { scanMessage as rspamdScan } from '../rspamd/index.js';
import { checkBlacklist } from '../blacklist/index.js';
import { checkAttachments } from '../attachment/index.js';

const log = createLogger('security-filter:pipeline');

export type PipelineAction = 'accept' | 'defer' | 'reject' | 'quarantine';

/**
 * Effective filter configuration. Built from the BCP settings by
 * settings.ts `buildPipelineConfig()`; defaults equal the schema defaults.
 */
export interface PipelineConfig {
  /** @deprecated DNSBL zones are now loaded from the DB (DnsblZone table) */
  dnsblZones?: string[];
  /** SmtpSettings.greylistingEnabled (default: true) */
  greylistingEnabled?: boolean;
  /** SecuritySettings.dnsblEnabled (default: true) */
  dnsblEnabled?: boolean;
  /** SecuritySettings.geoipMode/geoipCountries — null = no country filter */
  countryFilter?: CountryConfig | null;
  /** score threshold → junk folder (SecuritySettings.rspamdSpamScore, default 6.0) */
  spamScoreJunk?: number;
  /** score threshold → reject (SecuritySettings.rspamdRejectScore, default 15.0) */
  spamScoreReject?: number;
  /** SecuritySettings.attachmentEnabled (default: true) */
  attachmentEnabled?: boolean;
  /** SecuritySettings.attachmentMaxSizeMb in bytes (default 50 MB) */
  maxAttachmentBytes?: number;
  /** SecuritySettings.attachmentBlockedExt — extensions without dot */
  blockedExtensions?: readonly string[];
  hostname?: string;
  /** Whether rspamd anti-spam scanning is enabled (default: true) */
  rspamdEnabled?: boolean;
  /** Whether ClamAV antivirus scanning is enabled (default: true) */
  clamavEnabled?: boolean;
  /** SecuritySettings.clamavAction — infected message: quarantine | reject | pass (default quarantine) */
  clamavAction?: 'quarantine' | 'reject' | 'pass';
  /** SecuritySettings.clamavBlockOnFailure — scan error → defer (4xx) instead of accept (default false) */
  clamavBlockOnFailure?: boolean;
  /** SecuritySettings.clamavTimeoutSec in ms (default 20 000) */
  clamavTimeoutMs?: number;
  /** SecuritySettings.clamavScanLimitMb in bytes — larger messages are not sent to clamd (default 50 MB) */
  clamavScanLimitBytes?: number;
  /** SecuritySettings.clamavOversizeAction — not scanned because of size: accept (tagged) | reject (default accept) */
  clamavOversizeAction?: 'accept' | 'reject';
  /** Treat Heuristics.* results as a virus (default true); false → deliver, tagged "suspicious" */
  clamavHeuristicsAsVirus?: boolean;
  /** Treat PUA.* results as a virus (default true) */
  clamavPuaAsVirus?: boolean;
  /** Treat Heuristics.Encrypted.* results as a virus (default true) */
  clamavEncryptedAsVirus?: boolean;
}

/**
 * Virus-scan note for a message that is delivered or quarantined without a
 * clean scan. smtp-server writes it as the `X-CoreMail-Virus-Scan` header.
 */
export interface VirusScanNote {
  status: 'infected' | 'suspicious' | 'unscanned';
  signature?: string;
  reason?: 'too-large' | 'scanner-error';
}

export interface PipelineResult {
  action: PipelineAction;
  reason: string;
  spamScore?: number;
  virusName?: string;
  authSummary?: string;
  junkFolder?: boolean;
  /**
   * `Received-SPF` + `Authentication-Results` lines (RFC 8601) the SMTP server
   * prepends to the delivered message.
   */
  authHeaders?: string;
  /** Domains the message is authenticated for (DMARC/SPF/DKIM pass) — used by iTIP. */
  verifiedDomains?: string[];
  /** Set when the message was not scanned clean (see VirusScanNote). */
  virusScan?: VirusScanNote;
}

export interface ConnectionContext {
  senderIp: string;
  mailFrom: string;
  rcptTo: string;
  domainId?: string;
  userId?: string;
  /** EHLO/HELO name of the SMTP session (content stage). */
  helo?: string;
  /** Our host name — authserv-id of the Authentication-Results header. */
  hostname?: string;
  /**
   * Envelope recipients (content stage; rcptTo is the first). smtp-server
   * sends at most the first 100 (X-Filter-Context header size), see rcptCount.
   */
  rcpts?: string[];
  /** Total number of envelope recipients when `rcpts` was capped. */
  rcptCount?: number;
  /** SMTP AUTH user of the session, when authenticated. */
  authUser?: string;
}

/** Injectable stage implementations (tests replace them; production uses the real modules). */
export interface PipelineDeps {
  dnsbl: typeof checkDnsbl;
  country: typeof checkCountry;
  greylist: typeof checkGreylist;
  authenticate: typeof authenticateMail;
  blacklist: typeof checkBlacklist;
  parse: typeof parseRawMessage;
  clamav: (raw: Buffer, opts?: ScanOptions) => Promise<ClamavResult>;
  rspamd: typeof rspamdScan;
  /** Is the domain one of ours (active Domain row)? */
  isLocalDomain: (domain: string) => Promise<boolean>;
  /** Local anti-spoofing options (default: from the environment). */
  spoofOptions?: SpoofPolicyOptions;
}

const defaultDeps: PipelineDeps = {
  dnsbl: checkDnsbl,
  country: checkCountry,
  greylist: checkGreylist,
  authenticate: authenticateMail,
  blacklist: checkBlacklist,
  parse: parseRawMessage,
  clamav: clamavScan,
  rspamd: rspamdScan,
  isLocalDomain: async (domain) =>
    !!(await prisma.domain.findFirst({ where: { name: domain.toLowerCase(), active: true }, select: { id: true } })),
};

/**
 * Pure: pipeline decision for a ClamAV result.
 * Returns null when the pipeline should continue with the next stage.
 *  - infected + quarantine → quarantine, + reject → reject, + pass → continue (logged)
 *  - scan error            → defer (451) when clamavBlockOnFailure, else continue
 */
export function decideClamav(result: ClamavResult, config: PipelineConfig): PipelineResult | null {
  return evaluateClamav(result, config).decision;
}

/** Is a FOUND result with this signature treated as a virus under the config? */
export function clamavCountsAsVirus(signature: string | undefined, config: PipelineConfig): boolean {
  switch (classifySignature(signature)) {
    case 'encrypted': return config.clamavEncryptedAsVirus !== false;
    case 'pua':       return config.clamavPuaAsVirus !== false;
    case 'heuristic': return config.clamavHeuristicsAsVirus !== false;
    default:          return true;
  }
}

/**
 * Pure: full ClamAV policy. `decision` stops the pipeline (null = continue);
 * `note` travels with a message that continues or is quarantined without a
 * clean scan (X-CoreMail-Virus-Scan header).
 *  - infected, counted as virus → clamavAction (quarantine | reject | pass = deliver, tagged)
 *  - infected, category not counted (Heuristics/PUA/Encrypted switched off) → deliver, tagged "suspicious"
 *  - oversize → clamavOversizeAction (reject = 552-class reject | accept = deliver, tagged)
 *  - error    → defer (451) when clamavBlockOnFailure, else deliver, tagged
 */
export function evaluateClamav(
  result: ClamavResult,
  config: PipelineConfig,
): { decision: PipelineResult | null; note?: VirusScanNote } {
  const sig = result.virusName ? { signature: result.virusName } : {};
  if (result.status === 'infected') {
    if (!clamavCountsAsVirus(result.virusName, config)) {
      return { decision: null, note: { status: 'suspicious', ...sig } };
    }
    const virus = result.virusName ?? 'unknown';
    const action = config.clamavAction ?? 'quarantine';
    const note: VirusScanNote = { status: 'infected', ...sig };
    if (action === 'pass') return { decision: null, note };
    return {
      decision: {
        action: action === 'reject' ? 'reject' : 'quarantine',
        reason: `Virus detected: ${virus}`,
        ...(result.virusName ? { virusName: result.virusName } : {}),
        ...(action === 'quarantine' ? { virusScan: note } : {}),
      },
      note,
    };
  }
  if (result.status === 'oversize') {
    const note: VirusScanNote = { status: 'unscanned', reason: 'too-large' };
    return config.clamavOversizeAction === 'reject'
      ? { decision: { action: 'reject', reason: 'Message too large for virus scanning' }, note }
      : { decision: null, note };
  }
  if (result.status === 'error') {
    const note: VirusScanNote = { status: 'unscanned', reason: 'scanner-error' };
    return config.clamavBlockOnFailure
      ? { decision: { action: 'defer', reason: 'Virus scanner unavailable — please retry later' }, note }
      : { decision: null, note };
  }
  return { decision: null };
}

/**
 * Runs the ClamAV stage with the configured size limit and timeout. A message
 * above clamavScanLimitBytes is never sent to clamd (result `oversize`).
 */
export async function scanWithPolicy(
  rawMessage: Buffer,
  config: PipelineConfig,
  clamav: PipelineDeps['clamav'],
): Promise<ClamavResult> {
  const limit = config.clamavScanLimitBytes;
  if (limit !== undefined && limit > 0 && rawMessage.length > limit) {
    return { status: 'oversize', clean: false, error: `message ${rawMessage.length} bytes > scan limit ${limit}` };
  }
  return clamav(rawMessage, config.clamavTimeoutMs !== undefined ? { timeoutMs: config.clamavTimeoutMs } : {});
}

// Connection-level checks are split by SMTP stage (`connect` → IP checks,
// `rcpt` → greylisting); the dispatch lives in ../connection-request.ts.

/**
 * Stage 1a: greylisting — needs the full (IP, MAIL FROM, RCPT TO) triple, so
 * it can only run at RCPT TO time. `mailFrom` may be '' (null sender `<>`).
 */
export async function runGreylistCheck(
  ctx: ConnectionContext,
  config: PipelineConfig = {},
  deps: Pick<PipelineDeps, 'greylist'> = defaultDeps,
): Promise<PipelineResult> {
  if (config.greylistingEnabled !== false) {
    const grey = await deps.greylist(ctx.senderIp, ctx.mailFrom, ctx.rcptTo);
    if (grey.action === 'defer') {
      return { action: 'defer', reason: grey.reason ?? 'Greylisted' };
    }
  }
  return { action: 'accept', reason: 'Greylisting passed' };
}

/**
 * Stages 1b/1c: checks that only need the client IP (DNSBL/DNSWL, GeoIP
 * country filter) — these run at connect time.
 */
export async function runIpChecks(
  senderIp: string,
  config: PipelineConfig = {},
  deps: Pick<PipelineDeps, 'dnsbl' | 'country'> = defaultDeps,
): Promise<PipelineResult> {
  // ── Stage 1b: DNSBL ──────────────────────────────────────────────────────
  if (config.dnsblEnabled !== false) {
    const dnsbl = await deps.dnsbl(senderIp);
    if (dnsbl.whitelisted) {
      // DNSWL hit → skip the following stage-1 filters
      log.info({ senderIp, hits: dnsbl.hits.map((h) => h.zone.host) }, 'DNSWL hit — bypassing remaining checks');
      return { action: 'accept', reason: 'DNSWL whitelisted' };
    }
    if (dnsbl.action === 'REJECT') {
      return {
        action: 'reject',
        reason: `Sender IP listed in DNSBL: ${dnsbl.hits.map((h) => h.zone.host).join(', ')}`,
      };
    }
    // TAG and SCORE_ONLY hits feed into the rspamd score further below
  }

  // ── Stage 1c: Country filtering ──────────────────────────────────────────
  if (config.countryFilter) {
    const geo = await deps.country(senderIp, config.countryFilter);
    if (!geo.allowed) {
      return { action: 'reject', reason: geo.reason ?? 'Country blocked' };
    }
  }

  return { action: 'accept', reason: 'Connection checks passed' };
}

// ── Local-domain anti-spoofing configuration ─────────────────────────────────

export type LocalSpoofAction = 'policy' | 'junk' | 'reject';

export interface SpoofPolicyOptions {
  /**
   * LOCAL_SPOOF_ACTION: what happens to unauthenticated mail claiming one of
   * our domains. `policy` (default) follows the local domain's own published
   * policy (DMARC for the header From, SPF -all for MAIL FROM); `junk` always
   * delivers to Junk; `reject` always answers 550 (pre-8.1 behaviour).
   */
  action: LocalSpoofAction;
  /** LOCAL_SPOOF_ALLOW (IP/CIDR entries): trusted third-party sending hosts. */
  allowIp: (ip: string) => boolean;
  /** LOCAL_SPOOF_ALLOW (domain entries): trusted senders, matched against the authenticated (SPF/DKIM pass) domains. */
  allowDomains: readonly string[];
  /** ARC_TRUSTED_SEALERS: ARC sealers whose passing chain overrides the local check and DMARC rejection. */
  arcTrustedSealers: readonly string[];
  /** Random source of the DMARC pct sampling (tests). */
  rng?: () => number;
}

const splitList = (v: string | undefined): string[] =>
  (v ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);

/** Pure: parses LOCAL_SPOOF_ACTION / LOCAL_SPOOF_ALLOW / ARC_TRUSTED_SEALERS. */
export function loadSpoofPolicyOptions(env: Record<string, string | undefined> = process.env): SpoofPolicyOptions & { invalid: string[] } {
  const rawAction = (env['LOCAL_SPOOF_ACTION'] ?? '').trim().toLowerCase();
  const action: LocalSpoofAction = rawAction === 'junk' || rawAction === 'reject' ? rawAction : 'policy';
  const invalid: string[] = rawAction && rawAction !== action ? [`LOCAL_SPOOF_ACTION=${rawAction}`] : [];
  const blocks = new BlockList();
  let ipEntries = 0;
  const allowDomains: string[] = [];
  for (const entry of splitList(env['LOCAL_SPOOF_ALLOW'])) {
    const slash = entry.indexOf('/');
    const addr = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(addr);
    if (family !== 0) {
      const max = family === 4 ? 32 : 128;
      const prefixText = slash === -1 ? String(max) : entry.slice(slash + 1);
      const prefix = Number(prefixText);
      if (!/^\d{1,3}$/.test(prefixText) || prefix > max) { invalid.push(entry); continue; }
      blocks.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
      ipEntries++;
    } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry)) {
      allowDomains.push(entry);
    } else {
      invalid.push(entry);
    }
  }
  const allowIp = (rawIp: string): boolean => {
    if (ipEntries === 0) return false;
    const ip = rawIp.startsWith('::ffff:') && isIP(rawIp.slice(7)) === 4 ? rawIp.slice(7) : rawIp;
    const family = isIP(ip);
    return family !== 0 && blocks.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
  return { action, allowIp, allowDomains, arcTrustedSealers: splitList(env['ARC_TRUSTED_SEALERS']), invalid };
}

let defaultSpoofOptions: SpoofPolicyOptions | null = null;
function spoofOptionsFromEnv(): SpoofPolicyOptions {
  if (!defaultSpoofOptions) {
    const loaded = loadSpoofPolicyOptions();
    if (loaded.invalid.length) log.warn({ invalid: loaded.invalid }, 'ignoring invalid LOCAL_SPOOF_* entries');
    defaultSpoofOptions = loaded;
  }
  return defaultSpoofOptions;
}

const domainCovered = (domain: string, list: readonly string[]): boolean =>
  list.some((e) => domain === e || domain.endsWith(`.${e}`));

/** Pure: does a passing ARC chain from a trusted sealer vouch for this message? */
export function arcOverride(auth: AuthResult, trustedSealers: readonly string[]): boolean {
  if (auth.arc !== 'pass' || !auth.arcSealer || trustedSealers.length === 0) return false;
  // the sealer itself recorded a DMARC failure → nothing to vouch for
  if (auth.arcDmarc === 'fail') return false;
  return domainCovered(auth.arcSealer, trustedSealers);
}

/** Decision of decideAuthentication when the message is delivered to Junk. */
export interface JunkDecision {
  junk: true;
  /** Why: the sender's DMARC quarantine policy, or a local-domain spoofing suspicion. */
  cause: 'dmarc' | 'local-spoof';
  /** Local domain claimed without authentication (Authentication-Results tag). */
  spoofDomain?: string;
}

/**
 * Pure: SPF/DKIM/DMARC decision for an unauthenticated (port 25) message.
 *  - The From header must carry exactly one mailbox in exactly one field —
 *    DMARC cannot evaluate anything else (550 5.7.1 multiple or missing From).
 *  - Anti-spoofing: a local domain in MAIL FROM or in the header From must be
 *    authenticated (DMARC pass, or SPF/DKIM pass aligned with that domain).
 *    Otherwise LOCAL_SPOOF_ACTION decides (default `policy`: the local domain's
 *    own DMARC policy p=reject → 550, p=quarantine/none/no record → Junk with
 *    an Authentication-Results tag; MAIL FROM with SPF fail → 550). Hosts and
 *    authenticated domains in LOCAL_SPOOF_ALLOW and a passing ARC chain of an
 *    ARC_TRUSTED_SEALERS sealer are exempt.
 *  - DMARC fail → the policy the From domain publishes (with `pct` sampling):
 *    reject → 550 5.7.1, quarantine → Junk, none → only tagged. A trusted ARC
 *    chain overrides it.
 * Returns null to continue; a JunkDecision to deliver to Junk.
 */
export async function decideAuthentication(
  auth: AuthResult,
  ctx: ConnectionContext,
  isLocalDomain: (domain: string) => Promise<boolean>,
  opts: SpoofPolicyOptions = spoofOptionsFromEnv(),
): Promise<PipelineResult | JunkDecision | null> {
  if (ctx.authUser) return null; // authenticated SMTP session — identity checked by SMTP AUTH

  // RFC 5322 §3.6: exactly one From field; several mailboxes would need a
  // Sender field — refused for unauthenticated mail (DMARC-bypass vector).
  if ((auth.fromHeaderFields !== undefined && auth.fromHeaderFields !== 1)
    || (auth.fromMailboxes !== undefined && auth.fromMailboxes !== 1)) {
    return { action: 'reject', reason: 'multiple or missing From', authSummary: auth.summary };
  }

  const verified = auth.verifiedDomains ?? [];
  const arcTrusted = arcOverride(auth, opts.arcTrustedSealers);
  const allowlisted = opts.allowIp(ctx.senderIp)
    || verified.some((d) => domainCovered(d.toLowerCase(), opts.allowDomains));
  const rng = opts.rng ?? Math.random;

  const claims: Array<{ domain: string; kind: 'header' | 'envelope' }> = [];
  if (auth.headerFromDomain) claims.push({ domain: auth.headerFromDomain, kind: 'header' });
  const envDomain = ctx.mailFrom ? addressDomain(ctx.mailFrom) : null;
  if (envDomain && envDomain !== auth.headerFromDomain) claims.push({ domain: envDomain, kind: 'envelope' });

  let spoofDomain: string | null = null;
  let headerFromLocal = false;
  for (const claim of claims) {
    if (!(await isLocalDomain(claim.domain))) continue;
    if (claim.kind === 'header') headerFromLocal = true;
    if (isDomainAuthenticated(claim.domain, verified)) continue;
    if (arcTrusted || allowlisted) {
      log.info({ domain: claim.domain, senderIp: ctx.senderIp, arcTrusted, allowlisted }, 'Local domain claim accepted (ARC/allowlist override)');
      continue;
    }
    let verdict: 'reject' | 'junk';
    if (opts.action === 'reject') verdict = 'reject';
    else if (opts.action === 'junk') verdict = 'junk';
    else if (claim.kind === 'header') {
      // the local domain's own DMARC policy (mailauth looked up the header-From domain)
      verdict = applyDmarcPct(auth.dmarcPolicy ?? 'none', auth.dmarcPct, rng) === 'reject' ? 'reject' : 'junk';
    } else {
      // MAIL FROM only: our own SPF policy — a hard fail (-all) is a reject
      verdict = auth.spf === 'fail' ? 'reject' : 'junk';
    }
    if (verdict === 'reject') {
      return {
        action: 'reject',
        reason: `Unauthenticated mail claiming local domain ${claim.domain}`,
        authSummary: auth.summary,
      };
    }
    spoofDomain ??= claim.domain;
  }

  // The local-domain decision above already applied our own policy (or an
  // override) to a local header From — not a second time via DMARC.
  const disposition = arcTrusted || headerFromLocal ? 'none' : dmarcDisposition(auth, rng);
  if (disposition === 'reject') {
    return {
      action: 'reject',
      reason: `DMARC policy of ${auth.headerFromDomain ?? 'the sender domain'} rejects this message`,
      authSummary: auth.summary,
    };
  }
  if (spoofDomain) return { junk: true, cause: 'local-spoof', spoofDomain };
  if (disposition === 'quarantine') return { junk: true, cause: 'dmarc' };
  return null;
}

/** Pure: Authentication-Results tag (RFC 8601 extension method) for a local-domain spoofing suspicion. */
export function localSpoofAuthHeader(hostname: string, domain: string): string {
  return `Authentication-Results: ${hostname}; x-local-spoof=fail reason="unauthenticated use of a local domain" header.from=${domain}\r\n`;
}

export async function runContentChecks(
  rawMessage: Buffer,
  ctx: ConnectionContext,
  config: PipelineConfig = {},
  deps: PipelineDeps = defaultDeps,
): Promise<PipelineResult> {
  const hostname = ctx.hostname || config.hostname || process.env['SMTP_HOSTNAME'] || 'mail.localhost';

  // ── Stage 2: SPF / DKIM / DMARC — on the real SMTP session data ─────────
  const auth = await deps.authenticate(rawMessage, {
    ip: ctx.senderIp,
    helo: ctx.helo ?? '',
    mailFrom: ctx.mailFrom,
    mta: hostname,
  });
  const authDecision = await decideAuthentication(auth, ctx, deps.isLocalDomain, deps.spoofOptions);
  if (authDecision && 'action' in authDecision) return authDecision;
  const junk = authDecision !== null && 'junk' in authDecision ? authDecision : null;

  const result = await runContentStages(rawMessage, ctx, config, deps, auth, hostname);
  if (result.action !== 'accept') return result;
  const authHeaders = (auth.authHeaders ?? '')
    + (junk?.spoofDomain ? localSpoofAuthHeader(hostname, junk.spoofDomain) : '');
  return {
    ...result,
    ...(junk ? {
      junkFolder: true,
      reason: `${result.reason} (${junk.cause === 'dmarc' ? 'DMARC policy quarantine' : `unauthenticated local domain ${junk.spoofDomain ?? ''}`})`,
    } : {}),
    ...(authHeaders ? { authHeaders } : {}),
    verifiedDomains: auth.verifiedDomains ?? [],
  };
}

async function runContentStages(
  rawMessage: Buffer,
  ctx: ConnectionContext,
  config: PipelineConfig,
  deps: PipelineDeps,
  auth: AuthResult,
  hostname: string,
): Promise<PipelineResult> {
  // ── Stage 3: Address blacklist ───────────────────────────────────────────
  const blacklist = await deps.blacklist(ctx.mailFrom, ctx.domainId, ctx.userId);
  if (blacklist.blocked) {
    return { action: 'reject', reason: blacklist.reason ?? 'Sender blocked' };
  }

  // ── Stage 4a+b: Attachment filter (SecuritySettings.attachment*) ─────────
  if (config.attachmentEnabled !== false) {
    let parsed;
    try {
      parsed = await deps.parse(rawMessage);
    } catch (err) {
      log.error({ err }, 'MIME parsing failed');
      return { action: 'reject', reason: 'Invalid message format' };
    }
    const attCheck = checkAttachments(parsed.attachments, {
      ...(config.maxAttachmentBytes !== undefined ? { maxSizeBytes: config.maxAttachmentBytes } : {}),
      ...(config.blockedExtensions !== undefined ? { blockedExtensions: config.blockedExtensions } : {}),
    });
    if (attCheck.blocked) {
      return { action: 'reject', reason: attCheck.reason ?? 'Attachment not allowed' };
    }
  } else {
    log.debug('Attachment filter skipped (disabled in settings)');
  }

  // ── Stage 4c: ClamAV antivirus ───────────────────────────────────────────
  let virusNote: VirusScanNote | undefined;
  if (config.clamavEnabled !== false) {
    const clamav = await scanWithPolicy(rawMessage, config, deps.clamav);
    const { decision, note } = evaluateClamav(clamav, config);
    if (decision) {
      if (clamav.status === 'infected') log.warn({ virusName: clamav.virusName, mailFrom: ctx.mailFrom, action: decision.action }, 'Virus detected');
      else if (clamav.status === 'oversize') log.warn({ size: rawMessage.length, mailFrom: ctx.mailFrom }, 'Message too large for virus scanning — rejected (clamavOversizeAction=reject)');
      else log.warn({ err: clamav.error, mailFrom: ctx.mailFrom }, 'ClamAV scan failed — deferring (clamavBlockOnFailure)');
      return decision;
    }
    if (note?.status === 'infected') {
      log.warn({ virusName: clamav.virusName, mailFrom: ctx.mailFrom }, 'Virus detected — delivered anyway (clamavAction=pass)');
    } else if (note?.status === 'suspicious') {
      log.info({ virusName: clamav.virusName, mailFrom: ctx.mailFrom }, 'ClamAV heuristic/PUA/encrypted finding — delivered tagged (category not treated as virus)');
    } else if (note?.reason === 'too-large') {
      log.info({ size: rawMessage.length, mailFrom: ctx.mailFrom }, 'Message too large for virus scanning — accepting unscanned');
    } else if (note?.reason === 'scanner-error') {
      log.warn({ err: clamav.error }, 'ClamAV scan failed — accepting unscanned (clamavBlockOnFailure=false)');
    }
    virusNote = note;
  } else {
    log.debug('ClamAV scan skipped (disabled in settings)');
  }

  const result = await runSpamStage(rawMessage, ctx, config, deps, auth, hostname);
  return virusNote && result.action !== 'reject' ? { ...result, virusScan: virusNote } : result;
}

async function runSpamStage(
  rawMessage: Buffer,
  ctx: ConnectionContext,
  config: PipelineConfig,
  deps: PipelineDeps,
  auth: AuthResult,
  hostname: string,
): Promise<PipelineResult> {
  const spamJunk   = config.spamScoreJunk   ?? 6.0;
  const spamReject = config.spamScoreReject ?? 15.0;

  // ── Stage 4d: rspamd anti-spam (with the SMTP session data) ─────────────
  if (config.rspamdEnabled !== false) {
    const spam = await deps.rspamd(rawMessage, {
      ip: ctx.senderIp,
      ...(ctx.helo ? { helo: ctx.helo } : {}),
      from: ctx.mailFrom,
      rcpts: ctx.rcpts && ctx.rcpts.length > 0 ? ctx.rcpts : ctx.rcptTo ? [ctx.rcptTo] : [],
      ...(ctx.authUser ? { user: ctx.authUser } : {}),
      hostname,
    });

    if (spam.score >= spamReject) {
      return {
        action: 'reject',
        reason: `Spam score too high: ${spam.score.toFixed(2)}`,
        spamScore: spam.score,
      };
    }

    if (spam.score >= spamJunk) {
      return {
        action: 'accept',
        reason: 'Spam — deliver to Junk folder',
        spamScore: spam.score,
        junkFolder: true,
        authSummary: auth.summary,
      };
    }

    return {
      action: 'accept',
      reason: 'All checks passed',
      spamScore: spam.score,
      authSummary: auth.summary,
      junkFolder: false,
    };
  }

  // rspamd disabled — accept directly
  log.debug('Rspamd scan skipped (disabled in settings)');
  return {
    action: 'accept',
    reason: 'All checks passed (rspamd disabled)',
    authSummary: auth.summary,
    junkFolder: false,
  };
}

