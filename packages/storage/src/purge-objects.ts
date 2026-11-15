/**
 * Object clean-up after messages are hard-deleted (deleted-items purge, user
 * "Purge"). Raw messages are content-addressed (`raw/<xx>/<sha256>.eml`) and
 * copies share attachment objects, so an object is deleted only when NO row
 * references its key any more: messages (live, tombstones, drafts, Recoverable
 * Items), attachments, quarantine and S/MIME files.
 *
 * Safety rules:
 *  - only keys under `raw/` and `attachments/` are ever considered (never
 *    quarantine, outbound-queue, JMAP uploads, backups, S/MIME);
 *  - the reference check runs after the rows are gone and immediately before
 *    each delete; deleting a missing object is a no-op (idempotent);
 *  - DELETED_ITEM_PURGE_OBJECTS=dry-run only logs (info) what would be deleted,
 *    `off` disables it (objects stay, like before 8.1).
 *
 * Residual race: a writer that stores a byte-identical raw message in the few
 * milliseconds between our reference check and the delete (it sees the object
 * as existing and skips the upload) would lose its raw object; the message row
 * keeps its parsed body, so it stays readable.
 */
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { getObjectStore } from './object-store/index.js';

const log = createLogger('storage:purge-objects');

export type ObjectPurgeMode = 'delete' | 'dry-run' | 'off';

/** DELETED_ITEM_PURGE_OBJECTS: `delete` (default) | `dry-run` | `off`. */
export function objectPurgeMode(env: Record<string, string | undefined> = process.env): ObjectPurgeMode {
  const v = (env['DELETED_ITEM_PURGE_OBJECTS'] ?? '').trim().toLowerCase();
  if (v === 'dry-run' || v === 'dryrun') return 'dry-run';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'delete';
}

const PURGEABLE_PREFIXES = ['raw/', 'attachments/'];

/** Pure: object keys of purged rows that may be garbage-collected (unique, allowed prefixes only). */
export function purgeCandidateKeys(rows: ReadonlyArray<{ storagePath: string | null; attachments?: ReadonlyArray<{ storagePath: string | null }> }>): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of [r.storagePath, ...(r.attachments ?? []).map((a) => a.storagePath)]) {
      if (k && PURGEABLE_PREFIXES.some((p) => k.startsWith(p)) && !k.includes('..')) keys.add(k);
    }
  }
  return [...keys];
}

export interface ObjectPurgeDeps {
  isReferenced(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
}

/** Any row that still points at the key (messages incl. tombstones and drafts, attachments, quarantine, S/MIME). */
export async function isObjectKeyReferenced(key: string): Promise<boolean> {
  const [messages, attachments, quarantine, certs] = await Promise.all([
    prisma.message.count({ where: { storagePath: key } }),
    prisma.attachment.count({ where: { storagePath: key } }),
    prisma.quarantine.count({ where: { rawPath: key } }),
    prisma.userCertificate.count({ where: { storagePath: key } }),
  ]);
  return messages + attachments + quarantine + certs > 0;
}

const defaultDeps: ObjectPurgeDeps = {
  isReferenced: isObjectKeyReferenced,
  deleteObject: (key) => getObjectStore().delete(key),
};

/**
 * Deletes the objects among `keys` that no row references any more. Never
 * throws (a failed delete is logged; the next purge cannot find the key again,
 * so the object stays — no data loss). Returns what was (or, dry-run, would be) deleted.
 */
export async function deleteUnreferencedObjects(
  keys: readonly string[],
  opts: { mode?: ObjectPurgeMode; deps?: ObjectPurgeDeps } = {},
): Promise<{ deleted: string[]; kept: number; failed: number; mode: ObjectPurgeMode }> {
  const mode = opts.mode ?? objectPurgeMode();
  const deps = opts.deps ?? defaultDeps;
  const deleted: string[] = [];
  let kept = 0;
  let failed = 0;
  if (mode === 'off' || keys.length === 0) return { deleted, kept, failed, mode };
  for (const key of keys) {
    try {
      if (await deps.isReferenced(key)) { kept++; continue; }
      if (mode === 'delete') await deps.deleteObject(key);
      deleted.push(key);
    } catch (err) {
      failed++;
      log.warn({ err, key }, 'Object of a purged message not deleted');
    }
  }
  if (mode === 'dry-run') {
    log.info({ wouldDelete: deleted.length, kept, keys: deleted.slice(0, 50) }, 'Dry run (DELETED_ITEM_PURGE_OBJECTS=dry-run): unreferenced objects of purged messages');
  } else if (deleted.length > 0 || failed > 0) {
    log.info({ deleted: deleted.length, kept, failed }, 'Unreferenced objects of purged messages deleted');
  }
  return { deleted, kept, failed, mode };
}
