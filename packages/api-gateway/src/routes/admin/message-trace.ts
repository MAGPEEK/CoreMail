/**
 * Admin API: message trace
 *
 * GET /api/v1/admin/message-trace   — search messages (from SystemLog MAIL_FLOW)
 * GET /api/v1/admin/message-trace/export — CSV export
 * GET /api/v1/admin/message-trace/:id — one entry in detail (10.2): processing
 *     stages (`metadata.trace`), the related entries of the same message
 *     (queue attempts, other recipients) and the delivery path (Received chain
 *     of the stored original; outbound: CoreMail → the MX that was used)
 *
 * Reads from the SystemLog table (category='MAIL_FLOW').
 * The SMTP server writes a log entry there for every mail.
 */
import type { Readable } from 'node:stream';
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma, getObjectStream, sanitizeTrace, type TraceStage } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { csvCellQuoted } from '../../lib/export-safety.js';
import { redactorOf, scopeOf } from '../../middleware/admin-scope.js';
import {
  anyAddressInScope, isScoped, scopeDomainIds, domainOfAddress, OUT_OF_SCOPE_NOT_FOUND,
  type AddressRedactor, type AdminScope,
} from '../../lib/admin-scope.js';
import {
  headerBlock, headerFields, parseReceivedChain, authSummary, HEADER_READ_LIMIT,
  type ReceivedHop, type HeaderAuthSummary,
} from '../../lib/received-hops.js';

export const adminMessageTraceRouter: RouterType = Router();

export interface TraceFilter { sender?: string; recipient?: string; subject?: string; status?: string }

/**
 * Post-filter on the MAIL_FLOW metadata — shared by the list and the CSV export
 * so both return the same rows: sender/recipient/subject are case-insensitive
 * substring matches, status is exact.
 */
export function matchesTraceFilter(metadata: unknown, f: TraceFilter): boolean {
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  const has = (key: string, needle: string | undefined): boolean =>
    !needle || (typeof m[key] === 'string' && (m[key] as string).toLowerCase().includes(needle.toLowerCase()));
  if (!has('sender', f.sender)) return false;
  if (!has('recipient', f.recipient)) return false;
  if (!has('subject', f.subject)) return false;
  if (f.status && m['status'] !== f.status) return false;
  return true;
}
adminMessageTraceRouter.use(requireArea('compliance'));

/** Addresses of a MAIL_FLOW field (one address or a comma-separated list). */
function addressesOf(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((a) => a.trim()).filter(Boolean) : [];
}

/**
 * Pure (9.5): is a MAIL_FLOW entry inside a management scope? The sender or a
 * recipient must be an address of the admin's domains (organisation-wide: all).
 */
export function traceRowInScope(scope: AdminScope, metadata: unknown): boolean {
  if (!isScoped(scope)) return true;
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  return anyAddressInScope(scope, [...addressesOf(m['sender']), ...addressesOf(m['recipient'])]);
}

/**
 * Pure (w3 scope leaks): a MAIL_FLOW row as a scoped admin sees it — the
 * addresses of other hosted domains in its metadata and message text read
 * "(andere Domain)". Scoped searches match the redacted row (no oracle).
 */
export function redactTraceRow<T extends { metadata: unknown; message?: string }>(r: AddressRedactor, row: T): T {
  if (!r.active) return row;
  return { ...row, metadata: r.deep(row.metadata), ...(typeof row.message === 'string' ? { message: r.text(row.message) } : {}) };
}

/** The rows a scoped admin may see, redacted (organisation-wide: unchanged). */
function visibleRows<T extends { metadata: unknown; message?: string }>(scope: AdminScope, r: AddressRedactor, rows: T[]): T[] {
  return rows.filter((row) => traceRowInScope(scope, row.metadata)).map((row) => redactTraceRow(r, row));
}

/** Max. rows scanned for a filtered search / export (metadata is JSON, filtered in memory). */
export const TRACE_SCAN_LIMIT = 5000;

