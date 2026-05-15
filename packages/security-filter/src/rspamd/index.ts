import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:rspamd');

const RSPAMD_HOST = process.env['RSPAMD_HOST'] ?? 'rspamd';
const RSPAMD_PORT = process.env['RSPAMD_PORT'] ?? '11333';
const RSPAMD_BASE = `http://${RSPAMD_HOST}:${RSPAMD_PORT}`;

export interface RspamdResult {
  score: number;
  action: 'no action' | 'greylist' | 'add header' | 'rewrite subject' | 'reject';
  symbols: Record<string, { score: number; description?: string }>;
  isSpam: boolean;
}

export async function scanMessage(rawBuffer: Buffer): Promise<RspamdResult> {
  try {
    const response = await fetch(`${RSPAMD_BASE}/checkv2`, {
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
    await fetch(`http://${RSPAMD_HOST}:11334/learnspam`, {
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
    await fetch(`http://${RSPAMD_HOST}:11334/learnham`, {
      method: 'POST',
      body: rawBuffer,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err }, 'rspamd learn ham failed');
  }
}
