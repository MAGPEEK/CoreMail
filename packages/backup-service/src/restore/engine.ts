/**
 * Restore engine (9.3): writes messages of a backup archive into a mailbox.
 *
 *  - every message is stored with its ORIGINAL raw octets (content-addressed raw
 *    object) and created through the message store (atomic UID + modSeq);
 *  - idempotent: a message is skipped when the target folder already holds a
 *    non-deleted message with the same raw object (= byte-identical content) or,
 *    only for target rows without a content-addressed object, the same
 *    Message-ID and size —
 *    re-running a restore never duplicates messages;
 *  - folders are created as needed ("." hierarchy, parentId chain);
 *  - flags come from the archive manifest (sanitized), else \Seen.
 *
 * Contacts / calendar files of a ZIP backup are counted but not restored.
 */
import { createHash } from 'node:crypto';
import {
  prisma, createMessage, parseRawMessage, storeRawMessage, truncateBodyColumn, rawContentKey,
  attachmentKey, uploadBuffer, reservedFolderPrefix,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { openZip, ZipEntryTooLargeError, type ZipEntry } from './zip-reader.js';
import { readMbox } from './mbox-reader.js';
import { MANIFEST_NAME, parseManifest, type ManifestLookup } from '../export/manifest.js';
import { folderSegments, sanitizeFlags, targetFolderName, validRestoreFolder, type RestoreMode } from './source.js';

const log = createLogger('backup:restore');

export interface RestoreItem {
  /** Original octets; null = unreadable / over the size limit (counted as failed). */
  raw: Buffer | null;
  /** Folder in the source mailbox; null = unknown (MBOX). */
  folder: string | null;
  /** Flags from the manifest; null = unknown. */
  flags: string[] | null;
  /** Entry name / position for logs. */
  ref: string;
  /** Why `raw` is null. */
  error?: string;
}

export interface RestoreCounts {
  /** Messages read from the archive. */
  total: number;
  imported: number;
  /** Already present in the target folder (idempotent re-run). */
  duplicates: number;
  failed: number;
  /** Contacts / calendar entries of a ZIP backup (not restored). */
  otherEntries: number;
  foldersCreated: number;
}

export interface RestorePlan {
  mailboxId: string;
  mode: RestoreMode;
  /** Target folder for mode "folder" (must belong to the mailbox). */
  folderId?: string | null;
  /** Name of the restore root folder ("Wiederhergestellt YYYY-MM-DD"). */
  rootName: string;
  /** Max. folders created by this restore (default DEFAULT_MAX_RESTORE_FOLDERS). */
  maxFolders?: number;
}

export interface RestoreLimits {
  maxMessageBytes: number;
}

export const DEFAULT_MAX_MESSAGE_BYTES = 150 * 1024 * 1024;
/** 9.3 review: the archive manifest is read (and JSON-parsed) only up to 16 MiB. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export function emptyCounts(): RestoreCounts {
  return { total: 0, imported: 0, duplicates: 0, failed: 0, otherEntries: 0, foldersCreated: 0 };
}

/** Archive entries → restore items (ZIP: manifest folders/flags, else path-derived folder + \Seen). */
export async function* zipItems(path: string, limits: RestoreLimits, counts: RestoreCounts): AsyncGenerator<RestoreItem> {
  const zip = await openZip(path);
  try {
    let manifest: Map<string, ManifestLookup> | null = null;
    const mEntry = zip.entries.find((e) => e.name === MANIFEST_NAME);
    if (mEntry) {
      try {
        manifest = parseManifest((await zip.read(mEntry, MAX_MANIFEST_BYTES)).toString('utf8'));
      } catch (err) {
        log.warn({ err }, 'Backup manifest unreadable — folders from paths, flags \\Seen');
      }
    }
    for (const entry of zip.entries) {
      if (entry.name === MANIFEST_NAME || entry.name.endsWith('/')) continue;
      if (!entry.name.startsWith('mail/') || !entry.name.toLowerCase().endsWith('.eml')) {
        counts.otherEntries++;
        continue;
      }
      yield await zipItem(zip.read, entry, manifest, limits);
    }
  } finally {
    await zip.close();
  }
}

async function zipItem(
  read: (e: ZipEntry, max: number) => Promise<Buffer>,
  entry: ZipEntry,
  manifest: Map<string, ManifestLookup> | null,
  limits: RestoreLimits,
): Promise<RestoreItem> {
  const m = manifest?.get(entry.name) ?? null;
  // mail/<folder segment>/<uid>.eml (pre-9.3 archives: the segment is the sanitized folder name)
  const segs = entry.name.split('/');
  const pathFolder = segs.length >= 3 ? segs.slice(1, -1).join('/') : null;
  const folder = m?.folder ?? pathFolder;
  try {
    return { raw: await read(entry, limits.maxMessageBytes), folder, flags: m ? m.flags : null, ref: entry.name };
  } catch (err) {
    const error = err instanceof ZipEntryTooLargeError ? 'message too large' : (err instanceof Error ? err.message : String(err));
    return { raw: null, folder, flags: null, ref: entry.name, error };
  }
}

export async function* mboxItems(path: string, limits: RestoreLimits): AsyncGenerator<RestoreItem> {
  for await (const m of readMbox(path, { maxMessageBytes: limits.maxMessageBytes })) {
    yield {
      raw: m.raw, folder: null, flags: null, ref: `#${m.index}`,
      ...(m.raw ? {} : { error: 'message too large' }),
    };
  }
}

/** Default cap of folders one restore may create (BACKUP_RESTORE_MAX_FOLDERS). */
export const DEFAULT_MAX_RESTORE_FOLDERS = 1000;

/** The restore reached its folder cap — the message goes to the restore folder. */
export class FolderLimitError extends Error {
  constructor(readonly max: number) { super(`folder limit of the restore reached (${max})`); this.name = 'FolderLimitError'; }
}

/** The per-mailbox restore lock was lost — the restore stops before writing more. */
export class RestoreAbortedError extends Error {
  constructor(message = 'Wiederherstellung abgebrochen: die Sperre des Zielpostfachs ging verloren (Redis) — bitte erneut starten') {
    super(message);
    this.name = 'RestoreAbortedError';
  }
}

/** Folder resolution with a per-run cache; creates missing folders (parent chain). */
export class FolderResolver {
  private readonly cache = new Map<string, string>();
  created = 0;

  /** `maxCreate`: folders this run may create (9.3 review); `force` in ensure() bypasses it (restore root). */
  constructor(private readonly mailboxId: string, private readonly maxCreate = Number.POSITIVE_INFINITY) {}

  async ensure(fullName: string, force = false): Promise<string> {
    const segs = folderSegments(fullName);
    if (!segs.length) segs.push('INBOX');
    let parentId: string | null = null;
    let id = '';
    for (let i = 1; i <= segs.length; i++) {
      const name = segs.slice(0, i).join('.');
      const cached = this.cache.get(name);
      if (cached) { id = cached; parentId = cached; continue; }
      let row = await prisma.folder.findFirst({ where: { mailboxId: this.mailboxId, name }, select: { id: true } });
      if (!row) {
        if (!force && this.created >= this.maxCreate) throw new FolderLimitError(this.maxCreate);
        try {
          row = await prisma.folder.create({
            data: {
              mailboxId: this.mailboxId, name, displayName: segs[i - 1]!, totalCount: 0, unreadCount: 0,
              ...(parentId ? { parentId } : {}),
            },
            select: { id: true },
          });
          this.created++;
        } catch (err) {
          // concurrent creation (unique mailboxId + name): use the existing row
          row = await prisma.folder.findFirst({ where: { mailboxId: this.mailboxId, name }, select: { id: true } });
          if (!row) throw err;
        }
      }
      this.cache.set(name, row.id);
      id = row.id;
      parentId = row.id;
    }
    return id;
  }
}

const CONTENT_KEY_RE = /^raw\/[0-9a-f]{2}\/[0-9a-f]{64}\.eml$/;

/** True for a content-addressed raw object key (rawContentKey: raw/<2>/<sha256>.eml). */
export function isContentAddressedKey(storagePath: string | null | undefined): boolean {
  return !!storagePath && CONTENT_KEY_RE.test(storagePath);
}

/** True when the folder already holds this exact message (same content-addressed raw object). */
async function hasSameContent(folderId: string, storagePath: string): Promise<boolean> {
  const hit = await prisma.message.findFirst({
    where: { folderId, deletedAt: null, storagePath },
    select: { id: true },
  });
  return !!hit;
}

/**
 * Fallback for rows WITHOUT a content-addressed raw object (legacy rows):
 * same Message-ID + size. 9.3 review: a row that HAS a content key was already
 * compared by content — a different message that happens to share Message-ID
 * and size must not suppress the archived original.
 */
async function hasLegacyTwin(folderId: string, messageId: string, size: number): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: { folderId, deletedAt: null, messageId, rawSize: size },
    select: { storagePath: true },
    take: 50,
  }) as Array<{ storagePath: string | null }>;
  return rows.some((r) => !isContentAddressedKey(r.storagePath));
}

