import type { Request, Response } from 'express';
import { createLogger, verifyPassword } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v1');

/**
 * v5.2.14: Verifiziert Basic-Auth-Credentials gegen User.passwordHash UND
 * AppPassword.hash (gleiche Logik wie EWS-Middleware).  Liefert true/false.
 *
 * KRITISCH: Vorher akzeptierte V1 jedes beliebige Passwort als gültig — Outlook
 * bekam dann von Autodiscover ein OK, scheiterte aber an EWS/MAPI (401),
 * pollte Autodiscover wieder, bekam wieder OK → Endlos-Loop ohne Aussicht
 * dass der User je das richtige Passwort treffen würde.
 */
async function validateBasicAuth(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const user = await prisma.user.findUnique({
    where:  { email: email.toLowerCase() },
    select: { id: true, active: true, passwordHash: true },
  }).catch(() => null);

  if (!user || !user.active) return false;

  // 1) Regulärer Passwort-Hash
  if (user.passwordHash) {
    if (await verifyPassword(password, user.passwordHash).catch(() => false)) return true;
  }
  // 2) Fallback: App-Passwort (Pflicht für MFA-Accounts)
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

/** Normalisiert Outlook-Username (DOMAIN\user oder user@domain) auf E-Mail-Form. */
function normalizeBasicAuthUser(rawUser: string): string {
  const bsIdx = rawUser.lastIndexOf('\\');
  return (bsIdx !== -1 ? rawUser.slice(bsIdx + 1) : rawUser).trim();
}

// v5.0.0: MAPI/HTTP ist jetzt DEFAULT AKTIV. Mit den v4.1-v4.7 Releases sind
// alle wichtigen ROPs implementiert (Logon, Folder-Browse, Mail-Read/Write,
// Send, Attachments, Move/Delete, Push-Notifications, virtuelle PIM-Folder,
// Server-Side-Search). Outlook kann sich jetzt nativ als Exchange-Konto
// einrichten statt IMAP-Fallback. Opt-out via `ENABLE_MAPI_HTTP=false`.
const MAPI_HTTP_ENABLED = process.env['ENABLE_MAPI_HTTP'] !== 'false';

function buildAutodiscoverResponse(
  email: string,
  displayName: string,
  legacyDn: string,
  cfg: Awaited<ReturnType<typeof getServerConfig>>,
): string {
  // v3.18.38: Outlook-LTSC-2019/2021/2024-kompatible Autodiscover-Response.
  // KRITISCH (laut Recherche an Microsoft Docs + Grommunio-Implementierung):
  //   - AuthPackage MUSS "Basic" (capital B) sein, manche Outlook-Builds sind case-sensitive
  //   - <User><LegacyDN> ist Pflicht (Outlook verwendet es als interne User-Identity)
  //   - <GroupingInformation> im EXPR-Block ab Exchange 2013 SP1
  //   - <PublicFolderInformation> Dummy auch wenn keine Public Folders existieren
  //   - MAPI/HTTP-Block (Type=mapiHttp) NICHT ausliefern bis wirklich implementiert
  const ewsHost = (() => {
    try { return new URL(cfg.ewsUrl).hostname; } catch { return cfg.smtpHost; }
  })();
  const oabUrl = `${cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, '')}/OAB/`;
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
      ${MAPI_HTTP_ENABLED ? `
      <!--
        v5.0.0: MAPI-over-HTTP DEFAULT AKTIV. Outlook 2013 SP1+ erkennt diesen
        <Protocol Type="mapiHttp"> als modernen Transport und nutzt /mapi/emsmdb/
        + /mapi/nspi/ — Account-Type "Exchange" statt "IMAP". Volle Funktionen:
        Logon, Folder-Browse, Mail-Lesen, Mail-Schreiben+Senden, Attachments,
        Move/Delete, Push-Notifications (Redis-pub/sub), virtuelle PIM-Folder
        (Kalender/Kontakte/Aufgaben/Notizen), Server-Side-Search.
      -->
      <Protocol Type="mapiHttp" Version="1">
        <MailStore>
          <InternalUrl>${escapeXml(cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, ''))}/mapi/emsmdb/</InternalUrl>
          <ExternalUrl>${escapeXml(cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, ''))}/mapi/emsmdb/</ExternalUrl>
        </MailStore>
        <AddressBook>
          <InternalUrl>${escapeXml(cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, ''))}/mapi/nspi/</InternalUrl>
          <ExternalUrl>${escapeXml(cfg.ewsUrl.replace(/\/EWS\/Exchange\.asmx$/i, ''))}/mapi/nspi/</ExternalUrl>
        </AddressBook>
      </Protocol>` : ''}
      <!--
        v3.18.39: EXCH + EXPR Blöcke ENTFERNT.

        Hintergrund: Outlook 2016+/LTSC benötigt für „Exchange-Profile"
        entweder MAPI-over-HTTP (Type=mapiHttp) oder RPC-over-HTTPS (EXPR)
        oder intra-Exchange RPC/TCP (EXCH). Alle drei Pfade nutzen das
        binäre MAPI/ROP-Protokoll, das wir aktuell NICHT vollständig
        implementiert haben (nur Stubs auf /mapi/emsmdb/ + /mapi/nspi/).

        Wenn wir die Blöcke trotzdem ausliefern, versucht Outlook eine
        RPC-Verbindung an den Server-Hostname (Port 135/RPC-Endpoint-Mapper
        oder Port 443/rpcproxy.dll) — und hängt minutenlang im Connect-Loop.
        User-Symptom: „Outlook reagiert nicht", VIDs mit Status „wird
        hergestellt" und Protokoll RPC/TCP. Plus Fehler „Diese Ordnergruppe
        kann nicht geöffnet werden — Fehler bei der Anmeldung bei Exchange".

        Lösung bis MAPI/HTTP voll implementiert ist: nur IMAP/SMTP/ActiveSync
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
  // v5.2.3-Fix: Outlook macht zuerst einen GET-Probe ohne Auth-Header auf
  // den V1-Endpoint. Erwartet wird 401 + WWW-Authenticate (so weiß Outlook
  // dass der Endpoint Auth unterstützt). Wenn wir stattdessen 400 zurückgeben
  // bricht Outlook die Discovery ab und prompted endlos nach Passwort.
  //
  // Lösung: Bei fehlender Authorization → 401 mit Multi-Scheme-Header,
  // damit Outlook die Credentials sendet. Im zweiten Request (mit Auth)
  // parsen wir dann den Body und liefern das XML.
  //
  // Hinweis: Wir validieren die Credentials hier NICHT (Autodiscover liefert
  // nur Setup-Daten, keine User-Daten). Das ist Exchange-üblich.
  const authHeader = req.get('Authorization') ?? '';
  // v5.2.15: Auth-Scheme case-insensitive matchen (RFC 7235 §2.1). Manche
  // Outlook-Builds (insbesondere Outlook-LTSC unter aktuellen Win11-Patches)
  // senden `basic` (lowercase). Express liefert den raw Value zurück, so
  // dass startsWith('Basic ') case-sensitiv ist.
  const authSchemeLower = authHeader.split(' ')[0]?.toLowerCase() ?? '';
  if (!authHeader) {
    log.debug({ method: req.method, url: req.originalUrl }, 'Autodiscover v1: no auth, sending 401 challenge');
    res.set('WWW-Authenticate', 'Negotiate, NTLM, Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }
  // Negotiate/NTLM-Token → wir lehnen ab und drängen auf Basic
  if (authSchemeLower === 'negotiate' || authSchemeLower === 'ntlm') {
    log.debug({ scheme: authSchemeLower }, 'Autodiscover v1: Negotiate/NTLM → fordere Basic');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }
  // v5.3.2: Bearer-Token forensisch loggen — Outlook 2024 LTSC sendet nur
  // noch Bearer. Wir entschlüsseln den JWT-Payload (NICHT verify, nur base64
  // decoden) um zu sehen: iss (welcher Identity Provider?), aud (an wen
  // gerichtet?), sub (welcher User?), scp (welche Scopes?). Damit wissen
  // wir präzise, woher Outlook das Token hat und können entscheiden ob WS-
  // Trust-Emulation oder ADFS-Login-UI nötig ist.
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
    // SystemLog für BCP-Sichtbarkeit
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
    // Bearer von uns nicht akzeptiert (wir signieren nicht für Outlook-aud)
    // — sende 401 mit ADFS-Challenge zurück
    const settings = await prisma.serverSettings.findUnique({
      where:  { id: 'singleton' },
      select: { publicHostname: true, useHttps: true, httpPort: true },
    }).catch(() => null);
    const hostname = settings?.publicHostname ?? 'mail.localhost';
    const scheme = settings?.useHttps !== false ? 'https' : 'http';
    const port = settings?.httpPort ?? 443;
    const portSuffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
    const base = `${scheme}://${hostname}${portSuffix}`;
    res.set('WWW-Authenticate', `Bearer realm="${base}", authorization_uri="${base}/adfs/oauth2/authorize", error="invalid_token", Basic realm="CoreMail Autodiscover"`);
    res.status(401).send('Unauthorized');
    return;
  }

  // v5.2.14: KRITISCH — Basic-Auth muss VALIDIERT werden!
  // Vorher akzeptierte V1 jedes Passwort. Outlook bekam dann gültiges XML
  // mit FALSCHEM Passwort, scheiterte aber an EWS/MAPI (die korrekt prüfen),
  // promptet User erneut, schickt erneut zu Autodiscover (das wieder OK
  // sagt), → ENDLOS-LOOP.
  let basicAuthUser: string | null = null;  // raw username (kann admin oder admin@domain sein)
  let basicAuthPassword: string | null = null;
  if (authSchemeLower === 'basic') {
    // Whitespace-tolerant slicen (Outlook fügt manchmal mehrere Leerzeichen ein)
    const tokenStart = authHeader.indexOf(' ');
    const b64 = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        basicAuthUser     = normalizeBasicAuthUser(decoded.slice(0, colonIdx));
        basicAuthPassword = decoded.slice(colonIdx + 1);
      }
    } catch { /* malformed header — wird unten als 401 behandelt */ }
  }

  if (!basicAuthUser || !basicAuthPassword) {
    log.warn({
      ip: req.ip,
      scheme: authSchemeLower,
      hasUser: !!basicAuthUser,
      hasPassword: !!basicAuthPassword,
    }, 'Autodiscover v1: Basic-Auth-Header malformed → 401');
    res.set('WWW-Authenticate', 'Negotiate, NTLM, Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }

  // v5.2.15: Bare-Username Fallback. Outlook sendet bei NTLM-Style `DOMAIN\user`
  // teilweise auch nur `user` (ohne @domain). Wenn kein @ enthalten ist, suchen
  // wir den User in der primären Domain.
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
    // v5.2.16: Forensisches Logging um zu sehen WAS Outlook sendet ohne
    // das Passwort selbst zu leaken: Länge + Code-Points der ersten/letzten
    // 2 Zeichen (Trailing-Whitespace / Newline / Encoding-Issue erkennbar).
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
    // SystemLog für Audit (analog zu EWS-Middleware in writeAuthFailureLog)
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
    res.set('WWW-Authenticate', 'Negotiate, NTLM, Basic realm="CoreMail Autodiscover"');
    res.status(401).send('Unauthorized');
    return;
  }

  // Auth OK — Email aus Body extrahieren (oder Fallback auf Basic-Auth-Email)
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
  // v3.18.38: LegacyDN ist Pflicht für MAPI-Profile (Outlook benutzt es als
  // interne User-Identity). Format nach Microsoft-Spec.
  const userId = user?.id ?? email.split('@')[0] ?? 'unknown';
  const legacyDn = `/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=${userId}`;

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(buildAutodiscoverResponse(email, displayName, legacyDn, cfg));
}
