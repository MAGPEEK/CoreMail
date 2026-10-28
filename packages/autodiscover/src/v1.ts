import type { Request, Response } from 'express';
import { createLogger, verifyPassword } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v1');

/**
 * v5.2.14: verifies Basic-Auth credentials against User.passwordHash AND
 * AppPassword.hash (same logic as the EWS middleware).  Returns true/false.
 *
 * CRITICAL: previously V1 accepted any password as valid — Outlook
 * then got an OK from Autodiscover but failed at EWS/MAPI (401),
 * polled Autodiscover again, got OK again → endless loop with no chance
 * that the user would ever hit the right password.
 */
async function validateBasicAuth(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const user = await prisma.user.findUnique({
    where:  { email: email.toLowerCase() },
    select: { id: true, active: true, passwordHash: true },
  }).catch(() => null);

  if (!user || !user.active) return false;

  // 1) Regular password hash
  if (user.passwordHash) {
    if (await verifyPassword(password, user.passwordHash).catch(() => false)) return true;
  }
  // 2) Fallback: app password (mandatory for MFA accounts)
  const appPasswords = await prisma.appPassword.findMany({
    where: { userId: user.id },
    select: { id: true, hash: true },
  }).catch(() => []);
  for (const ap of appPasswords) {
    if (await verifyPassword(password, ap.hash).catch(() => false)) {
      void prisma.appPassword.update({
        where: { id: ap.id }, data: { lastUsedAt: new Date() },
      }).catch(() => { /* ignore */ });
      return true;
    }
  }
  return false;
}

/** Normalizes an Outlook username (DOMAIN\user or user@domain) to e-mail form. */
function normalizeBasicAuthUser(rawUser: string): string {
  const bsIdx = rawUser.lastIndexOf('\\');
  return (bsIdx !== -1 ? rawUser.slice(bsIdx + 1) : rawUser).trim();
}

// v5.7.0: MAPI/HTTP is optional (BCP → Server → "MAPI over HTTP",
// ServerSettings.mapiHttpEnabled, default OFF). Only when active is
// <Protocol Type="mapiHttp"> announced and Outlook sets up an
// "Exchange" account. Otherwise only IMAP+SMTP+ActiveSync → IMAP account.
// Limitation: Outlook 2024 LTSC / M365 Classic enforce Modern Auth against
// Entra/ADFS for Exchange accounts — there IMAP remains the safe route
// (see v5.3.x/v5.4.0 in the CHANGELOG). Outlook 2013–2021 connect via Basic.

