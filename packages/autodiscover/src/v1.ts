import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v1');

function buildAutodiscoverResponse(email: string, displayName: string, cfg: Awaited<ReturnType<typeof getServerConfig>>): string {
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
        <EwsUrl>${escapeXml(cfg.ewsUrl)}</EwsUrl>
        <EwsPartnerUrl>${escapeXml(cfg.ewsUrl)}</EwsPartnerUrl>
        <OWAUrl>${escapeXml(cfg.owaUrl)}</OWAUrl>
      </Protocol>
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
      select: { displayName: true, email: true },
    }),
    getServerConfig(),
  ]);

  const displayName = user?.displayName ?? email;

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(buildAutodiscoverResponse(email, displayName, cfg));
}
