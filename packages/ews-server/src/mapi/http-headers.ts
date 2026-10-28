/**
 * MAPI/HTTP header handling (v4.0.0)
 *
 * MS-OXCMAPIHTTP §2.2.3 defines the HTTP-layer headers for Outlook ↔ server.
 * We validate request headers and set response headers correctly.
 */

import type { Request, Response } from 'express';
import { ResponseCode } from './codec.js';

/**
 * Known X-RequestType values (MS-OXCMAPIHTTP §2.2.3.2).
 * Servers must recognize all of them and return `InvalidXRequestType` (HTTP 200 with
 * X-ResponseCode=4) for unknown values.
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
 * Server application string. Outlook only uses this for display in
 * diagnostics — the concrete value is not protocol-relevant, but it should
 * contain an Exchange-2019-compatible version.
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

/** Parses the MAPI-specific request headers. */
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
 * Sets the mandatory response headers for MAPI/HTTP. Outlook ignores
 * response bodies if `X-ResponseCode` is missing from the header (or != 0).
 */
export function setMapiResponseHeaders(
  res: Response,
  opts: {
    requestId:     string;
    responseCode?: number;          // default: SUCCESS
    expirationMs?: number;          // X-ExpirationInfo, default 600_000
    pendingMs?:    number;          // X-PendingPeriod (for NotificationWait)
    setCookie?:    string;          // optional: full Set-Cookie header value
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
 * Sends an error response (header only, empty body). MS-OXCMAPIHTTP
 * §2.2.3.4 — for some response codes the body is empty / ignored.
 */
export function sendMapiError(
  res: Response,
  opts: {
    requestId:    string;
    responseCode: number;
    httpStatus?:  number;  // default 200 (MAPI errors live in X-ResponseCode, not in the HTTP status)
  },
): void {
  setMapiResponseHeaders(res, {
    requestId:    opts.requestId,
    responseCode: opts.responseCode,
  });
  res.status(opts.httpStatus ?? 200).end();
}
