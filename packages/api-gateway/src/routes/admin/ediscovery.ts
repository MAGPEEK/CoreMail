/**
 * Admin routes — eDiscovery & Legal Hold — Phase 8
 *
 * Suchen
 *   GET    /api/v1/admin/ediscovery/searches
 *   POST   /api/v1/admin/ediscovery/searches
 *   GET    /api/v1/admin/ediscovery/searches/:id
 *   DELETE /api/v1/admin/ediscovery/searches/:id
 *   POST   /api/v1/admin/ediscovery/searches/:id/run
 *   GET    /api/v1/admin/ediscovery/searches/:id/results?limit&offset&dedupe
 *   GET    /api/v1/admin/ediscovery/searches/:id/preview?limit&dedupe
 *   GET    /api/v1/admin/ediscovery/searches/:id/export?dedupe   (MBOX-Stream)
 *
 * Legal Hold
 *   GET    /api/v1/admin/ediscovery/holds
 *   POST   /api/v1/admin/ediscovery/holds
 *   GET    /api/v1/admin/ediscovery/holds/:id
 *   DELETE /api/v1/admin/ediscovery/holds/:id
 *   GET    /api/v1/admin/ediscovery/holds/check/:userId
 *
 * Hilfsroute (für UI-Picker)
 *   GET    /api/v1/admin/ediscovery/mailboxes
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('api:ediscovery');
export const adminEDiscoveryRouter: RouterType = Router();
adminEDiscoveryRouter.use(requireAdmin);

// ──────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ──────────────────────────────────────────────────────────────────

interface EDiscoveryQuery {
  keywords?: string;
  senderAddresses?: string[];
  recipientAddresses?: string[];
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
  subjectContains?: string;
}

/**
 * Baut die Prisma-Where-Klausel für eine eDiscovery-Suche.
 * Wird sowohl beim Run als auch beim Preview/Export benutzt — single source of truth.
 */
async function buildMessageWhere(
  query: EDiscoveryQuery,
  mailboxIds: string[],
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { deletedAt: null };

  // Mailbox-Scope (falls leer → alle Postfächer)
  if (mailboxIds.length > 0) {
    const folders = await prisma.folder.findMany({
      where: { mailbox: { userId: { in: mailboxIds } } },
      select: { id: true },
    });
    where['folderId'] = { in: folders.map((f) => f.id) };
  }

  // Absender
  if (query.senderAddresses?.length) {
    where['fromAddr'] = { in: query.senderAddresses.map((a) => a.toLowerCase()) };
  }

  // Empfänger — über To/Cc/Bcc, weil RFC 822 Empfänger in mehreren Headern auftauchen kann
  if (query.recipientAddresses?.length) {
    const addrs = query.recipientAddresses.map((a) => a.toLowerCase());
    where['OR'] = [
      { toAddrs:  { hasSome: addrs } },
      { ccAddrs:  { hasSome: addrs } },
      { bccAddrs: { hasSome: addrs } },
    ];
  }

  // Zeitraum
  if (query.dateFrom || query.dateTo) {
    const range: Record<string, Date> = {};
    if (query.dateFrom) range['gte'] = new Date(query.dateFrom);
    if (query.dateTo)   range['lte'] = new Date(query.dateTo);
    where['date'] = range;
  }

  // Betreff
  if (query.subjectContains) {
    where['subject'] = { contains: query.subjectContains, mode: 'insensitive' };
  }

  // Stichwort über Subject + BodyText.
  // Wenn schon ein recipient-OR gesetzt ist, kombinieren wir per AND.
  if (query.keywords) {
    const keywordOr = [
      { subject:  { contains: query.keywords, mode: 'insensitive' } },
      { bodyText: { contains: query.keywords, mode: 'insensitive' } },
    ];
    if (where['OR']) {
      where['AND'] = [{ OR: where['OR'] }, { OR: keywordOr }];
      delete where['OR'];
    } else {
      where['OR'] = keywordOr;
    }
  }

  // Hat Anhang
  if (query.hasAttachment === true) {
    where['attachments'] = { some: {} };
  } else if (query.hasAttachment === false) {
    where['attachments'] = { none: {} };
  }

  return where;
}

/**
 * De-Duplizierung anhand des RFC-822-Message-IDs.
 * Wenn eine Mail an mehrere interne User ging, taucht sie pro Postfach einmal in der DB auf.
 * messageId ist identisch → wir behalten nur die älteste Kopie.
 */
