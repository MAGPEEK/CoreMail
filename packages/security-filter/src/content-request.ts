/**
 * Request parsing + failure policy for POST /check/content.
 */
import { isIP } from 'node:net';
import type { ConnectionContext, PipelineResult } from './pipeline/index.js';

const str = (v: unknown, max = 1024): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined;

/**
 * Pure: validates the `X-Filter-Context` JSON. senderIp must be an IP (it is
 * the SPF client IP); unknown or mistyped fields are dropped.
 */
export function parseContentContext(header: string): ConnectionContext | null {
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const senderIp = str(b['senderIp'], 64)?.trim() ?? '';
  if (isIP(senderIp) === 0) return null;
  const rcpts = Array.isArray(b['rcpts'])
    ? (b['rcpts'] as unknown[]).filter((r): r is string => typeof r === 'string' && r.length <= 512).slice(0, 1000)
    : undefined;
  const helo = str(b['helo'], 512);
  const hostname = str(b['hostname'], 255);
  const authUser = str(b['authUser'], 512);
  const rcptCount = typeof b['rcptCount'] === 'number' && Number.isInteger(b['rcptCount']) && b['rcptCount'] >= 0
    ? b['rcptCount'] : undefined;
  const domainId = str(b['domainId'], 64);
  const userId = str(b['userId'], 64);
  return {
    senderIp,
    mailFrom: str(b['mailFrom'], 512) ?? '',
    rcptTo: str(b['rcptTo'], 512) ?? rcpts?.[0] ?? '',
    ...(rcpts ? { rcpts } : {}),
    ...(rcptCount !== undefined ? { rcptCount } : {}),
    ...(helo ? { helo } : {}),
    ...(hostname ? { hostname } : {}),
    ...(authUser ? { authUser } : {}),
    ...(domainId ? { domainId } : {}),
    ...(userId ? { userId } : {}),
  };
}

/**
 * Pure: answer when the content pipeline throws unexpectedly. Default: defer
 * (smtp-server answers 451 4.7.0 and the sender retries) — an internal error
 * must never deliver a message unscanned. `SECURITY_FILTER_FAIL_OPEN=true`
 * restores the old accept behaviour.
 */
export function contentErrorResult(env: Record<string, string | undefined> = process.env): PipelineResult {
  return (env['SECURITY_FILTER_FAIL_OPEN'] ?? '').trim().toLowerCase() === 'true'
    ? { action: 'accept', reason: 'Internal error — failing open (SECURITY_FILTER_FAIL_OPEN=true)' }
    : { action: 'defer', reason: 'Content filter internal error — try again later' };
}
