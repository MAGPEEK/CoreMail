import type { Request, Response } from 'express';
import { createLogger, PROTO_VERIFIED_HEADER } from '@coremail/core';
import {
  prisma, verifyMailCredentials, clientIpInfoFromRequest, effectiveProtocolAccess, legacyDnFor, mapiEndpointsFor, mapiHttpsTrusted,
  type MailAuthUser, type MapiEndpoints, type ProtocolAccess,
} from '@coremail/storage';
import { getServerConfig, ServerConfigUnavailableError, type ServerConfig } from './settings.js';
import { SMTPS_PORT } from './v2.js';
import { LogBudget } from './log-budget.js';

/** SystemLog rows for failed Basic logins: at most 10 per IP and 60 in total per minute. */
export const failedAuthLogBudget = new LogBudget({ perKey: 10, total: 60, windowMs: 60_000 });

const log = createLogger('autodiscover:v1');

// Autodiscover v1 (POX, MS-OXDSCLI; ActiveSync clients: MS-ASCMD "Autodiscover").
//
//  - Basic auth is required and verified by the shared mail-protocol check
//    verifyMailCredentials() (@coremail/storage): login normalisation
//    (DOMAIN\user, bare user name → primary domain), MFA → app passwords only,
//    shared lockout, database errors → 503 instead of 401. (v5.2.14: Autodiscover
//    must validate, otherwise the client loops on a wrong password.)
//  - A caller only gets settings for its OWN address (primary address or one of
//    its aliases). Any other address — another user, an unknown account, a domain
//    this server does not host — gets the same Error 500, so nothing about other
//    accounts can be learned.
//  - AcceptableResponseSchema selects the answer: outlook/2006a (default) →
//    IMAP + SMTP account; mobilesync/2006 → MobileSync server URL; anything else →
//    Error 601.
//  - 9.4: only protocols switched on for the account are announced (IMAP, else
//    POP3; SMTP; MobileSync) — nothing left → Error 500 "No client protocol …".
//  - 9.4: MAPI over HTTP (a desktop client's MAPI account): the
//    <Protocol Type="mapiHttp" Version="1"> block (MailStore + AddressBook URLs,
//    MS-OXDSCLI 3.2.5.1) when the client asks for it (X-MapiHttpCapability ≥ 1),
//    the account's `mapi` switch is on and HTTPS has a trusted certificate
//    (storage mapiHttpsTrusted). IMAP / SMTP blocks stay as they are.
//
// Never EXCH / EXPR / EXHTTP blocks (MS-OXDSCLI 3.2.5.1 forbids EXCH/EXPR next to
// mapiHttp; they make the client attempt a binary MAPI/RPC connection, v3.18.39) and
// no EWS (removed in v7.0.0).

const REALM_CHALLENGE = 'Basic realm="CoreMail Autodiscover"';
const NS_RESPONSE = 'http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006';
export const NS_OUTLOOK = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a';
export const NS_MOBILESYNC = 'http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006';

/** MS-OXDSCLI §2.2.4.2.1 error codes. */
const ERROR = {
  notFound: { code: 500, message: 'The e-mail address cannot be found.' },
  // 9.4: every protocol the answer could offer is switched off for the account
  protocolDisabled: { code: 500, message: 'No client protocol is enabled for this account.' },
  invalidRequest: { code: 600, message: 'Invalid Request' },
  schemaNotSupported: { code: 601, message: 'The requested schema version is not supported' },
} as const;

export type OutlookProtocol = 'IMAP' | 'POP3' | 'SMTP';

/**
 * 9.4: the internet-mail <Protocol> blocks of a mail account (outlook/2006a schema) answer for the
 * account's protocol switches — IMAP (else POP3) for incoming mail, SMTP for
 * submission. The mapiHttp block is decided by mapiAnnouncement().
 */
export function outlookProtocols(access: Pick<ProtocolAccess, 'imap' | 'pop3' | 'smtp'>): OutlookProtocol[] {
  const incoming: OutlookProtocol[] = access.imap ? ['IMAP'] : access.pop3 ? ['POP3'] : [];
  return [...incoming, ...(access.smtp ? ['SMTP' as const] : [])];
}

/** The only mapiHttp response format CoreMail serves (MS-OXDSCLI 3.2.5.1, version 1). */
export const MAPI_HTTP_VERSION = 1;

