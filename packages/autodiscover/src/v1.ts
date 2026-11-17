import type { Request, Response } from 'express';
import { createLogger, PROTO_VERIFIED_HEADER } from '@coremail/core';
import { prisma, verifyMailCredentials, clientIpFromRequest, type MailAuthUser } from '@coremail/storage';
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
//    must validate, otherwise Outlook loops on a wrong password.)
//  - A caller only gets settings for its OWN address (primary address or one of
//    its aliases). Any other address — another user, an unknown account, a domain
//    this server does not host — gets the same Error 500, so nothing about other
//    accounts can be learned.
//  - AcceptableResponseSchema selects the answer: outlook/2006a (default) →
//    IMAP + SMTP account; mobilesync/2006 → MobileSync server URL; anything else →
//    Error 601.
//
// MAPI over HTTP (v6.0.0) and EWS (v7.0.0) were removed: no EXCH/EXPR/EXHTTP
// blocks — those make Outlook attempt a binary MAPI/RPC connection (v3.18.39).

const REALM_CHALLENGE = 'Basic realm="CoreMail Autodiscover"';
const NS_RESPONSE = 'http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006';
export const NS_OUTLOOK = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a';
export const NS_MOBILESYNC = 'http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006';
/** Organisation part of the X.500 LegacyDN (Outlook expects the Exchange 2007+ format). */
const LEGACY_DN_PREFIX = '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=';

/** MS-OXDSCLI §2.2.4.2.1 error codes. */
const ERROR = {
  notFound: { code: 500, message: 'The e-mail address cannot be found.' },
  invalidRequest: { code: 600, message: 'Invalid Request' },
  schemaNotSupported: { code: 601, message: 'The requested schema version is not supported' },
} as const;
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

/**
 * Outlook schema response. The account is always described by its PRIMARY
 * address — also when the client asked for one of its aliases: the mail
 * protocols log in with the primary address only, and AutoDiscoverSMTPAddress
 * tells Outlook which address the profile belongs to. (No redirectAddr: the
 * caller is already authenticated for this account, a redirect would only cost
 * another round trip and a client prompt.)
 */
function buildOutlookResponse(user: MailAuthUser, cfg: ServerConfig): string {
  // Outlook LTSC 2019/2021/2024 compatible (v3.18.38): <User><LegacyDN> is mandatory.
  // The LegacyDN carries the caller's own id — the response only ever describes
  // the authenticated account itself.
  const email = user.email;
  const webHost = (() => {
    try { return new URL(cfg.owaUrl).hostname; } catch { return cfg.smtpHost; }
  })();
  const smtpEncryption = !cfg.smtpTls ? 'None' : cfg.smtpPort === SMTPS_PORT ? 'SSL' : 'TLS';
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="${NS_RESPONSE}">
  <Response xmlns="${NS_OUTLOOK}">
    <User>
      <DisplayName>${escapeXml(user.displayName || email)}</DisplayName>
      <LegacyDN>${escapeXml(LEGACY_DN_PREFIX + user.id)}</LegacyDN>
      <AutoDiscoverSMTPAddress>${escapeXml(email)}</AutoDiscoverSMTPAddress>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <MicrosoftOnline>False</MicrosoftOnline>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${escapeXml(cfg.imapHost)}</Server>
        <Port>${cfg.imapPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>${cfg.imapSsl ? 'on' : 'off'}</SSL>
        <Encryption>${imapEncryption(cfg)}</Encryption>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${escapeXml(cfg.smtpHost)}</Server>
        <Port>${cfg.smtpPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <Encryption>${smtpEncryption}</Encryption>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>
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

export async function handleAutodiscoverV1(req: Request, res: Response): Promise<void> {
  // v5.2.3: Outlook first probes without an Authorization header and expects
  // 401 + WWW-Authenticate before it sends credentials.
  const authHeader = req.get('Authorization') ?? '';
  // v5.2.15: the scheme is case-insensitive (RFC 7235 §2.1) — some Outlook builds send `basic`.
  const scheme = authHeader.split(' ')[0]?.toLowerCase() ?? '';
  const httpsTarget = await redirectTargetForPlainHttp(req, authHeader !== '');
  if (httpsTarget) {
    log.debug({ method: req.method }, 'Autodiscover v1: plain HTTP probe → 302 to HTTPS');
    res.set('Cache-Control', 'no-store');
    res.redirect(302, httpsTarget);
    return;
  }
  if (scheme !== 'basic') {
    // No header, Negotiate/NTLM, Bearer (Outlook Modern Auth tokens we cannot
    // validate) …: ask for Basic. No database access and no persistent log for
    // unauthenticated requests (v7.1: the old Bearer "forensic" SystemLog write
    // let anyone fill the database).
    log.debug({ scheme: scheme || 'none', method: req.method }, 'Autodiscover v1: requesting Basic auth');
    sendChallenge(res);
    return;
  }

  // Whitespace-tolerant slicing (Outlook sometimes inserts multiple spaces)
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

  const clientIp = clientIpFromRequest(req.socket?.remoteAddress, req.headers['x-forwarded-for']);
  const auth = await verifyMailCredentials(login, password, { ip: clientIp, protocol: 'autodiscover' });
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
  try {
    cfg = await getServerConfig();
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) throw err;
    res.set('Retry-After', '30');
    res.status(503).send('Service Unavailable');
    return;
  }

  log.info({ userId: auth.user.id, schema: parsed.schema, method: req.method }, 'Autodiscover v1 request (authenticated)');
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(parsed.schema === 'mobilesync'
    ? buildMobileSyncResponse(auth.user, cfg)
    : buildOutlookResponse(auth.user, cfg));
}
