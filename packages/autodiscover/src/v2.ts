import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';

const log = createLogger('autodiscover:v2');

const EWS_URL = process.env['EWS_URL'] ?? 'https://mail.example.com/EWS/Exchange.asmx';
const OWA_URL = process.env['OWA_URL'] ?? 'https://mail.example.com/owa/';
const IMAP_HOST = process.env['IMAP_HOST'] ?? 'mail.example.com';
const SMTP_HOST = process.env['SMTP_HOST'] ?? 'mail.example.com';
const AUTODISCOVER_BASE = process.env['AUTODISCOVER_BASE'] ?? 'https://mail.example.com';

// Autodiscover v2 — JSON response (Outlook 2019/365 Modern Auth)
// GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol={EWS|AutodiscoverV1}
export function handleAutodiscoverV2(req: Request, res: Response): void {
  const email = decodeURIComponent(req.params['email'] ?? '');
  const protocol = (req.query['Protocol'] as string | undefined)?.toLowerCase() ?? 'ews';

  log.info({ email, protocol }, 'Autodiscover v2 request');

  if (!email || !email.includes('@')) {
    res.status(400).json({ ErrorCode: 'InvalidRequest', ErrorMessage: 'Email required' });
    return;
  }

  // Outlook first requests AutodiscoverV1 to find the v1 endpoint
  if (protocol === 'autodiscoverv1') {
    res.json({
      Protocol: 'AutodiscoverV1',
      Url: `${AUTODISCOVER_BASE}/Autodiscover/Autodiscover.xml`,
    });
    return;
  }

  // EWS protocol
  if (protocol === 'ews') {
    res.json({
      Protocol: 'EWS',
      Url: EWS_URL,
    });
    return;
  }

  // IMAP
  if (protocol === 'imap') {
    res.json({
      Protocol: 'IMAP',
      Hostname: IMAP_HOST,
      Port: 993,
      SSL: 'on',
    });
    return;
  }

  // SMTP
  if (protocol === 'smtp') {
    res.json({
      Protocol: 'SMTP',
      Hostname: SMTP_HOST,
      Port: 587,
      SSL: 'STARTTLS',
    });
    return;
  }

  res.status(404).json({
    ErrorCode: 'NoSuchProtocol',
    ErrorMessage: `Protocol ${String(req.query['Protocol'])} not supported`,
  });
}
