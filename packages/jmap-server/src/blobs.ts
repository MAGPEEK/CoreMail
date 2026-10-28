/**
 * Blob-Ids (RFC 8620 §6) — URL-safe, eindeutig pro Account:
 *   m-<messageId>        komplette RFC-5322-Nachricht
 *   a-<attachmentId>     Anhang (MinIO)
 *   p-<messageId>-text   text/plain-Body-Part
 *   p-<messageId>-html   text/html-Body-Part
 *   u-<hex>              Upload (POST /jmap/upload bzw. Blob/upload), 7 Tage
 * Upload-Metadaten liegen in Redis (`jmap:blob:<accountId>:<blobId>`), die
 * Bytes in MinIO unter jmap-upload/<accountId>/<blobId> (Lifecycle 7 Tage).
 */
import { randomBytes } from 'node:crypto';
import { prisma, downloadBuffer, uploadBuffer, jmapUploadKey, parseRawMessage } from '@coremail/storage';
import { getRedisClient } from '@coremail/core';
import type { AccountContext } from './types.js';
import { loadRawMessage, bodyPartBuffer } from './mail/raw.js';

export interface ResolvedBlob {
  buffer: Buffer;
  type: string;
  name: string | null;
}

const UPLOAD_TTL_SEC = 7 * 24 * 3600;

function metaKey(accountId: string, blobId: string): string {
  return `jmap:blob:${accountId}:${blobId}`;
}

export async function storeUpload(account: AccountContext, data: Buffer, type: string): Promise<{ blobId: string; size: number; type: string }> {
  const blobId = `u-${randomBytes(16).toString('hex')}`;
  const contentType = type || 'application/octet-stream';
  await uploadBuffer(jmapUploadKey(account.accountId, blobId), data, contentType);
  await getRedisClient().set(
    metaKey(account.accountId, blobId),
    JSON.stringify({ type: contentType, size: data.length }),
    'EX', UPLOAD_TTL_SEC,
  );
  return { blobId, size: data.length, type: contentType };
}

export async function resolveBlob(account: AccountContext, blobId: string): Promise<ResolvedBlob | null> {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(blobId)) return null;

  if (blobId.startsWith('u-')) {
    const raw = await getRedisClient().get(metaKey(account.accountId, blobId));
    if (!raw) return null;
    const meta = JSON.parse(raw) as { type: string; size: number };
    try {
      const buffer = await downloadBuffer(jmapUploadKey(account.accountId, blobId));
      return { buffer, type: meta.type, name: null };
    } catch {
      return null;
    }
  }

  if (blobId.startsWith('m-')) {
    const msg = await prisma.message.findFirst({
      where: { id: blobId.slice(2), folder: { mailboxId: account.mailboxId } },
      include: { attachments: true },
    });
    if (!msg) return null;
    return { buffer: await loadRawMessage(msg), type: 'message/rfc822', name: `${msg.subject || 'message'}.eml` };
  }

  if (blobId.startsWith('a-')) {
    const att = await prisma.attachment.findFirst({
      where: { id: blobId.slice(2), message: { folder: { mailboxId: account.mailboxId } } },
    });
    if (!att) return null;
    try {
      return { buffer: await downloadBuffer(att.storagePath), type: att.mimeType, name: att.filename };
    } catch {
      return null;
    }
  }

  // Parts eines per Email/parse geparsten Blobs: pp<hex(srcBlobId)>-(text|html|att<n>)
  const pp = /^pp([0-9a-f]+)-(text|html|att(\d+))$/.exec(blobId);
  if (pp) {
    const src = await resolveBlob(account, Buffer.from(pp[1]!, 'hex').toString('utf8'));
    if (!src) return null;
    const parsed = await parseRawMessage(src.buffer);
    if (pp[2] === 'text') return { buffer: Buffer.from(parsed.bodyText, 'utf8'), type: 'text/plain', name: null };
    if (pp[2] === 'html') return { buffer: Buffer.from(parsed.bodyHtml, 'utf8'), type: 'text/html', name: null };
    const att = parsed.attachments[Number(pp[3])];
    return att ? { buffer: att.buffer, type: att.mimeType, name: att.filename } : null;
  }

  const part = /^p-(.+)-(text|html)$/.exec(blobId);
  if (part) {
    const msg = await prisma.message.findFirst({
      where: { id: part[1]!, folder: { mailboxId: account.mailboxId } },
      select: { bodyText: true, bodyHtml: true },
    });
    if (!msg) return null;
    const kind = part[2] as 'text' | 'html';
    return { buffer: bodyPartBuffer(msg, kind), type: kind === 'html' ? 'text/html' : 'text/plain', name: null };
  }

  return null;
}

/** Blob/lookup (RFC 9404 §4): in welchen Objekten kommt der Blob vor? */
export async function lookupBlobReferences(
  account: AccountContext,
  blobId: string,
  typeNames: string[],
): Promise<Record<string, string[]> | null> {
  let messageIds: string[] = [];
  if (blobId.startsWith('m-')) {
    const m = await prisma.message.findFirst({
      where: { id: blobId.slice(2), folder: { mailboxId: account.mailboxId } }, select: { id: true },
    });
    if (!m) return null;
    messageIds = [m.id];
  } else if (blobId.startsWith('a-')) {
    const a = await prisma.attachment.findFirst({
      where: { id: blobId.slice(2), message: { folder: { mailboxId: account.mailboxId } } }, select: { messageId: true },
    });
    if (!a) return null;
    messageIds = [a.messageId];
  } else {
    const part = /^p-(.+)-(text|html)$/.exec(blobId);
    if (!part) return null;
    const m = await prisma.message.findFirst({
      where: { id: part[1]!, folder: { mailboxId: account.mailboxId } }, select: { id: true },
    });
    if (!m) return null;
    messageIds = [m.id];
  }
  const msgs = await prisma.message.findMany({
    where: { id: { in: messageIds } },
    select: { id: true, folderId: true, threadId: true },
  });
  const out: Record<string, string[]> = {};
  for (const t of typeNames) {
    if (t === 'Email') out['Email'] = msgs.map((m) => m.id);
    else if (t === 'Mailbox') out['Mailbox'] = [...new Set(msgs.map((m) => m.folderId))];
    else if (t === 'Thread') out['Thread'] = [...new Set(msgs.map((m) => m.threadId ?? m.id))];
  }
  return out;
}
