import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('autodiscover:v1');

const EWS_URL = process.env['EWS_URL'] ?? 'https://mail.example.com/EWS/Exchange.asmx';
const OWA_URL = process.env['OWA_URL'] ?? 'https://mail.example.com/owa/';
const IMAP_HOST = process.env['IMAP_HOST'] ?? 'mail.example.com';
const SMTP_HOST = process.env['SMTP_HOST'] ?? 'mail.example.com';

function buildAutodiscoverResponse(email: string, displayName: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${escapeXml(displayName)}</DisplayName>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>EXCH</Type>
        <EwsUrl>${escapeXml(EWS_URL)}</EwsUrl>
        <EwsPartnerUrl>${escapeXml(EWS_URL)}</EwsPartnerUrl>
        <OWAUrl>${escapeXml(OWA_URL)}</OWAUrl>
      </Protocol>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${escapeXml(IMAP_HOST)}</Server>
        <Port>993</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${escapeXml(SMTP_HOST)}</Server>
        <Port>587</Port>
        <LoginName>${escapeXml(email)}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <Encryption>TLS</Encryption>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>off</UsePOPAuth>
        <SMTPLast>off</SMTPLast>
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
    // GET — try query param
    email = (req.query['emailaddress'] as string | undefined) ?? null;
  }

  if (!email) {
    log.warn({ method: req.method }, 'Autodiscover v1: no email found in request');
    res.status(400).send('<?xml version="1.0"?><Autodiscover><Response><Error/></Response></Autodiscover>');
    return;
  }

  log.info({ email }, 'Autodiscover v1 request');

  
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { displayName: true, email: true },
  });

  const displayName = user?.displayName ?? email;

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(buildAutodiscoverResponse(email, displayName));
}
