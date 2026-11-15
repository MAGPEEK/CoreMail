/**
 * Server drafts for the webmail (v8.x) — mounted at /api/v1/mail/drafts.
 *
 *   POST   /                create a draft                → { id, savedAt, attachments }
 *   GET    /:id             load a draft (compose fields + attachments)
 *   PUT    /:id             replace a draft (new message) → { id, savedAt, attachments }
 *   DELETE /:id             discard a draft
 *   POST   /:id/send        send it like POST /mail/send (same checks, rate limit),
 *                           optional { undoDelaySec 0–30 | scheduledAt }
 *   POST   /:id/unsend      undo a held/scheduled send: back to Drafts
 *
 * A draft is a real message in the caller's own Drafts folder: RFC 5322 raw
 * (nodemailer, Bcc kept), stored raw original, `\Draft` flag, written through
 * the message store — IMAP/JMAP/ActiveSync see it like any other draft. A
 * replace creates the new version and expunges the old one in the same
 * transaction (new UID, modSeq bump: QRESYNC/JMAP see destroy + create).
 *
 * Bodies: JSON, or multipart/form-data with a `draft` field (the same JSON)
 * plus new files in `attachments`. Attachments of the previous version are kept
 * by id (`keepAttachmentIds`) and reuse their stored objects.
 *
 * Send: the draft is claimed (no double send), handed to the shared send core
 * (`performSend` in mail.ts) and, once the outbound job is enqueued, moved to
 * Sent — it becomes the Sent copy. With an undo hold or scheduledAt it carries
 * scheduledStatus PENDING + the job id until the worker sends it, so the send
 * survives tab close and logout; /unsend removes the delayed job and moves it
 * back to Drafts. Own mailbox only (shared-mailbox drafts: use send-as from the
 * own Drafts folder).
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isoDateTime } from '../lib/zod-compat.js';
import type { SendMailOptions } from 'nodemailer';
import {
  prisma, parseRawMessage, storeRawMessage, truncateBodyColumn, attachmentKey, uploadBuffer,
  downloadBuffer, deleteObject, loadRawMessage, createMessage, expunge, moveMessages, touchMessages,
  nextModSeq, parseDraftFields, draftSenderMode, encodeDraftPending, DRAFTS_FOLDER, DRAFT_FLAG, DRAFT_PENDING_HEADER,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';
import { maxMessageBytes, maxRecipients, recipientAddress, MAX_SEND_FILES } from '../lib/send-limits.js';
import { resolveReplyHeaders, parseClientReferences } from '../lib/reply-headers.js';
import {
  performSend, resolveSender, buildRawMime, sendRateLimiter, sendUploadMiddleware, getOutboundQueue,
  replyLookup, MAX_SEND_HOLD_MS,
} from './mail.js';

const log = createLogger('api:drafts');
export const draftsRouter: RouterType = Router();
draftsRouter.use(requireAuth);

const SENT_FOLDER = 'Sent';
/** A send claim older than this is considered abandoned (process crash). */
const CLAIM_TTL_MS = 60_000;

const Recipients = z.array(z.string().max(1000)).max(2000).default([]);
const DraftSchema = z.object({
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: z.string().max(2000).default(''),
  bodyHtml: z.string().default(''),
  bodyText: z.string().default(''),
  inReplyTo: z.string().max(1000).optional(),
  references: z.union([z.array(z.string()), z.string()]).optional(),
  sendAs: z.string().email().optional(),
  sendOnBehalfOf: z.string().email().optional(),
  keepAttachmentIds: z.array(z.string().max(100)).max(MAX_SEND_FILES).default([]),
});
type DraftInput = z.infer<typeof DraftSchema>;

/** JSON passes through; multipart (new attachments) goes through the /send upload limits. */
function draftUpload(req: Request, res: Response, next: NextFunction): void {
  const ct = req.headers['content-type'] ?? '';
  if (ct.startsWith('application/json')) { next(); return; }
  sendUploadMiddleware(req, res, next);
}

