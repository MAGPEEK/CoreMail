/**
 * Client for the security-filter `/check/connection` endpoint (port 25) and
 * the content-stage endpoints `/check/content` / `/check/malware`.
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
  /** 10.2: per-stage summary for the message trace (validated, see parseContentChecks). */
  checks?: ContentChecksSummary;
}

/**
 * Per-stage summary of the security-filter content checks (10.2 message
 * trace) — the validated form of its `checks` field. Absent = stage did not run
 * (or an older security-filter without the summary).
 */
export interface ContentChecksSummary {
  auth?: {
    spf: string; spfDomain?: string; dkim: string; dkimDomains?: string[];
    dmarc: string; dmarcPolicy?: string; headerFrom?: string; arc: string; arcSealer?: string;
    junk?: 'dmarc' | 'local-spoof'; ms?: number;
  };
  senderList?: 'allow' | 'none' | 'block';
  attachments?: 'ok' | 'blocked' | 'disabled';
  virus?: { status: 'clean' | 'disabled' | 'infected' | 'suspicious' | 'unscanned'; signature?: string; reason?: string; ms?: number };
  spam?: { verdict: 'inbox' | 'junk' | 'reject' | 'allowlisted' | 'disabled'; score?: number; dnsblZones?: string[]; ms?: number };
}

const RESULT_TOKEN = /^[a-z]{1,16}$/;
const DOMAIN_TOKEN = /^[a-z0-9.-]{1,253}$/i;
const SIGNATURE_TOKEN = /^[\w.:/-]{1,120}$/;

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined;
}
const token = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);
const msOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const domains = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((d): d is string => typeof d === 'string' && DOMAIN_TOKEN.test(d)).map((d) => d.toLowerCase()).slice(0, 8);
  return list.length ? list : undefined;
};

/** Pure: validates the `checks` field of a `/check/content` answer (unknown values are dropped). */
export function parseContentChecks(value: unknown): ContentChecksSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  const out: ContentChecksSummary = {};
  const a = c['auth'];
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    const spf = token(o['spf'], RESULT_TOKEN), dkim = token(o['dkim'], RESULT_TOKEN);
    const dmarc = token(o['dmarc'], RESULT_TOKEN), arc = token(o['arc'], RESULT_TOKEN);
    if (spf && dkim && dmarc && arc) {
      const spfDomain = token(o['spfDomain'], DOMAIN_TOKEN), headerFrom = token(o['headerFrom'], DOMAIN_TOKEN);
      const arcSealer = token(o['arcSealer'], DOMAIN_TOKEN), dmarcPolicy = token(o['dmarcPolicy'], RESULT_TOKEN);
      const dkimDomains = domains(o['dkimDomains']), junk = oneOf(o['junk'], ['dmarc', 'local-spoof'] as const), ms = msOf(o['ms']);
      out.auth = {
        spf, dkim, dmarc, arc,
        ...(spfDomain ? { spfDomain } : {}), ...(dkimDomains ? { dkimDomains } : {}),
        ...(dmarcPolicy ? { dmarcPolicy } : {}), ...(headerFrom ? { headerFrom } : {}),
        ...(arcSealer ? { arcSealer } : {}), ...(junk ? { junk } : {}), ...(ms !== undefined ? { ms } : {}),
      };
    }
  }
  const senderList = oneOf(c['senderList'], ['allow', 'none', 'block'] as const);
  if (senderList) out.senderList = senderList;
  const attachments = oneOf(c['attachments'], ['ok', 'blocked', 'disabled'] as const);
  if (attachments) out.attachments = attachments;
  const v = c['virus'];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const status = oneOf(o['status'], ['clean', 'disabled', 'infected', 'suspicious', 'unscanned'] as const);
    if (status) {
      const signature = token(o['signature'], SIGNATURE_TOKEN), reason = oneOf(o['reason'], ['too-large', 'scanner-error'] as const), ms = msOf(o['ms']);
      out.virus = { status, ...(signature ? { signature } : {}), ...(reason ? { reason } : {}), ...(ms !== undefined ? { ms } : {}) };
    }
  }
  const s = c['spam'];
  if (s && typeof s === 'object') {
    const o = s as Record<string, unknown>;
    const verdict = oneOf(o['verdict'], ['inbox', 'junk', 'reject', 'allowlisted', 'disabled'] as const);
    if (verdict) {
      const score = typeof o['score'] === 'number' && Number.isFinite(o['score']) ? Math.round(o['score'] * 100) / 100 : undefined;
      const dnsblZones = domains(o['dnsblZones']), ms = msOf(o['ms']);
      out.spam = { verdict, ...(score !== undefined ? { score } : {}), ...(dnsblZones ? { dnsblZones } : {}), ...(ms !== undefined ? { ms } : {}) };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
      ...(parseContentChecks(b['checks']) ? { checks: parseContentChecks(b['checks'])! } : {}),
    },
  };
}

/**
 * Content-stage endpoints of the security-filter: the full pipeline (port 25)
 * and the malware-only checks (attachment filter + ClamAV, device relay).
 */
export type ContentFilterEndpoint = '/check/content' | '/check/malware';

export type ContentFilterVerdict = ReturnType<typeof interpretContentFilterResponse>;

type ContentFetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * POSTs the raw message to a content-stage endpoint. `contextHeader` is the
 * ASCII-only JSON of the X-Filter-Context header. A network error, a non-200
 * answer or an invalid body is `unavailable` — the caller defers the message,
 * it is never delivered unscanned.
 */
export async function callContentFilter(
  baseUrl: string,
  endpoint: ContentFilterEndpoint,
  raw: Buffer,
  contextHeader: string,
  fetchImpl: ContentFetchLike = fetch as unknown as ContentFetchLike,
  timeoutMs = 30_000,
): Promise<ContentFilterVerdict> {
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filter-Context': contextHeader },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'unavailable', detail: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  return interpretContentFilterResponse(res.status, body);
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