function dedupeByMessageId<T extends { id: string; messageId: string | null; date: Date | string }>(
  messages: T[],
): T[] {
  const seen = new Map<string, T>();
  const noId: T[] = [];
  for (const m of messages) {
    if (!m.messageId) { noId.push(m); continue; }
    const existing = seen.get(m.messageId);
    if (!existing || new Date(m.date).getTime() < new Date(existing.date).getTime()) {
      seen.set(m.messageId, m);
    }
  }
  return [...seen.values(), ...noId];
}

/**
 * RFC-4155-konforme „From "-Zeile für MBOX-Format.
 * Body-Zeilen, die mit "From " beginnen, werden mit ">" maskiert.
 */
function buildMboxEntry(args: {
  fromAddr: string;
  date: Date;
  subject: string;
  toAddrs: string[];
  messageId: string | null;
  bodyText: string;
  bodyHtml: string;
}): string {
  const fromLine = `From ${args.fromAddr || 'MAILER-DAEMON'} ${args.date.toUTCString()}\n`;
  const headers =
    `From: ${args.fromAddr}\n` +
    `To: ${args.toAddrs.join(', ')}\n` +
    `Subject: ${args.subject}\n` +
    `Date: ${args.date.toUTCString()}\n` +
    (args.messageId ? `Message-ID: ${args.messageId}\n` : '') +
    `MIME-Version: 1.0\n`;

  let body: string;
  let contentType: string;
  if (args.bodyHtml && !args.bodyText) {
    contentType = 'text/html; charset=utf-8';
    body = args.bodyHtml;
  } else {
    contentType = 'text/plain; charset=utf-8';
    body = args.bodyText || '';
  }

  // Body-Zeilen, die mit "From " beginnen → escapen (mboxo-Style, kompatibel mit Thunderbird et al.)
  const safeBody = body.replace(/^From /gm, '>From ');

  return fromLine + headers + `Content-Type: ${contentType}\n\n` + safeBody + '\n\n';
}

// ──────────────────────────────────────────────────────────────────
// Mailbox-Picker (Hilfsroute für die UI)
// ──────────────────────────────────────────────────────────────────

adminEDiscoveryRouter.get('/mailboxes', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { active: true, mailbox: { isNot: null } },
    select: { id: true, email: true, displayName: true, domain: { select: { name: true } } },
    orderBy: { email: 'asc' },
  });
  res.json(users.map((u) => ({
    id: u.id, email: u.email, displayName: u.displayName, domainName: u.domain.name,
  })));
});

// ──────────────────────────────────────────────────────────────────
// Searches
// ──────────────────────────────────────────────────────────────────

adminEDiscoveryRouter.get('/searches', async (_req: Request, res: Response) => {
  const searches = await prisma.eDiscoverySearch.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json(searches);
});

adminEDiscoveryRouter.get('/searches/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  res.json(search);
});

const SearchQuerySchema = z.object({
  keywords:           z.string().optional(),
  senderAddresses:    z.array(z.string().email()).default([]),
  recipientAddresses: z.array(z.string().email()).default([]),
  dateFrom:           z.string().datetime().optional(),
  dateTo:             z.string().datetime().optional(),
  hasAttachment:      z.boolean().optional(),
  subjectContains:    z.string().optional(),
});

const CreateSearchSchema = z.object({
  name:        z.string().min(1),
  description: z.string().default(''),
  query:       SearchQuerySchema,
  mailboxIds:  z.array(z.string()).default([]),
});

adminEDiscoveryRouter.post('/searches', async (req: Request, res: Response) => {
  const parsed = CreateSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const createdBy = req.apiUser?.userId ?? '';
  const search = await prisma.eDiscoverySearch.create({
    data: {
      name:        parsed.data.name,
      description: parsed.data.description,
      query:       parsed.data.query,
      mailboxIds:  parsed.data.mailboxIds,
      createdBy,
    },
  });
  res.status(201).json(search);
});

adminEDiscoveryRouter.delete('/searches/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  await prisma.eDiscoverySearch.delete({ where: { id } });
  res.status(204).end();
});

