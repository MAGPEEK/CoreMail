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
 *   POST /api/v1/admin/audit-log/verify-export — check an export's signature (v8.1)
 *
 * IMMUTABILITY NOTICE:
 *   Audit logs are immutable by design (compliance: DSGVO, SOX, HIPAA).
 *   No purge/delete endpoint exists. Old entries are managed by the
 *   system-level retention policy in the `RetentionPolicy` table.
 *   Even administrators must NOT be able to delete or modify audit entries.
 */

import express, { Router, type Router as RouterType, type Request, type Response } from 'express';
import PDFDocument from 'pdfkit';
import { prisma } from '@coremail/storage/prisma';
import { requireArea } from '../../middleware/auth.js';
import { csvCell, exportSignature, verifyExportSignature } from '../../lib/export-safety.js';
import { redactorOf, requireUnscoped, scopeOf } from '../../middleware/admin-scope.js';
import { andWhere, isScoped, type AddressRedactor } from '../../lib/admin-scope.js';

// 9.5 management scopes: a scoped admin's list and exports contain only entries
// about objects of its domains and its own actions (auditScopeWhere), with the
// addresses of other domains redacted (redactAuditEntry, w3); the
// organisation-wide statistics and anomaly views are for unscoped admins only.
export const adminAuditLogRouter: RouterType = Router();
adminAuditLogRouter.use(requireArea('compliance'));

// ─── POST /api/v1/admin/audit-log/verify-export ─────────────────────────────
// v8.1: checks the signature of an audit export (CSV / JSON / PDF). Body = the
// exported file byte-exact (Content-Type application/octet-stream), signature =
// the `X-CoreMail-Signature` value of the export response (header
// X-CoreMail-Signature or ?signature=). Answer: { valid: boolean }.
// Exports signed with an earlier key (rotated AUDIT_EXPORT_SIGNING_KEY,
// JWT_SECRET or PEPPER) verify as invalid.
const VERIFY_MAX_BYTES = 100 * 1024 * 1024;
adminAuditLogRouter.post(
  '/verify-export',
  express.raw({ type: () => true, limit: VERIFY_MAX_BYTES }),
  (req: Request, res: Response) => {
    const q = req.query['signature'];
    const signature = (req.get('x-coremail-signature') ?? (typeof q === 'string' ? q : '')).trim();
    if (!signature || signature.length > 200) {
      res.status(400).json({ error: 'Signature missing (X-CoreMail-Signature header or ?signature=)', code: 'SIGNATURE_MISSING' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      // a JSON/form body was already parsed — the bytes are no longer exact
      res.status(415).json({ error: 'Send the export file unchanged as application/octet-stream', code: 'RAW_BODY_REQUIRED' });
      return;
    }
    const body = req.body as Buffer;
    if (body.length === 0) { res.status(400).json({ error: 'Empty file', code: 'FILE_MISSING' }); return; }
    let valid = false;
    try {
      valid = verifyExportSignature(body, signature);
    } catch {
      res.status(500).json({ error: 'Signature key unavailable' });
      return;
    }
    res.json({ valid, bytes: body.length, algorithm: 'hmac-sha256' });
  },
);

// ─── Filter parsing (shared by list + exports) ───────────────────────────────

export interface AuditFilters {
  actorId?: string;
  actorEmail?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  ipAddress?: string;
  searchText?: string;
  /** 9.4: 'mailbox-access' = the mailbox access audit (mailbox.foreign.*). */
  category?: string;
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
  if (q['category']) out.category = q['category'];
  if (q['success'] !== undefined) out.success = q['success'];
  if (q['from']) out.from = q['from'];
  if (q['to']) out.to = q['to'];
  return out;
}

/** Audit categories (9.4) — BCP filter "Postfachzugriffe" = mailbox access audit. */
export const AUDIT_CATEGORIES: Readonly<Record<string, { action: { startsWith: string } }>> = {
  'mailbox-access': { action: { startsWith: 'mailbox.foreign.' } },
};

/** Pure: the filter of a category; null for none / an unknown one. */
export function auditCategoryWhere(category: string | undefined): { action: { startsWith: string } } | null {
  return category ? (AUDIT_CATEGORIES[category] ?? null) : null;
}

function buildWhere(filters: AuditFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.actorId) where['actorId'] = filters.actorId;
  if (filters.actorEmail) where['actorEmail'] = { contains: filters.actorEmail, mode: 'insensitive' };
  if (filters.action) where['action'] = { contains: filters.action, mode: 'insensitive' };
  // free-text field in the BCP ("mail" finds "mailboxes")
  if (filters.targetType) where['targetType'] = { contains: filters.targetType, mode: 'insensitive' };
  if (filters.targetId) where['targetId'] = filters.targetId;
  if (filters.ipAddress) where['ipAddress'] = filters.ipAddress;
  const category = auditCategoryWhere(filters.category);
  if (category) where['AND'] = [category];
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
      { actorEmail: { contains: filters.searchText, mode: 'insensitive' } },
      { errorMsg: { contains: filters.searchText, mode: 'insensitive' } },
    ];
  }

  return where;
}