function readDraftBody(req: Request): DraftInput | null {
  let body: unknown = req.body;
  const ct = req.headers['content-type'] ?? '';
  if (!ct.startsWith('application/json')) {
    const raw = (req.body as Record<string, unknown> | undefined)?.['draft'];
    try { body = typeof raw === 'string' ? JSON.parse(raw) : {}; } catch { return null; }
  }
  const parsed = DraftSchema.safeParse(body ?? {});
  return parsed.success ? parsed.data : null;
}

/** Recipients as typed (partial addresses allowed in a draft), without CR/LF/NUL. */
function cleanRecipients(list: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return list.map((s) => s.replace(/[\r\n\u0000]/g, ' ').trim()).filter(Boolean);
}

interface DraftRow {
  id: string;
  folderId: string;
  flags: string[];
  createdAt: Date;
  storagePath: string | null;
  scheduledStatus: string | null;
  scheduledAt: Date | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number; sha256: string; storagePath: string; contentId: string | null; inline: boolean }>;
  folder: { id: string; mailboxId: string };
}

/** A live message in the caller's OWN Drafts folder (anything else → null → 404). */
async function findDraft(userId: string, id: string): Promise<DraftRow | null> {
  return prisma.message.findFirst({
    where: { id, deletedAt: null, folder: { name: DRAFTS_FOLDER, mailbox: { userId } } },
    include: { attachments: true, folder: { select: { id: true, mailboxId: true } } },
  }) as unknown as Promise<DraftRow | null>;
}

async function systemFolder(userId: string, name: string): Promise<{ id: string; mailboxId: string } | null> {
  return prisma.folder.findFirst({
    where: { name, mailbox: { userId } },
    select: { id: true, mailboxId: true },
  });
}

function attachmentView(a: DraftRow['attachments'][number]) {
  return { id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, contentId: a.contentId, inline: a.inline };
}

class DraftGoneError extends Error {
  constructor() { super('draft no longer exists'); this.name = 'DraftGoneError'; }
}

type Outcome = { status: number; body: Record<string, unknown> };

const asRawSource = (m: DraftRow) => m as unknown as Parameters<typeof loadRawMessage>[0];

/**
 * Writes one draft version (create, or replace `previous`): builds the raw
 * message, stores it, creates the row + attachment rows and expunges the
 * previous version — one transaction, so a reader sees exactly one version.
 */
