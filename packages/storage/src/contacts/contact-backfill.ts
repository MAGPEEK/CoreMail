/**
 * 9.5: one-time backfill of the structured contact columns (uid, name parts,
 * nickname, file as, dates, categories, typed lists, searchText) for contacts
 * stored before 9.5 — they keep empty columns until their next write otherwise.
 *
 * - A row needs the backfill while `searchText` is '' (every 9.5 writer fills it
 *   for a contact that holds anything at all).
 * - The columns are derived through the one contact mapping
 *   (contactCardFromRow → contactColumns): from the vCard, or from the flat
 *   columns for a row whose vcardData holds no vCard. The flat columns
 *   (displayName, email, …) and the vCard itself are not touched.
 * - Not a client-visible change: `updatedAt` (CardDAV ETag, sync-token, ctag)
 *   and `changeKey` are kept, so CardDAV / ActiveSync / MAPI clients see nothing.
 * - Batched (id order), one instance at a time (Redis lock
 *   `storage:contacts-backfill:lock`, refreshed between batches with a token
 *   check, released with compare-and-delete), resumable (the last id done is kept
 *   in `storage:contacts-backfill:cursor`), one-time (`storage:contacts-backfill:done`
 *   once a pass reached the end of the table). Idempotent: a row changed meanwhile
 *   (other updatedAt) or already filled is left alone.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createLogger } from '@coremail/core/logger';
import { prisma } from '../prisma/index.js';
import { contactCardFromRow, contactColumns, vcardUidKey, type ContactColumns, type ContactRowFlat } from './contact-vcard.js';

const log = createLogger('storage:contacts-backfill');

export const CONTACT_BACKFILL_LOCK_KEY = 'storage:contacts-backfill:lock';
export const CONTACT_BACKFILL_CURSOR_KEY = 'storage:contacts-backfill:cursor';
export const CONTACT_BACKFILL_DONE_KEY = 'storage:contacts-backfill:done';
/** Rows per batch. */
export const CONTACT_BACKFILL_BATCH = 200;
/** Batches per locked run. */
export const CONTACT_BACKFILL_MAX_BATCHES = 50;
export const CONTACT_BACKFILL_LOCK_TTL_MS = 2 * 60_000;
/** Pause between batches (keeps the database responsive). */
export const CONTACT_BACKFILL_PAUSE_MS = 200;

/** The 9.5 columns the backfill writes (never the flat pre-9.5 columns). */
export type ContactBackfillData = Omit<ContactColumns, 'displayName' | 'email' | 'email2' | 'phone' | 'mobile' | 'company' | 'department' | 'jobTitle' | 'notes' | 'emails' | 'phones' | 'addresses' | 'urls' | 'ims'> & {
  emails: Prisma.InputJsonValue; phones: Prisma.InputJsonValue; addresses: Prisma.InputJsonValue; urls: Prisma.InputJsonValue; ims: Prisma.InputJsonValue;
};

/**
 * The 9.5 columns of a stored row (pure). Null when the row holds nothing to
 * fill (no field, no UID) — writing it would change nothing.
 */
export function contactBackfillData(row: ContactRowFlat): ContactBackfillData | null {
  const c = contactColumns(contactCardFromRow(row), vcardUidKey(row.vcardData));
  if (!c.searchText && !c.uid) return null;
  return {
    uid: c.uid, givenName: c.givenName, familyName: c.familyName, middleName: c.middleName, namePrefix: c.namePrefix,
    nameSuffix: c.nameSuffix, nickname: c.nickname, fileAs: c.fileAs, birthday: c.birthday, anniversary: c.anniversary,
    categories: c.categories, searchText: c.searchText,
    emails: c.emails, phones: c.phones, addresses: c.addresses, urls: c.urls, ims: c.ims,
  };
}

const ROW_SELECT = {
  id: true, updatedAt: true, vcardData: true, displayName: true, email: true, email2: true, phone: true, mobile: true,
  company: true, department: true, jobTitle: true, notes: true,
} as const;

export interface ContactBackfillBatch {
  scanned: number;
  filled: number;
  /** Id of the last row looked at (null when the batch was empty). */
  last: string | null;
  /** True when the end of the table was reached. */
  exhausted: boolean;
}

