/**
 * Thunderbird / Mozilla autoconfig (v8.1) — ISPDB format `config-v1.1.xml`.
 *
 *   GET /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=…   (on the mail domain)
 *   GET /mail/config-v1.1.xml?emailaddress=…                           (on autoconfig.<domain>)
 *
 * Also used by K-9 Mail / Thunderbird for Android, FairEmail, Evolution and KMail.
 *
 * Anonymous by design. The answer depends ONLY on the mail domain — the local part is
 * never looked up and never echoed (the username is the `%EMAILADDRESS%` placeholder),
 * so the endpoint cannot be used to find out whether an address exists. Domains this
 * server does not serve (unknown or inactive) get 404. Rate-limited per client IP.
 * Hostnames and ports come from ServerSettings (same source as Autodiscover and the
 * MWA "External clients" page).
 */
import type { Request, Response } from 'express';
import {
  prisma, clientIpFromRequest, isPrivateOrLoopbackIp, domainProtocolAccess, DEFAULT_PRODUCT_NAME, type ProtocolAccess,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { getServerConfig, ServerConfigUnavailableError, type ServerConfig } from './settings.js';
import { FixedWindowLimiter } from './rate-limit.js';

const log = createLogger('autodiscover:autoconfig');

// ── XML helpers ──────────────────────────────────────────────────────────────

/** Escapes text and attribute values (all five XML special characters). */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // characters that are not allowed in XML 1.0 at all
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

// ── Domain handling ──────────────────────────────────────────────────────────

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-cased domain if syntactically valid (punycode for IDNs), else null. */
export function normalizeDomain(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_RE.test(d) ? d : null;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

/**
 * The mail domain a request asks about: the domain part of `emailaddress`
 * (Thunderbird always sends it), otherwise the requested host with a leading
 * `autoconfig.` removed. The gateway's X-Forwarded-Host is only honoured from a
 * private/loopback peer (the api-gateway sets it from trusted values).
 */
export function requestedDomain(req: Request): string | null {
  const q = req.query['emailaddress'];
  if (typeof q === 'string' && q.includes('@')) {
    return normalizeDomain(q.slice(q.lastIndexOf('@') + 1));
  }
  if (q !== undefined && typeof q !== 'string') return null;
  const peer = req.socket?.remoteAddress ?? '';
  const fwd = isPrivateOrLoopbackIp(peer.replace(/^::ffff:/, '')) ? firstHeader(req.headers['x-forwarded-host']) : undefined;
  const hostHeader = fwd ?? firstHeader(req.headers['host']) ?? '';
  // strip the port ("[::1]:443" style IPv6 hosts are never mail domains)
  const host = hostHeader.replace(/:\d+$/, '');
  const d = normalizeDomain(host);
  if (!d) return null;
  return d.startsWith('autoconfig.') ? d.slice('autoconfig.'.length) : d;
}

// Served domains — cached like the server settings (60 s, last good value on DB errors)
let domainCache: { names: Set<string>; expires: number } | null = null;
let domainLastGood: Set<string> | null = null;
const DOMAIN_CACHE_TTL_MS = 60_000;

async function servedDomains(now: number): Promise<Set<string>> {
  if (domainCache && now < domainCache.expires) return domainCache.names;
  try {
    const rows = await prisma.domain.findMany({ where: { active: true }, select: { name: true } });
    const names = new Set(rows.map((r) => r.name.trim().toLowerCase()));
    domainCache = { names, expires: now + DOMAIN_CACHE_TTL_MS };
    domainLastGood = names;
    return names;
  } catch (err) {
    if (domainLastGood) {
      log.warn({ err }, 'Could not read domains — serving the last known list');
      return domainLastGood;
    }
    throw new ServerConfigUnavailableError(err);
  }
}

/** Invalidate the domain cache (settings reload signal). */
export function invalidateAutoconfigCache(): void {
  domainCache = null;
}

/** Test helper: forget everything incl. the outage fallback. */
export function resetAutoconfigForTests(): void {
  domainCache = null;
  domainLastGood = null;
  limiter = createLimiter();
}

// ── Server list ──────────────────────────────────────────────────────────────

export type SocketType = 'SSL' | 'STARTTLS';
export interface MailServer { hostname: string; port: number; socketType: SocketType }

/**
 * The configured endpoint first, then the other RFC 8314 variant on its standard
 * port (implicit TLS preferred). Plaintext is never offered — since v7 every mail
 * protocol requires TLS before authentication, so a "TLS off" setting is announced
 * as STARTTLS.
 */
function variants(host: string, port: number, implicitTls: boolean, sslPort: number, starttlsPort: number): MailServer[] {
  const list: MailServer[] = [
    { hostname: host, port, socketType: implicitTls ? 'SSL' : 'STARTTLS' },
    { hostname: host, port: sslPort, socketType: 'SSL' },
    { hostname: host, port: starttlsPort, socketType: 'STARTTLS' },
  ];
  const seen = new Set<number>();
  return list.filter((s) => (seen.has(s.port) ? false : (seen.add(s.port), true)));
}

export function mailServers(cfg: ServerConfig): { imap: MailServer[]; pop3: MailServer[]; smtp: MailServer[] } {
  return {
    imap: variants(cfg.imapHost, cfg.imapPort, cfg.imapSsl, 993, 143),
    pop3: variants(cfg.pop3Host, cfg.pop3Port, cfg.pop3Ssl, 995, 110),
    // SMTP: smtpTls means "TLS required"; implicit TLS only on 465 (RFC 8314)
    smtp: variants(cfg.smtpHost, cfg.smtpPort, cfg.smtpPort === 465, 465, 587),
  };
}

/** Public web base URL (CalDAV/CardDAV/webmail), same rule as GET /user/client-config. */
export function webBaseUrl(cfg: ServerConfig): string {
  const proto = cfg.useHttps ? 'https' : 'http';
  const std = (proto === 'https' && cfg.httpPort === 443) || (proto === 'http' && cfg.httpPort === 80);
  return `${proto}://${cfg.publicHostname}${std ? '' : `:${cfg.httpPort}`}`;
}

// ── Document ─────────────────────────────────────────────────────────────────

/** 9.4: the protocol switches the document follows (the mail domain's, never one account's). */
export type AutoconfigAccess = Pick<ProtocolAccess, 'imap' | 'pop3' | 'smtp' | 'dav' | 'webmail'>;

/**
 * config-v1.1.xml for one mail domain. Identical for every address of that
 * domain. 9.4: only protocols switched on for the domain are listed.
 */
export function buildAutoconfigXml(domain: string, cfg: ServerConfig, access: AutoconfigAccess): string {
  const e = xmlEscape;
  const all = mailServers(cfg);
  const servers = {
    imap: access.imap ? all.imap : [],
    pop3: access.pop3 ? all.pop3 : [],
    smtp: access.smtp ? all.smtp : [],
  };
  const base = webBaseUrl(cfg);
  // 9.3: the branded product name, else the organisation name (as before), else the domain
  const name = cfg.productName && cfg.productName !== DEFAULT_PRODUCT_NAME ? cfg.productName : (cfg.orgName.trim() || domain);
  const server = (tag: 'incomingServer' | 'outgoingServer', type: string, s: MailServer): string => [
    `    <${tag} type="${type}">`,
    `      <hostname>${e(s.hostname)}</hostname>`,
    `      <port>${s.port}</port>`,
    `      <socketType>${s.socketType}</socketType>`,
    `      <authentication>password-cleartext</authentication>`,
    `      <username>%EMAILADDRESS%</username>`,
    `    </${tag}>`,
  ].join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<clientConfig version="1.1">',
    `  <emailProvider id="${e(domain)}">`,
    `    <domain>${e(domain)}</domain>`,
    `    <displayName>${e(name)}</displayName>`,
    `    <displayShortName>${e(name)}</displayShortName>`,
    ...servers.imap.map((s) => server('incomingServer', 'imap', s)),
    ...servers.pop3.map((s) => server('incomingServer', 'pop3', s)),
    ...servers.smtp.map((s) => server('outgoingServer', 'smtp', s)),
    ...(access.webmail ? [
      `    <documentation url="${e(`${base}/`)}">`,
      `      <descr lang="en">Webmail and client setup (Settings → External clients)</descr>`,
      `    </documentation>`,
    ] : []),
    `  </emailProvider>`,
    // Thunderbird 102+ reads these (CalDAV/CardDAV accounts next to the mail account).
    // The server URL is the DAV context path; clients find the principal via
    // DAV:current-user-principal (RFC 5397 / RFC 6764).
    ...(access.dav ? [
      `  <addressBook type="carddav">`,
      `    <username>%EMAILADDRESS%</username>`,
      `    <authentication>http-basic</authentication>`,
      `    <serverURL>${e(`${base}/dav/`)}</serverURL>`,
      `  </addressBook>`,
      `  <calendar type="caldav">`,
      `    <username>%EMAILADDRESS%</username>`,
      `    <authentication>http-basic</authentication>`,
      `    <serverURL>${e(`${base}/dav/`)}</serverURL>`,
      `  </calendar>`,
    ] : []),
    ...(access.webmail ? [
      `  <webMail>`,
      `    <loginPage url="${e(`${base}/`)}"/>`,
      `  </webMail>`,
    ] : []),
    '</clientConfig>',
    '',
  ].join('\n');
}

// ── Handler ──────────────────────────────────────────────────────────────────

function createLimiter(): FixedWindowLimiter {
  const perMinute = parseInt(process.env['AUTOCONFIG_RATE_LIMIT'] ?? '', 10);
  return new FixedWindowLimiter({ limit: perMinute > 0 ? perMinute : 60, windowMs: 60_000 });
}
let limiter = createLimiter();

/** Cache lifetime of a successful answer (clients and proxies may cache it). */
export const AUTOCONFIG_MAX_AGE_SEC = 3600;

export async function handleAutoconfig(req: Request, res: Response): Promise<void> {
  const ip = clientIpFromRequest(req.socket?.remoteAddress, req.headers['x-forwarded-for']);
  const rl = limiter.hit(ip);
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfterSec));
    res.set('Cache-Control', 'no-store');
    res.status(429).type('text/plain').send('Too many requests');
    return;
  }

  const domain = requestedDomain(req);
  let cfg: ServerConfig;
  let served: Set<string>;
  try {
    [cfg, served] = await Promise.all([getServerConfig(), servedDomains(Date.now())]);
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) throw err;
    res.set('Retry-After', '30');
    res.set('Cache-Control', 'no-store');
    res.status(503).type('text/plain').send('Try again later');
    return;
  }

  if (!domain || !served.has(domain)) {
    // Same body for malformed input and foreign domains.
    res.set('Cache-Control', 'public, max-age=300');
    res.status(404).type('text/plain').send('Not found');
    return;
  }

  let access: AutoconfigAccess;
  try {
    access = await domainProtocolAccess(domain);
  } catch (err) {
    log.error({ err }, 'autoconfig: protocol switches not readable');
    res.set('Retry-After', '30');
    res.set('Cache-Control', 'no-store');
    res.status(503).type('text/plain').send('Try again later');
    return;
  }

  log.debug({ domain }, 'autoconfig served');
  res.set('Cache-Control', `public, max-age=${AUTOCONFIG_MAX_AGE_SEC}`);
  res.set('Vary', 'Host');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type('application/xml; charset=utf-8').send(buildAutoconfigXml(domain, cfg, access));
}
