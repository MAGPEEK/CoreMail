import { authenticate, type AuthenticateResult } from 'mailauth';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:spf-dkim');

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface AuthResult {
  spf: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
  dkim: 'pass' | 'fail' | 'none';
  dmarc: 'pass' | 'fail' | 'none' | 'temperror';
  arc:   'pass' | 'fail' | 'none';
  /** Policy the header-From domain publishes (`sp` for subdomains); null without a record. */
  dmarcPolicy: DmarcPolicy | null;
  /** DMARC `pct` (0..100) of the header-From domain's record; absent/null = 100. */
  dmarcPct?: number | null;
  /**
   * Shape of the RFC 5322 From header: number of `From:` header fields and of
   * mailboxes in them. Exactly 1/1 is required for unauthenticated mail
   * (DMARC cannot evaluate anything else). Absent = not inspected.
   */
  fromHeaderFields?: number;
  fromMailboxes?: number;
  /** Signing domain (d=) of the newest ARC set when the ARC chain passed; null otherwise. */
  arcSealer?: string | null;
  /** `dmarc=` result the newest ARC-Authentication-Results reports (lower case); null when absent. */
  arcDmarc?: string | null;
  /** Domain of the (single) RFC 5322 From address; null when missing or ambiguous. */
  headerFromDomain: string | null;
  /** Domain SPF evaluated (MAIL FROM domain, or the HELO name for the null sender). */
  spfDomain: string | null;
  /** Signing domains (d=) of DKIM signatures that verified. */
  dkimDomains: string[];
  /**
   * Domains this message is authenticated for: the header-From domain on a
   * DMARC pass, the SPF domain on an SPF pass, every passing DKIM d= domain.
   */
  verifiedDomains: string[];
  summary: string;
  /** `Received-SPF:` + `Authentication-Results:` (RFC 8601) lines, CRLF-terminated. */
  authHeaders: string;
}

/** SMTP session data the checks must be evaluated against (never message headers). */
export interface AuthInput {
  /** Client IP of the SMTP connection. */
  ip: string;
  /** EHLO/HELO name the client sent. */
  helo: string;
  /** Envelope MAIL FROM ('' = null sender). */
  mailFrom: string;
  /** Our host name (authserv-id of the Authentication-Results header). */
  mta: string;
}

const domainOf = (addr: string): string | null => {
  const at = addr.lastIndexOf('@');
  const d = (at >= 0 ? addr.slice(at + 1) : addr).trim().toLowerCase().replace(/\.$/, '');
  return d || null;
};

function asPolicy(v: unknown): DmarcPolicy | null {
  const p = typeof v === 'string' ? v.toLowerCase() : '';
  return p === 'none' || p === 'quarantine' || p === 'reject' ? p : null;
}

/** Pure: mailauth result → AuthResult (exported for tests). */
export function summarizeAuthResult(result: AuthenticateResult): AuthResult {
  const spfRaw = result.spf !== false ? (result.spf.status?.result ?? 'none') : 'none';
  const spf = (['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'].includes(spfRaw) ? spfRaw : 'none') as AuthResult['spf'];
  const dkimResults = result.dkim?.results ?? [];
  const dkimDomains = [...new Set(dkimResults
    .filter((r) => r.status?.result === 'pass' && typeof r.signingDomain === 'string')
    .map((r) => r.signingDomain.toLowerCase()))];
  const dkim: AuthResult['dkim'] = dkimDomains.length > 0 ? 'pass' : dkimResults.length ? 'fail' : 'none';
  let dmarc: AuthResult['dmarc'] = 'none';
  let dmarcPolicy: DmarcPolicy | null = null;
  if (result.dmarc !== false && result.dmarc) {
    const r = result.dmarc.status?.result;
    dmarc = r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : r === 'temperror' ? 'temperror' : 'none';
    dmarcPolicy = asPolicy(result.dmarc.policy);
  }
  const arc = (result.arc !== false && result.arc ? (result.arc.status?.result === 'pass' ? 'pass' : result.arc.status?.result && result.arc.status.result !== 'none' ? 'fail' : 'none') : 'none') as AuthResult['arc'];
  const froms = result.dkim?.headerFrom ?? [];
  const headerFromDomain = froms.length === 1 ? domainOf(froms[0]!) : null;
  const spfDomain = result.spf !== false && result.spf?.domain ? result.spf.domain.toLowerCase() : null;
  const dmarcPct = result.dmarc !== false && result.dmarc ? asPct((result.dmarc as { pct?: unknown }).pct) : null;
  const arcInfo = arc === 'pass' ? arcDetails(result.arc) : { sealer: null, dmarc: null };

  const verified = new Set<string>();
  if (dmarc === 'pass' && headerFromDomain) verified.add(headerFromDomain);
  if (spf === 'pass' && spfDomain) verified.add(spfDomain);
  for (const d of dkimDomains) verified.add(d);

  return {
    spf, dkim, dmarc, arc, dmarcPolicy, dmarcPct, headerFromDomain, spfDomain, dkimDomains,
    fromMailboxes: froms.length,
    arcSealer: arcInfo.sealer,
    arcDmarc: arcInfo.dmarc,
    verifiedDomains: [...verified],
    summary: buildSummary({ spf, dkim, dmarc, arc }),
    authHeaders: typeof result.headers === 'string' ? result.headers : '',
  };
}

