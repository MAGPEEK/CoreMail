/**
 * Let's Encrypt pre-flight checks (BCP → SSL/TLS → "Check prerequisites").
 *
 * Per domain:
 *  - dns        A / AAAA records exist (error without any)
 *  - ipv6       AAAA present → it must reach this server too (the CA prefers IPv6)
 *  - server-ip  the domain points to the same IPv4 as the server's public host name
 *  - caa        CAA records do not exclude Let's Encrypt
 *  - local      this server serves a self-test token under /.well-known/acme-challenge/
 *  - public     the token can be fetched over http://<domain>/ FROM this server —
 *               informational only: many hosts (Docker, NAT) cannot reach their
 *               own public address ("hairpin"), so a failure is a warning
 * plus, when requested and nothing above is an error, the external test: the
 * Let's Encrypt staging environment validates the domains over port 80 (the
 * only check that really runs from the internet).
 *
 * All network access is injected (resolver, serving, external test) — unit-testable.
 */
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { AcmeProblemError } from './acme-errors.js';
import { describeFetchError, withTimeout, type ChallengeServing } from './acme-flow.js';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';
export type CheckId = 'dns' | 'ipv6' | 'server-ip' | 'caa' | 'local' | 'public';

export interface PreflightCheck { id: CheckId; status: CheckStatus; message: string }
export interface DomainPreflight { domain: string; ipv4: string[]; ipv6: string[]; checks: PreflightCheck[] }
export interface PreflightReport {
  ok: boolean;
  domains: DomainPreflight[];
  external: { status: CheckStatus; message: string; code?: string };
}

export interface CaaRecordLike { critical?: number; issue?: string; issuewild?: string; iodef?: string; [tag: string]: unknown }

export interface PreflightResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<CaaRecordLike[]>;
}

let systemResolverInstance: PreflightResolver | null = null;
/**
 * What Let's Encrypt sees is the public DNS view: ask public resolvers first
 * (a LAN / split-horizon resolver may not know the public name). When they are
 * unreachable (blocked outbound DNS) fall back to the system resolver. Short
 * timeouts — a hanging DNS server must not block the check.
 */
export function systemResolver(): PreflightResolver {
  if (!systemResolverInstance) {
    const pub = new Resolver({ timeout: 2_500, tries: 1 });
    pub.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
    const sys = new Resolver({ timeout: 3_000, tries: 2 });
    const viaBoth = <T>(fn: (r: Resolver) => Promise<T>): Promise<T> =>
      fn(pub).catch((err: unknown) => (isNoData(err) ? Promise.reject(err) : fn(sys)));
    systemResolverInstance = {
      resolve4: (n) => viaBoth((r) => r.resolve4(n)),
      resolve6: (n) => viaBoth((r) => r.resolve6(n)),
      resolveCaa: (n) => viaBoth((r) => r.resolveCaa(n) as Promise<CaaRecordLike[]>),
    };
  }
  return systemResolverInstance;
}

/** Test seam: globalThis.__acmeResolver. */
export function activeResolver(): PreflightResolver {
  return (globalThis as { __acmeResolver?: PreflightResolver }).__acmeResolver ?? systemResolver();
}

const NO_DATA = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

function isNoData(err: unknown): boolean {
  return NO_DATA.has(String((err as { code?: string })?.code ?? ''));
}

export interface DnsLookup { ipv4: string[]; ipv6: string[]; error?: string; definiteMissing: boolean }

export async function lookupAddresses(domain: string, resolver: PreflightResolver = activeResolver()): Promise<DnsLookup> {
  const errors: string[] = [];
  let missing = 0;
  const one = async (fn: () => Promise<string[]>): Promise<string[]> => {
    try { return await fn(); } catch (err) {
      if (isNoData(err)) { missing++; return []; }
      errors.push(String((err as { code?: string })?.code ?? (err as Error)?.message ?? err));
      return [];
    }
  };
  const [ipv4, ipv6] = await Promise.all([one(() => resolver.resolve4(domain)), one(() => resolver.resolve6(domain))]);
  return {
    ipv4, ipv6,
    ...(errors.length ? { error: errors.join(', ') } : {}),
    definiteMissing: missing === 2,
  };
}

export interface CaaResult { status: 'ok' | 'error' | 'warn'; message: string; issuers?: string[]; at?: string }

/**
 * CAA: the closest CAA record set walking up from the name to (excluding) the
 * top-level domain decides. Issuance is allowed when that set has no "issue"
 * property or one of them names letsencrypt.org; an unknown tag flagged
 * critical forbids issuance.
 */