/** Page window: page ≥ 1, limit 1–500 (default 100); garbage → defaults. */
export function tracePage(pageStr: unknown, limitStr: unknown): { page: number; limit: number } {
  const p = Number.parseInt(typeof pageStr === 'string' ? pageStr : '', 10);
  const l = Number.parseInt(typeof limitStr === 'string' ? limitStr : '', 10);
  return {
    page: Number.isFinite(p) && p > 0 ? p : 1,
    limit: Number.isFinite(l) ? Math.min(Math.max(l, 1), 500) : 100,
  };
}

/** Prisma where (MAIL_FLOW + time range), or an error message for an invalid date. */
export function traceWhere(fromDate: string, toDate: string): { where: Record<string, unknown> } | { error: string } {
  const where: Record<string, unknown> = { category: 'MAIL_FLOW' };
  const ts: Record<string, Date> = {};
  for (const [key, v, op] of [['from', fromDate, 'gte'], ['to', toDate, 'lte']] as const) {
    if (!v) continue;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return { error: `Invalid date in "${key}"` };
    ts[op] = d;
  }
  if (Object.keys(ts).length) where['timestamp'] = ts;
  return { where };
}

/**
 * One page of a filtered search: the filter runs over the newest
 * TRACE_SCAN_LIMIT rows, so page, total and the rows agree (an over-fetch
 * window per page would skip matches and report the unfiltered total).
 */
