import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { getServerConfig } from './settings.js';

const log = createLogger('autodiscover:v2');

// Autodiscover v2 — JSON response (Outlook 2019/2022/365)
// GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol={EWS|AutodiscoverV1|IMAP|SMTP}
export async function handleAutodiscoverV2(req: Request, res: Response): Promise<void> {
  const email = decodeURIComponent(req.params['email'] ?? '');
  const protocol = (req.query['Protocol'] as string | undefined)?.toLowerCase() ?? 'ews';

  log.info({ email, protocol }, 'Autodiscover v2 request');

  if (!email || !email.includes('@')) {
    res.status(400).json({ ErrorCode: 'InvalidRequest', ErrorMessage: 'Email required' });
    return;
  }

  const cfg = await getServerConfig();

  // Outlook fragt zuerst AutodiscoverV1 um den v1-Endpunkt zu finden
  if (protocol === 'autodiscoverv1') {
    res.json({
      Protocol: 'AutodiscoverV1',
      Url: `${cfg.autodiscoverBase}/Autodiscover/Autodiscover.xml`,
    });
    return;
  }

  if (protocol === 'ews') {
    res.json({
      Protocol: 'EWS',
      Url: cfg.ewsUrl,
    });
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
