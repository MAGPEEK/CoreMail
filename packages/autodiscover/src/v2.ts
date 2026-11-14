import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v2');

// Autodiscover v2 — JSON response (Outlook 2019/2022/365)
// GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol={AutodiscoverV1|IMAP|SMTP|ActiveSync}
// EWS was removed in v7.0.0: Protocol=EWS answers 404 NoSuchProtocol.
export async function handleAutodiscoverV2(req: Request, res: Response): Promise<void> {
  // Express has already percent-decoded the route param. A second decode used
  // to throw URIError on input like "%25E0%25A4%25A" and crash the process.
  const email = req.params['email'] ?? '';
  const protocol = (req.query['Protocol'] as string | undefined)?.toLowerCase() ?? '';

  log.info({ email, protocol }, 'Autodiscover v2 request');

  if (!email || !email.includes('@')) {
    res.status(400).json({ ErrorCode: 'InvalidRequest', ErrorMessage: 'Email required' });
    return;
  }

  const cfg = await getServerConfig();

  // Outlook first asks for AutodiscoverV1 to find the v1 endpoint
  if (protocol === 'autodiscoverv1') {
    res.json({
      Protocol: 'AutodiscoverV1',
      Url: `${cfg.autodiscoverBase}/Autodiscover/Autodiscover.xml`,
    });
    return;
  }

  // v7.0.0: Exchange Web Services removed — never announce an EWS URL.
  if (protocol === 'ews') {
    res.status(404).json({ ErrorCode: 'NoSuchProtocol', ErrorMessage: 'EWS is not supported (use IMAP/SMTP, JMAP or ActiveSync)' });
    return;
  }

  if (protocol === 'imap') {
    res.json({
      Protocol: 'IMAP',
      Hostname: cfg.imapHost,
      Port: cfg.imapPort,
      SSL: cfg.imapSsl ? 'on' : 'off',
    });
    return;
  }

  if (protocol === 'smtp') {
    res.json({
      Protocol: 'SMTP',
      Hostname: cfg.smtpHost,
      Port: cfg.smtpPort,
      SSL: cfg.smtpTls ? 'STARTTLS' : 'None',
    });
    return;
  }

  if (protocol === 'activesync') {
    res.json({
      Protocol: 'ActiveSync',
      Url: cfg.easUrl,
    });
    return;
  }

  res.status(404).json({
    ErrorCode: 'NoSuchProtocol',
    ErrorMessage: `Protocol ${String(req.query['Protocol'])} not supported`,
  });
}