async function writeDraft(
  userId: string,
  input: DraftInput,
  files: Express.Multer.File[],
  previous: DraftRow | null,
): Promise<Outcome> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { domain: true } });
  if (!user) return { status: 404, body: { error: 'Benutzer nicht gefunden' } };
  const drafts = previous ? previous.folder : await systemFolder(userId, DRAFTS_FOLDER);
  if (!drafts) return { status: 409, body: { error: 'Entwürfe-Ordner fehlt' } };

  const to = cleanRecipients(input.to);
  const cc = cleanRecipients(input.cc);
  const bcc = cleanRecipients(input.bcc);
  const maxRcpt = maxRecipients();
  if (to.length + cc.length + bcc.length > maxRcpt) {
    return { status: 400, body: { error: `Too many recipients (max. ${maxRcpt})` } };
  }
  // Not-yet-valid entries ("bob") cannot go into To/Cc/Bcc — kept in a header
  const valid = (l: string[]) => l.filter((a) => recipientAddress(a) !== null);
  const invalid = (l: string[]) => l.filter((a) => recipientAddress(a) === null);
  const pending = { to: invalid(to), cc: invalid(cc), bcc: invalid(bcc) };
  const pendingHeader = encodeDraftPending(pending);
  if (!pendingHeader && (pending.to.length || pending.cc.length || pending.bcc.length)) {
    return { status: 400, body: { error: 'Invalid recipient address' } };
  }
  const clientRefs = parseClientReferences(input.references);
  if (!clientRefs.ok) return { status: 400, body: { error: clientRefs.error } };

  const sender = await resolveSender(user, input.sendAs?.toLowerCase() ?? null, input.sendOnBehalfOf?.toLowerCase() ?? null);
  if (!sender.ok) return { status: sender.status, body: { error: sender.error } };

  // Attachments of the previous version to keep (by id) + new uploads
  const prevAtts = previous?.attachments ?? [];
  const kept = input.keepAttachmentIds.map((id) => prevAtts.find((a) => a.id === id));
  if (kept.some((a) => !a)) return { status: 400, body: { error: 'Unbekannter Anhang' } };
  const keptAtts = kept as DraftRow['attachments'];
  if (keptAtts.length + files.length > MAX_SEND_FILES) {
    return { status: 400, body: { error: `Zu viele Anhänge (max. ${MAX_SEND_FILES})` } };
  }

  const reply = await resolveReplyHeaders(input.inReplyTo, user.id, replyLookup, clientRefs.refs);
  const replyRefs = reply.references ?? reply.inReplyTo;

  let messageId = `<${crypto.randomUUID()}@${user.domain.name}>`;
  if (previous?.storagePath) {
    try {
      const prevFields = await parseDraftFields(await loadRawMessage(asRawSource(previous), { persist: false }));
      if (prevFields.messageId) messageId = prevFields.messageId;
    } catch { /* new Message-ID */ }
  }

  const attachments: NonNullable<SendMailOptions['attachments']> = [];
  for (const a of keptAtts) {
    attachments.push({
      filename: a.filename,
      content: await downloadBuffer(a.storagePath),
      contentType: a.mimeType,
      ...(a.contentId ? { cid: a.contentId.replace(/^<|>$/g, '') } : {}),
      ...(a.inline ? { contentDisposition: 'inline' as const } : {}),
    });
  }
  for (const f of files) attachments.push({ filename: f.originalname, content: f.buffer, contentType: f.mimetype });

  const raw = await buildRawMime({
    messageId,
    from: sender.fromName ? { name: sender.fromName, address: sender.fromEmail } : sender.fromEmail,
    ...(sender.onBehalfHeader ? { sender: sender.onBehalfHeader } : {}),
    ...(valid(to).length ? { to: valid(to) } : {}),
    ...(valid(cc).length ? { cc: valid(cc) } : {}),
    ...(valid(bcc).length ? { bcc: valid(bcc) } : {}),     // drafts keep Bcc (stream transport keepBcc)
    ...(pendingHeader ? { headers: { [DRAFT_PENDING_HEADER]: pendingHeader } } : {}),
    subject: input.subject,
    date: new Date(),
    ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
    ...(input.bodyText || !input.bodyHtml ? { text: input.bodyText } : {}),
    ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
    ...(replyRefs ? { references: replyRefs } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
  const limit = await maxMessageBytes();
  if (raw.length > limit) return { status: 413, body: { error: 'Message too large', maxBytes: limit } };

  const parsed = await parseRawMessage(raw);
  // Raw-always storage: written before the row exists (content-addressed).
  const { storagePath } = await storeRawMessage(raw);

  // Attachment objects: a kept attachment (same bytes) reuses its object; new
  // ones are uploaded under a fresh prefix BEFORE the transaction, so the row
  // is never visible without them.
  const uploadPrefix = `draft-${crypto.randomUUID()}`;
  const attachmentRows: Array<{ contentId: string | null; filename: string; mimeType: string; size: number; sha256: string; storagePath: string; inline: boolean }> = [];
  for (const [index, att] of parsed.attachments.entries()) {
    const reuse = keptAtts.find((k) => k.sha256 === att.sha256);
    let key = reuse?.storagePath;
    if (!key) {
      key = attachmentKey(uploadPrefix, `${index}-${att.sha256.slice(0, 16)}`);
      await uploadBuffer(key, att.buffer, att.mimeType);
    }
    attachmentRows.push({
      contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
      size: att.size, sha256: att.sha256, storagePath: key, inline: att.inline,
    });
  }

  let created: { id: string; createdAt: Date };
  try {
    created = await prisma.$transaction(async (tx) => {
      // createMessage takes the mailbox row lock first: concurrent replaces of
      // the same draft are serialized and the loser sees it gone.
      const msg = await createMessage(tx, drafts.mailboxId, drafts.id, {
        flags: [DRAFT_FLAG, '\\Seen'],
        subject: parsed.subject,
        fromAddr: parsed.fromAddr,
        fromName: parsed.fromName,
        toAddrs: parsed.toAddrs,
        ccAddrs: parsed.ccAddrs,
        bccAddrs: parsed.bccAddrs,
        replyTo: parsed.replyTo,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        date: parsed.date,
        bodyText: truncateBodyColumn(parsed.bodyText),
        bodyHtml: truncateBodyColumn(parsed.bodyHtml),
        rawSize: raw.length,
        storagePath,
        ...(attachmentRows.length ? { attachments: { create: attachmentRows } } : {}),
      });
      if (previous) {
        const live = await tx.message.findFirst({
          where: { id: previous.id, folderId: drafts.id, deletedAt: null },
          select: { id: true, scheduledStatus: true },
        });
        if (!live || live.scheduledStatus === 'SENDING') throw new DraftGoneError();
        await expunge(tx, [previous.id], { mailboxId: drafts.mailboxId, where: { folderId: drafts.id, deletedAt: null } });
      }
      return msg;
    });
  } catch (err) {
    if (err instanceof DraftGoneError) return { status: 404, body: { error: 'Entwurf nicht gefunden' } };
    throw err;
  }
  if (!previous) {
    await prisma.folder.update({ where: { id: drafts.id }, data: { totalCount: { increment: 1 } } })
      .catch((e: unknown) => log.warn({ err: e }, 'Drafts counter update failed'));
  }

  const rows = await prisma.attachment.findMany({ where: { messageId: created.id } }) as DraftRow['attachments'];
  return {
    status: previous ? 200 : 201,
    body: { id: created.id, savedAt: created.createdAt, attachments: rows.map(attachmentView) },
  };
}

// POST /api/v1/mail/drafts — create
draftsRouter.post('/', draftUpload, async (req: Request, res: Response) => {
  const input = readDraftBody(req);
  if (!input) { res.status(400).json({ error: 'Invalid request' }); return; }
  if (input.keepAttachmentIds.length) { res.status(400).json({ error: 'Unbekannter Anhang' }); return; }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const out = await writeDraft(req.apiUser!.userId, input, files, null);
  res.status(out.status).json(out.body);
});

// GET /api/v1/mail/drafts/:id — compose fields of a draft
draftsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const draft = await findDraft(req.apiUser!.userId, id);
  if (!draft) { res.status(404).json({ error: 'Entwurf nicht gefunden' }); return; }
  const user = await prisma.user.findUnique({ where: { id: req.apiUser!.userId }, select: { email: true } });
  let raw: Buffer;
  try {
    raw = await loadRawMessage(asRawSource(draft), { persist: false });
  } catch (err) {
    log.warn({ err, id }, 'Draft source not readable');
    res.status(503).json({ error: 'Entwurf vorübergehend nicht lesbar' });
    return;
  }
  const f = await parseDraftFields(raw);
  const mode = draftSenderMode(f, user?.email ?? '');
  res.json({
    id: draft.id,
    savedAt: draft.createdAt,
    to: f.to, cc: f.cc, bcc: f.bcc,
    subject: f.subject,
    bodyHtml: f.bodyHtml,
    bodyText: f.bodyText,
    messageId: f.messageId,
    inReplyTo: f.inReplyTo,
    references: f.references,
    sendAs: mode.sendAs,
    sendOnBehalfOf: mode.sendOnBehalfOf,
    attachments: draft.attachments.map(attachmentView),
  });
});

