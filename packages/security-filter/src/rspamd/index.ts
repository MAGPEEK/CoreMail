import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:rspamd');

export interface RspamdEndpoints {
  /** Base URL for /checkv2. */
  scan: string;
  /** Base URL of the controller (/learnspam, /learnham). */
  controller: string;
  /** Where the values came from (logged at startup). */
  source: 'RSPAMD_URL' | 'RSPAMD_HOST/RSPAMD_PORT';
}

/**
 * v7.1.0: rspamd endpoints from the environment.
 *
 * - `RSPAMD_URL` (preferred; what docker-compose, the Helm chart and the
 *   api-gateway use): the rspamd **controller**, e.g. `http://rspamd:11334`.
 *   The controller serves /checkv2 as well as /learnspam and /learnham, so one
 *   URL covers scanning and learning. http/https only, no credentials, an
 *   optional path prefix (reverse proxy) is kept.
 * - Fallback (pre-7.1 configuration): `RSPAMD_HOST` (default `rspamd`) +
 *   `RSPAMD_PORT` (default 11333, normal worker) for scanning, the controller
 *   on `RSPAMD_HOST:11334` for learning.
 *
 * An invalid RSPAMD_URL is reported and the fallback is used.
 */
export function resolveRspamdEndpoints(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (msg) => log.error(msg),
): RspamdEndpoints {
  const raw = (env['RSPAMD_URL'] ?? '').trim();
  if (raw) {
    const parsed = parseRspamdUrl(raw);
    if ('error' in parsed) warn(`RSPAMD_URL ignored: ${parsed.error} — falling back to RSPAMD_HOST/RSPAMD_PORT`);
    else return { scan: parsed.url, controller: parsed.url, source: 'RSPAMD_URL' };
  }
  const host = (env['RSPAMD_HOST'] ?? '').trim() || 'rspamd';
  const port = (env['RSPAMD_PORT'] ?? '').trim() || '11333';
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host; // IPv6 literal
  return { scan: `http://${h}:${port}`, controller: `http://${h}:11334`, source: 'RSPAMD_HOST/RSPAMD_PORT' };
}

/** Normalised base URL (no trailing slash) or an error text. */
export function parseRspamdUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `unsupported scheme ${u.protocol}` };
  if (u.username || u.password) return { error: 'credentials in the URL are not supported' };
  if (u.search || u.hash) return { error: 'query or fragment not allowed' };
  const path = u.pathname.replace(/\/+$/, '');
  return { url: `${u.protocol}//${u.host}${path}` };
}

let endpoints: RspamdEndpoints | null = null;
function rspamd(): RspamdEndpoints {
  if (!endpoints) {
    endpoints = resolveRspamdEndpoints();
    log.info({ scan: endpoints.scan, controller: endpoints.controller, source: endpoints.source }, 'rspamd endpoints');
  }
  return endpoints;
}

export interface RspamdResult {
  score: number;
  action: 'no action' | 'greylist' | 'add header' | 'rewrite subject' | 'reject';
  symbols: Record<string, { score: number; description?: string }>;
  isSpam: boolean;
}

export async function scanMessage(rawBuffer: Buffer): Promise<RspamdResult> {
  try {
    const response = await fetch(`${rspamd().scan}/checkv2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Pass': 'all',
      },
      body: rawBuffer,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`rspamd HTTP ${response.status}`);
    }

    const data = await response.json() as {
      score: number;
      action: string;
      symbols?: Record<string, { score: number; description?: string }>;
    };

    log.debug({ score: data.score, action: data.action }, 'rspamd result');

    return {
      score: data.score,
      action: data.action as RspamdResult['action'],
      symbols: data.symbols ?? {},
      isSpam: data.action === 'reject' || data.action === 'add header',
    };
  } catch (err) {
    log.error({ err }, 'rspamd scan failed — failing open');
    return { score: 0, action: 'no action', symbols: {}, isSpam: false };
  }
}

export async function learnSpam(rawBuffer: Buffer): Promise<void> {
  try {
    await fetch(`${rspamd().controller}/learnspam`, {
      method: 'POST',
      body: rawBuffer,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err }, 'rspamd learn spam failed');
  }
}

export async function learnHam(rawBuffer: Buffer): Promise<void> {
  try {
    await fetch(`${rspamd().controller}/learnham`, {
      method: 'POST',
      body: rawBuffer,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err }, 'rspamd learn ham failed');
  }
}