/** One batch: rows after `after` (id order) that still need the backfill. */
export async function backfillContactBatch(after: string, limit = CONTACT_BACKFILL_BATCH): Promise<ContactBackfillBatch> {
  const rows = await prisma.contact.findMany({
    where: { searchText: '', ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' },
    take: limit,
    select: ROW_SELECT,
  });
  let filled = 0;
  for (const row of rows) {
    const data = contactBackfillData(row);
    if (!data) continue;
    // updatedAt is written back unchanged (Prisma would set @updatedAt to now);
    // the where clause skips a row another writer changed since it was read.
    const r = await prisma.contact.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt, searchText: '' },
      data: { ...data, updatedAt: row.updatedAt },
    });
    filled += r.count;
  }
  return { scanned: rows.length, filled, last: rows.at(-1)?.id ?? null, exhausted: rows.length < limit };
}

/** Minimal Redis surface (ioredis-compatible). `eval` is optional (no refresh / release without it). */
export interface ContactBackfillRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval?(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const REFRESH_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type ContactBackfillRun =
  | { status: 'done' }
  | { status: 'locked' }
  | { status: 'ran'; scanned: number; filled: number; batches: number; finished: boolean };

/**
 * One locked run: up to `maxBatches` batches, continuing after the stored
 * cursor. `done` when the backfill already finished once, `locked` when another
 * instance holds the lock.
 */
export async function runLockedContactBackfill(
  redis: ContactBackfillRedis,
  opts: { batchSize?: number; maxBatches?: number; pauseMs?: number; lockTtlMs?: number } = {},
): Promise<ContactBackfillRun> {
  if (await redis.get(CONTACT_BACKFILL_DONE_KEY)) return { status: 'done' };
  const ttl = opts.lockTtlMs ?? CONTACT_BACKFILL_LOCK_TTL_MS;
  const token = randomUUID();
  if (await redis.set(CONTACT_BACKFILL_LOCK_KEY, token, 'PX', ttl, 'NX') !== 'OK') return { status: 'locked' };
  const canEval = typeof redis.eval === 'function';
  const total = { scanned: 0, filled: 0, batches: 0, finished: false };
  try {
    let cursor = (await redis.get(CONTACT_BACKFILL_CURSOR_KEY)) ?? '';
    const maxBatches = opts.maxBatches ?? CONTACT_BACKFILL_MAX_BATCHES;
    const pauseMs = opts.pauseMs ?? CONTACT_BACKFILL_PAUSE_MS;
    for (let i = 0; i < maxBatches; i++) {
      if (i > 0) {
        if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
        if (canEval && Number(await redis.eval!(REFRESH_LOCK_SCRIPT, 1, CONTACT_BACKFILL_LOCK_KEY, token, ttl)) !== 1) break;
      }
      const b = await backfillContactBatch(cursor, opts.batchSize);
      total.batches++;
      total.scanned += b.scanned;
      total.filled += b.filled;
      if (b.last) {
        cursor = b.last;
        await redis.set(CONTACT_BACKFILL_CURSOR_KEY, cursor);
      }
      if (b.exhausted) {
        await redis.set(CONTACT_BACKFILL_DONE_KEY, new Date().toISOString());
        total.finished = true;
        break;
      }
    }
  } finally {
    if (canEval) {
      await redis.eval!(RELEASE_LOCK_SCRIPT, 1, CONTACT_BACKFILL_LOCK_KEY, token)
        .catch((err: unknown) => log.debug({ err }, 'contacts backfill: lock release failed (expires by TTL)'));
    }
  }
  return { status: 'ran', ...total };
}

/**
 * Starts the background backfill: runs until a pass reached the end of the
 * table, then stops for good. Another instance holding the lock / an error →
 * retried after `retryMs`.
 */
export function startContactBackfill(
  redis: ContactBackfillRedis,
  opts: { initialDelayMs?: number; busyIntervalMs?: number; retryMs?: number } = {},
): { stop(): void } {
  const busy = opts.busyIntervalMs ?? 1_000;
  const retry = opts.retryMs ?? CONTACT_BACKFILL_LOCK_TTL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, ms);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    try {
      const r = await runLockedContactBackfill(redis);
      if (r.status === 'done') return;
      if (r.status === 'locked') { schedule(retry); return; }
      if (r.filled > 0 || r.finished) log.info({ ...r }, 'Contacts backfill: structured columns filled');
      if (!r.finished) schedule(busy);
    } catch (err) {
      log.warn({ err }, 'Contacts backfill failed — retried later');
      schedule(retry);
    }
  };
  schedule(opts.initialDelayMs ?? 30_000);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
