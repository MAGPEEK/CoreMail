/**
 * Admin API — Audit Log (Phase 10)
 *
 * ECP → Compliance Management → Audit Log
 *
 * Routes:
 *   GET /api/v1/admin/audit-log               — list (filterable, paginated)
 *   GET /api/v1/admin/audit-log/export.csv    — CSV export (all filters)
 *   GET /api/v1/admin/audit-log/export.pdf    — PDF export (all filters, capped at 1000 rows)
 *   GET /api/v1/admin/audit-log/stats         — Statistics dashboard
 *
 * IMMUTABILITY NOTICE:
 *   Audit logs are immutable by design (compliance: DSGVO, SOX, HIPAA).
 *   No purge/delete endpoint exists. Old entries are managed by the
 *   system-level retention policy in the `RetentionPolicy` table.
 *   Even administrators must NOT be able to delete or modify audit entries.
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import PDFDocument from 'pdfkit';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminAuditLogRouter: RouterType = Router();
adminAuditLogRouter.use(requireAuth, requireAdmin);

// ─── Filter parsing (shared by list + exports) ───────────────────────────────

interface AuditFilters {
  actorId?: string;
  actorEmail?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  ipAddress?: string;
  searchText?: string;
  success?: string;
  from?: string;
  to?: string;
}

function parseFilters(q: Record<string, string | undefined>): AuditFilters {
  const out: AuditFilters = {};
  if (q['actorId']) out.actorId = q['actorId'];
  if (q['actorEmail']) out.actorEmail = q['actorEmail'];
  if (q['action']) out.action = q['action'];
  if (q['targetType']) out.targetType = q['targetType'];
  if (q['targetId']) out.targetId = q['targetId'];
  if (q['ipAddress']) out.ipAddress = q['ipAddress'];
  if (q['searchText']) out.searchText = q['searchText'];
  if (q['success'] !== undefined) out.success = q['success'];
  if (q['from']) out.from = q['from'];
  if (q['to']) out.to = q['to'];
  return out;
}

function buildWhere(filters: AuditFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.actorId) where['actorId'] = filters.actorId;
  if (filters.actorEmail) where['actorEmail'] = { contains: filters.actorEmail, mode: 'insensitive' };
  if (filters.action) where['action'] = { contains: filters.action, mode: 'insensitive' };
  if (filters.targetType) where['targetType'] = filters.targetType;
  if (filters.targetId) where['targetId'] = filters.targetId;
  if (filters.ipAddress) where['ipAddress'] = filters.ipAddress;
  if (filters.success !== undefined && filters.success !== '') {
    where['success'] = filters.success === 'true';
  }

  if (filters.from || filters.to) {
    const ts: Record<string, Date> = {};
    if (filters.from) ts['gte'] = new Date(filters.from);
    if (filters.to) ts['lte'] = new Date(filters.to);
    where['timestamp'] = ts;
  }

  if (filters.searchText) {
    where['OR'] = [
      { action: { contains: filters.searchText, mode: 'insensitive' } },
      { targetName: { contains: filters.searchText, mode: 'insensitive' } },
      { errorMsg: { contains: filters.searchText, mode: 'insensitive' } },
    ];
  }

  return where;
}

// ─── GET /api/v1/admin/audit-log ─────────────────────────────────────────────

adminAuditLogRouter.get('/', async (req: Request, res: Response) => {
  const filters = parseFilters(req.query as Record<string, string | undefined>);
  const { limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;

  const limit = Math.min(parseInt(limitStr ?? '100', 10), 500);
  const offset = parseInt(offsetStr ?? '0', 10);
  const where = buildWhere(filters);

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ total, limit, offset, entries });
});

// ─── GET /api/v1/admin/audit-log/stats ───────────────────────────────────────

adminAuditLogRouter.get('/stats', async (_req: Request, res: Response) => {
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d  = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [
    totalEntries,
    last24h,
    last7d,
    failureCount,
    topActorsRaw,
    topActionsRaw,
    oldest,
    newest,
  ] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { timestamp: { gte: since24h } } }),
    prisma.auditLog.count({ where: { timestamp: { gte: since7d } } }),
    prisma.auditLog.count({ where: { success: false } }),
    prisma.auditLog.groupBy({
      by: ['actorEmail'],
      where: { actorEmail: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.auditLog.groupBy({
      by: ['action'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.auditLog.findFirst({ orderBy: { timestamp: 'asc' }, select: { timestamp: true } }),
    prisma.auditLog.findFirst({ orderBy: { timestamp: 'desc' }, select: { timestamp: true } }),
  ]);

  const failureRate = totalEntries > 0 ? failureCount / totalEntries : 0;

  res.json({
    totalEntries,
    last24h,
    last7d,
    topActors:  topActorsRaw.map((r) => ({ actorEmail: r.actorEmail ?? '', count: r._count.id })),
    topActions: topActionsRaw.map((r) => ({ action: r.action, count: r._count.id })),
    failureRate,
    oldestEntry: oldest?.timestamp.toISOString() ?? null,
    newestEntry: newest?.timestamp.toISOString() ?? null,
  });
});

// ─── GET /api/v1/admin/audit-log/export.csv ─────────────────────────────────

adminAuditLogRouter.get('/export.csv', async (req: Request, res: Response) => {
  const filters = parseFilters(req.query as Record<string, string | undefined>);
  const where = buildWhere(filters);

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 10_000, // hard cap to prevent OOM
  });

  const csvHeader = [
    'timestamp',
    'actorId',
    'actorEmail',
    'action',
    'targetType',
    'targetId',
    'targetName',
    'ipAddress',
    'userAgent',
    'success',
    'errorMsg',
    'changes',
  ].join(',');

  const csvRows = entries.map((e) =>
    [
      e.timestamp.toISOString(),
      csvEscape(e.actorId ?? ''),
      csvEscape(e.actorEmail ?? ''),
      csvEscape(e.action),
      csvEscape(e.targetType ?? ''),
      csvEscape(e.targetId ?? ''),
      csvEscape(e.targetName ?? ''),
      csvEscape(e.ipAddress ?? ''),
      csvEscape(e.userAgent ?? ''),
      e.success ? 'true' : 'false',
      csvEscape(e.errorMsg ?? ''),
      csvEscape(e.changes ? JSON.stringify(e.changes) : ''),
    ].join(','),
  );

  const csv = [csvHeader, ...csvRows].join('\n');
  const dateStr = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.csv"`);
  // UTF-8 BOM so Excel detects encoding correctly
  res.send('﻿' + csv);
});

// ─── GET /api/v1/admin/audit-log/export.pdf ─────────────────────────────────

adminAuditLogRouter.get('/export.pdf', async (req: Request, res: Response) => {
  const filters = parseFilters(req.query as Record<string, string | undefined>);
  const where = buildWhere(filters);

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: 1000, // PDF cap (use CSV for larger exports)
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.pdf"`);

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 40, bottom: 50, left: 40, right: 40 },
    bufferPages: true,
  });
  doc.pipe(res);

  // ─── Header
  doc.fontSize(16).font('Helvetica-Bold').text('CoreMail Audit-Log Export');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#666');
  doc.text(`Erstellt am: ${new Date().toLocaleString('de-DE')}`);
  doc.text(`Einträge: ${entries.length}${entries.length === 1000 ? ' (gekappt auf 1000 — größere Exporte bitte als CSV)' : ''}`);

  // Filter summary
  const filterParts: string[] = [];
  if (filters.from) filterParts.push(`Von: ${filters.from}`);
  if (filters.to) filterParts.push(`Bis: ${filters.to}`);
  if (filters.action) filterParts.push(`Aktion: ${filters.action}`);
  if (filters.actorEmail) filterParts.push(`Akteur: ${filters.actorEmail}`);
  if (filters.targetType) filterParts.push(`Zieltyp: ${filters.targetType}`);
  if (filters.ipAddress) filterParts.push(`IP: ${filters.ipAddress}`);
  if (filters.searchText) filterParts.push(`Suche: ${filters.searchText}`);
  if (filters.success !== undefined && filters.success !== '') {
    filterParts.push(`Status: ${filters.success === 'true' ? 'Erfolgreich' : 'Fehlgeschlagen'}`);
  }
  if (filterParts.length > 0) {
    doc.text(`Filter: ${filterParts.join(' · ')}`);
  }
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // ─── Table header
  const cols = [
    { label: 'Zeitpunkt', width: 105 },
    { label: 'Akteur',    width: 140 },
    { label: 'Aktion',    width: 130 },
    { label: 'Ziel',      width: 220 },
    { label: 'Status',    width: 60  },
  ];
  const startX = doc.page.margins.left;
  const tableWidth = cols.reduce((sum, c) => sum + c.width, 0);
  const rowHeight = 16;

  function drawTableHeader() {
    const y = doc.y;
    doc.rect(startX, y, tableWidth, rowHeight).fillAndStroke('#f0f0f0', '#cccccc');
    let x = startX;
    doc.fillColor('#333').fontSize(8).font('Helvetica-Bold');
    for (const col of cols) {
      doc.text(col.label, x + 4, y + 4, { width: col.width - 8, lineBreak: false });
      x += col.width;
    }
    doc.fillColor('#000').font('Helvetica');
    doc.y = y + rowHeight;
  }

  drawTableHeader();

  // ─── Table rows
  doc.fontSize(7.5);
  for (const e of entries) {
    // page break check
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      drawTableHeader();
      doc.fontSize(7.5);
    }
    const y = doc.y;
    let x = startX;
    const target =
      (e.targetType ? e.targetType : '') +
      (e.targetName ? (e.targetType ? ': ' : '') + e.targetName : '');
    const cells = [
      e.timestamp.toLocaleString('de-DE'),
      e.actorEmail ?? '—',
      e.action,
      target || '—',
      e.success ? 'OK' : 'FAIL',
    ];

    if (!e.success) {
      doc.fillColor('#c00');
    } else {
      doc.fillColor('#000');
    }

    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]!;
      const text = cells[i]!;
      doc.text(text, x + 4, y + 4, {
        width: col.width - 8,
        height: rowHeight - 4,
        ellipsis: true,
        lineBreak: false,
      });
      x += col.width;
    }
    doc.fillColor('#000');
    // bottom border
    doc.strokeColor('#eeeeee').lineWidth(0.5)
      .moveTo(startX, y + rowHeight).lineTo(startX + tableWidth, y + rowHeight).stroke();
    doc.y = y + rowHeight;
  }

  // ─── Footer with page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - 30;
    doc.fontSize(8).fillColor('#888').font('Helvetica');
    doc.text(
      `CoreMail Audit-Log — Seite ${i + 1} / ${range.count}`,
      doc.page.margins.left,
      bottom,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false },
    );
  }

  doc.end();
});

// ─── DELETE /api/v1/admin/audit-log/purge ────────────────────────────────────
//
// Intentionally NOT implemented.
//
// Audit logs are immutable by design — compliance frameworks (DSGVO/GDPR,
// SOX, HIPAA, ISO 27001) require that audit trails cannot be deleted or
// modified, not even by administrators. Any retention of old entries must
// be governed by the system-level RetentionPolicy table and executed by
// a privileged background process, not a user-facing API.

// ─── Helpers ────────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
