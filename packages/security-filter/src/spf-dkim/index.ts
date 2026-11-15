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

  const verified = new Set<string>();
  if (dmarc === 'pass' && headerFromDomain) verified.add(headerFromDomain);
  if (spf === 'pass' && spfDomain) verified.add(spfDomain);
  for (const d of dkimDomains) verified.add(d);

  return {
    spf, dkim, dmarc, arc, dmarcPolicy, headerFromDomain, spfDomain, dkimDomains,
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
    const auth = summarizeAuthResult(result);
    log.debug({ senderIp: input.ip, spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, policy: auth.dmarcPolicy }, 'Auth result');
    return auth;
  } catch (err) {
    log.error({ err, senderIp: input.ip }, 'mailauth error');
    return {
      spf: 'temperror', dkim: 'none', dmarc: 'temperror', arc: 'none',
      dmarcPolicy: null, headerFromDomain: null, spfDomain: null, dkimDomains: [], verifiedDomains: [],
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
export function dmarcDisposition(auth: Pick<AuthResult, 'dmarc' | 'dmarcPolicy'>): DmarcPolicy {
  if (auth.dmarc !== 'fail') return 'none';
  return auth.dmarcPolicy ?? 'none';
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
