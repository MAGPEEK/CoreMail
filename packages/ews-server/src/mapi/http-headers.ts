/**
 * MAPI/HTTP-Header-Handling (v4.0.0)
 *
 * MS-OXCMAPIHTTP §2.2.3 definiert die HTTP-Layer-Header für Outlook ↔ Server.
 * Wir validieren Request-Header und setzen Response-Header korrekt.
 */

import type { Request, Response } from 'express';
import { ResponseCode } from './codec.js';

/**
 * Bekannte X-RequestType-Werte (MS-OXCMAPIHTTP §2.2.3.2).
 * Server müssen alle erkennen und ggf. `InvalidXRequestType` (HTTP 200 mit
 * X-ResponseCode=4) zurückgeben für unbekannte Werte.
 */
export type RequestType =
  | 'Connect'       // emsmdb: open mailbox session
  | 'Execute'       // emsmdb: run ROP batch
  | 'Disconnect'    // emsmdb: close session
  | 'NotificationWait' // emsmdb: long-poll for events
  | 'Bind'          // nspi: open address book session
  | 'Unbind'        // nspi: close
  | 'GetMatches'    // nspi: search address book
  | 'QueryRows'     // nspi: list address book rows
  | 'ResolveNames'  // nspi: alias → SMTP
  | 'GetSpecialTable' // nspi: hierarchy table
  | 'GetProps'      // nspi: properties for a single entry
  | 'DnToMinId'     // nspi: distinguished-name → minimal-id
  | 'GetPropList';  // nspi: list available properties

/**
 * Server-Application-String. Outlook verwendet das nur zur Anzeige in
 * Diagnostics — der konkrete Wert ist nicht protokoll-relevant, sollte aber
 * eine Exchange-2019-kompatible Version enthalten.
 */
export const SERVER_APP_STRING = 'Exchange/15.20.1118.7';

export interface ParsedMapiHeaders {
  requestType:    RequestType | string;
  requestId:      string;
  clientInfo:     string;
  clientApp:      string;
  userIdentity:   string;
  /** Parsed Cookies: { MapiSession?, NspiSession? }. */
  cookies:        Record<string, string>;
}

/** Parst die MAPI-spezifischen Request-Header. */
export function parseMapiHeaders(req: Request): ParsedMapiHeaders {
  const cookieHeader = req.get('cookie') ?? '';
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return {
    requestType:  (req.get('x-requesttype') as RequestType) ?? '',
    requestId:    req.get('x-requestid')    ?? '',
    clientInfo:   req.get('x-clientinfo')   ?? '',
    clientApp:    req.get('x-clientapplication') ?? '',
    userIdentity: req.get('x-user-identity') ?? '',
    cookies,
  };
}

/**
 * Setzt die Pflicht-Response-Header für MAPI/HTTP. Outlook ignoriert
 * Response-Bodies wenn `X-ResponseCode` nicht im Header steht (oder != 0).
 */
export function setMapiResponseHeaders(
  res: Response,
  opts: {
    requestId:     string;
    responseCode?: number;          // default: SUCCESS
    expirationMs?: number;          // X-ExpirationInfo, default 600_000
    pendingMs?:    number;          // X-PendingPeriod (für NotificationWait)
    setCookie?:    string;          // optional: ganzer Set-Cookie-Header-Wert
  },
): void {
  const code = opts.responseCode ?? ResponseCode.SUCCESS;
  res.setHeader('X-ResponseCode', String(code));
  res.setHeader('X-ServerApplication', SERVER_APP_STRING);
  res.setHeader('X-RequestId', opts.requestId);
  res.setHeader('X-ResponseTimestamp', String(Date.now()));
  res.setHeader('X-ExpirationInfo', String(opts.expirationMs ?? 600_000));
  if (opts.pendingMs !== undefined) {
    res.setHeader('X-PendingPeriod', String(opts.pendingMs));
  }
  if (opts.setCookie) {
    res.setHeader('Set-Cookie', opts.setCookie);
  }
  res.setHeader('Content-Type', 'application/mapi-http');
}

/**
 * Sendet eine Error-Response (Header-Only, leerer Body). MS-OXCMAPIHTTP
 * §2.2.3.4 — bei einigen Response-Codes ist der Body leer / ignored.
 */
export function sendMapiError(
  res: Response,
  opts: {
    requestId:    string;
    responseCode: number;
    httpStatus?:  number;  // default 200 (MAPI Errors sind in X-ResponseCode, nicht im HTTP-Status)
  },
): void {
  setMapiResponseHeaders(res, {
    requestId:    opts.requestId,
    responseCode: opts.responseCode,
  });
  res.status(opts.httpStatus ?? 200).end();
}