/**
 * Restores `items` into the mailbox of `plan`. Never throws for a single bad
 * message (counted as failed); throws only for setup errors (bad target folder).
 */
export async function restoreItems(
  items: AsyncIterable<RestoreItem>,
  plan: RestorePlan,
  counts: RestoreCounts = emptyCounts(),
  onProgress?: (c: RestoreCounts) => void | Promise<void>,
  /** Aborted when the per-mailbox restore lock is lost — nothing is written after that. */
  signal?: AbortSignal,
): Promise<RestoreCounts> {
  const folders = new FolderResolver(plan.mailboxId, plan.maxFolders ?? DEFAULT_MAX_RESTORE_FOLDERS);
  let fixedFolderId: string | null = null;
  if (plan.mode === 'folder') {
    const f = await prisma.folder.findFirst({ where: { id: plan.folderId ?? '', mailboxId: plan.mailboxId }, select: { id: true } });
    if (!f) throw new Error('Target folder not found in the target mailbox');
    fixedFolderId = f.id;
  }
  const isReserved = (name: string): boolean => reservedFolderPrefix(name) !== null;

  // 9.3 review: folder names from the archive are validated (refused → restore
  // folder) and the number of folders one restore creates is capped.
  let refusedFolders = 0;
  let cappedFolders = 0;
  const folderFor = async (item: RestoreItem): Promise<string> => {
    const mode = plan.mode as Exclude<RestoreMode, 'folder'>;
    const source = validRestoreFolder(item.folder, isReserved);
    if (item.folder !== null && source === null) {
      refusedFolders++;
      return folders.ensure(plan.rootName, true);
    }
    try {
      return await folders.ensure(targetFolderName(mode, source, plan.rootName, isReserved));
    } catch (err) {
      if (!(err instanceof FolderLimitError)) throw err;
      cappedFolders++;
      return folders.ensure(plan.rootName, true);
    }
  };

  let lastReport = Date.now();
  for await (const item of items) {
    if (signal?.aborted) throw new RestoreAbortedError();
    counts.total++;
    try {
      if (!item.raw) throw new Error(item.error ?? 'unreadable message');
      const raw = item.raw;
      const folderId = fixedFolderId ?? await folderFor(item);
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const key = rawContentKey(sha256);
      if (await hasSameContent(folderId, key)) { counts.duplicates++; continue; }
      const parsed = await parseRawMessage(raw);
      if (parsed.messageId && await hasLegacyTwin(folderId, parsed.messageId, raw.length)) { counts.duplicates++; continue; }

      const { storagePath } = await storeRawMessage(raw);
      const flags = sanitizeFlags(item.flags);
      const created = await prisma.$transaction((tx) => createMessage(tx, plan.mailboxId, folderId, {
        flags,
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
      }));
      for (const [index, att] of parsed.attachments.entries()) {
        const attKey = attachmentKey(created.id, `${index}-${att.sha256.slice(0, 16)}`);
        await uploadBuffer(attKey, att.buffer, att.mimeType);
        await prisma.attachment.create({
          data: {
            messageId: created.id, contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
            size: att.size, sha256: att.sha256, storagePath: attKey, inline: att.inline,
          },
        });
      }
      const unread = !flags.includes('\\Seen');
      await prisma.folder.update({
        where: { id: folderId },
        data: { totalCount: { increment: 1 }, ...(unread ? { unreadCount: { increment: 1 } } : {}) },
      }).catch(() => undefined);
      counts.imported++;
    } catch (err) {
      counts.failed++;
      log.warn({ err, ref: item.ref }, 'Restore: message could not be restored');
    } finally {
      counts.foldersCreated = folders.created;
      if (onProgress && Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        await Promise.resolve(onProgress({ ...counts })).catch(() => undefined);
      }
    }
  }
  counts.foldersCreated = folders.created;
  if (refusedFolders || cappedFolders) {
    log.warn({ mailboxId: plan.mailboxId, refusedFolders, cappedFolders }, 'Restore: messages with refused folder names / beyond the folder cap went to the restore folder');
  }
  return counts;
}