/**
 * MS-OXDSCLI 3.2.5.1: the X-MapiHttpCapability header is valid when it is an
 * integer > 0 and the server supports a version ≤ it; the answer uses the
 * highest such version. Null = no (valid) header → no mapiHttp block.
 */
export function mapiHttpVersion(header: string | undefined): number | null {
  if (header === undefined || !/^\s*\d{1,9}\s*$/.test(header)) return null;
  return parseInt(header, 10) >= MAPI_HTTP_VERSION ? MAPI_HTTP_VERSION : null;
}

/** Pure: whether the mapiHttp block goes into the answer (all conditions met). */
export function announcesMapi(c: { switchOn: boolean; version: number | null; endpoints: MapiEndpoints | null; trusted: boolean }): boolean {
  return c.switchOn && c.version !== null && c.endpoints !== null && c.trusted;
}

/** The mapiHttp <Protocol> block, version 1 format: MailStore + AddressBook, internal and external URL. */
export function mapiHttpBlock(urls: MapiEndpoints, version = MAPI_HTTP_VERSION): string {
  const pair = (url: string): string => `
          <InternalUrl>${escapeXml(url)}</InternalUrl>
          <ExternalUrl>${escapeXml(url)}</ExternalUrl>`;
  return `
      <Protocol Type="mapiHttp" Version="${version}">
        <MailStore>${pair(urls.mailStore)}
        </MailStore>
        <AddressBook>${pair(urls.addressBook)}
        </AddressBook>
      </Protocol>`;
}
type AutodiscoverError = typeof ERROR[keyof typeof ERROR];

type ResponseSchema = 'outlook' | 'mobilesync';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(str: string): string {
  return str.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const cp = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Text content of the first `<[prefix:]name>` element (entities decoded), or null. */
export function xmlElementText(body: string, name: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'i');
  const m = re.exec(body);
  return m ? decodeXmlEntities(m[1]!).trim() : null;
}

/** IMAP encryption: implicit TLS, else STARTTLS (CoreMail refuses login before TLS). */
export function imapEncryption(cfg: Pick<ServerConfig, 'imapSsl'>): 'SSL' | 'TLS' {
  return cfg.imapSsl ? 'SSL' : 'TLS';
}

/**
 * Pure: an unauthenticated GET/HEAD that verifiably reached us over plain HTTP.
 * The gateway sets X-Forwarded-Proto and, only when that scheme is known,
 * X-CoreMail-Proto-Verified: behind a reverse proxy without TRUST_PROXY the
 * scheme is a guess ("http" also for HTTPS clients) and a redirect would loop.
 */
export function isPlainHttpProbe(r: {
  method: string; forwardedProto: string | undefined; protoVerified: boolean; hasAuthorization: boolean;
}): boolean {
  return (r.method === 'GET' || r.method === 'HEAD') && !r.hasAuthorization
    && r.protoVerified && r.forwardedProto?.toLowerCase() === 'http';
}

/**
 * MS-OXDSCLI "HTTP redirect method": a plain-HTTP probe (isPlainHttpProbe) is
 * answered with a 302 to the HTTPS Autodiscover endpoint — never with a Basic
 * challenge, which would invite the client to send the password in clear
 * text. Null when no HTTPS endpoint is configured.
 */