// POST /searches/:id/run — execute the search and update count
adminEDiscoveryRouter.post('/searches/:id/run', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status === 'RUNNING') {
    res.status(409).json({ error: 'Search is already running' }); return;
  }

  await prisma.eDiscoverySearch.update({ where: { id }, data: { status: 'RUNNING' } });

  // Asynchron — User bekommt sofort 202, Status pollt die UI
  void (async () => {
    try {
      const where = await buildMessageWhere(search.query as EDiscoveryQuery, search.mailboxIds);
      const count = await prisma.message.count({ where });
      await prisma.eDiscoverySearch.update({
        where: { id },
        data: { status: 'COMPLETED', resultCount: count },
      });
      log.info({ searchId: id, count }, 'eDiscovery search completed');
    } catch (err) {
      log.error({ err, searchId: id }, 'eDiscovery search failed');
      await prisma.eDiscoverySearch.update({
        where: { id },
        data: { status: 'FAILED' },
      });
    }
  })();

  res.status(202).json({ message: 'Search started', searchId: id });
});

/**
 * GET /searches/:id/results — paginiert, optional dedupliziert.
 * `dedupe=1` filtert Duplikate (gleiche Message-ID in mehreren Postfächern).
 */
adminEDiscoveryRouter.get('/searches/:id/results', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const q = req.query as Record<string, string>;
  const limit  = Math.min(parseInt(q['limit']  ?? '50', 10), 200);
  const offset = parseInt(q['offset'] ?? '0', 10);
  const dedupe = q['dedupe'] === '1' || q['dedupe'] === 'true';

  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status !== 'COMPLETED') {
    res.status(409).json({ error: 'Search not yet completed' }); return;
  }

  const where = await buildMessageWhere(search.query as EDiscoveryQuery, search.mailboxIds);

  if (!dedupe) {
    const [total, messages] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        select: {
          id: true, subject: true, fromAddr: true, toAddrs: true, date: true,
          rawSize: true, messageId: true,
          folder: { select: { name: true, mailbox: { select: { user: { select: { email: true } } } } } },
        },
        orderBy: { date: 'desc' },
        skip: offset, take: limit,
      }),
    ]);
    res.json({ total, dedupedTotal: total, deduped: false, messages });
    return;
  }

  // Dedupe-Modus: alles laden (capped) und in Node deduplizieren — Postgres hat keine
  // einfache window-distinct-by-messageId-Klausel mit Prisma; bei großen Suchen sollte
  // der Worker das in einem Batch tun. Für sinnvolle Suchgrößen (< 10000) ist das OK.
  const HARD_CAP = 10_000;
  const all = await prisma.message.findMany({
    where,
    select: {
      id: true, subject: true, fromAddr: true, toAddrs: true, date: true,
      rawSize: true, messageId: true,
      folder: { select: { name: true, mailbox: { select: { user: { select: { email: true } } } } } },
    },
    orderBy: { date: 'desc' },
    take: HARD_CAP,
  });
  const deduped = dedupeByMessageId(all);
  const slice   = deduped.slice(offset, offset + limit);
  res.json({
    total: all.length,
    dedupedTotal: deduped.length,
    deduped: true,
    messages: slice,
    capped: all.length >= HARD_CAP,
  });
});

/**
 * GET /searches/:id/preview — Top-N-Vorschau (Light-Weight), ohne Run/Status-Pflicht.
 */
adminEDiscoveryRouter.get('/searches/:id/preview', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const q = req.query as Record<string, string>;
  const limit  = Math.min(parseInt(q['limit'] ?? '20', 10), 100);
  const dedupe = q['dedupe'] === '1' || q['dedupe'] === 'true';

  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }

  const where = await buildMessageWhere(search.query as EDiscoveryQuery, search.mailboxIds);
  const total = await prisma.message.count({ where });

  // Für Preview holen wir bis zu 500 (Dedupe-Sample) bzw. limit (no-Dedupe)
  const sampleCount = dedupe ? Math.min(500, total) : limit;
  const messages = await prisma.message.findMany({
    where,
    select: {
      id: true, subject: true, fromAddr: true, toAddrs: true, date: true,
      rawSize: true, messageId: true,
      folder: { select: { name: true, mailbox: { select: { user: { select: { email: true } } } } } },
    },
    orderBy: { date: 'desc' },
    take: sampleCount,
  });

  const finalMessages = dedupe ? dedupeByMessageId(messages).slice(0, limit) : messages;
  const dedupedSample = dedupe ? dedupeByMessageId(messages).length : messages.length;

  res.json({
    total,
    sample: messages.length,
    dedupedSample,
    deduped: dedupe,
    messages: finalMessages,
  });
});

/**
 * GET /searches/:id/export?dedupe=1 — MBOX-Download
 * Streamt direkt eine MBOX-Datei als attachment. Funktioniert auch für mehrere Postfächer.
 */
