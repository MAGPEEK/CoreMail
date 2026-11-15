import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { getServerConfig, ServerConfigUnavailableError, type ServerConfig } from './settings.js';

const log = createLogger('autodiscover:v2');

/** SMTP submission on port 465 is implicit TLS (RFC 8314); other ports use STARTTLS. */
export const SMTPS_PORT = 465;

/** First value of a query parameter that must be a single string (arrays → undefined). */
function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' ? v : undefined;
}

// Autodiscover v2 — JSON response (Outlook 2019/2022/365). Both documented forms:
//   GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol=…
//   GET /autodiscover/autodiscover.json?Email={email}&Protocol=…
// Protocols: AutodiscoverV1 | IMAP | SMTP | ActiveSync. Anonymous by design: the
// answer is the same generic server configuration for every address.
// EWS was removed in v7.0.0: Protocol=EWS answers 404 NoSuchProtocol.
export async function handleAutodiscoverV2(req: Request, res: Response): Promise<void> {
  // Express has already percent-decoded the route param / query. A second decode
  // used to throw URIError on input like "%25E0%25A4%25A" and crash the process.
  const email = req.params['email'] ?? queryString(req, 'Email') ?? queryString(req, 'email') ?? '';
  const protocolParam = queryString(req, 'Protocol') ?? queryString(req, 'protocol');
  const protocol = protocolParam?.toLowerCase() ?? '';

  log.debug({ protocol }, 'Autodiscover v2 request');

  if (!email || !email.includes('@')) {
    res.status(400).json({ ErrorCode: 'InvalidRequest', ErrorMessage: 'Email required' });
    return;
  }

  let cfg: ServerConfig;
  try {
    cfg = await getServerConfig();
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) throw err;
    res.set('Retry-After', '30');
    res.status(503).json({ ErrorCode: 'ServiceUnavailable', ErrorMessage: 'Try again later' });
    return;
  }

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
      SSL: !cfg.smtpTls ? 'None' : cfg.smtpPort === SMTPS_PORT ? 'SSL' : 'STARTTLS',
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
    ErrorMessage: `Protocol ${protocolParam ?? ''} not supported`,
  });
}
