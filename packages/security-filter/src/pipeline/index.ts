import { createLogger } from '@coremail/core';
import { parseRawMessage } from '@coremail/storage';
import { checkDnsbl } from '../dnsbl/index.js';
import { checkGreylist } from '../greylisting/index.js';
import { checkCountry, type CountryConfig } from '../geoip/index.js';
import { authenticateMail, shouldRejectByDmarc } from '../spf-dkim/index.js';
import { scanBuffer as clamavScan } from '../clamav/index.js';
import { scanMessage as rspamdScan } from '../rspamd/index.js';
import { checkBlacklist } from '../blacklist/index.js';
import { checkAttachments } from '../attachment/index.js';

const log = createLogger('security-filter:pipeline');

export type PipelineAction = 'accept' | 'defer' | 'reject' | 'quarantine';

export interface PipelineConfig {
  /** @deprecated DNSBL-Zonen werden jetzt aus der DB geladen (DnsblZone-Tabelle) */
  dnsblZones?: string[];
  greylistingEnabled?: boolean;
  countryFilter?: CountryConfig | null;
  spamScoreJunk?: number;    // score threshold → junk folder (default 3.0)
  spamScoreReject?: number;  // score threshold → reject (default 6.0)
  maxAttachmentBytes?: number;
  hostname?: string;
}

export interface PipelineResult {
  action: PipelineAction;
  reason: string;
  spamScore?: number;
  virusName?: string;
  authSummary?: string;
  junkFolder?: boolean;
}

export interface ConnectionContext {
  senderIp: string;
  mailFrom: string;
  rcptTo: string;
  domainId?: string;
  userId?: string;
}

export async function runConnectionChecks(
  ctx: ConnectionContext,
  config: PipelineConfig = {},
): Promise<PipelineResult> {
  const { senderIp, mailFrom, rcptTo } = ctx;

  // ── Stage 1a: Greylisting ────────────────────────────────────────────────
  if (config.greylistingEnabled !== false) {
    const grey = await checkGreylist(senderIp, mailFrom, rcptTo);
    if (grey.action === 'defer') {
      return { action: 'defer', reason: grey.reason ?? 'Greylisted' };
    }
  }

  // ── Stage 1b: DNSBL ──────────────────────────────────────────────────────
  const dnsbl = await checkDnsbl(senderIp);
  if (dnsbl.whitelisted) {
    // DNSWL-Treffer → folgende Stage-1-Filter überspringen
    log.info({ senderIp, hits: dnsbl.hits.map((h) => h.zone.host) }, 'DNSWL hit — bypassing remaining checks');
    return { action: 'accept', reason: 'DNSWL whitelisted' };
  }
  if (dnsbl.action === 'REJECT') {
    return {
      action: 'reject',
      reason: `Sender IP listed in DNSBL: ${dnsbl.hits.map((h) => h.zone.host).join(', ')}`,
    };
  }
  // TAG- und SCORE_ONLY-Hits fließen weiter unten in den rspamd-Score

  // ── Stage 1c: Country filtering ──────────────────────────────────────────
  const geo = await checkCountry(senderIp, config.countryFilter ?? null);
  if (!geo.allowed) {
    return { action: 'reject', reason: geo.reason ?? 'Country blocked' };
  }

  return { action: 'accept', reason: 'Connection checks passed' };
}

export async function runContentChecks(
  rawMessage: Buffer,
  ctx: ConnectionContext,
  config: PipelineConfig = {},
): Promise<PipelineResult> {
  const hostname = config.hostname ?? process.env['SMTP_HOSTNAME'] ?? 'mail.localhost';
  const spamJunk   = config.spamScoreJunk   ?? 3.0;
  const spamReject = config.spamScoreReject ?? 6.0;

  // ── Stage 2: SPF / DKIM / DMARC ─────────────────────────────────────────
  const auth = await authenticateMail(rawMessage, ctx.senderIp, hostname);

  // Hard DMARC reject (policy=reject and both SPF+DKIM fail)
  if (shouldRejectByDmarc(auth.dmarc, 'reject') && auth.spf === 'fail' && auth.dkim === 'fail') {
    return {
      action: 'reject',
      reason: 'DMARC policy violation',
      authSummary: auth.summary,
    };
  }

  // ── Stage 3: Address blacklist ───────────────────────────────────────────
  const blacklist = await checkBlacklist(ctx.mailFrom, ctx.domainId, ctx.userId);
  if (blacklist.blocked) {
    return { action: 'reject', reason: blacklist.reason ?? 'Sender blocked' };
  }

  // ── Stage 4a: Parse MIME for attachment check ────────────────────────────
  let parsed;
  try {
    parsed = await parseRawMessage(rawMessage);
  } catch (err) {
    log.error({ err }, 'MIME parsing failed');
    return { action: 'reject', reason: 'Invalid message format' };
  }

  // ── Stage 4b: Attachment filter ──────────────────────────────────────────
  const attCheck = checkAttachments(parsed.attachments, config.maxAttachmentBytes);
  if (attCheck.blocked) {
    return { action: 'reject', reason: attCheck.reason ?? 'Attachment not allowed' };
  }

  // ── Stage 4c: ClamAV antivirus ───────────────────────────────────────────
  const clamav = await clamavScan(rawMessage);
  if (!clamav.clean) {
    log.warn({ virusName: clamav.virusName, mailFrom: ctx.mailFrom }, 'Virus detected');
    return {
      action: 'quarantine',
      reason: `Virus detected: ${clamav.virusName ?? 'unknown'}`,
      ...(clamav.virusName ? { virusName: clamav.virusName } : {}),
    };
  }

  // ── Stage 4d: rspamd anti-spam ───────────────────────────────────────────
  const spam = await rspamdScan(rawMessage);

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
