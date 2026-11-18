/**
 * Request-body cap of /Microsoft-Server-ActiveSync (9.4; before: a fixed 25 MB).
 *
 * The cap follows the configured maximum message size (storage `maxOutgoingMessageBytes`,
 * the limit SendMail / SmartReply / SmartForward enforce) plus a protocol margin:
 *  - ×4/3 for base64 content and WBXML framing, so a message slightly above the limit still
 *    reaches the compose handler and gets the protocol answer (Status 122 / HTTP 413 in 12.1)
 *    instead of a bare body-parser refusal;
 *  - + 1 MB for the WBXML envelope and request line of small limits.
 * Upper bound 150 MB: the body is buffered in memory (and base64-encoded once more for the
 * outbound queue), so a very large configured size must not let one request hold gigabytes.
 *
 * Applied per request: the size limit is cached 60 s in storage and dropped on every
 * settings reload (`clearMessageSizeLimitCache` in server.ts), so a BCP change applies at once.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { maxOutgoingMessageBytes } from '@coremail/storage';

const MB = 1024 * 1024;
/** Fixed allowance for the WBXML envelope / request line. */
export const EAS_BODY_OVERHEAD_BYTES = MB;
/** Upper bound of one ActiveSync request body. */
export const EAS_MAX_BODY_BYTES = 150 * MB;

/** Pure: request-body cap for a maximum message size in bytes. */
export function easBodyLimit(maxMessageBytes: number): number {
  const withMargin = Math.ceil((maxMessageBytes * 4) / 3) + EAS_BODY_OVERHEAD_BYTES;
  return Math.min(EAS_MAX_BODY_BYTES, withMargin);
}

/** Current cap from the configured maximum message size. */
export async function currentEasBodyLimit(): Promise<number> {
  return easBodyLimit(await maxOutgoingMessageBytes());
}

/**
 * Raw body parser whose limit is resolved per request (`express.raw`; one parser per
 * distinct limit value, rebuilt when the setting changes). An oversized body ends in the
 * shared error middleware as 413.
 */
export function easBodyParser(limitBytes: () => Promise<number> = currentEasBodyLimit): RequestHandler {
  let current: { limit: number; parse: RequestHandler } | null = null;
  return (req: Request, res: Response, next: NextFunction): void => {
    limitBytes().then((limit) => {
      if (!current || current.limit !== limit) current = { limit, parse: express.raw({ type: '*/*', limit }) };
      current.parse(req, res, next);
    }, next);
  };
}