export async function checkCaa(domain: string, resolver: PreflightResolver = activeResolver()): Promise<CaaResult> {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    let records: CaaRecordLike[];
    try {
      records = await resolver.resolveCaa(name);
    } catch (err) {
      if (isNoData(err)) continue;
      return { status: 'warn', message: `CAA lookup for ${name} failed (${String((err as { code?: string })?.code ?? err)}) — Let's Encrypt refuses issuance when the CAA lookup fails.` };
    }
    if (!records || records.length === 0) continue;
    const known = new Set(['critical', 'issue', 'issuewild', 'iodef', 'contactemail', 'contactphone', 'issuemail', 'issuevmc']);
    const criticalUnknown = records.some((r) => (r.critical ?? 0) & 128 && Object.keys(r).some((k) => !known.has(k)));
    if (criticalUnknown) return { status: 'error', at: name, message: `A CAA record at ${name} has an unknown critical tag — no certificate authority may issue.` };
    const issues = records.filter((r) => typeof r.issue === 'string').map((r) => String(r.issue));
    if (issues.length === 0) return { status: 'ok', at: name, message: `CAA records at ${name} do not restrict issuance.` };
    const issuers = issues.map((v) => v.split(';')[0]!.trim().toLowerCase());
    if (issuers.includes('letsencrypt.org')) return { status: 'ok', at: name, issuers, message: `CAA at ${name} allows letsencrypt.org.` };
    const list = issuers.filter(Boolean).join(', ') || 'none';
    return { status: 'error', at: name, issuers, message: `CAA at ${name} only allows: ${list}. Add 0 issue "letsencrypt.org".` };
  }
  return { status: 'ok', message: 'No CAA records — every certificate authority may issue.' };
}

/**
 * Problems that make a Let's Encrypt validation certain to fail — checked
 * before an order is placed (failed validations count against the CA's limit).
 * Lookup errors (timeouts) are not definite and return null.
 */
export async function definiteDnsProblem(domain: string, resolver: PreflightResolver = activeResolver()): Promise<AcmeProblemError | null> {
  const dns = await lookupAddresses(domain, resolver);
  if (dns.definiteMissing) {
    return new AcmeProblemError('dns', `no A or AAAA record found for ${domain}`, { domain });
  }
  const caa = await checkCaa(domain, resolver);
  if (caa.status === 'error') return new AcmeProblemError('caa', caa.message, { domain });
  return null;
}

// ── Additional names for the public host name's certificate (9.3) ─────────────

export interface SanSuggestion {
  name: string;
  ipv4: string[];
  ipv6: string[];
  /** Every address of the name is an address of the public host name → safe to add. */
  resolvesHere: boolean;
  message: string;
}

/**
 * autodiscover.<domain> and autoconfig.<domain> as additional names for the
 * certificate of the public host name (Outlook / Thunderbird fetch them over
 * HTTPS). `resolvesHere` is true when the name has addresses and all of them
 * belong to the public host name — only then the HTTP-01 validation can
 * succeed, so the BCP checks it by default.
 */
export async function suggestAdditionalSans(
  publicHostname: string, domain: string, resolver: PreflightResolver = activeResolver(),
): Promise<SanSuggestion[]> {
  const host = publicHostname.trim().toLowerCase();
  const base = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!base.includes('.')) return [];
  const server = await lookupAddresses(host, resolver);
  const here = new Set([...server.ipv4, ...server.ipv6]);
  const names = [`autodiscover.${base}`, `autoconfig.${base}`].filter((n) => n !== host);
  return Promise.all(names.map(async (name) => {
    const l = await lookupAddresses(name, resolver);
    const addrs = [...l.ipv4, ...l.ipv6];
    const resolvesHere = here.size > 0 && addrs.length > 0 && addrs.every((a) => here.has(a));
    const message = addrs.length === 0
      ? `${name} has no A/AAAA record — add a CNAME to ${host} to include it.`
      : resolvesHere
        ? `${name} → ${addrs.join(', ')} (this server).`
        : `${name} → ${addrs.join(', ')}, but ${host} → ${[...here].join(', ') || 'unresolved'} — validation would fail.`;
    return { name, ipv4: l.ipv4, ipv6: l.ipv6, resolvesHere, message };
  }));
}

export interface PreflightDeps {
  resolver?: PreflightResolver;
  serving: ChallengeServing;
  /** Public host name of this server and its IPv4 addresses (reference for "points to this server"). */
  serverHost?: { hostname: string; ipv4: string[] } | null;
  /** Upper bound of each self-check fetch (default 8 s). */
  fetchTimeoutMs?: number;
  /** External validation (Let's Encrypt staging); omitted = not requested. */
  external?: (domains: string[]) => Promise<{ status: 'ok'; message: string } | { status: 'error'; code: string; message: string }>;
}

