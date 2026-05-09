/**
 * Internal Storage API — accessed only by other CoreMail services.
 * Exposes REST endpoints for message, folder, mailbox, and MinIO operations.
 * Not reachable from outside the Docker network.
 */
import express from 'express';
import { createLogger } from '@coremail/core/logger';
import { getPrisma } from './prisma/index.js';
import { getMinioClient } from './minio/index.js';
import { runMigrations } from './prisma/migrate.js';

const log = createLogger('storage-api');
const app = express();
const PORT = parseInt(process.env.STORAGE_PORT ?? '3001', 10);

app.use(express.json({ limit: '10mb' }));

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Mailboxes ────────────────────────────────────────────────────────────────
app.get('/mailboxes/:userId', async (req, res) => {
  try {
    const mailbox = await getPrisma().mailbox.findFirst({
      where: { userId: req.params.userId },
      include: { folders: true },
    });
    if (!mailbox) return res.status(404).json({ error: 'not found' });
    res.json(mailbox);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/mailboxes', async (req, res) => {
  try {
    const mailbox = await getPrisma().mailbox.create({ data: req.body });
    res.status(201).json(mailbox);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Folders ──────────────────────────────────────────────────────────────────
app.get('/folders/:mailboxId', async (req, res) => {
  try {
    const folders = await getPrisma().folder.findMany({
      where: { mailboxId: req.params.mailboxId },
      include: { children: true },
    });
    res.json(folders);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/folders/by-name/:mailboxId/:name', async (req, res) => {
  try {
    const folder = await getPrisma().folder.findFirst({
      where: { mailboxId: req.params.mailboxId, name: req.params.name },
    });
    if (!folder) return res.status(404).json({ error: 'not found' });
    res.json(folder);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/folders', async (req, res) => {
  try {
    const folder = await getPrisma().folder.create({ data: req.body });
    res.status(201).json(folder);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────
app.get('/messages/:folderId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string ?? '50', 10);
    const offset = parseInt(req.query.offset as string ?? '0', 10);
    const messages = await getPrisma().message.findMany({
      where: { folderId: req.params.folderId, deletedAt: null },
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true, uid: true, flags: true, subject: true,
        fromAddr: true, toAddrs: true, date: true, rawSize: true,
        changeKey: true,
      },
    });
    res.json(messages);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/messages/by-id/:id', async (req, res) => {
  try {
    const msg = await getPrisma().message.findUnique({
      where: { id: req.params.id },
      include: { attachments: true },
    });
    if (!msg || msg.deletedAt) return res.status(404).json({ error: 'not found' });
    res.json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/messages', async (req, res) => {
  try {
    const msg = await getPrisma().message.create({
      data: req.body,
      include: { attachments: true },
    });
    // update folder counters
    await getPrisma().folder.update({
      where: { id: msg.folderId },
      data: {
        totalCount: { increment: 1 },
        unreadCount: { increment: msg.flags.includes('\\Seen') ? 0 : 1 },
      },
    });
    // advance uidNext on mailbox
    await getPrisma().$executeRaw`
      UPDATE "Mailbox" m
      SET "uidNext" = "uidNext" + 1
      FROM "Folder" f
      WHERE f.id = ${msg.folderId} AND f."mailboxId" = m.id`;
    res.status(201).json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

app.patch('/messages/:id', async (req, res) => {
  try {
    const msg = await getPrisma().message.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(msg);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Soft-delete
app.delete('/messages/:id', async (req, res) => {
  try {
    const hard = req.query.hard === 'true';
    if (hard) {
      await getPrisma().message.delete({ where: { id: req.params.id } });
    } else {
      await getPrisma().message.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      });
    }
    res.status(204).send();
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── MinIO attachment proxy ────────────────────────────────────────────────────
app.get('/attachments/:key(*)', async (req, res) => {
  try {
    const minio = getMinioClient();
    const bucket = process.env.MINIO_BUCKET ?? 'mail-attachments';
    const stream = await minio.getObject(bucket, req.params.key);
    stream.pipe(res);
  } catch (err) {
    log.error(err);
    res.status(404).json({ error: 'not found' });
  }
});

// ── Users (read-only, for auth delegation) ───────────────────────────────────
app.get('/users/by-email/:email', async (req, res) => {
  try {
    const user = await getPrisma().user.findUnique({
      where: { email: req.params.email },
      select: {
        id: true, email: true, displayName: true, passwordHash: true,
        role: true, domainId: true, quotaBytes: true, usedBytes: true,
        active: true,
      } as Record<string, boolean>,
    });
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await runMigrations();
    app.listen(PORT, () => log.info(`storage-api listening on :${PORT}`));
  } catch (err) {
    log.error(err, 'startup failed');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  log.info('shutting down');
  await getPrisma().$disconnect();
  process.exit(0);
});

start();