/** Ids and names of the objects inside a management scope (9.5) — what scoped audit entries may be about. */
export interface AuditScopeTargets {
  /** ids of users, their Mailbox rows, shared mailboxes (+ Mailbox rows), resources, aliases, domains */
  ids: readonly string[];
  /** domain names: entries whose targetName is an address of these domains */
  domainNames: readonly string[];
  /** the scoped admin itself: its own actions stay visible */
  actorId: string;
}

/**
 * Pure (9.5): Prisma `where` of the audit entries a scoped admin may read —
 * entries about an object of its domains (by target id, or by an address of
 * its domains anywhere in the target name — one address or a ", " list, bare or
 * in angle brackets) and its own actions. Combined with the request filters
 * through AND (the filters' own OR stays intact). The addresses of other
 * domains in an entry are redacted before it is returned (redactAuditEntry).
 */
export function auditScopeWhere(t: AuditScopeTargets): Record<string, unknown> {
  const nameOf = (op: 'endsWith' | 'contains', value: string) => ({ targetName: { [op]: value, mode: 'insensitive' } });
  return {
    OR: [
      { targetId: { in: [...t.ids] } },
      ...t.domainNames.flatMap((d) => [
        nameOf('endsWith', `@${d}`), nameOf('contains', `@${d},`), nameOf('contains', `@${d}>`),
      ]),
      { actorId: t.actorId },
    ],
  };
}

/** The columns of an audit entry that can name addresses. */
interface AuditAddressColumns {
  actorEmail: string | null;
  targetName: string | null;
  errorMsg: string | null;
  changes: unknown;
}

/**
 * Pure (w3 scope leaks): an entry as a scoped admin sees it — every address of
 * another hosted domain in the actor, target name, error and `changes` is
 * replaced by "(andere Domain)" (lib/admin-scope.ts addressRedactor).
 */
export function redactAuditEntry<T extends AuditAddressColumns>(r: AddressRedactor, e: T): T {
  if (!r.active) return e;
  return {
    ...e,
    actorEmail: r.optionalText(e.actorEmail),
    targetName: r.optionalText(e.targetName),
    errorMsg: r.optionalText(e.errorMsg),
    changes: r.deep(e.changes),
  };
}

/** The request filters that match text which may name addresses (actor, free-text search). */
const hasTextFilter = (f: AuditFilters): boolean => !!f.actorEmail || !!f.searchText;

/**
 * Pure: the text filters of buildWhere (actor e-mail, free-text search over
 * action / target name / actor / error; case-insensitive substrings) on an
 * entry. A scoped admin's text filters run on the redacted entries, so a search
 * for a hidden address finds nothing (no oracle).
 */