// PUT /api/v1/mail/drafts/:id — replace (the new version has a new id)
draftsRouter.put('/:id', draftUpload, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const input = readDraftBody(req);
  if (!input) { res.status(400).json({ error: 'Invalid request' }); return; }
  const previous = await findDraft(req.apiUser!.userId, id);
  if (!previous || previous.scheduledStatus === 'SENDING') { res.status(404).json({ error: 'Entwurf nicht gefunden' }); return; }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const out = await writeDraft(req.apiUser!.userId, input, files, previous);
  res.status(out.status).json(out.body);
});

// DELETE /api/v1/mail/drafts/:id — discard
draftsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const draft = await findDraft(req.apiUser!.userId, id);
  if (!draft) { res.status(404).json({ error: 'Entwurf nicht gefunden' }); return; }
  await prisma.$transaction((tx) => expunge(tx, [id], {
    mailboxId: draft.folder.mailboxId, where: { folderId: draft.folder.id, deletedAt: null },
  }));
  await prisma.folder.update({ where: { id: draft.folder.id }, data: { totalCount: { decrement: 1 } } })
    .catch((e: unknown) => log.warn({ err: e }, 'Drafts counter update failed'));
  res.json({ ok: true });
});

const SendDraftSchema = z.object({
  undoDelaySec: z.number().int().min(0).max(MAX_SEND_HOLD_MS / 1000).optional(),
  scheduledAt: isoDateTime().optional(),
});

