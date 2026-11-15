import { createLogger } from '@coremail/core';
import { parseRawMessage } from '@coremail/storage';
import { checkDnsbl } from '../dnsbl/index.js';
import { checkGreylist } from '../greylisting/index.js';
import { checkCountry, type CountryConfig } from '../geoip/index.js';
import { prisma } from '@coremail/storage';
import {
  authenticateMail, dmarcDisposition, isDomainAuthenticated, addressDomain, type AuthResult,
} from '../spf-dkim/index.js';
import { scanBuffer as clamavScan, type ClamavResult } from '../clamav/index.js';
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
  /** All envelope recipients (content stage; rcptTo is the first). */
  rcpts?: string[];
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
  clamav: (raw: Buffer) => Promise<ClamavResult>;
  rspamd: typeof rspamdScan;
  /** Is the domain one of ours (active Domain row)? */
  isLocalDomain: (domain: string) => Promise<boolean>;
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
  if (result.status === 'infected') {
    const virus = result.virusName ?? 'unknown';
    const action = config.clamavAction ?? 'quarantine';
    if (action === 'pass') return null;
    return {
      action: action === 'reject' ? 'reject' : 'quarantine',
      reason: `Virus detected: ${virus}`,
      ...(result.virusName ? { virusName: result.virusName } : {}),
    };
  }
  if (result.status === 'error') {
    return config.clamavBlockOnFailure
      ? { action: 'defer', reason: 'Virus scanner unavailable — please retry later' }
      : null;
  }
  return null;
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

/**
 * Pure: SPF/DKIM/DMARC decision for an unauthenticated (port 25) message.
 *  - Anti-spoofing: a local domain in MAIL FROM or in the header From must be
 *    authenticated (DMARC pass, or SPF/DKIM pass aligned with that domain) —
 *    our own domains never arrive unauthenticated from outside.
 *  - DMARC fail → the policy the From domain publishes: reject → 550 5.7.1,
 *    quarantine → Junk, none → only tagged (Authentication-Results).
 * Returns null to continue; `{ junk: true }` to deliver to Junk.
 */
export async function decideAuthentication(
  auth: AuthResult,
  ctx: ConnectionContext,
  isLocalDomain: (domain: string) => Promise<boolean>,
): Promise<PipelineResult | { junk: true } | null> {
  if (ctx.authUser) return null; // authenticated SMTP session — identity checked by SMTP AUTH
  const verified = auth.verifiedDomains ?? [];
  const claimed = new Set<string>();
  const envDomain = ctx.mailFrom ? addressDomain(ctx.mailFrom) : null;
  if (envDomain) claimed.add(envDomain);
  if (auth.headerFromDomain) claimed.add(auth.headerFromDomain);
  for (const domain of claimed) {
    if (!(await isLocalDomain(domain))) continue;
    if (!isDomainAuthenticated(domain, verified)) {
      return {
        action: 'reject',
        reason: `Unauthenticated mail claiming local domain ${domain}`,
        authSummary: auth.summary,
      };
    }
  }
  switch (dmarcDisposition(auth)) {
    case 'reject':
      return {
        action: 'reject',
        reason: `DMARC policy of ${auth.headerFromDomain ?? 'the sender domain'} rejects this message`,
        authSummary: auth.summary,
      };
    case 'quarantine':
      return { junk: true };
    default:
      return null;
  }
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
  const authDecision = await decideAuthentication(auth, ctx, deps.isLocalDomain);
  if (authDecision && 'action' in authDecision) return authDecision;
  const dmarcJunk = authDecision !== null && 'junk' in authDecision;

  const result = await runContentStages(rawMessage, ctx, config, deps, auth, hostname);
  if (result.action !== 'accept') return result;
  return {
    ...result,
    ...(dmarcJunk ? { junkFolder: true, reason: `${result.reason} (DMARC policy quarantine)` } : {}),
    ...(auth.authHeaders ? { authHeaders: auth.authHeaders } : {}),
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
  const spamJunk   = config.spamScoreJunk   ?? 6.0;
  const spamReject = config.spamScoreReject ?? 15.0;

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
  if (config.clamavEnabled !== false) {
    const clamav = await deps.clamav(rawMessage);
    const decision = decideClamav(clamav, config);
    if (decision) {
      if (clamav.status === 'infected') log.warn({ virusName: clamav.virusName, mailFrom: ctx.mailFrom, action: decision.action }, 'Virus detected');
      else log.warn({ err: clamav.error, mailFrom: ctx.mailFrom }, 'ClamAV scan failed — deferring (clamavBlockOnFailure)');
      return decision;
    }
    if (clamav.status === 'infected') {
      log.warn({ virusName: clamav.virusName, mailFrom: ctx.mailFrom }, 'Virus detected — delivered anyway (clamavAction=pass)');
    } else if (clamav.status === 'error') {
      log.warn({ err: clamav.error }, 'ClamAV scan failed — accepting unscanned (clamavBlockOnFailure=false)');
    }
  } else {
    log.debug('ClamAV scan skipped (disabled in settings)');
  }

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

