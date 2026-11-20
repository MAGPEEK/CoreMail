/**
 * Message trace (10.2) — the compact processing record a MAIL_FLOW row
 * (SystemLog, category MAIL_FLOW) carries in `metadata.trace`: what CoreMail
 * did with a message, stage by stage (connection, checks, rules, delivery,
 * queue, MX, remote reply, DSN).
 *
 * Writers (smtp-server) build it with createTraceRecorder(); the reader
 * (api-gateway message trace detail) validates it with sanitizeTrace() before
 * it leaves the server. Never message bodies; every list and string is capped
 * so a row stays small (a few KB at most).
 *
 * Also here: a tolerant RFC 8601 Authentication-Results parser, shared by the
 * trace writer (our own verdict) and the reader (hops of a stored message).
 */

export type TraceResult = 'ok' | 'warn' | 'fail' | 'info';
export type TraceDetailValue = string | number | boolean | string[];
export type TraceDetail = Record<string, TraceDetailValue>;

// Object type aliases (not interfaces): assignable to Prisma's JSON input type.
export type TraceStage = {
  /** Stage name, e.g. `connection`, `authentication`, `spam`, `delivery`, `mx`, `remote`. */
  stage: string;
  /** ISO time the stage happened (or started). */
  at: string;
  /** Duration in ms, when measured. */
  ms?: number;
  result: TraceResult;
  /** Short structured facts (bounded, see TRACE_LIMITS). */
  detail?: TraceDetail;
};

export type MessageTrace = {
  v: 1;
  stages: TraceStage[];
};

export const TRACE_LIMITS = Object.freeze({
  /** Stages per row. */
  stages: 48,
  /** Keys per detail object. */
  detailKeys: 16,
  /** Characters per string value. */
  string: 300,
  /** Entries per list value. */
  list: 12,
});

const STAGE_RE = /^[a-z][a-z0-9-]{0,40}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const RESULTS: readonly TraceResult[] = ['ok', 'warn', 'fail', 'info'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

/** One line, control characters removed, at most `max` characters. */
export function traceText(value: unknown, max: number = TRACE_LIMITS.string): string {
  const s = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const flat = s.replace(CONTROL_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function boundValue(v: unknown): TraceDetailValue | undefined {
  if (typeof v === 'string') { const t = traceText(v); return t === '' ? undefined : t; }
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => traceText(x)).filter(Boolean);
    if (items.length === 0) return undefined;
    return items.length > TRACE_LIMITS.list
      ? [...items.slice(0, TRACE_LIMITS.list), `+${items.length - TRACE_LIMITS.list}`]
      : items;
  }
  return undefined;
}

/** Pure: a detail object with valid keys and bounded values only; undefined when empty. */
export function boundDetail(detail: unknown): TraceDetail | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const out: TraceDetail = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (n >= TRACE_LIMITS.detailKeys) break;
    if (!KEY_RE.test(k)) continue;
    const b = boundValue(v);
    if (b === undefined) continue;
    out[k] = b;
    n++;
  }
  return n > 0 ? out : undefined;
}

function isoOf(at: Date | string | undefined, now: () => Date): string {
  if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString();
  if (typeof at === 'string') {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now().toISOString();
}

/** Pure: one bounded stage. */
export function traceStage(
  stage: string,
  result: TraceResult,
  detail?: Record<string, unknown>,
  opts: { at?: Date | string; ms?: number; now?: () => Date } = {},
): TraceStage {
  const d = boundDetail(detail);
  const ms = typeof opts.ms === 'number' && Number.isFinite(opts.ms) && opts.ms >= 0 ? Math.round(opts.ms) : undefined;
  return {
    stage: STAGE_RE.test(stage) ? stage : 'other',
    at: isoOf(opts.at, opts.now ?? (() => new Date())),
    ...(ms !== undefined ? { ms } : {}),
    result: RESULTS.includes(result) ? result : 'info',
    ...(d ? { detail: d } : {}),
  };
}

export interface TraceRecorder {
  /** Adds a stage (dropped beyond TRACE_LIMITS.stages). */
  add(stage: string, result: TraceResult, detail?: Record<string, unknown>, opts?: { at?: Date | string; ms?: number }): void;
  /** Adds already built stages (e.g. the session's connection notes). */
  push(...stages: readonly TraceStage[]): void;
  /** Copy of the stages recorded so far. */
  stages(): TraceStage[];
  /** The `metadata.trace` value of a MAIL_FLOW row. */
  toJSON(): MessageTrace;
}

/** A bounded stage collector, optionally seeded with the stages of an earlier step. */
export function createTraceRecorder(seed: readonly TraceStage[] = [], now: () => Date = () => new Date()): TraceRecorder {
  const list: TraceStage[] = [];
  const room = () => list.length < TRACE_LIMITS.stages;
  const push = (...stages: readonly TraceStage[]) => {
    for (const s of stages) { if (!room()) return; list.push(s); }
  };
  push(...seed);
  return {
    add(stage, result, detail, opts = {}) {
      if (!room()) return;
      list.push(traceStage(stage, result, detail, { ...opts, now }));
    },
    push,
    stages: () => [...list],
    toJSON: () => ({ v: 1, stages: [...list] }),
  };
}

/**
 * Pure: validates a stored trace (reader side). Anything malformed is dropped
 * stage by stage; returns null when nothing usable is left. Rows written
 * before 10.2 have no trace.
 */
export function sanitizeTrace(value: unknown): MessageTrace | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { stages?: unknown }).stages;
  if (!Array.isArray(raw)) return null;
  const stages: TraceStage[] = [];
  for (const s of raw.slice(0, TRACE_LIMITS.stages)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o['stage'] !== 'string' || !STAGE_RE.test(o['stage'])) continue;
    if (typeof o['at'] !== 'string' || Number.isNaN(new Date(o['at']).getTime())) continue;
    const result = RESULTS.includes(o['result'] as TraceResult) ? o['result'] as TraceResult : 'info';
    const detail = boundDetail(o['detail']);
    const ms = typeof o['ms'] === 'number' && Number.isFinite(o['ms']) && o['ms'] >= 0 ? Math.round(o['ms']) : undefined;
    stages.push({ stage: o['stage'], at: new Date(o['at']).toISOString(), ...(ms !== undefined ? { ms } : {}), result, ...(detail ? { detail } : {}) });
  }
  return stages.length > 0 ? { v: 1, stages } : null;
}

