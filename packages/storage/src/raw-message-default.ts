/**
 * Default wiring of the raw message store: MinIO objects + Prisma rows.
 * See raw-message.ts for the storage rules.
 */
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { downloadBuffer, uploadBuffer, objectExists } from './minio/index.js';
import { createRawMessageStore, type RawSourceMessage, type LoadOptions, type StoredRaw } from './raw-message.js';

const log = createLogger('raw-message');

const store = createRawMessageStore({
  download: downloadBuffer,
  upload: (key, data) => uploadBuffer(key, data, 'message/rfc822'),
  exists: objectExists,
  findAttachments: (messageId) => prisma.attachment.findMany({
    where: { messageId },
    orderBy: { createdAt: 'asc' },
    select: { filename: true, mimeType: true, storagePath: true, contentId: true, inline: true },
  }),
  // Lazy migration of legacy rows: only rows that still have no raw object. Not a
  // client-visible change (same message, now byte-stable), so no modSeq bump.
  markStored: async (messageId, storagePath, rawSize) => {
    await prisma.message.updateMany({ where: { id: messageId, storagePath: null }, data: { storagePath, rawSize } });
  },
  warn: (msg, err) => log.warn({ err }, msg),
});

/** Stores raw RFC 5322 octets (content-addressed); returns the `storagePath`. */
export function storeRawMessage(raw: Buffer): Promise<StoredRaw> {
  return store.storeRawMessage(raw);
}

/** Original RFC 5322 octets of a message (legacy rows: reconstructed + persisted). */
export function loadRawMessage(msg: RawSourceMessage, opts?: LoadOptions): Promise<Buffer> {
  return store.loadRawMessage(msg, opts);
}

/** Legacy reconstruction without persisting (diagnostics, previews). */
export function reconstructRawMessage(msg: RawSourceMessage): Promise<Buffer> {
  return store.reconstructRawMessage(msg);
}
