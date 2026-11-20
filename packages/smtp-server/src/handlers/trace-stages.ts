/**
 * Message trace stages (10.2) — pure builders for the `metadata.trace` record
 * of MAIL_FLOW rows (storage message-trace.ts). Only facts the SMTP path has
 * computed anyway: session data, security-filter verdicts, rule outcomes, the
 * outbound worker's MX lookup and remote replies. Never message content.
 */
import {
  traceStage, parseAuthenticationResults, authResultDomain,
  type TraceStage, type TraceResult, type TransportOutcome,
} from '@coremail/storage';
import type { MessageMeta } from '../core/types.js';
import type { ConnectionFilterDecision, ContentFilterResult, ContentChecksSummary } from '../inbound/connection-filter.js';
import type { RelayHop } from '../outbound/relay.js';

type At = { at?: Date | string; ms?: number };

/** Pure: the trace note of a connection-filter verdict (connect stage or one RCPT). */
export function filterDecisionStage(
  stage: 'connection-check' | 'recipient-check',
  decision: ConnectionFilterDecision,
  opts: At & { recipient?: string } = {},
): TraceStage {
  const rcpt = opts.recipient ? { recipient: opts.recipient } : {};
  const at = { ...(opts.at ? { at: opts.at } : {}), ...(opts.ms !== undefined ? { ms: opts.ms } : {}) };
  if (decision.kind === 'unavailable') {
    return traceStage(stage, 'warn', { ...rcpt, unavailable: decision.detail }, at);
  }
  if (decision.kind === 'block') {
    return traceStage(stage, decision.action === 'defer' ? 'warn' : 'fail', { ...rcpt, action: decision.action, reason: decision.reason }, at);
  }
  return traceStage(stage, 'ok', { ...rcpt, ...(decision.reason ? { reason: decision.reason } : {}) }, at);
}

/**
 * Pure: the `connection` stage of a message received over SMTP plus the
 * session's connect-/RCPT-stage notes. Without session data (other callers)
 * only the client IP is known.
 */
export function sessionStages(ip: string, meta: MessageMeta | undefined, now: () => Date = () => new Date()): TraceStage[] {
  const c = meta?.connection;
  const tls = c?.tlsVersion !== undefined;
  const stage = traceStage('connection', meta && !tls ? 'warn' : 'ok', {
    clientIp: ip,
    ...(meta?.helo ? { helo: meta.helo } : {}),
    ...(meta?.protocol ? { protocol: meta.protocol } : {}),
    ...(c?.port !== undefined ? { port: c.port } : {}),
    ...(meta ? { tls } : {}),
    ...(c?.tlsVersion ? { tlsVersion: c.tlsVersion } : {}),
    ...(c?.tlsCipher ? { tlsCipher: c.tlsCipher } : {}),
    ...(c?.authUser ? { authUser: c.authUser } : {}),
    ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
  }, { ...(c?.connectedAt ? { at: c.connectedAt } : {}), now });
  return [stage, ...(c?.notes ?? [])];
}

const authResult = (spf: string, dkim: string, dmarc: string, junk?: string): TraceResult => {
  if (dmarc === 'fail' || junk) return 'fail';
  if (dmarc === 'pass' || spf === 'pass' || dkim === 'pass') return 'ok';
  return 'warn';
};

/**
 * Pure: the authentication stage from our own Authentication-Results header
 * (fallback for a security-filter without the checks summary).
 */
export function authStageFromHeaders(authHeaders: string, opts: At = {}): TraceStage | null {
  const fields = authHeaders.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter((l) => /^Authentication-Results:/i.test(l));
  const results = fields.flatMap((l) => parseAuthenticationResults(l.replace(/^Authentication-Results:\s*/i, '')).results);
  if (results.length === 0) return null;
  const get = (m: string) => results.find((r) => r.method === m);
  const spf = get('spf'), dkim = get('dkim'), dmarc = get('dmarc'), arc = get('arc');
  return traceStage('authentication', authResult(spf?.result ?? 'none', dkim?.result ?? 'none', dmarc?.result ?? 'none'), {
    spf: spf?.result ?? 'none', ...(spf && authResultDomain(spf) ? { spfDomain: authResultDomain(spf) } : {}),
    dkim: dkim?.result ?? 'none', ...(dkim && authResultDomain(dkim) ? { dkimDomains: [authResultDomain(dkim)] } : {}),
    dmarc: dmarc?.result ?? 'none', ...(dmarc && authResultDomain(dmarc) ? { headerFrom: authResultDomain(dmarc) } : {}),
    arc: arc?.result ?? 'none',
  }, opts);
}

