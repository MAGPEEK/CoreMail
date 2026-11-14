/**
 * Raw message storage — the original RFC 5322 octets of every message.
 *
 * Since v6.1 every writer stores the raw message in object storage
 * (`Message.storagePath`), whatever its size. IMAP, POP3, JMAP, the REST source
 * view and backups serve these octets unchanged, so attachments and all header
 * fields survive and RFC822.SIZE / LIST sizes are exact (`rawSize` = object length).
 *
 * Objects are content-addressed (`raw/<aa>/<sha256>.eml`): delivering one mail to
 * several local recipients, rule copies and IMAP/REST copies (message-store
 * `copyMessages` copies `storagePath`) share one object. Raw objects are never
 * deleted together with a single message row for that reason.
 *
 * Legacy rows (written before raw-always storage, `storagePath = null`) are
 * reconstructed from the database columns with the deterministic builder
 * (`mime/build.ts`) and the result is persisted on first access (lazy migration),
 * so every later access is byte-identical.
 *
 * This module only depends on the injected object store and the pure builder, so
 * protocol test stubs can wire it to in-memory fakes; `raw-message-default.ts`
 * wires it to MinIO + Prisma.
 */
import { createHash } from 'node:crypto';
import { buildRfc822FromFields, type FallbackAttachment } from './mime/build.js';

/** Max characters kept in `bodyText` / `bodyHtml` (search + preview); the raw object keeps everything. */
export const BODY_COLUMN_MAX_CHARS = 1024 * 1024;

/** Truncates a body column value to {@link BODY_COLUMN_MAX_CHARS} (never splits a surrogate pair). */
export function truncateBodyColumn(text: string | null | undefined, max = BODY_COLUMN_MAX_CHARS): string {
  if (!text) return '';
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return text.slice(0, cut);
}

/** Content-addressed object key of a raw message. */
export function rawContentKey(sha256Hex: string): string {
  return `raw/${sha256Hex.slice(0, 2)}/${sha256Hex}.eml`;
}

export interface RawAttachmentRow {
  filename: string;
  mimeType: string;
  storagePath: string | null;
  contentId: string | null;
  inline: boolean;
}

/** The message columns the loader needs. */
export interface RawSourceMessage {
  id: string;
  storagePath: string | null;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  date: Date | string;
  bodyText: string;
  bodyHtml: string;
  /** Attachment rows; loaded through `findAttachments` when omitted. */
  attachments?: Array<Partial<RawAttachmentRow> & { filename: string; mimeType: string }>;
}

export interface RawObjectStore {
  download(key: string): Promise<Buffer>;
  upload(key: string, data: Buffer): Promise<void>;
  /** True when the object already exists (skips re-uploading identical content). */
  exists?(key: string): Promise<boolean>;
  /** Attachment rows of a legacy message (fallback reconstruction). */
  findAttachments?(messageId: string): Promise<RawAttachmentRow[]>;
  /**
   * Records the raw object of a legacy row (`storagePath` was null). Must only
   * update rows whose `storagePath` is still null.
   */
  markStored?(messageId: string, storagePath: string, rawSize: number): Promise<void>;
  warn?(msg: string, err?: unknown): void;
}

export interface StoredRaw { storagePath: string; size: number; sha256: string }

export interface LoadOptions {
  /** Persist the reconstruction of a legacy row (default true). */
  persist?: boolean;
}

export interface RawMessageStore {
  /** Stores raw octets content-addressed; returns the key to put into `Message.storagePath`. */
  storeRawMessage(raw: Buffer): Promise<StoredRaw>;
  /**
   * The original RFC 5322 octets of a message. Throws when a stored object cannot
   * be read (never silently substitutes a reconstruction: IMAP clients cache
   * message content forever). Legacy rows are reconstructed and, by default, persisted.
   */
  loadRawMessage(msg: RawSourceMessage, opts?: LoadOptions): Promise<Buffer>;
  /** Reconstruction of a legacy row from its columns (no persistence). */
  reconstructRawMessage(msg: RawSourceMessage): Promise<Buffer>;
}

export function createRawMessageStore(store: RawObjectStore): RawMessageStore {
  async function storeRawMessage(raw: Buffer): Promise<StoredRaw> {
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const storagePath = rawContentKey(sha256);
    let present = false;
    if (store.exists) present = await store.exists(storagePath).catch(() => false);
    if (!present) await store.upload(storagePath, raw);
    return { storagePath, size: raw.length, sha256 };
  }

  async function reconstructRawMessage(msg: RawSourceMessage): Promise<Buffer> {
    let rows: Array<Partial<RawAttachmentRow> & { filename: string; mimeType: string }> = msg.attachments ?? [];
    if (!msg.attachments && store.findAttachments) {
      rows = await store.findAttachments(msg.id).catch(() => []);
    }
    const attachments: FallbackAttachment[] = [];
    for (const a of rows) {
      let content: Buffer = Buffer.alloc(0);
      if (a.storagePath) {
        try { content = await store.download(a.storagePath); } catch (err) {
          store.warn?.(`attachment object missing for legacy message ${msg.id}`, err);
        }
      }
      attachments.push({
        filename: a.filename,
        mimeType: a.mimeType,
        contentId: a.contentId ?? null,
        inline: !!a.inline,
        content,
      });
    }
    return buildRfc822FromFields({
      subject: msg.subject ?? '',
      fromAddr: msg.fromAddr ?? '',
      fromName: msg.fromName ?? '',
      toAddrs: msg.toAddrs ?? [],
      ccAddrs: msg.ccAddrs ?? [],
      replyTo: msg.replyTo ?? null,
      messageId: msg.messageId ?? null,
      inReplyTo: msg.inReplyTo ?? null,
      date: msg.date instanceof Date ? msg.date : new Date(msg.date),
      bodyText: msg.bodyText ?? '',
      bodyHtml: msg.bodyHtml ?? '',
    }, attachments);
  }

  async function loadRawMessage(msg: RawSourceMessage, opts: LoadOptions = {}): Promise<Buffer> {
    if (msg.storagePath) return store.download(msg.storagePath);
    const raw = await reconstructRawMessage(msg);
    if (opts.persist !== false && store.markStored) {
      try {
        const stored = await storeRawMessage(raw);
        await store.markStored(msg.id, stored.storagePath, stored.size);
      } catch (err) {
        store.warn?.(`could not persist reconstructed raw message ${msg.id}`, err);
      }
    }
    return raw;
  }

  return { storeRawMessage, loadRawMessage, reconstructRawMessage };
}