export async function authenticateMail(
  rawMessage: Buffer,
  input: AuthInput,
  /** DNS resolver override (tests). */
  resolver?: (name: string, rr: string) => Promise<unknown>,
): Promise<AuthResult> {
  try {
    const result = await authenticate(rawMessage, {
      ...(resolver ? { resolver: resolver as never } : {}),
      ip: input.ip,
      // mailauth falls back to the IP literal when HELO is unknown
      ...(input.helo ? { helo: input.helo } : {}),
      // MAIL FROM; the null sender is checked against postmaster@<HELO> (RFC 7208 §2.4)
      ...(input.mailFrom ? { sender: input.mailFrom } : {}),
      mta: input.mta,
      trustReceived: false,
      disableBimi: true,
    });
    const summary = summarizeAuthResult(result);
    const shape = fromHeaderShape(rawMessage);
    // Our own count is authoritative; when it sees exactly one mailbox, the
    // count of mailauth's address parser must agree as well.
    const auth: AuthResult = {
      ...summary,
      fromHeaderFields: shape.fromHeaderFields,
      fromMailboxes: shape.fromMailboxes === 1 ? (summary.fromMailboxes ?? 1) : shape.fromMailboxes,
    };
    log.debug({ senderIp: input.ip, spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, policy: auth.dmarcPolicy }, 'Auth result');
    return auth;
  } catch (err) {
    log.error({ err, senderIp: input.ip }, 'mailauth error');
    return {
      spf: 'temperror', dkim: 'none', dmarc: 'temperror', arc: 'none',
      dmarcPolicy: null, headerFromDomain: null, spfDomain: null, dkimDomains: [], verifiedDomains: [],
      ...fromHeaderShape(rawMessage),
      summary: 'Authentication check failed',
      authHeaders: `Authentication-Results: ${input.mta}; spf=temperror; dmarc=temperror\r\n`,
    };
  }
}

function buildSummary(r: Pick<AuthResult, 'spf' | 'dkim' | 'dmarc' | 'arc'>): string {
  return `spf=${r.spf} dkim=${r.dkim} dmarc=${r.dmarc} arc=${r.arc}`;
}

/**
 * Pure: what the receiver does with the message per the sender's DMARC policy
 * (RFC 7489 §6.6.2). Only an actual `fail` applies the policy — `none` (no
 * record) and `temperror` (DNS trouble) never reject.
 */
export function dmarcDisposition(
  auth: Pick<AuthResult, 'dmarc' | 'dmarcPolicy'> & { dmarcPct?: number | null | undefined },
  /** Random source in [0, 1) for the `pct` sampling (tests inject a fixed one). */
  rng: () => number = Math.random,
): DmarcPolicy {
  if (auth.dmarc !== 'fail') return 'none';
  return applyDmarcPct(auth.dmarcPolicy ?? 'none', auth.dmarcPct, rng);
}

/**
 * Pure: RFC 7489 §6.6.4 — with `pct` < 100 only that share of failing messages
 * gets the published policy; the rest gets the next less strict one
 * (reject → quarantine, quarantine → none). Missing/invalid pct = 100.
 */
