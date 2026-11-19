/**
 * Admin API: message trace
 *
 * GET /api/v1/admin/message-trace   — search messages (from SystemLog MAIL_FLOW)
 * GET /api/v1/admin/message-trace/export — CSV export
 *
 * Reads from the SystemLog table (category='MAIL_FLOW').
 * The SMTP server writes a log entry there for every mail.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { csvCellQuoted } from '../../lib/export-safety.js';
import { redactorOf, scopeOf } from '../../middleware/admin-scope.js';
import { anyAddressInScope, isScoped, type AddressRedactor, type AdminScope } from '../../lib/admin-scope.js';

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
