/**
 * Request validation + stage dispatch for POST /check/connection.
 *
 * Stages:
 *  - `connect` — only the client IP is known (TCP connect): DNSBL/DNSWL + GeoIP.
 *  - `rcpt`    — IP + MAIL FROM + RCPT TO known: sender lists of the recipient (9.4), greylisting.
 *  - `full`    — legacy combined request (sender lists + greylisting + IP checks).
 *
 * Before v5.9.x smtp-server sent `{senderIp, mailFrom:'', rcptTo:''}` at
 * connect time, which the old validation rejected with 400 — so DNSBL,
 * GeoIP and greylisting never ran for inbound mail.
 */
import { isIP } from 'node:net';
import type { ConnectionContext, PipelineConfig, PipelineResult } from './pipeline/index.js';

export type ConnectionStage = 'connect' | 'rcpt' | 'full';

export type ParsedConnectionRequest =
  | { ok: true; stage: ConnectionStage; ctx: ConnectionContext }
  | { ok: false; error: string };

const STAGES: readonly ConnectionStage[] = ['connect', 'rcpt', 'full'];

export function parseConnectionRequest(body: unknown): ParsedConnectionRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const senderIp = typeof b['senderIp'] === 'string' ? b['senderIp'].trim() : '';
  if (!senderIp) return { ok: false, error: 'Missing senderIp' };
  if (isIP(senderIp) === 0) return { ok: false, error: 'senderIp is not a valid IP address' };

  if (b['mailFrom'] !== undefined && typeof b['mailFrom'] !== 'string') {
    return { ok: false, error: 'mailFrom must be a string' };
  }
  if (b['rcptTo'] !== undefined && typeof b['rcptTo'] !== 'string') {
    return { ok: false, error: 'rcptTo must be a string' };
  }
  const mailFrom = ((b['mailFrom'] as string | undefined) ?? '').trim();
  const rcptTo   = ((b['rcptTo']   as string | undefined) ?? '').trim();

  let stage: ConnectionStage;
  if (b['stage'] === undefined) {
    // Legacy callers: a recipient means the full check, otherwise connect stage.
    stage = rcptTo ? 'full' : 'connect';
  } else if (typeof b['stage'] === 'string' && (STAGES as readonly string[]).includes(b['stage'])) {
    stage = b['stage'] as ConnectionStage;
  } else {
    return { ok: false, error: `stage must be one of ${STAGES.join(', ')}` };
  }

  if (stage !== 'connect' && !rcptTo) {
    // mailFrom may legitimately be empty (null sender <> for bounces)
    return { ok: false, error: `Missing rcptTo for stage '${stage}'` };
  }

  const ctx: ConnectionContext = stage === 'connect'
    ? { senderIp, mailFrom: '', rcptTo: '' }
    : { senderIp, mailFrom, rcptTo };
  return { ok: true, stage, ctx };
}

export interface ConnectionStageDeps {
  ipChecks(senderIp: string, config: PipelineConfig): Promise<PipelineResult>;
  greylist(ctx: ConnectionContext, config: PipelineConfig): Promise<PipelineResult>;
  senderList(ctx: ConnectionContext): Promise<PipelineResult>;
}

/** Run the checks that belong to the requested stage. */
export async function runConnectionStage(
  stage: ConnectionStage,
  ctx: ConnectionContext,
  config: PipelineConfig,
  deps: ConnectionStageDeps,
): Promise<PipelineResult> {
  switch (stage) {
    case 'connect':
      return deps.ipChecks(ctx.senderIp, config);
    case 'rcpt':
      return recipientChecks(ctx, config, deps);
    case 'full': {
      const rcpt = await recipientChecks(ctx, config, deps);
      if (rcpt.action !== 'accept') return rcpt;
      return deps.ipChecks(ctx.senderIp, config);
    }
  }
}

/** RCPT TO: sender lists of this recipient first (a block is final), then greylisting. */
async function recipientChecks(
  ctx: ConnectionContext,
  config: PipelineConfig,
  deps: ConnectionStageDeps,
): Promise<PipelineResult> {
  const lists = await deps.senderList(ctx);
  if (lists.action !== 'accept') return lists;
  return deps.greylist(ctx, config);
}