export function plainHttpRedirectTarget(autodiscoverBase: string): string | null {
  if (!/^https:\/\//i.test(autodiscoverBase)) return null;
  return `${autodiscoverBase.replace(/\/+$/, '')}/Autodiscover/Autodiscover.xml`;
}

function sendChallenge(res: Response): void {
  res.set('WWW-Authenticate', REALM_CHALLENGE);
  res.status(401).send('Unauthorized');
}

/** Error response (HTTP 200, MS-OXDSCLI §2.2.4.2.1 / MS-ASCMD Autodiscover Error). */
function sendError(res: Response, err: AutodiscoverError): void {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send(`<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="${NS_RESPONSE}">
  <Response>
    <Error Time="${new Date().toISOString().slice(11, 19)}" Id="0">
      <ErrorCode>${err.code}</ErrorCode>
      <Message>${escapeXml(err.message)}</Message>
      <DebugData />
    </Error>
  </Response>
</Autodiscover>`);
}

/** One <Protocol> block of the mail account answer (login = the account's primary address). */
function outlookProtocolBlock(protocol: OutlookProtocol, email: string, cfg: ServerConfig): string {
  const login = `
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>`;
  if (protocol === 'SMTP') {
    const smtpEncryption = !cfg.smtpTls ? 'None' : cfg.smtpPort === SMTPS_PORT ? 'SSL' : 'TLS';
    return `
      <Protocol>
        <Type>SMTP</Type>
        <Server>${escapeXml(cfg.smtpHost)}</Server>
        <Port>${cfg.smtpPort}</Port>${login}
        <Encryption>${smtpEncryption}</Encryption>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>`;
  }
  // IMAP / POP3: explicit <Encryption> — implicit TLS (SSL), else STARTTLS/STLS
  // (TLS); CoreMail refuses a login before TLS on both protocols.
  const [host, port, ssl] = protocol === 'IMAP'
    ? [cfg.imapHost, cfg.imapPort, cfg.imapSsl]
    : [cfg.pop3Host, cfg.pop3Port, cfg.pop3Ssl];
  return `
      <Protocol>
        <Type>${protocol}</Type>
        <Server>${escapeXml(host)}</Server>
        <Port>${port}</Port>${login}
        <SSL>${ssl ? 'on' : 'off'}</SSL>
        <Encryption>${imapEncryption({ imapSsl: ssl })}</Encryption>
        <AuthRequired>on</AuthRequired>
      </Protocol>`;
}

/**
 * Mail account (outlook/2006a) schema response. The account is always described by its PRIMARY
 * address — also when the client asked for one of its aliases: the mail
 * protocols log in with the primary address only, and AutoDiscoverSMTPAddress
 * tells the client which address the profile belongs to. (No redirectAddr: the
 * caller is already authenticated for this account, a redirect would only cost
 * another round trip and a client prompt.) 9.4: only `protocols` (the
 * account's enabled ones, outlookProtocols()) get a <Protocol> block; `mapi`
 * adds the mapiHttp block first (the LegacyDN is the DN the MAPI Connect
 * names, storage legacyDnFor).
 */
export function buildOutlookResponse(user: MailAuthUser, cfg: ServerConfig, protocols: OutlookProtocol[], mapi: MapiEndpoints | null = null): string {
  // LTSC 2019/2021/2024 desktop clients (v3.18.38): <User><LegacyDN> is mandatory.
  // The LegacyDN carries the caller's own id — the response only ever describes
  // the authenticated account itself.
  const email = user.email;
  const webHost = (() => {
    try { return new URL(cfg.owaUrl).hostname; } catch { return cfg.smtpHost; }
  })();
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="${NS_RESPONSE}">
  <Response xmlns="${NS_OUTLOOK}">
    <User>
      <DisplayName>${escapeXml(user.displayName || email)}</DisplayName>
      <LegacyDN>${escapeXml(legacyDnFor(user.id))}</LegacyDN>
      <AutoDiscoverSMTPAddress>${escapeXml(email)}</AutoDiscoverSMTPAddress>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <MicrosoftOnline>False</MicrosoftOnline>${mapi ? mapiHttpBlock(mapi) : ''}${protocols.map((p) => outlookProtocolBlock(p, email, cfg)).join('')}
      <PublicFolderInformation>
        <SmtpAddress>publicfolder@${escapeXml(webHost.replace(/^mail\./, ''))}</SmtpAddress>
      </PublicFolderInformation>
    </Account>
  </Response>
</Autodiscover>`;
}

/** MS-ASCMD Autodiscover response (mobilesync schema): the ActiveSync URL. */
function buildMobileSyncResponse(user: MailAuthUser, cfg: ServerConfig): string {
  const email = user.email;
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="${NS_RESPONSE}">
  <Response xmlns="${NS_MOBILESYNC}">
    <Culture>en:us</Culture>
    <User>
      <DisplayName>${escapeXml(user.displayName || email)}</DisplayName>
      <EMailAddress>${escapeXml(email)}</EMailAddress>
    </User>
    <Action>
      <Settings>
        <Server>
          <Type>MobileSync</Type>
          <Url>${escapeXml(cfg.easUrl)}</Url>
          <Name>${escapeXml(cfg.easUrl)}</Name>
        </Server>
      </Settings>
    </Action>
  </Response>
</Autodiscover>`;
}

interface ParsedRequest { email: string | null; schema: ResponseSchema | 'unsupported'; invalid: boolean }

function parseRequest(req: Request): ParsedRequest {
  let email: string | null = null;
  let schemaRaw: string | null = null;
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? req.body : '';
    email = xmlElementText(body, 'EMailAddress');
    schemaRaw = xmlElementText(body, 'AcceptableResponseSchema');
  } else {
    const q = req.query['emailaddress'];
    if (q !== undefined && typeof q !== 'string') return { email: null, schema: 'outlook', invalid: true };
    email = q ?? null;
  }
  const schema: ParsedRequest['schema'] = !schemaRaw || schemaRaw === NS_OUTLOOK
    ? 'outlook'
    : schemaRaw === NS_MOBILESYNC ? 'mobilesync' : 'unsupported';
  return { email: email || null, schema, invalid: false };
}