export function matchesAuditText(e: Pick<AuditAddressColumns, 'actorEmail' | 'targetName' | 'errorMsg'> & { action: string }, f: AuditFilters): boolean {
  const has = (value: string | null, needle: string): boolean => !!value && value.toLowerCase().includes(needle.toLowerCase());
  if (f.actorEmail && !has(e.actorEmail, f.actorEmail)) return false;
  if (f.searchText && ![e.action, e.targetName, e.actorEmail, e.errorMsg].some((v) => has(v, f.searchText!))) return false;
  return true;
}

/** Max. entries a scoped admin's text search scans (the filter runs in memory, newest first). */
export const AUDIT_SCOPED_SCAN_LIMIT = 5000;

/** I/O: the scope targets of a scoped admin (organisation-wide → null). */
async function auditScopeTargets(req: Request): Promise<AuditScopeTargets | null> {
  const scope = scopeOf(req);
  if (!isScoped(scope)) return null;
  const domainIds = scope.domains.map((d) => d.id);
  const inDomains = { domainId: { in: domainIds } };
  const [users, shared, resources, aliases] = await Promise.all([
    prisma.user.findMany({ where: inDomains, select: { id: true, mailbox: { select: { id: true } } } }),
    prisma.sharedMailbox.findMany({ where: inDomains, select: { id: true, mailbox: { select: { id: true } } } }),
    prisma.resourceMailbox.findMany({ where: inDomains, select: { id: true } }),
    prisma.emailAlias.findMany({ where: inDomains, select: { id: true } }),
  ]);
  const ids = [
    ...domainIds,
    ...users.flatMap((u) => [u.id, ...(u.mailbox ? [u.mailbox.id] : [])]),
    ...shared.flatMap((s) => [s.id, ...(s.mailbox ? [s.mailbox.id] : [])]),
    ...resources.map((r) => r.id),
    ...aliases.map((a) => a.id),
  ];
  return { ids, domainNames: scope.domains.map((d) => d.name), actorId: req.apiUser!.userId };
}

type AuditRow = Awaited<ReturnType<typeof prisma.auditLog.findMany>>[number];

/**
 * I/O: one window of the entries the admin may read, newest first, and their
 * total. Organisation-wide admins: the request filters as they are. Scoped
 * admins (9.5 + w3): limited to the scope (auditScopeWhere), addresses of other
 * domains redacted; text filters then run on the redacted entries over the
 * newest AUDIT_SCOPED_SCAN_LIMIT entries of the scope (`truncated`).
 */
async function readEntries(
  req: Request, filters: AuditFilters, window: { skip: number; take: number },
): Promise<{ entries: AuditRow[]; total: number; truncated: boolean }> {
  const targets = await auditScopeTargets(req);
  if (!targets) {
    const where = buildWhere(filters);
    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip: window.skip, take: window.take }),
      prisma.auditLog.count({ where }),
    ]);
    return { entries, total, truncated: false };
  }
  const redactor = await redactorOf(req);
  if (!hasTextFilter(filters)) {
    const where = andWhere(buildWhere(filters), auditScopeWhere(targets));
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip: window.skip, take: window.take }),
      prisma.auditLog.count({ where }),
    ]);
    return { entries: rows.map((e) => redactAuditEntry(redactor, e)), total, truncated: false };
  }
  const { actorEmail: _actor, searchText: _search, ...dbFilters } = filters;
  const rows = await prisma.auditLog.findMany({
    where: andWhere(buildWhere(dbFilters), auditScopeWhere(targets)),
    orderBy: { timestamp: 'desc' },
    take: AUDIT_SCOPED_SCAN_LIMIT,
  });
  const matched = rows.map((e) => redactAuditEntry(redactor, e)).filter((e) => matchesAuditText(e, filters));
  return {
    entries: matched.slice(window.skip, window.skip + window.take),
    total: matched.length,
    truncated: rows.length >= AUDIT_SCOPED_SCAN_LIMIT,
  };
}

