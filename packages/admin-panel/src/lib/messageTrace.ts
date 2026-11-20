/**
 * Message trace detail (10.2) — pure helpers for the BCP detail panel of
 * "Nachrichtenablaufverfolgung": response types of
 * GET /admin/message-trace/:id, stage / detail label keys (i18n), value
 * formatting and badge tones. Everything is rendered as React text.
 */

export type TraceResult = 'ok' | 'warn' | 'fail' | 'info';
export type DetailValue = string | number | boolean | string[];

export interface TraceStage {
  stage: string;
  at: string;
  ms?: number;
  result: TraceResult | string;
  detail?: Record<string, DetailValue>;
}

export interface TraceEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

export interface ReceivedHop {
  from?: string; fromRdns?: string; fromIp?: string; by?: string; with?: string; id?: string; for?: string;
  tls: boolean; tlsVersion?: string; tlsCipher?: string; time?: string; delayMs?: number; raw?: string;
}

export interface OutboundHop {
  from: string; to: string; domain?: string; address?: string; port?: number; tls: boolean; tlsMode?: string;
  time: string; ms?: number; code?: number; response?: string; result: string;
}

export interface AuthSummary {
  authResults: Array<{ source: string; authservId: string; results: Array<{ method: string; result: string; domain?: string }> }>;
  arcSeals: Array<{ instance: number; cv: string; domain?: string }>;
}

export type DeliveryPath =
  | { kind: 'received'; hops: ReceivedHop[]; auth: AuthSummary }
  | { kind: 'outbound'; hops: OutboundHop[] }
  | { kind: 'none'; reason: 'not-stored' | 'unavailable' | 'no-route' };

export type TraceDirection = 'inbound' | 'outbound' | 'internal' | 'unknown';

export interface TraceDetail {
  entry: TraceEntry;
  direction: TraceDirection;
  trace: { stages: TraceStage[] } | null;
  related: Array<TraceEntry & { trace: { stages: TraceStage[] } | null }>;
  path: DeliveryPath;
}

/** Badge classes per result (theme tokens only). */
export const RESULT_TONE: Readonly<Record<TraceResult, string>> = Object.freeze({
  ok: 'bg-success-bg text-success-fg',
  warn: 'bg-warning-bg text-warning-fg',
  fail: 'bg-danger-bg text-danger-fg',
  info: 'bg-surface-2 text-fg-muted',
});

export function resultOf(r: unknown): TraceResult {
  return r === 'ok' || r === 'warn' || r === 'fail' ? r : 'info';
}

/** Stages with their own label (`mt_stage_<name>`, dashes as underscores). */
export const KNOWN_STAGES: readonly string[] = [
  'connection', 'connection-check', 'recipient-check', 'authentication', 'sender-list', 'attachments', 'virus-scan',
  'spam', 'content-filter', 'aliases', 'transport-rules', 'inbox-rules', 'admin-forward', 'delivery', 'submission',
  'queued', 'smime', 'dkim', 'mx', 'remote', 'local-delivery', 'dsn', 'queue-result',
];

/** Translation key of a stage label. */
export function stageLabelKey(stage: string): string {
  return KNOWN_STAGES.includes(stage) ? `mt_stage_${stage.replace(/-/g, '_')}` : 'mt_stage_other';
}

/** Translation key of a detail label (`mt_k_<key>`); the caller shows the raw key when it is unknown. */
export function detailLabelKey(key: string): string {
  return `mt_k_${key}`;
}

/** Detail keys whose values are words with a translation (`mt_v_<value>`). */
const VALUE_KEYS = new Set(['verdict', 'status', 'outcome', 'action', 'mode', 'junk', 'reason', 'tls']);

/** Translation key of a value, or null when it is shown as it is. */
export function valueLabelKey(key: string, value: DetailValue): string | null {
  if (typeof value !== 'string' || !VALUE_KEYS.has(key) || !/^[a-z][a-z-]{0,30}$/.test(value)) return null;
  return `mt_v_${value.replace(/-/g, '_')}`;
}

/** Keys shown in a stage's detail list, in this order first; the rest follow as stored. */
const KEY_ORDER = [
  'clientIp', 'helo', 'protocol', 'port', 'authUser', 'sessionId',
  'domain', 'host', 'address', 'records', 'implicit', 'error', 'mode',
  'verdict', 'status', 'outcome', 'action', 'reason', 'score', 'signature',
  'spf', 'spfDomain', 'dkim', 'dkimDomains', 'dmarc', 'dmarcPolicy', 'headerFrom', 'arc', 'arcSealer', 'junk',
  'mailbox', 'folder', 'recipient', 'code', 'response',
];