export function pageFiltered<T extends { metadata: unknown }>(rows: T[], f: TraceFilter, page: number, limit: number): { items: T[]; total: number } {
  const matched = rows.filter((r) => matchesTraceFilter(r.metadata, f));
  return { items: matched.slice((page - 1) * limit, page * limit), total: matched.length };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── GET / ─────────────────────────────────────────────────────────────────────
adminMessageTraceRouter.get('/', async (req: Request, res: Response) => {
  const q = req.query;
  // status: ACCEPTED | DELIVERED | JUNK | QUARANTINE | REJECTED | DEFERRED
  const filter: TraceFilter = { sender: str(q['sender']), recipient: str(q['recipient']), subject: str(q['subject']), status: str(q['status']) };
  const { page, limit } = tracePage(q['page'], q['limit']);
  const w = traceWhere(str(q['from']), str(q['to']));
  if ('error' in w) { res.status(400).json({ error: w.error }); return; }
  const select = { id: true, timestamp: true, level: true, message: true, metadata: true, userId: true } as const;

  const scope = scopeOf(req);
  // 9.5: a scoped admin always goes through the filtered scan (the scope is a metadata filter)
  if (!isScoped(scope) && !filter.sender && !filter.recipient && !filter.subject && !filter.status) {
    const [items, total] = await Promise.all([
      prisma.systemLog.findMany({ where: w.where, orderBy: { timestamp: 'desc' }, skip: (page - 1) * limit, take: limit, select }),
      prisma.systemLog.count({ where: w.where }),
    ]);
    res.json({ items, total, page, limit, truncated: false });
    return;
  }

  const rows = await prisma.systemLog.findMany({ where: w.where, orderBy: { timestamp: 'desc' }, take: TRACE_SCAN_LIMIT, select });
  const { items, total } = pageFiltered(visibleRows(scope, await redactorOf(req), rows), filter, page, limit);
  res.json({ items, total, page, limit, truncated: rows.length >= TRACE_SCAN_LIMIT });
});

// ── GET /export ───────────────────────────────────────────────────────────────
adminMessageTraceRouter.get('/export', async (req: Request, res: Response) => {
  const q = req.query;
  const sender = str(q['sender']), recipient = str(q['recipient']), subject = str(q['subject']), status = str(q['status']);
  const w = traceWhere(str(q['from']), str(q['to']));
  if ('error' in w) { res.status(400).json({ error: w.error }); return; }

  const rows = await prisma.systemLog.findMany({
    where: w.where, orderBy: { timestamp: 'desc' }, take: TRACE_SCAN_LIMIT,
    select: { timestamp: true, message: true, metadata: true },
  });

  const scope = scopeOf(req);
  const filtered = visibleRows(scope, await redactorOf(req), rows)
    .filter((r) => matchesTraceFilter(r.metadata, { sender, recipient, subject, status }));

  const header = 'Zeitstempel,Absender,Empfänger,Betreff,Status,MessageId\r\n';
  const lines = filtered.map(r => {
    const m = (r.metadata ?? {}) as Record<string, string>;
    const esc = (s: string) => csvCellQuoted(s ?? ''); // formula-safe (lib/export-safety.ts)
    return [
      esc(new Date(r.timestamp).toISOString()),
      esc(m['sender'] ?? ''), esc(m['recipient'] ?? ''),
      esc(m['subject'] ?? ''), esc(m['status'] ?? ''), esc(m['messageId'] ?? ''),
    ].join(',');
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="message-trace.csv"');
  res.send(header + lines.join('\r\n'));
});

// ── GET /:id — detail (10.2) ──────────────────────────────────────────────────

/** Window around an entry in which its related entries (queue attempts, other recipients) are searched. */
export const RELATED_WINDOW_MS = Object.freeze({ before: 2 * 86_400_000, after: 8 * 86_400_000 });
/** Related entries returned at most. */
export const RELATED_LIMIT = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const metaOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const metaStr = (m: Record<string, unknown>, key: string): string => (typeof m[key] === 'string' ? m[key] as string : '');

/**
 * Pure: the keys that tie the MAIL_FLOW entries of one message together — the
 * queue tracking id (REST/JMAP/EAS/MAPI accept entry + every queue attempt),
 * the Message-ID header (inbound recipients, 10.2 queue entries) and the
 * tracking ids an SMTP submission queued.
 */
export function correlationKeys(row: { messageId?: string | null; metadata: unknown }): string[] {
  const m = metaOf(row.metadata);
  const keys = [row.messageId ?? '', metaStr(m, 'messageId'), metaStr(m, 'headerMessageId'), ...metaStr(m, 'queueTrackingIds').split(',')]
    .map((k) => k.trim())
    .filter((k) => k.length >= 6 && k.length <= 255);
  return [...new Set(keys)].slice(0, 6);
}

/** Pure: does `candidate` share a correlation key with `row`? */
export function isRelated(row: { messageId?: string | null; metadata: unknown }, candidate: { messageId?: string | null; metadata: unknown }): boolean {
  const keys = new Set(correlationKeys(row));
  return correlationKeys(candidate).some((k) => keys.has(k));
}

export type TraceDirection = 'inbound' | 'outbound' | 'internal' | 'unknown';

/** Pure: inbound / outbound, or internal when sender and every recipient are hosted domains. */
export function traceDirection(metadata: unknown, hostedDomains: readonly string[]): TraceDirection {
  const m = metaOf(metadata);
  const hosted = new Set(hostedDomains.map((d) => d.toLowerCase()));
  const sender = domainOfAddress(metaStr(m, 'sender'));
  const rcpts = metaStr(m, 'recipient').split(',').map((a) => domainOfAddress(a)).filter(Boolean);
  if (sender && hosted.has(sender) && rcpts.length > 0 && rcpts.every((d) => hosted.has(d))) return 'internal';
  const dir = metaStr(m, 'direction').toUpperCase();
  return dir === 'INBOUND' ? 'inbound' : dir === 'OUTBOUND' ? 'outbound' : 'unknown';
}

/** One step of the outbound delivery path: CoreMail → the host it connected to. */
export interface OutboundHop {
  from: string;
  to: string;
  domain?: string;
  address?: string;
  port?: number;
  tls: boolean;
  tlsMode?: string;
  time: string;
  ms?: number;
  code?: number;
  response?: string;
  result: string;
}

/** Pure: the outbound path from the `remote` stages of the entries' traces, in time order. */
export function outboundHops(stages: readonly TraceStage[], ourHost: string): OutboundHop[] {
  return stages
    .filter((s) => s.stage === 'remote' && typeof s.detail?.['host'] === 'string')
    .map((s) => {
      const d = s.detail ?? {};
      const tlsMode = typeof d['tls'] === 'string' ? d['tls'] : undefined;
      return {
        from: ourHost,
        to: String(d['host']),
        ...(typeof d['domain'] === 'string' ? { domain: d['domain'] } : {}),
        ...(typeof d['address'] === 'string' ? { address: d['address'] } : {}),
        ...(typeof d['port'] === 'number' ? { port: d['port'] } : {}),
        tls: tlsMode === 'starttls' || tlsMode === 'implicit',
        ...(tlsMode ? { tlsMode } : {}),
        time: s.at,
        ...(s.ms !== undefined ? { ms: s.ms } : {}),
        ...(typeof d['code'] === 'number' ? { code: d['code'] } : {}),
        ...(typeof d['response'] === 'string' ? { response: d['response'] } : {}),
        result: s.result,
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Pure: the transport-rule stages with the names of their rules (ids stay). */
export function withRuleNames(stages: readonly TraceStage[], names: ReadonlyMap<string, string>): TraceStage[] {
  return stages.map((s) => {
    if (s.stage !== 'transport-rules' || !Array.isArray(s.detail?.['ruleIds'])) return s;
    const ruleNames = (s.detail['ruleIds'] as string[]).map((id) => names.get(id)).filter((n): n is string => !!n);
    return ruleNames.length ? { ...s, detail: { ...s.detail, ruleNames } } : s;
  });
}

/** The metadata of an entry without its trace (sent separately, validated). */
function plainMetadata(metadata: unknown): Record<string, unknown> {
  const { trace: _trace, ...rest } = metaOf(metadata);
  return rest;
}

/** Prisma `where`: a message whose mailbox belongs to a user or Shared Mailbox inside the scope. */
function messageScopeWhere(scope: AdminScope): Record<string, unknown> {
  const ids = scopeDomainIds(scope);
  if (!ids) return {};
  return { folder: { mailbox: { OR: [{ user: { domainId: { in: ids } } }, { sharedBox: { domainId: { in: ids } } }] } } };
}

/**
 * The stored copy of an inbound entry inside the scope: by the id the 10.2
 * delivery recorded, else (older entries) by Message-ID in the recipient's mailbox.
 */
async function storedMessageOf(metadata: unknown, scope: AdminScope): Promise<{ storagePath: string | null } | null> {
  const m = metaOf(metadata);
  const id = metaStr(m, 'storedMessageId');
  const scoped = messageScopeWhere(scope);
  if (id && ID_RE.test(id)) {
    return prisma.message.findFirst({ where: { AND: [{ id }, scoped] }, select: { storagePath: true } });
  }
  const header = metaStr(m, 'messageId');
  const rcpt = metaStr(m, 'recipient').trim().toLowerCase();
  if (!header || header.length > 255 || !rcpt || rcpt.includes(',')) return null;
  return prisma.message.findFirst({
    where: { AND: [{ messageId: header }, { folder: { mailbox: { OR: [{ user: { email: rcpt } }, { sharedBox: { email: rcpt } }] } } }, scoped] },
    select: { storagePath: true },
  });
}

/** The first HEADER_READ_LIMIT bytes of a stored original (the rest is never read). */
async function readHead(key: string, limit: number = HEADER_READ_LIMIT): Promise<Buffer> {
  const stream: Readable = await getObjectStream(key);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      chunks.push(b);
      size += b.length;
      if (size >= limit) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

export type DeliveryPath =
  | { kind: 'received'; hops: ReceivedHop[]; auth: HeaderAuthSummary }
  | { kind: 'outbound'; hops: OutboundHop[] }
  | { kind: 'none'; reason: 'not-stored' | 'unavailable' | 'no-route' };

adminMessageTraceRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '');
  const select = { id: true, timestamp: true, level: true, message: true, metadata: true, messageId: true } as const;
  const scope = scopeOf(req);
  const row = ID_RE.test(id) ? await prisma.systemLog.findFirst({ where: { id, category: 'MAIL_FLOW' }, select }) : null;
  // Out of scope answers exactly like an unknown id (no existence oracle).
  if (!row || !traceRowInScope(scope, row.metadata)) { res.status(404).json(OUT_OF_SCOPE_NOT_FOUND); return; }
  const redact = await redactorOf(req);

  // Related entries: same message (queue attempts, accept entry, other recipients) near in time.
  const keys = correlationKeys(row);
  const t = new Date(row.timestamp).getTime();
  const candidates = keys.length === 0 ? [] : await prisma.systemLog.findMany({
    where: {
      category: 'MAIL_FLOW',
      timestamp: { gte: new Date(t - RELATED_WINDOW_MS.before), lte: new Date(t + RELATED_WINDOW_MS.after) },
      OR: [
        { messageId: { in: keys } },
        ...keys.map((k) => ({ metadata: { path: ['messageId'], equals: k } })),
        ...keys.map((k) => ({ metadata: { path: ['headerMessageId'], equals: k } })),
      ],
    },
    orderBy: { timestamp: 'asc' },
    take: RELATED_LIMIT + 1,
    select,
  });
  const related = candidates.filter((c) => c.id !== row.id && isRelated(row, c) && traceRowInScope(scope, c.metadata)).slice(0, RELATED_LIMIT);

  const trace = sanitizeTrace(metaOf(row.metadata)['trace']);
  const relatedTraces = related.map((r) => sanitizeTrace(metaOf(r.metadata)['trace']));
  const ruleIds = [trace, ...relatedTraces].flatMap((tr) => (tr?.stages ?? [])
    .filter((s) => s.stage === 'transport-rules' && Array.isArray(s.detail?.['ruleIds']))
    .flatMap((s) => s.detail!['ruleIds'] as string[]));
  const names = new Map<string, string>(ruleIds.length === 0 ? [] : (await prisma.transportRule.findMany({
    where: { id: { in: [...new Set(ruleIds)].slice(0, 50) } }, select: { id: true, name: true },
  })).map((r) => [r.id, r.name] as const));

  const [domains, settings] = await Promise.all([
    prisma.domain.findMany({ select: { name: true } }),
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }),
  ]);
  const direction = traceDirection(row.metadata, domains.map((d) => d.name));

  // Delivery path: the Received chain of the stored original (inbound / internal),
  // or CoreMail → the remote hosts the queue connected to (outbound).
  let path: DeliveryPath = { kind: 'none', reason: 'not-stored' };
  const allStages = [trace, ...relatedTraces].flatMap((tr) => tr?.stages ?? []);
  const remote = outboundHops(allStages, settings?.publicHostname || 'CoreMail');
  if (direction === 'outbound' || (direction === 'internal' && metaStr(metaOf(row.metadata), 'direction') === 'OUTBOUND')) {
    path = remote.length ? { kind: 'outbound', hops: remote } : { kind: 'none', reason: 'no-route' };
  } else {
    try {
      const stored = await storedMessageOf(row.metadata, scope);
      if (stored?.storagePath) {
        const fields = headerFields(headerBlock(await readHead(stored.storagePath)));
        path = { kind: 'received', hops: parseReceivedChain(fields), auth: authSummary(fields) };
      }
    } catch {
      path = { kind: 'none', reason: 'unavailable' };
    }
  }

  // Everything an admin sees goes through the redactor (scoped: other hosted domains' addresses).
  res.json(redact.deep({
    entry: { id: row.id, timestamp: row.timestamp, level: row.level, message: row.message, metadata: plainMetadata(row.metadata) },
    direction,
    trace: trace ? { stages: withRuleNames(trace.stages, names) } : null,
    related: related.map((r, i) => {
      const tr = relatedTraces[i];
      return {
        id: r.id, timestamp: r.timestamp, level: r.level, message: r.message, metadata: plainMetadata(r.metadata),
        trace: tr ? { stages: withRuleNames(tr.stages, names) } : null,
      };
    }),
    path,
  }));
});