adminEDiscoveryRouter.get('/searches/:id/export', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const q = req.query as Record<string, string>;
  const dedupe = q['dedupe'] === '1' || q['dedupe'] === 'true';

  const search = await prisma.eDiscoverySearch.findUnique({ where: { id } });
  if (!search) { res.status(404).json({ error: 'Search not found' }); return; }
  if (search.status !== 'COMPLETED') {
    res.status(409).json({ error: 'Search must be completed before export' }); return;
  }

  const where = await buildMessageWhere(search.query as EDiscoveryQuery, search.mailboxIds);

  // Sicherheits-Hard-Cap: keine unbegrenzten MBOX-Streams
  const HARD_CAP = 50_000;
  const total = await prisma.message.count({ where });
  if (total > HARD_CAP) {
    res.status(413).json({ error: `Zu viele Ergebnisse (${total} > ${HARD_CAP}). Bitte Suche einschränken.` }); return;
  }

  const filename = `ediscovery-${search.name.replace(/[^a-z0-9-]+/gi, '_')}-${id.slice(0, 6)}.mbox`;
  res.setHeader('Content-Type', 'application/mbox');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Streaming in Batches (1000) — Node-Backpressure-aware
  const BATCH = 1000;
  let offset = 0;
  const seenMessageIds = new Set<string>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await prisma.message.findMany({
      where,
      select: {
        id: true, subject: true, fromAddr: true, toAddrs: true, date: true,
        messageId: true, bodyText: true, bodyHtml: true,
      },
      orderBy: { date: 'asc' },
      skip: offset, take: BATCH,
    });
    if (batch.length === 0) break;

    for (const m of batch) {
      if (dedupe && m.messageId) {
        if (seenMessageIds.has(m.messageId)) continue;
        seenMessageIds.add(m.messageId);
      }
      res.write(buildMboxEntry({
        fromAddr:  m.fromAddr,
        date:      m.date,
        subject:   m.subject,
        toAddrs:   m.toAddrs,
        messageId: m.messageId,
        bodyText:  m.bodyText,
        bodyHtml:  m.bodyHtml,
      }));
    }

    if (batch.length < BATCH) break;
    offset += BATCH;
  }

  // Export-Pfad-Marker im Datensatz (für UI-Display, kein eigentlicher Speicherort hier)
  await prisma.eDiscoverySearch.update({
    where: { id },
    data:  { exportPath: `direct-stream:${filename}` },
  }).catch(() => undefined);

  res.end();
  log.info({ searchId: id, total, dedupe }, 'eDiscovery MBOX export streamed');
});

// ──────────────────────────────────────────────────────────────────
// Legal Hold
// ──────────────────────────────────────────────────────────────────

adminEDiscoveryRouter.get('/holds', async (_req: Request, res: Response) => {
  const holds = await prisma.legalHold.findMany({ orderBy: { appliedAt: 'desc' } });
  res.json(holds);
});

adminEDiscoveryRouter.get('/holds/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hold = await prisma.legalHold.findUnique({ where: { id } });
  if (!hold) { res.status(404).json({ error: 'Legal hold not found' }); return; }
  res.json(hold);
});

const CreateHoldSchema = z.object({
  name:        z.string().min(1),
  description: z.string().default(''),
  mailboxIds:  z.array(z.string()).min(1),
});

adminEDiscoveryRouter.post('/holds', async (req: Request, res: Response) => {
  const parsed = CreateHoldSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const appliedBy = req.apiUser?.userId ?? '';
  const hold = await prisma.legalHold.create({
    data: {
      name:        parsed.data.name,
      description: parsed.data.description,
      mailboxIds:  parsed.data.mailboxIds,
      appliedBy,
    },
  });
  log.info({ holdId: hold.id, mailboxes: parsed.data.mailboxIds.length }, 'Legal hold applied');
  res.status(201).json(hold);
});

adminEDiscoveryRouter.delete('/holds/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hold = await prisma.legalHold.findUnique({ where: { id } });
  if (!hold) { res.status(404).json({ error: 'Legal hold not found' }); return; }
  await prisma.legalHold.update({
    where: { id },
    data:  { active: false, releasedAt: new Date() },
  });
  log.info({ holdId: id }, 'Legal hold released');
  res.status(204).end();
});

adminEDiscoveryRouter.get('/holds/check/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  const hold = await prisma.legalHold.findFirst({
    where: { active: true, mailboxIds: { has: userId } },
    select: { id: true, name: true, appliedAt: true },
  });
  res.json({ underHold: !!hold, hold: hold ?? null });
});