/** True when `email` is the caller's own primary address or one of its aliases. */
async function isOwnAddress(user: MailAuthUser, email: string): Promise<boolean> {
  const wanted = email.toLowerCase();
  if (wanted === user.email.toLowerCase()) return true;
  const alias = await prisma.emailAlias.findFirst({
    where: { address: wanted, targetUserId: user.id },
    select: { id: true },
  });
  return alias !== null;
}

/** HTTPS target for a plain-HTTP probe, or null (not a probe / no HTTPS endpoint / settings unreadable). */
async function redirectTargetForPlainHttp(req: Request, hasAuthorization: boolean): Promise<string | null> {
  const probe = isPlainHttpProbe({
    method: req.method,
    forwardedProto: req.get('X-Forwarded-Proto'),
    protoVerified: req.get(PROTO_VERIFIED_HEADER) === '1',
    hasAuthorization,
  });
  if (!probe) return null;
  try {
    return plainHttpRedirectTarget((await getServerConfig()).autodiscoverBase);
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) throw err;
    return null;
  }
}

/**
 * The MAPI endpoints to announce to this caller, or null. The certificate is
 * only read when everything else allows the block; a database error
 * propagates (the handler answers 503).
 */
async function mapiAnnouncement(req: Request, access: ProtocolAccess, cfg: ServerConfig, userId: string): Promise<MapiEndpoints | null> {
  const version = mapiHttpVersion(req.get('X-MapiHttpCapability'));
  const endpoints = mapiEndpointsFor(cfg);
  if (!access.mapi || version === null || endpoints === null) return null;
  const trusted = await mapiHttpsTrusted();
  if (!announcesMapi({ switchOn: access.mapi, version, endpoints, trusted })) {
    log.info({ userId }, 'Autodiscover v1: MAPI is on but HTTPS has no trusted certificate — mapiHttp not announced');
    return null;
  }
  return endpoints;
}

