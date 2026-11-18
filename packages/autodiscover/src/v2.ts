import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { domainProtocolAccess, mapiEndpointsFor, mapiHttpsTrusted, type AccessProtocol, type ProtocolAccess } from '@coremail/storage';
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
// Protocols: AutodiscoverV1 | IMAP | SMTP | ActiveSync | MapiHttp. Anonymous by design: the
// answer is the same generic server configuration for every address.
// EWS was removed in v7.0.0: Protocol=EWS answers 404 NoSuchProtocol.
// 9.4: a protocol switched off for the mail domain answers 404 NoSuchProtocol
// (domain level only — an anonymous answer never depends on one account).
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
  let access: ProtocolAccess;
  try {
    cfg = await getServerConfig();
    // 9.4: anonymous → the mail domain's switches (server + domain level, never an account's).
    access = await domainProtocolAccess(email.slice(email.lastIndexOf('@') + 1));
  } catch (err) {
    if (!(err instanceof ServerConfigUnavailableError)) log.error({ err }, 'Autodiscover v2: protocol switches not readable');
    res.set('Retry-After', '30');
    res.status(503).json({ ErrorCode: 'ServiceUnavailable', ErrorMessage: 'Try again later' });
    return;
  }
  const disabled = (p: AccessProtocol): boolean => {
    if (access[p]) return false;
    res.status(404).json({ ErrorCode: 'NoSuchProtocol', ErrorMessage: `Protocol ${protocolParam ?? ''} is not enabled` });
    return true;
  };

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
    if (disabled('imap')) return;
    res.json({
      Protocol: 'IMAP',
      Hostname: cfg.imapHost,
      Port: cfg.imapPort,
      SSL: cfg.imapSsl ? 'on' : 'off',
    });
    return;
  }

  if (protocol === 'smtp') {
    if (disabled('smtp')) return;
    res.json({
      Protocol: 'SMTP',
      Hostname: cfg.smtpHost,
      Port: cfg.smtpPort,
      SSL: !cfg.smtpTls ? 'None' : cfg.smtpPort === SMTPS_PORT ? 'SSL' : 'STARTTLS',
    });
    return;
  }

  // 9.4: MAPI over HTTP — the mailbox endpoint URL, only with `mapi` on for the
  // domain and trusted HTTPS (as the v1 mapiHttp block).
  if (protocol === 'mapihttp') {
    if (disabled('mapi')) return;
    const endpoints = mapiEndpointsFor(cfg);
    let trusted: boolean;
    try {
      trusted = endpoints !== null && await mapiHttpsTrusted();
    } catch (err) {
      log.error({ err }, 'Autodiscover v2: certificate state not readable');
      res.set('Retry-After', '30');
      res.status(503).json({ ErrorCode: 'ServiceUnavailable', ErrorMessage: 'Try again later' });
      return;
    }
    if (!endpoints || !trusted) {
      res.status(404).json({ ErrorCode: 'NoSuchProtocol', ErrorMessage: `Protocol ${protocolParam ?? ''} is not available` });
      return;
    }
    res.json({ Protocol: 'MapiHttp', Url: endpoints.mailStore });
    return;
  }

  if (protocol === 'activesync') {
    if (disabled('activesync')) return;
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