export async function runPreflight(domains: string[], deps: PreflightDeps): Promise<PreflightReport> {
  const resolver = deps.resolver ?? activeResolver();
  const results: DomainPreflight[] = [];

  for (const domain of domains) {
    const checks: PreflightCheck[] = [];
    const dns = await lookupAddresses(domain, resolver);
    if (dns.ipv4.length === 0 && dns.ipv6.length === 0) {
      checks.push({ id: 'dns', status: 'error', message: dns.definiteMissing
        ? `No A/AAAA record for ${domain}. Create an A record pointing to this server's public IP address.`
        : `DNS lookup for ${domain} failed (${dns.error ?? 'no answer'}).` });
    } else {
      checks.push({ id: 'dns', status: 'ok', message: `${domain} → ${[...dns.ipv4, ...dns.ipv6].join(', ')}` });
    }
    if (dns.ipv6.length > 0) {
      checks.push({ id: 'ipv6', status: 'warn', message: `AAAA record ${dns.ipv6.join(', ')}: Let's Encrypt prefers IPv6 — port 80 must reach this server over IPv6 as well, or remove the AAAA record.` });
    }
    const ref = deps.serverHost;
    if (ref && ref.ipv4.length > 0 && ref.hostname.toLowerCase() !== domain.toLowerCase() && dns.ipv4.length > 0) {
      const same = dns.ipv4.some((ip) => ref.ipv4.includes(ip));
      checks.push(same
        ? { id: 'server-ip', status: 'ok', message: `Same address as the server host name ${ref.hostname}.` }
        : { id: 'server-ip', status: 'warn', message: `${domain} points to ${dns.ipv4.join(', ')}, the server host name ${ref.hostname} to ${ref.ipv4.join(', ')}.` });
    }
    const caa = await checkCaa(domain, resolver);
    checks.push({ id: 'caa', status: caa.status, message: caa.message });

    // Self-test token: served locally (route + token store) and over the public name.
    const token = `cm-preflight-${randomBytes(12).toString('hex')}`;
    const keyAuth = `${token}.${randomBytes(16).toString('hex')}`;
    try {
      await deps.serving.store(token, keyAuth);
    } catch (err) {
      checks.push({ id: 'local', status: 'error', message: `Could not store the test token (${describeFetchError(err)}) — Redis unavailable?` });
      results.push({ domain, ipv4: dns.ipv4, ipv6: dns.ipv6, checks });
      continue;
    }
    try {
      if (deps.serving.checkLocal) {
        try {
          const r = await withTimeout(deps.serving.checkLocal(domain, token), deps.fetchTimeoutMs ?? 8_000, 'no answer within 8 s');
          checks.push(r.status === 200 && r.body.trim() === keyAuth
            ? { id: 'local', status: 'ok', message: 'This server serves validation tokens under /.well-known/acme-challenge/.' }
            : { id: 'local', status: 'error', message: `The validation path answered HTTP ${r.status} instead of the token.` });
        } catch (err) {
          checks.push({ id: 'local', status: 'error', message: `Local request to the validation path failed: ${describeFetchError(err)}.` });
        }
      }
      if (deps.serving.checkPublic) {
        try {
          const r = await withTimeout(deps.serving.checkPublic(domain, token), deps.fetchTimeoutMs ?? 8_000, 'no answer within 8 s');
          checks.push(r.status === 200 && r.body.trim() === keyAuth
            ? { id: 'public', status: 'ok', message: `http://${domain}/ reaches this server (port 80).` }
            // 9.2.x review: the redirect target is never echoed (SSRF read-back) — status only.
            : { id: 'public', status: 'warn', message: `http://${domain}/.well-known/acme-challenge/ answered HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ' (redirect)' : ''} with other content — port 80 may be forwarded to a different web server.` });
        } catch (err) {
          if ((err as { code?: string })?.code === 'EPRIVATE') {
            // 9.2.x review: a private / internal address is never fetched.
            checks.push({ id: 'public', status: 'skip', message: `${domain}: ${describeFetchError(err)} — the name resolves to a private/internal address; the external test decides.` });
          } else {
            checks.push({ id: 'public', status: 'warn', message: `Not verifiable from the server itself (${describeFetchError(err)}). Many servers cannot reach their own public address (Docker, NAT) — the external test decides.` });
          }
        }
      }
    } finally {
      await deps.serving.remove(token).catch(() => undefined);
    }
    results.push({ domain, ipv4: dns.ipv4, ipv6: dns.ipv6, checks });
  }

  const hasError = results.some((d) => d.checks.some((c) => c.status === 'error'));
  let external: PreflightReport['external'];
  if (!deps.external) {
    external = { status: 'skip', message: 'External test not requested.' };
  } else if (hasError) {
    external = { status: 'skip', message: 'External test skipped — fix the errors above first.' };
  } else {
    const r = await deps.external(domains);
    external = r.status === 'ok' ? { status: 'ok', message: r.message } : { status: 'error', message: r.message, code: r.code };
  }
  return { ok: !hasError && external.status !== 'error', domains: results, external };
}
