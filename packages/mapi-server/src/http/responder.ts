/**
 * Writing MAPI over HTTP responses (MS-OXCMAPIHTTP 3.2.5.2): an accepted
 * request is answered at once with X-ResponseCode 0 and the PROCESSING
 * meta-tag (chunked, Nagle off), PENDING every X-PendingPeriod while the work
 * runs, then DONE with the final X-ResponseCode, timing headers and the body.
 * Requests refused before processing get a plain response whose X-ResponseCode
 * header carries the failure and a short diagnostic text. A failure after the
 * PROCESSING meta-tag still ends the response properly: DONE with
 * X-ResponseCode 1 and an empty body (MS-OXCMAPIHTTP "Responding to All
 * Request Type Requests": the additional X-ResponseCode after DONE reports a
 * failure that occurs after the initial response).
 */
import type { Response } from 'express';
import { createLogger } from '@coremail/core';
import {
  doneSection, META_PENDING, META_PROCESSING, ResponseCode, responseHeaders, type MapiRequestHeaders,
} from './envelope.js';

const log = createLogger('mapi:http');

export interface StreamOptions {
  pendingMs: number;
  expirationMs: number;
  setCookies?: string[];
}

export interface WorkResult { responseCode: number; body: Buffer }

/** Streams the response of an accepted request; `work` produces the final section. */
export async function respondStreaming(
  res: Response, h: MapiRequestHeaders, opts: StreamOptions, work: () => Promise<WorkResult>,
): Promise<void> {
  const startedAt = new Date();
  res.socket?.setNoDelay(true);
  res.status(200);
  for (const [k, v] of Object.entries(responseHeaders(h, 0, {
    'X-PendingPeriod': String(opts.pendingMs),
    'X-ExpirationInfo': String(opts.expirationMs),
  }))) res.setHeader(k, v);
  if (opts.setCookies?.length) res.setHeader('Set-Cookie', opts.setCookies);
  res.write(META_PROCESSING);
  const timer = setInterval(() => { if (!res.writableEnded) res.write(META_PENDING); }, opts.pendingMs);
  let result: WorkResult;
  try {
    result = await work();
  } catch (err) {
    log.error({ err, requestType: h.requestType }, 'MAPI request failed after PROCESSING');
    result = { responseCode: ResponseCode.UnknownFailure, body: Buffer.alloc(0) };
  } finally {
    clearInterval(timer);
  }
  if (!res.writableEnded) res.end(doneSection(result.responseCode, Date.now() - startedAt.getTime(), startedAt, result.body));
}

/** A request refused before processing (non-zero X-ResponseCode, diagnostic text body). */
export function respondFailure(
  res: Response, h: MapiRequestHeaders, responseCode: number, text: string, httpStatus = 200, extra: Record<string, string> = {},
): void {
  res.status(httpStatus);
  for (const [k, v] of Object.entries(responseHeaders(h, responseCode, extra))) res.setHeader(k, v);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}