export async function handleAutodiscoverV1(req: Request, res: Response): Promise<void> {
  // v5.2.3: desktop clients first probe without an Authorization header and expect
  // 401 + WWW-Authenticate before it sends credentials.
  const authHeader = req.get('Authorization') ?? '';
  // v5.2.15: the scheme is case-insensitive (RFC 7235 §2.1) — some desktop client builds send `basic`.
  const scheme = authHeader.split(' ')[0]?.toLowerCase() ?? '';
  const httpsTarget = await redirectTargetForPlainHttp(req, authHeader !== '');
  if (httpsTarget) {
    log.debug({ method: req.method }, 'Autodiscover v1: plain HTTP probe → 302 to HTTPS');
    res.set('Cache-Control', 'no-store');
    res.redirect(302, httpsTarget);
    return;
  }
  if (scheme !== 'basic') {
    // No header, Negotiate/NTLM, Bearer (Modern Auth tokens we cannot
    // validate) …: ask for Basic. No database access and no persistent log for
    // unauthenticated requests (v7.1: the old Bearer "forensic" SystemLog write
    // let anyone fill the database).
    log.debug({ scheme: scheme || 'none', method: req.method }, 'Autodiscover v1: requesting Basic auth');
    sendChallenge(res);
    return;
  }

  // Whitespace-tolerant slicing (some clients insert multiple spaces)
  const tokenStart = authHeader.indexOf(' ');
  const decoded = Buffer.from(tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '', 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const login = colonIdx !== -1 ? decoded.slice(0, colonIdx).trim() : '';
  const password = colonIdx !== -1 ? decoded.slice(colonIdx + 1) : '';
  if (!login || !password) {
    log.debug({ hasUser: !!login, hasPassword: !!password }, 'Autodiscover v1: Basic-Auth header malformed → 401');
    sendChallenge(res);
    return;
  }

  // 10.5 review: the gateway marks a forwarded IP it could verify (IP_VERIFIED_HEADER)
  const client = clientIpInfoFromRequest(req.socket?.remoteAddress, req.headers);
  const clientIp = client.ip;
  const auth = await verifyMailCredentials(login, password, { ip: clientIp, ipTrusted: client.trusted, protocol: 'autodiscover' });
  if (auth.status === 'locked') {
    res.set('Retry-After', String(auth.retryAfterSec));
    res.status(429).send('Too Many Requests');
    return;
  }
  if (auth.status === 'error') {
    res.set('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }
  if (auth.status !== 'ok') {
    // v7: no derivative of a submitted password is ever logged. Failed attempts
    // are bounded by the shared lockout (per IP and per account).
    log.warn({ login, ip: clientIp, status: auth.status, userAgent: req.get('User-Agent') ?? '' },
      'Autodiscover v1: authentication failed');
    // 8.0.0: the database row is sampled (per IP and in total per minute) — the pino
    // line above records every attempt.
    const budget = failedAuthLogBudget.take(clientIp || 'unknown');
    if (budget.ok) void prisma.systemLog.create({
      data: {
        level:    'WARN',
        service:  'autodiscover',
        category: 'AUTODISCOVER_AUTH',
        message:  `Autodiscover Basic-Auth failed: ${login.slice(0, 320)} (${auth.status})`,
        metadata: {
          protocol:  'AUTODISCOVER',
          email:     login.slice(0, 320),
          reason:    auth.status === 'mfa_app_password_required' ? 'MFA_APP_PASSWORD_REQUIRED' : 'WRONG_PASSWORD_OR_USER',
          ip:        clientIp || 'unknown',
          userAgent: (req.get('User-Agent') ?? '').slice(0, 256),
          path:      req.originalUrl.slice(0, 256),
          ...(budget.suppressedBefore > 0 ? { suppressedBefore: budget.suppressedBefore } : {}),
        },
      },
    }).catch(() => { /* non-fatal */ });
    sendChallenge(res);
    return;
  }

  const parsed = parseRequest(req);
  if (parsed.invalid) return sendError(res, ERROR.invalidRequest);
  if (parsed.schema === 'unsupported') return sendError(res, ERROR.schemaNotSupported);
  const email = parsed.email ?? auth.user.email;

  let own: boolean;
  try {
    own = await isOwnAddress(auth.user, email);
  } catch (err) {
    log.error({ err }, 'Autodiscover v1: alias lookup failed');
    res.set('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }
  if (!own) {
    // Same answer for other users, unknown accounts and foreign domains.
    log.debug({ userId: auth.user.id }, 'Autodiscover v1: address is not the caller\'s own → Error 500');
    return sendError(res, ERROR.notFound);
  }

  let cfg: ServerConfig;
  let access: ProtocolAccess;
  let mapi: MapiEndpoints | null = null;
  try {
    cfg = await getServerConfig();
    // 9.4: only protocols that are switched on for the account are announced.
    access = await effectiveProtocolAccess({ id: auth.user.id, domainId: auth.user.domainId });
    if (parsed.schema === 'outlook') mapi = await mapiAnnouncement(req, access, cfg, auth.user.id);
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) log.error({ err }, 'Autodiscover v1: protocol switches not readable');
    res.set('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }

  log.info({ userId: auth.user.id, schema: parsed.schema, method: req.method, mapiHttp: mapi !== null }, 'Autodiscover v1 request (authenticated)');
  if (parsed.schema === 'mobilesync') {
    if (!access.activesync) return sendError(res, ERROR.protocolDisabled);
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(buildMobileSyncResponse(auth.user, cfg));
    return;
  }
  const protocols = outlookProtocols(access);
  if (protocols.length === 0 && !mapi) return sendError(res, ERROR.protocolDisabled);
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(buildOutlookResponse(auth.user, cfg, protocols, mapi));
}