/** Only string query values count (a repeated parameter arrives as an array). */
function stringQuery(q: Request['query']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Error message for unusable filters (an invalid date would make Prisma throw → 500). */
export function auditFilterError(filters: AuditFilters): string | null {
  for (const key of ['from', 'to'] as const) {
    const v = filters[key];
    if (v !== undefined && Number.isNaN(new Date(v).getTime())) return `Invalid date in "${key}"`;
  }
  if (filters.success !== undefined && !['', 'true', 'false'].includes(filters.success)) return 'success must be true or false';
  return null;
}

/** Page window of the list: limit 1–500 (default 100), offset ≥ 0; garbage → defaults. */
export function auditPage(limitStr: string | undefined, offsetStr: string | undefined): { limit: number; offset: number } {
  const l = Number.parseInt(limitStr ?? '', 10);
  const o = Number.parseInt(offsetStr ?? '', 10);
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(l, 1), 500) : 100,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

/** Filters of an audit request, or null after answering 400. */
function requestFilters(req: Request, res: Response): AuditFilters | null {
  const filters = parseFilters(stringQuery(req.query));
  const err = auditFilterError(filters);
  if (err) { res.status(400).json({ error: err, code: 'INVALID_FILTER' }); return null; }
  return filters;
}

// ─── GET /api/v1/admin/audit-log ─────────────────────────────────────────────

adminAuditLogRouter.get('/', async (req: Request, res: Response) => {
  const filters = requestFilters(req, res);
  if (!filters) return;
  const q = stringQuery(req.query);
  const { limit, offset } = auditPage(q['limit'], q['offset']);
  const { entries, total, truncated } = await readEntries(req, filters, { skip: offset, take: limit });
  res.json({ total, limit, offset, entries, ...(truncated ? { truncated } : {}) });
});

// ─── GET /api/v1/admin/audit-log/stats ───────────────────────────────────────

adminAuditLogRouter.get('/stats', requireUnscoped, async (_req: Request, res: Response) => {
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
  const filters = requestFilters(req, res);
  if (!filters) return;
  const { entries } = await readEntries(req, filters, { skip: 0, take: 10_000 }); // hard cap to prevent OOM

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
  // Integrity signature: HMAC-SHA256 over the exact payload (incl. UTF-8 BOM),
  // keyed with a server secret (lib/export-safety.ts) — an unkeyed hash could be
  // recomputed by whoever modified the file. Verification needs the server key
  // (verifyExportSignature); the header is `hmac-sha256=<hex>`.
  const payload = '﻿' + csv;
  const signature = exportSignature(payload);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.csv"`);
  res.setHeader('X-CoreMail-Signature', signature);
  res.setHeader('X-CoreMail-Export-Entries', String(entries.length));
  res.setHeader('X-CoreMail-Export-Generated-At', new Date().toISOString());
  res.setHeader('Access-Control-Expose-Headers', 'X-CoreMail-Signature, X-CoreMail-Export-Entries, X-CoreMail-Export-Generated-At');
  res.send(payload);
});

// ─── GET /api/v1/admin/audit-log/export.json ────────────────────────────────
// For SIEM integration (Splunk, Azure Sentinel, ELK). Structured + signed.

adminAuditLogRouter.get('/export.json', async (req: Request, res: Response) => {
  const filters = requestFilters(req, res);
  if (!filters) return;
  const { entries } = await readEntries(req, filters, { skip: 0, take: 10_000 });

  const payloadObj = {
    metadata: {
      generator:     'CoreMail Audit-Log',
      exportedAt:    new Date().toISOString(),
      entries:       entries.length,
      filters,
      schemaVersion: '1.0',
    },
    entries: entries.map((e) => ({
      id:         e.id,
      timestamp:  e.timestamp.toISOString(),
      actorId:    e.actorId,
      actorEmail: e.actorEmail,
      action:     e.action,
      targetType: e.targetType,
      targetId:   e.targetId,
      targetName: e.targetName,
      ipAddress:  e.ipAddress,
      userAgent:  e.userAgent,
      success:    e.success,
      errorMsg:   e.errorMsg,
      changes:    e.changes,
    })),
  };
  const payload = JSON.stringify(payloadObj, null, 2);
  const signature = exportSignature(payload);
  const dateStr = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.json"`);
  res.setHeader('X-CoreMail-Signature', signature);
  res.setHeader('X-CoreMail-Export-Entries', String(entries.length));
  res.setHeader('X-CoreMail-Export-Generated-At', new Date().toISOString());
  res.setHeader('Access-Control-Expose-Headers', 'X-CoreMail-Signature, X-CoreMail-Export-Entries, X-CoreMail-Export-Generated-At');
  res.send(payload);
});

// ─── GET /api/v1/admin/audit-log/export.pdf ─────────────────────────────────

adminAuditLogRouter.get('/export.pdf', async (req: Request, res: Response) => {
  const filters = requestFilters(req, res);
  if (!filters) return;
  const { entries } = await readEntries(req, filters, { skip: 0, take: 1000 }); // PDF cap (use CSV for larger exports)

  const dateStr = new Date().toISOString().slice(0, 10);

  // Write the PDF into a buffer, then sign and send — enables the
  // X-CoreMail-Signature header (not possible with direct doc.pipe(res)).
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 40, bottom: 50, left: 40, right: 40 },
    bufferPages: true,
  });
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const pdfDone: Promise<Buffer> = new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

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
  const pdfBuffer = await pdfDone;
  const signature = exportSignature(pdfBuffer);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${dateStr}.pdf"`);
  res.setHeader('X-CoreMail-Signature', signature);
  res.setHeader('X-CoreMail-Export-Entries', String(entries.length));
  res.setHeader('X-CoreMail-Export-Generated-At', new Date().toISOString());
  res.setHeader('Access-Control-Expose-Headers', 'X-CoreMail-Signature, X-CoreMail-Export-Entries, X-CoreMail-Export-Generated-At');
  res.send(pdfBuffer);
});