/**
 * Claims a draft for sending (scheduledStatus SENDING) under the mailbox row
 * lock, so two concurrent sends of the same draft cannot both enqueue it.
 */
async function claimDraft(draft: DraftRow): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await nextModSeq(tx, draft.folder.mailboxId);
    const row = await tx.message.findFirst({
      where: { id: draft.id, folderId: draft.folder.id, deletedAt: null },
      select: { scheduledStatus: true, scheduledAt: true },
    });
    if (!row) return false;
    if (row.scheduledStatus === 'SENDING' && row.scheduledAt && Date.now() - row.scheduledAt.getTime() < CLAIM_TTL_MS) return false;
    await touchMessages(tx, [draft.id], { scheduledStatus: 'SENDING', scheduledAt: new Date() }, { mailboxId: draft.folder.mailboxId });
    return true;
  });
}

async function releaseDraft(draft: DraftRow): Promise<void> {
  await prisma.$transaction((tx) => touchMessages(
    tx, [draft.id], { scheduledStatus: null, scheduledAt: null },
    { mailboxId: draft.folder.mailboxId, where: { scheduledStatus: 'SENDING' } },
  )).catch((e: unknown) => log.warn({ err: e, id: draft.id }, 'Draft claim release failed'));
}

// POST /api/v1/mail/drafts/:id/send — send exactly like POST /mail/send
draftsRouter.post('/:id/send', sendRateLimiter.middleware, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsedBody = SendDraftSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const userId = req.apiUser!.userId;

  const draft = await findDraft(userId, id);
  if (!draft) { res.status(404).json({ error: 'Entwurf nicht gefunden' }); return; }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

  let raw: Buffer;
  try {
    raw = await loadRawMessage(asRawSource(draft), { persist: false });
  } catch (err) {
    log.warn({ err, id }, 'Draft source not readable');
    res.status(503).json({ error: 'Entwurf vorübergehend nicht lesbar' });
    return;
  }
  // Same size limit as a /send request
  const limit = await maxMessageBytes();
  if (raw.length > limit) { res.status(413).json({ error: 'Message too large', maxBytes: limit }); return; }
  const f = await parseDraftFields(raw);
  const mode = draftSenderMode(f, user.email);

  if (!(await claimDraft(draft))) { res.status(409).json({ error: 'Entwurf wird bereits gesendet' }); return; }

  const sent = await systemFolder(userId, SENT_FOLDER);
  const flags = [...new Set([...draft.flags.filter((x) => x !== DRAFT_FLAG), '\\Seen'])];
  const scheduledAt = parsedBody.data.scheduledAt ? new Date(parsedBody.data.scheduledAt) : null;

  let out;
  try {
    out = await performSend(userId, {
      to: f.to, cc: f.cc, bcc: f.bcc,
      subject: f.subject,
      bodyHtml: f.bodyHtml,
      bodyText: f.bodyText,
      inReplyTo: f.inReplyTo ?? undefined,
      ...(f.references.length ? { referencesRaw: f.references } : {}),
      scheduledAt,
      holdMs: (parsedBody.data.undoDelaySec ?? 0) * 1000,
      sendAs: mode.sendAs,
      sendOnBehalfOf: mode.sendOnBehalfOf,
      messageId: f.messageId,
      attachments: draft.attachments.map((a) => ({
        filename: a.filename, contentType: a.mimeType, size: a.size, storagePath: a.storagePath,
      })),
      // Only after a successful enqueue: the draft becomes the Sent copy
      // (held/scheduled: PENDING + job id, so /unsend and the worker find it).
      afterEnqueue: async (info) => {
        const scheduled = info.sendAt
          ? { scheduledAt: info.sendAt, scheduledStatus: 'PENDING', scheduledJobId: info.queueJobId }
          : { scheduledAt: null, scheduledStatus: null, scheduledJobId: null };
        await prisma.$transaction(async (tx) => {
          if (sent) {
            await moveMessages(tx, [draft.id], sent.id, {
              targetMailboxId: sent.mailboxId, sourceMailboxId: draft.folder.mailboxId,
              data: { flags, ...scheduled },
            });
          } else {
            await expunge(tx, [draft.id], { mailboxId: draft.folder.mailboxId });
          }
        });
        await prisma.folder.update({ where: { id: draft.folder.id }, data: { totalCount: { decrement: 1 } } }).catch(() => undefined);
        if (sent) await prisma.folder.update({ where: { id: sent.id }, data: { totalCount: { increment: 1 } } }).catch(() => undefined);
      },
    });
  } catch (err) {
    await releaseDraft(draft);
    throw err;
  }
  if (out.status !== 200) {
    await releaseDraft(draft);
    res.status(out.status).json(out.body);
    return;
  }
  res.json({ ...out.body, id: draft.id, ...(sent ? { sentFolderId: sent.id } : {}) });
});

