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

// ── GET / ─────────────────────────────────────────────────────────────────────
adminMessageTraceRouter.get('/', async (req: Request, res: Response) => {
  const {
    sender = '', recipient = '', subject = '',
    status = '',   // ACCEPTED | REJECTED | DEFERRED | DELIVERED
    from: fromDate = '', to: toDate = '',
    page = '1', limit = '100',
  } = req.query as Record<string, string>;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // SystemLog entries with category MAIL_FLOW contain metadata:
  // { sender, recipient, subject, status, messageId, size, spamScore }
  const where: Record<string, unknown> = { category: 'MAIL_FLOW' };

  if (fromDate) where['timestamp'] = { gte: new Date(fromDate) };
  if (toDate) {
    const existing = (where['timestamp'] as Record<string, unknown>) ?? {};
    where['timestamp'] = { ...existing, lte: new Date(toDate) };
  }

  // For text searches we filter in memory after fetch (SystemLog metadata is Json)
  // For production scale: add GIN index on metadata
  const [rawItems, total] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip,
      take: parseInt(limit) * 3, // overfetch to allow client-side filter
      select: { id: true, timestamp: true, level: true, message: true, metadata: true, userId: true },
    }),
    prisma.systemLog.count({ where }),
  ]);

  // Post-filter by sender/recipient/subject/status
  const filtered = rawItems
    .filter(row => matchesTraceFilter(row.metadata, { sender, recipient, subject, status }))
    .slice(0, parseInt(limit));

  res.json({ items: filtered, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /export ───────────────────────────────────────────────────────────────
adminMessageTraceRouter.get('/export', async (req: Request, res: Response) => {
  const {
    from: fromDate = '', to: toDate = '', sender = '', recipient = '', subject = '', status = '',
  } = req.query as Record<string, string>;

  const where: Record<string, unknown> = { category: 'MAIL_FLOW' };
  if (fromDate) where['timestamp'] = { gte: new Date(fromDate) };
  if (toDate) {
    const existing = (where['timestamp'] as Record<string, unknown>) ?? {};
    where['timestamp'] = { ...existing, lte: new Date(toDate) };
  }

  const rows = await prisma.systemLog.findMany({
    where, orderBy: { timestamp: 'desc' }, take: 5000,
    select: { timestamp: true, message: true, metadata: true },
  });

  const filtered = rows.filter(r => matchesTraceFilter(r.metadata, { sender, recipient, subject, status }));

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