export function applyDmarcPct(policy: DmarcPolicy, pct: number | null | undefined, rng: () => number = Math.random): DmarcPolicy {
  if (policy === 'none') return 'none';
  const p = typeof pct === 'number' && Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 100;
  if (p >= 100) return policy;
  if (rng() * 100 < p) return policy;
  return policy === 'reject' ? 'quarantine' : 'none';
}

function asPct(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Sealer + reported DMARC result of the newest ARC set (mailauth ARC result). */
function arcDetails(arc: unknown): { sealer: string | null; dmarc: string | null } {
  if (!arc || typeof arc !== 'object') return { sealer: null, dmarc: null };
  const a = arc as {
    signature?: { signingDomain?: unknown } | false;
    authenticationResults?: { dmarc?: { result?: unknown } };
  };
  const d = a.signature && typeof a.signature.signingDomain === 'string' ? a.signature.signingDomain.toLowerCase() : null;
  const r = a.authenticationResults?.dmarc?.result;
  return { sealer: d || null, dmarc: typeof r === 'string' ? r.toLowerCase() : null };
}

/**
 * Pure: number of `From:` header fields and of mailboxes in them (RFC 5322
 * §3.6.2 address-list syntax: quoted strings, comments, angle addresses and
 * groups are honoured; an empty group counts 0).
 */
export function fromHeaderShape(raw: Buffer): { fromHeaderFields: number; fromMailboxes: number } {
  let end = raw.indexOf('\r\n\r\n');
  if (end < 0) end = raw.indexOf('\n\n');
  const head = raw.subarray(0, end >= 0 ? end : Math.min(raw.length, 256 * 1024)).toString('latin1');
  const unfolded = head.replace(/\r?\n(?=[ \t])/g, '');
  let fields = 0;
  let mailboxes = 0;
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^From[ \t]*:(.*)$/i.exec(line);
    if (!m) continue;
    fields++;
    mailboxes += countMailboxes(m[1]!);
  }
  return { fromHeaderFields: fields, fromMailboxes: mailboxes };
}

/** Pure: mailboxes in an RFC 5322 address-list (best effort, never throws). */
export function countMailboxes(value: string): number {
  let count = 0;
  let current = '';       // text of the current list member, outside quotes/comments
  let inGroup = false;
  const flush = (): void => {
    // any non-empty member is a mailbox claim (also an addr-spec without '@')
    if (current.trim() !== '') count++;
    current = '';
  };
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '"') {
      // quoted string (display name or local part)
      i++;
      while (i < value.length && value[i] !== '"') { if (value[i] === '\\') i++; i++; }
      current += 'q';
      i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < value.length && depth > 0) {
        if (value[i] === '\\') i++;
        else if (value[i] === '(') depth++;
        else if (value[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (ch === '<') {
      const close = value.indexOf('>', i);
      current += close < 0 ? value.slice(i) : value.slice(i, close + 1);
      i = close < 0 ? value.length : close + 1;
      continue;
    }
    if (ch === ':' && !inGroup) {
      // group start: the display name before ':' is not a mailbox
      inGroup = true;
      current = '';
      i++;
      continue;
    }
    if (ch === ';' && inGroup) {
      flush();
      inGroup = false;
      i++;
      continue;
    }
    if (ch === ',') { flush(); i++; continue; }
    current += ch;
    i++;
  }
  flush();
  return count;
}

/**
 * Pure: relaxed alignment between a claimed domain and an authenticated one
 * (equal, or one is a subdomain of the other — RFC 7489 §3.1 without the
 * public-suffix lookup, i.e. stricter than DMARC for sibling subdomains).
 */
export function domainsAligned(claimed: string, verified: string): boolean {
  const a = claimed.toLowerCase().replace(/\.$/, '');
  const b = verified.toLowerCase().replace(/\.$/, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Pure: is `domain` authenticated by one of the verified domains? */
export function isDomainAuthenticated(domain: string, verifiedDomains: readonly string[]): boolean {
  return verifiedDomains.some((v) => domainsAligned(domain, v));
}

export { domainOf as addressDomain };