// ─── GET /api/v1/admin/audit-log/anomalies ───────────────────────────────────
// Suspicious patterns: bursts, failure bursts, critical actions, off-hours.
// Evaluates the last 24h (read-only — no persistence, every request recomputes).

// Action strings come from the audit middleware (<path segments>.<verb>, e.g. mailboxes.delete,
// certificates.post, settings.security.put) and from explicit audit() calls (audit.disabled, …).
const CRITICAL_ACTIONS_PATTERN = /^(mailbox(es)?\.delete|domains?\.delete|shared-mailboxes\.delete|transport-rules\.|settings\.|servers\.settings\.|certificates?\.|connectors?\.|smtp-config\.|sso\.|ldap\.|storage\.|audit\.|backups?\.)/i;

interface Anomaly {
  type:     'BURST_ACTIONS' | 'BURST_FAILURES' | 'CRITICAL_ACTION' | 'OFF_HOURS_LOGIN';
  severity: 'high' | 'medium' | 'low';
  actor:    string | null;
  count:    number;
  firstAt:  string;
  lastAt:   string;
  message:  string;
}

adminAuditLogRouter.get('/anomalies', requireUnscoped, async (_req: Request, res: Response) => {
  const now = Date.now();
  const since5min = new Date(now - 5 * 60 * 1000);
  const since24h  = new Date(now - 24 * 60 * 60 * 1000);

  const recent5min = await prisma.auditLog.findMany({
    where: { timestamp: { gte: since5min } },
    select: { actorEmail: true, action: true, success: true, timestamp: true, ipAddress: true },
    take: 5000,
  });

  const last24h = await prisma.auditLog.findMany({
    where: { timestamp: { gte: since24h } },
    select: { actorEmail: true, action: true, success: true, timestamp: true, ipAddress: true },
    take: 20_000,
  });

  const anomalies: Anomaly[] = [];

  // 1) Burst (actions): >50 actions by the same actor in the last 5 min
  const byActor = new Map<string, { count: number; first: Date; last: Date }>();
  for (const e of recent5min) {
    const k = e.actorEmail ?? '(anonym)';
    const cur = byActor.get(k);
    if (!cur) byActor.set(k, { count: 1, first: e.timestamp, last: e.timestamp });
    else {
      cur.count++;
      if (e.timestamp < cur.first) cur.first = e.timestamp;
      if (e.timestamp > cur.last)  cur.last = e.timestamp;
    }
  }
  for (const [actor, info] of byActor.entries()) {
    if (info.count >= 50) {
      anomalies.push({
        type: 'BURST_ACTIONS',
        severity: info.count >= 200 ? 'high' : 'medium',
        actor,
        count: info.count,
        firstAt: info.first.toISOString(),
        lastAt:  info.last.toISOString(),
        message: `Burst: ${info.count} Admin-Aktionen in 5 Minuten`,
      });
    }
  }

  // 2) Burst (failures): >10 failed actions by the same actor in 5 min
  const byActorFail = new Map<string, { count: number; first: Date; last: Date }>();
  for (const e of recent5min) {
    if (e.success) continue;
    const k = e.actorEmail ?? '(anonym)';
    const cur = byActorFail.get(k);
    if (!cur) byActorFail.set(k, { count: 1, first: e.timestamp, last: e.timestamp });
    else {
      cur.count++;
      if (e.timestamp < cur.first) cur.first = e.timestamp;
      if (e.timestamp > cur.last)  cur.last = e.timestamp;
    }
  }
  for (const [actor, info] of byActorFail.entries()) {
    if (info.count >= 10) {
      anomalies.push({
        type: 'BURST_FAILURES',
        severity: 'high',
        actor,
        count: info.count,
        firstAt: info.first.toISOString(),
        lastAt:  info.last.toISOString(),
        message: `${info.count} fehlgeschlagene Aktionen in 5 Minuten — möglicher Angriff oder Skript-Fehler`,
      });
    }
  }

  // 3) Critical actions — ALWAYS escalate
  for (const e of last24h) {
    if (CRITICAL_ACTIONS_PATTERN.test(e.action)) {
      anomalies.push({
        type: 'CRITICAL_ACTION',
        severity: 'high',
        actor: e.actorEmail,
        count: 1,
        firstAt: e.timestamp.toISOString(),
        lastAt:  e.timestamp.toISOString(),
        message: `Kritische Aktion: ${e.action}`,
      });
    }
  }

  // 4) Off-hours: actions between 00:00 and 06:00 server time
  for (const e of last24h) {
    const h = e.timestamp.getHours();
    if (h >= 0 && h < 6 && e.actorEmail) {
      anomalies.push({
        type: 'OFF_HOURS_LOGIN',
        severity: 'low',
        actor: e.actorEmail,
        count: 1,
        firstAt: e.timestamp.toISOString(),
        lastAt:  e.timestamp.toISOString(),
        message: `Admin-Aktivität außerhalb der Geschäftszeiten (${h}:00 Uhr)`,
      });
    }
  }

  // Merge duplicate CRITICAL_ACTION entries (same actor + action)
  const dedupKey = (a: Anomaly) => `${a.type}|${a.actor ?? ''}|${a.message}`;
  const dedupMap = new Map<string, Anomaly>();
  for (const a of anomalies) {
    const k = dedupKey(a);
    const cur = dedupMap.get(k);
    if (!cur) dedupMap.set(k, { ...a });
    else {
      cur.count += a.count;
      if (a.firstAt < cur.firstAt) cur.firstAt = a.firstAt;
      if (a.lastAt  > cur.lastAt)  cur.lastAt = a.lastAt;
    }
  }
  const deduped = [...dedupMap.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  res.json({
    generatedAt: new Date().toISOString(),
    window: { burstSince: since5min.toISOString(), criticalSince: since24h.toISOString() },
    anomalies: deduped,
  });
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

// Formula-safe CSV cell (= + - @ TAB CR prefixed with ') — see lib/export-safety.ts.
function csvEscape(value: string): string {
  return csvCell(value);
}