/** Pure: stages of one content-filter verdict (checks summary first, then the decision). */
export function contentFilterStages(result: ContentFilterResult, opts: { at?: Date | string; ms?: number } = {}): TraceStage[] {
  const at = opts.at ? { at: opts.at } : {};
  const c: ContentChecksSummary = result.checks ?? {};
  const out: TraceStage[] = [];
  if (c.auth) {
    const a = c.auth;
    out.push(traceStage('authentication', authResult(a.spf, a.dkim, a.dmarc, a.junk), { ...a, ms: undefined } as Record<string, unknown>, { ...at, ...(a.ms !== undefined ? { ms: a.ms } : {}) }));
  } else if (result.authHeaders) {
    const s = authStageFromHeaders(result.authHeaders, at);
    if (s) out.push(s);
  }
  if (c.senderList) {
    out.push(traceStage('sender-list', c.senderList === 'block' ? 'fail' : 'ok', { verdict: c.senderList }, at));
  }
  if (c.attachments) {
    out.push(traceStage('attachments', c.attachments === 'blocked' ? 'fail' : c.attachments === 'ok' ? 'ok' : 'info', { verdict: c.attachments }, at));
  }
  if (c.virus) {
    const v = c.virus;
    const r: TraceResult = v.status === 'clean' ? 'ok' : v.status === 'disabled' ? 'info' : v.status === 'infected' ? 'fail' : 'warn';
    out.push(traceStage('virus-scan', r, { status: v.status, ...(v.signature ? { signature: v.signature } : {}), ...(v.reason ? { reason: v.reason } : {}) },
      { ...at, ...(v.ms !== undefined ? { ms: v.ms } : {}) }));
  } else if (result.virusName || result.virusScan) {
    const signature = result.virusName ?? result.virusScan?.signature;
    out.push(traceStage('virus-scan', result.virusName ? 'fail' : 'warn', {
      status: result.virusScan?.status ?? 'infected',
      ...(signature ? { signature } : {}),
      ...(result.virusScan?.reason ? { reason: result.virusScan.reason } : {}),
    }, at));
  }
  if (c.spam) {
    const s = c.spam;
    const r: TraceResult = s.verdict === 'inbox' || s.verdict === 'allowlisted' ? 'ok' : s.verdict === 'junk' ? 'warn' : s.verdict === 'reject' ? 'fail' : 'info';
    out.push(traceStage('spam', r, { verdict: s.verdict, ...(s.score !== undefined ? { score: s.score } : {}), ...(s.dnsblZones ? { dnsblZones: s.dnsblZones } : {}) },
      { ...at, ...(s.ms !== undefined ? { ms: s.ms } : {}) }));
  } else if (result.spamScore !== undefined) {
    out.push(traceStage('spam', result.junkFolder ? 'warn' : 'ok', { score: result.spamScore, verdict: result.junkFolder ? 'junk' : 'inbox' }, at));
  }
  const decision: TraceResult = result.action === 'accept' ? (result.junkFolder ? 'warn' : 'ok')
    : result.action === 'defer' ? 'warn' : 'fail';
  out.push(traceStage('content-filter', decision, {
    action: result.action,
    ...(result.junkFolder ? { junk: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  }, { ...at, ...(opts.ms !== undefined ? { ms: opts.ms } : {}) }));
  return out;
}

/** Pure: what the matching transport rules did (ids are resolved to names by the reader). */
export function transportRuleDetail(o: TransportOutcome): Record<string, unknown> {
  const actions: string[] = [];
  if (o.rejected) actions.push('reject');
  if (o.quarantined) actions.push('quarantine');
  if (o.redirectedTo.length) actions.push('redirect');
  if (o.additionalRcpts.length) actions.push('addRecipient');
  if (o.removedRcpts.length) actions.push('removeRecipient');
  if (o.headerAdds.length) actions.push('addHeader');
  if (o.headerRemoves.length) actions.push('removeHeader');
  if (o.subjectPrefix || o.subjectSuffix) actions.push('subject');
  if (o.disclaimerHtml) actions.push('disclaimer');
  return { ruleIds: o.appliedRuleIds, ...(actions.length ? { actions } : {}) };
}

/** Pure: the alias / group expansion stage (only addresses that changed); null when nothing was expanded. */
export function aliasStage(origins: ReadonlyMap<string, readonly string[]>, opts: At = {}): TraceStage | null {
  const lines: string[] = [];
  for (const [target, sources] of origins) {
    for (const src of sources) if (src.toLowerCase() !== target.toLowerCase()) lines.push(`${src} → ${target}`);
  }
  return lines.length ? traceStage('aliases', 'info', { expanded: lines }, opts) : null;
}

/** Pure: stages of the outbound relay (MX lookup per domain, one stage per remote connection). */
export function relayStages(hops: readonly RelayHop[]): TraceStage[] {
  const out: TraceStage[] = [];
  const mxSeen = new Set<string>();
  for (const h of hops) {
    if (h.mode === 'mx' && h.domain && !mxSeen.has(h.domain)) {
      mxSeen.add(h.domain);
      out.push(traceStage('mx', h.mxError ? (h.permanent ? 'fail' : 'warn') : 'ok', {
        domain: h.domain,
        ...(h.mx?.length ? { records: h.mx.map((r) => `${r.priority} ${r.exchange || '.'}`) } : {}),
        ...(!h.mxError && h.mx && h.mx.length === 0 ? { implicit: true } : {}),
        ...(h.mxError ? { error: h.mxError } : {}),
      }, { at: h.at }));
    }
    if (!h.host) continue;
    const r: TraceResult = h.failed === 0 ? 'ok' : h.permanent ? 'fail' : 'warn';
    out.push(traceStage('remote', r, {
      mode: h.mode,
      ...(h.domain ? { domain: h.domain } : {}),
      host: h.host,
      ...(h.address ? { address: h.address } : {}),
      ...(h.port !== undefined ? { port: h.port } : {}),
      ...(h.tls ? { tls: h.tls } : {}),
      ...(h.code !== undefined && h.code !== null ? { code: h.code } : {}),
      ...(h.response ? { response: h.response } : {}),
      delivered: h.delivered,
      failed: h.failed,
    }, { at: h.at, ...(h.ms !== undefined ? { ms: h.ms } : {}) }));
  }
  return out;
}
