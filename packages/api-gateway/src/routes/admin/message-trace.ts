/**
 * Admin-API: Nachrichtenablaufverfolgung (Message Trace)
 *
 * GET /api/v1/admin/message-trace   — Nachrichten suchen (aus SystemLog MAIL_FLOW)
 * GET /api/v1/admin/message-trace/export — CSV-Export
 *
 * Liest aus der SystemLog-Tabelle (category='MAIL_FLOW').
 * SMTP-Server schreibt dort bei jeder Mail einen Logeintrag.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminMessageTraceRouter: RouterType = Router();
adminMessageTraceRouter.use(requireAdmin);

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
  const filtered = rawItems.filter(row => {
    const m = (row.metadata ?? {}) as Record<string, string>;
    if (sender    && !m['sender']?.toLowerCase().includes(sender.toLowerCase()))       return false;
    if (recipient && !m['recipient']?.toLowerCase().includes(recipient.toLowerCase())) return false;
    if (subject   && !m['subject']?.toLowerCase().includes(subject.toLowerCase()))     return false;
    if (status    && m['status'] !== status)                                          return false;
    return true;
  }).slice(0, parseInt(limit));

  res.json({ items: filtered, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /export ───────────────────────────────────────────────────────────────
adminMessageTraceRouter.get('/export', async (req: Request, res: Response) => {
  const { from: fromDate = '', to: toDate = '', sender = '', recipient = '' } = req.query as Record<string, string>;

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

  const filtered = rows.filter(r => {
    const m = (r.metadata ?? {}) as Record<string, string>;
    if (sender    && !m['sender']?.toLowerCase().includes(sender.toLowerCase()))       return false;
    if (recipient && !m['recipient']?.toLowerCase().includes(recipient.toLowerCase())) return false;
    return true;
  });

  const header = 'Zeitstempel,Absender,Empfänger,Betreff,Status,MessageId\r\n';
  const lines = filtered.map(r => {
    const m = (r.metadata ?? {}) as Record<string, string>;
    const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
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