/** Keys a stage renders in a special line (connection TLS) or never shows. */
const HIDDEN_KEYS: Readonly<Record<string, readonly string[]>> = {
  connection: ['tls', 'tlsVersion', 'tlsCipher'],
  remote: ['tls'],
  'transport-rules': ['ruleIds'],
};

/** Pure: the detail entries of a stage to list, ordered. */
export function detailEntries(stage: TraceStage): Array<[string, DetailValue]> {
  const hidden = new Set(HIDDEN_KEYS[stage.stage] ?? []);
  const entries = Object.entries(stage.detail ?? {}).filter(([k]) => !hidden.has(k));
  // transport rules: the names replace the ids when the server resolved them
  if (stage.stage === 'transport-rules' && !stage.detail?.['ruleNames'] && stage.detail?.['ruleIds']) {
    entries.unshift(['ruleIds', stage.detail['ruleIds']]);
  }
  const rank = (k: string) => { const i = KEY_ORDER.indexOf(k); return i < 0 ? KEY_ORDER.length : i; };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** Pure: transport security of a connection / remote stage: encrypted + version · cipher (or STARTTLS / TLS). */
export function stageTls(stage: TraceStage): { encrypted: boolean; text: string } | null {
  const d = stage.detail ?? {};
  if (stage.stage === 'connection') {
    if (d['tls'] === undefined && d['tlsVersion'] === undefined) return null;
    const encrypted = d['tls'] === true || typeof d['tlsVersion'] === 'string';
    const text = [d['tlsVersion'], d['tlsCipher']].filter((x) => typeof x === 'string').join(' · ');
    return { encrypted, text };
  }
  if (stage.stage === 'remote' && typeof d['tls'] === 'string') {
    const encrypted = d['tls'] === 'starttls' || d['tls'] === 'implicit';
    return { encrypted, text: d['tls'] === 'starttls' ? 'STARTTLS' : d['tls'] === 'implicit' ? 'TLS' : '' };
  }
  return null;
}

/** Pure: a duration for people ("<1 ms", "850 ms", "2,3 s", "4 min", "2 h 5 min"). */
export function formatDuration(ms: number, lang: 'de' | 'en' = 'de'): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '−' : '';
  const num = (n: number, digits: number) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: digits });
  if (abs < 1) return '<1 ms';
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  if (abs < 60_000) return `${sign}${num(abs / 1000, 1)} s`;
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)} min`;
  const h = Math.floor(abs / 3_600_000);
  const m = Math.round((abs % 3_600_000) / 60_000);
  return `${sign}${h} h${m ? ` ${m} min` : ''}`;
}

/** Pure: a byte count for people (KB / MB). */
export function formatBytes(bytes: number, lang: 'de' | 'en' = 'de'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const loc = lang === 'en' ? 'en-GB' : 'de-DE';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString(loc, { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(loc, { maximumFractionDigits: 1 })} MB`;
}

/** Pure: a detail value as text (lists joined; booleans and words are translated by the caller). */
export function plainValue(key: string, value: DetailValue, lang: 'de' | 'en' = 'de'): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') {
    if (/ms$/i.test(key)) return formatDuration(value, lang);
    return value.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 2, useGrouping: key !== 'port' && key !== 'code' });
  }
  return String(value);
}

const str = (m: Record<string, unknown> | null, k: string): string => (m && typeof m[k] === 'string' ? m[k] as string : '');

/** Pure: the overview facts of an entry (strings as stored; empty = not recorded). */
export function overviewOf(entry: TraceEntry): {
  messageId: string; sender: string; recipients: string[]; subject: string; size: number | null; status: string;
  reason: string; spamScore: string; attempt: string;
} {
  const m = entry.metadata;
  const size = Number.parseInt(str(m, 'size'), 10);
  return {
    messageId: str(m, 'headerMessageId') || str(m, 'messageId'),
    sender: str(m, 'sender'),
    recipients: str(m, 'recipient').split(',').map((r) => r.trim()).filter(Boolean),
    subject: str(m, 'subject'),
    size: Number.isFinite(size) ? size : null,
    status: str(m, 'status'),
    reason: str(m, 'reason'),
    spamScore: str(m, 'spamScore'),
    attempt: str(m, 'attempt'),
  };
}

/** Pure: the entry carries no processing record (written before 10.2) or no delivery path. */
export function hasFewerDetails(d: Pick<TraceDetail, 'trace'>): boolean {
  return !d.trace || d.trace.stages.length === 0;
}

/** Pure: time of day of an ISO instant (seconds precision). */
export function timeOfDay(iso: string, lang: 'de' | 'en' = 'de'): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Pure: date and time of an ISO instant. */
export function dateTime(iso: string, lang: 'de' | 'en' = 'de'): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE');
}