// POST /api/v1/mail/drafts/:id/unsend — undo a held / scheduled send (still delayed)
draftsRouter.post('/:id/unsend', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser!.userId;
  const msg = await prisma.message.findFirst({
    where: { id, deletedAt: null, scheduledStatus: 'PENDING', folder: { name: SENT_FOLDER, mailbox: { userId } } },
    select: { id: true, flags: true, scheduledJobId: true, folderId: true, folder: { select: { mailboxId: true } } },
  });
  if (!msg || !msg.scheduledJobId) { res.status(404).json({ error: 'Kein ausstehender Versand' }); return; }
  const drafts = await systemFolder(userId, DRAFTS_FOLDER);
  if (!drafts) { res.status(409).json({ error: 'Entwürfe-Ordner fehlt' }); return; }

  // Only a job that has not started can be withdrawn; remove() is atomic and
  // refuses a job a worker holds (locked) — then it is too late.
  const job = await getOutboundQueue().getJob(msg.scheduledJobId);
  const state = job ? await job.getState() : 'unknown';
  if (!job || (state !== 'delayed' && state !== 'waiting' && state !== 'prioritized')) {
    res.status(409).json({ error: 'Nachricht wird bereits gesendet', state });
    return;
  }
  try {
    await job.remove();
  } catch (err) {
    log.info({ err, id }, 'Unsend refused: job already active');
    res.status(409).json({ error: 'Nachricht wird bereits gesendet' });
    return;
  }
  // Outbound copies of the attachments are no longer needed
  const queued = (job.data as { message?: { attachments?: Array<{ minioPath: string }> } }).message?.attachments ?? [];
  await Promise.allSettled(queued.map((a) => deleteObject(a.minioPath)));

  const flags = [...new Set([...msg.flags, DRAFT_FLAG])];
  await prisma.$transaction((tx) => moveMessages(tx, [id], drafts.id, {
    targetMailboxId: drafts.mailboxId, sourceMailboxId: msg.folder.mailboxId,
    data: { flags, scheduledAt: null, scheduledStatus: null, scheduledJobId: null },
  }));
  await prisma.folder.update({ where: { id: msg.folderId }, data: { totalCount: { decrement: 1 } } }).catch(() => undefined);
  await prisma.folder.update({ where: { id: drafts.id }, data: { totalCount: { increment: 1 } } }).catch(() => undefined);
  res.json({ ok: true, id });
});
