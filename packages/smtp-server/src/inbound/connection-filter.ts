/**
 * Client for the security-filter `/check/connection` endpoint (port 25).
 *
 * Connect stage: only the client IP is known → DNSBL/DNSWL + GeoIP.
 * RCPT stage:    IP + MAIL FROM + RCPT TO   → greylisting.
 *
 * A non-200 answer, an unparsable body or a body without a valid `action` is
 * "filter unavailable" (fail-open, but the caller logs it at error level) —
 * previously a 400 was silently read as "accept" and the checks never ran.
 */

import { parseVirusScanNote, type VirusScanNote } from './virus-scan-header.js';

export type FilterAction = 'accept' | 'defer' | 'reject' | 'quarantine';

export type ConnectionFilterDecision =
  | { kind: 'accept'; reason?: string }
  | { kind: 'block'; action: 'reject' | 'defer'; reason: string }
  | { kind: 'unavailable'; detail: string };

const ACTIONS: readonly FilterAction[] = ['accept', 'defer', 'reject', 'quarantine'];

export type ConnectionFilterRequest =
  | { stage: 'connect'; senderIp: string }
  | { stage: 'rcpt'; senderIp: string; mailFrom: string; rcptTo: string };

/** Pure: map an HTTP status + parsed JSON body onto a decision. */
export function interpretConnectionFilterResponse(status: number, body: unknown): ConnectionFilterDecision {
  if (status !== 200) {
    const err = body && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : undefined;
    return { kind: 'unavailable', detail: `HTTP ${status}${typeof err === 'string' ? `: ${err}` : ''}` };
  }
  if (!body || typeof body !== 'object') {
    return { kind: 'unavailable', detail: 'Response body is not a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const action = b['action'];
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { kind: 'unavailable', detail: `Response without valid action (${JSON.stringify(action)})` };
  }
  const reason = typeof b['reason'] === 'string' ? b['reason'] : undefined;
  if (action === 'reject' || action === 'defer') {
    return { kind: 'block', action, reason: reason ?? (action === 'defer' ? 'Try again later' : 'Rejected by policy') };
  }
  // 'quarantine' has no meaning before DATA — treat as accept.
  return reason !== undefined ? { kind: 'accept', reason } : { kind: 'accept' };
}

/** Answer of `/check/content` (security-filter). */
export interface ContentFilterResult {
  action: FilterAction;
  reason?: string;
  junkFolder?: boolean;
  spamScore?: number;
  virusName?: string;
  /** `Received-SPF` / `Authentication-Results` lines to prepend on delivery. */
  authHeaders?: string;
  /** Domains the message is authenticated for (DMARC/SPF/DKIM pass). */
  verifiedDomains?: string[];
  /** Not scanned clean by ClamAV → X-CoreMail-Virus-Scan header (virus-scan-header.ts). */
  virusScan?: VirusScanNote;
}

/** Body limit of `/check/content` (security-filter: express.raw limit '52mb'). */
export const CONTENT_FILTER_MAX_BYTES = 52 * 1024 * 1024;

/** Room for the Received: field the inbound handler prepends before the scan. */
const TRACE_HEADROOM_BYTES = 16 * 1024;

/**
 * SIZE limit advertised and enforced on the inbound listener (port 25): the
 * configured maximum, but never more than the content filter can scan — a
 * bigger message would otherwise be transferred completely and then refused
 * with 552 after DATA.
 */
export function inboundMaxSize(configuredBytes: number): number {
  return Math.min(configuredBytes, CONTENT_FILTER_MAX_BYTES - TRACE_HEADROOM_BYTES);
}

/**
 * Pure: validates a `/check/content` answer. A non-200 status, a non-object
 * body or an unknown `action` is "unavailable" — the message must not be
 * delivered unscanned (the caller defers it with 451).
 */
export function interpretContentFilterResponse(
  status: number,
  body: unknown,
): { kind: 'ok'; result: ContentFilterResult } | { kind: 'unavailable'; detail: string } {
  if (status !== 200) return { kind: 'unavailable', detail: `HTTP ${status}` };
  if (!body || typeof body !== 'object') return { kind: 'unavailable', detail: 'Response body is not a JSON object' };
  const b = body as Record<string, unknown>;
  const action = b['action'];
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { kind: 'unavailable', detail: `Response without valid action (${JSON.stringify(action)})` };
  }
  return {
    kind: 'ok',
    result: {
      action: action as FilterAction,
      ...(typeof b['reason'] === 'string' ? { reason: b['reason'] } : {}),
      ...(typeof b['junkFolder'] === 'boolean' ? { junkFolder: b['junkFolder'] } : {}),
      ...(typeof b['spamScore'] === 'number' ? { spamScore: b['spamScore'] } : {}),
      ...(typeof b['virusName'] === 'string' ? { virusName: b['virusName'] } : {}),
      ...(typeof b['authHeaders'] === 'string' && b['authHeaders'] ? { authHeaders: b['authHeaders'] } : {}),
      ...(parseVirusScanNote(b['virusScan']) ? { virusScan: parseVirusScanNote(b['virusScan'])! } : {}),
      ...(Array.isArray(b['verifiedDomains'])
        ? { verifiedDomains: (b['verifiedDomains'] as unknown[]).filter((d): d is string => typeof d === 'string' && /^[a-z0-9.-]{1,253}$/i.test(d)).map((d) => d.toLowerCase()) }
        : {}),
    },
  };
}

/** Pure: connect-stage verdict. Only an explicit reject/defer closes the connection. */
export function connectionAllowed(decision: ConnectionFilterDecision): boolean {
  return decision.kind !== 'block';
}

/**
 * Pure: reply for a DATA-stage greylisting fallback (session did not pass the
 * client IP to onRcptTo). Any deferred recipient defers the whole message.
 * Returns the full reply text to throw from onMessage, or null to continue.
 */
export function dataStageGreylistReply(decisions: ConnectionFilterDecision[]): string | null {
  const blocks = decisions.filter(
    (d): d is Extract<ConnectionFilterDecision, { kind: 'block' }> => d.kind === 'block',
  );
  const reject = blocks.find((d) => d.action === 'reject');
  if (reject) return `550 5.7.1 ${reject.reason}`;
  const defer = blocks.find((d) => d.action === 'defer');
  if (defer) return `451 4.7.1 ${defer.reason}`;
  return null;
}

/**
 * Pure: SMTP reply text for a RCPT-stage decision (null = accept).
 * Unavailable → accept (fail-open, same policy as the connect stage).
 */
export function rcptReplyForDecision(decision: ConnectionFilterDecision): string | null {
  if (decision.kind !== 'block') return null;
  return decision.action === 'defer'
    ? `4.7.1 ${decision.reason}`
    : `5.7.1 ${decision.reason}`;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

/** POST to `/check/connection`; network/parse errors become `unavailable`. */
export async function callConnectionFilter(
  baseUrl: string,
  payload: ConnectionFilterRequest,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 5_000,
): Promise<ConnectionFilterDecision> {
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(`${baseUrl}/check/connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'unavailable', detail: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return interpretConnectionFilterResponse(res.status, body);
}
