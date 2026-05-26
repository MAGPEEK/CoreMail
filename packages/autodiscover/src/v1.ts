import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v1');

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
  let email: string | null = null;

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    email = extractEmailFromXml(body);
  } else {
    email = (req.query['emailaddress'] as string | undefined) ?? null;
  }

  if (!email) {
    log.warn({ method: req.method }, 'Autodiscover v1: no email found in request');
    res.status(400).send('<?xml version="1.0"?><Autodiscover><Response><Error/></Response></Autodiscover>');
    return;
  }

  log.info({ email }, 'Autodiscover v1 request');

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