// ─── RFC 8601 Authentication-Results ────────────────────────────────────────

export interface AuthMethodResult {
  /** Method in lower case: spf, dkim, dmarc, arc, iprev, auth, x-… */
  method: string;
  /** Result in lower case: pass, fail, softfail, none, … */
  result: string;
  /** `reason` and `ptype.property` values (e.g. `header.d`, `smtp.mailfrom`). */
  props: Record<string, string>;
}

export interface AuthResultsSummary {
  authservId: string;
  results: AuthMethodResult[];
}

/** Longest Authentication-Results value parsed (longer input is cut). */
export const AUTH_RESULTS_MAX_CHARS = 4096;
const AUTH_MAX_METHODS = 16;
const AUTH_MAX_PROPS = 8;

/** Removes RFC 5322 comments (nested, quoted strings kept) — linear time. */
function stripComments(s: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      out += c;
      if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (c === '(') { depth = 1; out += ' '; continue; }
    if (c === '"') quoted = true;
    out += c;
  }
  return out;
}

/** Splits on `sep` outside quoted strings. */
function splitOutsideQuotes(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') quoted = !quoted;
    if (!quoted && sep.test(c)) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

const unquote = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);

/**
 * Pure: parses the value of one Authentication-Results (or
 * ARC-Authentication-Results, after its `i=N;` instance tag) header field.
 * Tolerant: unknown syntax is skipped, never thrown; bounded input.
 */
export function parseAuthenticationResults(value: string): AuthResultsSummary {
  const text = stripComments(value.slice(0, AUTH_RESULTS_MAX_CHARS).replace(/\r?\n[ \t]+/g, ' '));
  const segments = splitOutsideQuotes(text, /;/).map((s) => s.trim());
  let first = segments.shift() ?? '';
  // ARC-Authentication-Results: "i=1; authserv-id; …"
  if (/^i\s*=\s*\d+$/i.test(first)) first = segments.shift() ?? '';
  const authservId = traceText(first.split(/\s+/)[0] ?? '', 255);
  const results: AuthMethodResult[] = [];
  for (const seg of segments) {
    if (results.length >= AUTH_MAX_METHODS) break;
    const tokens = splitOutsideQuotes(seg, /\s/).filter(Boolean);
    const head = /^([A-Za-z0-9_.-]+)(?:\/\d+)?\s*=\s*([A-Za-z0-9_-]+)$/.exec(tokens[0] ?? '');
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const tok of tokens.slice(1)) {
      if (Object.keys(props).length >= AUTH_MAX_PROPS) break;
      const kv = /^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)=(.+)$/.exec(tok);
      if (kv) props[kv[1]!.toLowerCase()] = traceText(unquote(kv[2]!), 255);
    }
    results.push({ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Pure: the domain a method result names (header.d / header.from / smtp.mailfrom / …). */
export function authResultDomain(r: AuthMethodResult): string {
  const p = r.props;
  const v = p['header.d'] ?? p['header.from'] ?? p['smtp.mailfrom'] ?? p['smtp.helo'] ?? p['header.i'] ?? p['policy.iprev'] ?? '';
  const at = v.lastIndexOf('@');
  return (at >= 0 ? v.slice(at + 1) : v).toLowerCase();
}