function buildAutodiscoverResponse(
  email: string,
  displayName: string,
  legacyDn: string,
  cfg: Awaited<ReturnType<typeof getServerConfig>>,
): string {
  // v3.18.38: Outlook LTSC 2019/2021/2024 compatible Autodiscover response.
  // CRITICAL (per research of Microsoft Docs + the Grommunio implementation):
  //   - AuthPackage MUST be "Basic" (capital B), some Outlook builds are case-sensitive
  //   - <User><LegacyDN> is mandatory (Outlook uses it as the internal user identity)
  //   - <GroupingInformation> in the EXPR block since Exchange 2013 SP1
  //   - <PublicFolderInformation> dummy even if no public folders exist
  //   - MAPI/HTTP block (Type=mapiHttp) only if cfg.mapiHttpEnabled (v5.7.0)
  const ewsHost = (() => {
    try { return new URL(cfg.ewsUrl).hostname; } catch { return cfg.smtpHost; }
  })();
  const mapiBase = cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, '');
  const oabUrl = `${mapiBase}/OAB/`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${escapeXml(displayName)}</DisplayName>
      <LegacyDN>${escapeXml(legacyDn)}</LegacyDN>
      <AutoDiscoverSMTPAddress>${escapeXml(email)}</AutoDiscoverSMTPAddress>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <MicrosoftOnline>False</MicrosoftOnline>
      ${cfg.mapiHttpEnabled ? `
      <Protocol Type="mapiHttp" Version="1">
        <MailStore>
          <InternalUrl>${escapeXml(mapiBase)}/mapi/emsmdb/</InternalUrl>
          <ExternalUrl>${escapeXml(mapiBase)}/mapi/emsmdb/</ExternalUrl>
        </MailStore>
        <AddressBook>
          <InternalUrl>${escapeXml(mapiBase)}/mapi/nspi/</InternalUrl>
          <ExternalUrl>${escapeXml(mapiBase)}/mapi/nspi/</ExternalUrl>
        </AddressBook>
      </Protocol>` : ''}
      <!--
        v3.18.39: EXCH + EXPR Blöcke ENTFERNT.

        Hintergrund: Outlook 2016+/LTSC benötigt für „Exchange-Profile"
        entweder MAPI-over-HTTP (Type=mapiHttp) oder RPC-over-HTTPS (EXPR)
        oder intra-Exchange RPC/TCP (EXCH). Alle drei Pfade nutzen das
        binäre MAPI/ROP-Protokoll. MAPI/HTTP liefern wir nur über den
        optionalen mapiHttp-Block oben aus (v5.7.0), EXCH/EXPR nie.

        Wenn wir die Blöcke trotzdem ausliefern, versucht Outlook eine
        RPC-Verbindung an den Server-Hostname (Port 135/RPC-Endpoint-Mapper
        oder Port 443/rpcproxy.dll) — und hängt minutenlang im Connect-Loop.
        User-Symptom: „Outlook reagiert nicht", VIDs mit Status „wird
        hergestellt" und Protokoll RPC/TCP. Plus Fehler „Diese Ordnergruppe
        kann nicht geöffnet werden — Fehler bei der Anmeldung bei Exchange".

        Ohne aktiviertes MAPI/HTTP: nur IMAP/SMTP/ActiveSync
        in der Autodiscover-Response. Outlook konfiguriert sich dann als
        „IMAP-Konto" — Mail funktioniert sofort. Kalender + Kontakte gehen
        per CalDAV/CardDAV (z.B. Apple Kalender, Thunderbird Lightning,
        eM Client) oder direkt über OWA im Browser.
      -->
      <Protocol>
        <Type>IMAP</Type>
        <Server>${escapeXml(cfg.imapHost)}</Server>
        <Port>${cfg.imapPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>${cfg.imapSsl ? 'on' : 'off'}</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${escapeXml(cfg.smtpHost)}</Server>
        <Port>${cfg.smtpPort}</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <Encryption>${cfg.smtpTls ? 'TLS' : 'None'}</Encryption>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
      </Protocol>
      <PublicFolderInformation>
        <SmtpAddress>publicfolder@${escapeXml(ewsHost.replace(/^mail\./, ''))}</SmtpAddress>
      </PublicFolderInformation>
    </Account>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>ActiveSync</Type>
        <Server>${escapeXml(cfg.easUrl)}</Server>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SSL>${cfg.imapSsl ? 'on' : 'off'}</SSL>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractEmailFromXml(body: string): string | null {
  const match = /<EMailAddress>(.*?)<\/EMailAddress>/i.exec(body);
  return match?.[1] ?? null;
}

export async function handleAutodiscoverV1(req: Request, res: Response): Promise<void> {
  // v5.2.3 fix: Outlook first does a GET probe without an Auth header on
  // the V1 endpoint. It expects 401 + WWW-Authenticate (that is how Outlook knows
  // the endpoint supports auth). If we return 400 instead,
  // Outlook aborts discovery and prompts endlessly for a password.
  //
  // Solution: on missing Authorization → 401 with a multi-scheme header,
  // so Outlook sends the credentials. In the second request (with auth)
  // we then parse the body and return the XML.
  //
  // Note: we do NOT validate the credentials here (Autodiscover only returns
  // setup data, no user data). That is customary for Exchange.
  const authHeader = req.get('Authorization') ?? '';
  // v5.2.15: match the auth scheme case-insensitively (RFC 7235 §2.1). Some
  // Outlook builds (especially Outlook LTSC on current Win11 patches)
  // send `basic` (lowercase). Express returns the raw value, so
  // startsWith('Basic ') is case-sensitive.
  const authSchemeLower = authHeader.split(' ')[0]?.toLowerCase() ?? '';
  if (!authHeader) {
    log.debug({ method: req.method, url: req.originalUrl }, 'Autodiscover v1: no auth, sending 401 challenge');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }
  // Negotiate/NTLM token → we reject and push for Basic
  if (authSchemeLower === 'negotiate' || authSchemeLower === 'ntlm') {
    log.debug({ scheme: authSchemeLower }, 'Autodiscover v1: Negotiate/NTLM → fordere Basic');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }
  // v5.3.2: log Bearer tokens forensically — Outlook 2024 LTSC only sends
  // Bearer. We decode the JWT payload (NOT verify, just base64
  // decode) to see: iss (which identity provider?), aud (addressed to
  // whom?), sub (which user?), scp (which scopes?). That tells us
  // precisely where Outlook got the token from and lets us decide whether WS-
  // Trust emulation or an ADFS login UI is needed.
  if (authSchemeLower === 'bearer') {
    const tokenStart = authHeader.indexOf(' ');
    const tok = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
    let claims: Record<string, unknown> = {};
    try {
      const parts = tok.split('.');
      if (parts.length >= 2 && parts[1]) {
        const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
        const json = Buffer.from(padded, 'base64').toString('utf8');
        claims = JSON.parse(json) as Record<string, unknown>;
      }
    } catch { /* unverified decode failed — empty token */ }
    log.warn({
      ip: req.ip,
      tokenLen: tok.length,
      iss: claims['iss'],
      aud: claims['aud'],
      sub: claims['sub'],
      scp: claims['scp'],
      tid: claims['tid'],
      appid: claims['appid'],
      exp: claims['exp'],
      userAgent: req.get('User-Agent') ?? '',
    }, 'Autodiscover v1: Bearer-Token empfangen (forensisch decoded, nicht verified)');
    // SystemLog for BCP visibility
    void prisma.systemLog.create({
      data: {
        level:    'INFO',
        service:  'autodiscover',
        category: 'MAPI_AUTH',
        message:  `Autodiscover Bearer-Token (iss=${claims['iss'] ?? 'n/a'}, aud=${claims['aud'] ?? 'n/a'}, sub=${claims['sub'] ?? 'n/a'})`,
        metadata: {
          protocol:  'AUTODISCOVER',
          reason:    'BEARER_TOKEN_INSPECTION',
          claims:    JSON.parse(JSON.stringify(claims)),  // Prisma JSON-safe
          ip:        req.ip ?? 'unknown',
          userAgent: req.get('User-Agent') ?? '',
        },
      },
    }).catch(() => { /* non-fatal */ });
    // Bearer not accepted by us (we do not sign for the Outlook aud)
    // — send back 401 with an ADFS challenge
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { publicHostname: true, useHttps: true, httpPort: true },
    }).catch(() => null);
    const hostname = settings?.publicHostname ?? 'mail.localhost';
    const scheme = settings?.useHttps !== false ? 'https' : 'http';
    const port = settings?.httpPort ?? 443;
    const portSuffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
    const base = `${scheme}://${hostname}${portSuffix}`;
    // v5.3.4: Bearer removed — otherwise Outlook 2024 LTSC would start Modern Auth
    // at login.microsoftonline.com instead of sending Basic auth to us.
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }

  // v5.2.14: CRITICAL — Basic auth must be VALIDATED!
  // Previously V1 accepted any password. Outlook then got valid XML
  // with a WRONG password, but failed at EWS/MAPI (which check correctly),
  // prompted the user again, sent to Autodiscover again (which said OK
  // again), → ENDLESS LOOP.
  let basicAuthUser: string | null = null;  // raw username (can be admin or admin@domain)
  let basicAuthPassword: string | null = null;
  if (authSchemeLower === 'basic') {
    // Whitespace-tolerant slicing (Outlook sometimes inserts multiple spaces)
    const tokenStart = authHeader.indexOf(' ');
    const b64 = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        basicAuthUser     = normalizeBasicAuthUser(decoded.slice(0, colonIdx));
        basicAuthPassword = decoded.slice(colonIdx + 1);
      }
    } catch { /* malformed header — handled as 401 below */ }
  }

  if (!basicAuthUser || !basicAuthPassword) {
    log.warn({
      ip: req.ip,
      scheme: authSchemeLower,
      hasUser: !!basicAuthUser,
      hasPassword: !!basicAuthPassword,
    }, 'Autodiscover v1: Basic-Auth-Header malformed → 401');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }

  // v5.2.15: bare-username fallback. With NTLM-style `DOMAIN\user` Outlook
  // sometimes sends only `user` (without @domain). If no @ is present, we
  // look up the user in the primary domain.
  let basicAuthEmail = basicAuthUser;
  if (!basicAuthUser.includes('@')) {
    const primaryDomain = await prisma.domain.findFirst({
      where:  { primary: true, active: true },
      select: { name: true },
    }).catch(() => null);
    if (primaryDomain) {
      basicAuthEmail = `${basicAuthUser}@${primaryDomain.name}`;
      log.debug({ raw: basicAuthUser, email: basicAuthEmail }, 'Autodiscover v1: bare username → expanded mit primary domain');
    }
  }

  const authOk = await validateBasicAuth(basicAuthEmail, basicAuthPassword);
  if (!authOk) {
    // v5.2.16: forensic logging to see WHAT Outlook sends without
    // leaking the password itself: length + code points of the first/last
    // 2 characters (trailing whitespace / newline / encoding issue detectable).
    const pwLen   = basicAuthPassword.length;
    const pwCodes = pwLen >= 4
      ? [basicAuthPassword.charCodeAt(0), basicAuthPassword.charCodeAt(1),
         basicAuthPassword.charCodeAt(pwLen - 2), basicAuthPassword.charCodeAt(pwLen - 1)]
      : Array.from(basicAuthPassword).map((c) => c.charCodeAt(0));
    log.warn({
      email: basicAuthEmail, ip: req.ip,
      pwLen, pwCodes,
      userAgent: req.get('User-Agent') ?? '',
    }, 'Autodiscover v1: Passwort + App-Passwort fehlgeschlagen');
    // SystemLog for audit (analogous to the EWS middleware in writeAuthFailureLog)
    void prisma.systemLog.create({
      data: {
        level:    'WARN',
        service:  'autodiscover',
        category: 'MAPI_AUTH',
        message:  `Autodiscover Basic-Auth fehlgeschlagen: ${basicAuthEmail} (pwLen=${pwLen}, codes=[${pwCodes.join(',')}])`,
        metadata: {
          protocol:  'AUTODISCOVER',
          email:     basicAuthEmail,
          reason:    'WRONG_PASSWORD_OR_USER',
          pwLen,
          pwCodes,
          ip:        req.ip ?? 'unknown',
          userAgent: req.get('User-Agent') ?? '',
          path:      req.originalUrl,
        },
      },
    }).catch(() => { /* non-fatal */ });
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }

  // Auth OK — extract e-mail from the body (or fall back to the Basic-Auth e-mail)
  let email: string | null = null;
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    email = extractEmailFromXml(body);
  } else {
    email = (req.query['emailaddress'] as string | undefined) ?? null;
  }
  if (!email && basicAuthEmail.includes('@')) email = basicAuthEmail;

  if (!email) {
    log.warn({ method: req.method }, 'Autodiscover v1: no email found in request body or header');
    res.status(400).send('<?xml version="1.0"?><Autodiscover><Response><Error/></Response></Autodiscover>');
    return;
  }

  log.info({ email, method: req.method }, 'Autodiscover v1 request (authenticated)');

  const [user, cfg] = await Promise.all([
    prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, displayName: true, email: true },
    }),
    getServerConfig(),
  ]);

  const displayName = user?.displayName ?? email;
  // v3.18.38: LegacyDN is mandatory for MAPI profiles (Outlook uses it as the
  // internal user identity). Format per Microsoft spec.
  const userId = user?.id ?? email.split('@')[0] ?? 'unknown';
  const legacyDn = `/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=${userId}`;

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(buildAutodiscoverResponse(email, displayName, legacyDn, cfg));
}
