/**
 * Draft version bookkeeping for the webmail drafts API (8.1).
 *
 * Every PUT /mail/drafts/:id creates a new version (new id). A client that
 * still holds an old id (a second tab, a save that raced) must be told where
 * the draft went instead of getting a bare 404 (on which the client would
 * create a duplicate). The gateway records, per user and for one day:
 *
 *   draft:state:<userId>:<oldId> = {"t":"superseded","id":<newId>,"att":{<oldAttId>:<newAttId>}}
 *                                | {"t":"sent"}            (handed to the outbound queue)
 *
 * Stored in Redis (shared by all gateway instances); when Redis is unavailable
 * an in-process map is used. Never throws.
 *
 * Test seam: `globalThis.__draftStateRedis` replaces the Redis client.
 */
import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('api:draft-state');

export const DRAFT_STATE_TTL_SEC = 24 * 60 * 60;
const MAX_HOPS = 50;
const TIMEOUT_MS = 500;

export interface DraftStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

type Entry = { t: 'superseded'; id: string; att?: Record<string, string> } | { t: 'sent' };

export type DraftState =
  | { kind: 'superseded'; currentId: string; attachmentIds: Record<string, string> }
  | { kind: 'sent' };

const local = new Map<string, { value: string; expires: number }>();

function store(): DraftStateStore {
  const seam = (globalThis as Record<string, unknown>)['__draftStateRedis'] as DraftStateStore | undefined;
  return seam ?? (getRedisClient() as unknown as DraftStateStore);
}

const keyOf = (userId: string, id: string): string => `draft:state:${userId}:${id}`;

async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('draft-state store timeout')), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function put(key: string, entry: Entry): Promise<void> {
  const value = JSON.stringify(entry);
  if (local.size > 50_000) local.clear();
  local.set(key, { value, expires: Date.now() + DRAFT_STATE_TTL_SEC * 1000 });
  try {
    await withTimeout(store().set(key, value, 'EX', DRAFT_STATE_TTL_SEC));
  } catch (err) {
    log.warn({ err }, 'Draft state not stored in Redis — in-process only');
  }
}

async function read(key: string): Promise<Entry | null> {
  let value: string | null = null;
  try {
    value = await withTimeout(store().get(key));
  } catch (err) {
    log.warn({ err }, 'Draft state lookup failed — in-process only');
  }
  if (value === null) {
    const l = local.get(key);
    value = l && l.expires > Date.now() ? l.value : null;
  }
  if (!value) return null;
  try { return JSON.parse(value) as Entry; } catch { return null; }
}

/** `oldId` was replaced by `newId`; `attachmentIds` maps the old attachment ids to the new ones. */
export async function recordDraftSuperseded(userId: string, oldId: string, newId: string, attachmentIds: Record<string, string> = {}): Promise<void> {
  await put(keyOf(userId, oldId), { t: 'superseded', id: newId, att: attachmentIds });
}

/** The draft was handed to the outbound queue: it must never be sent (or saved) again. */
export async function recordDraftSent(userId: string, id: string): Promise<void> {
  await put(keyOf(userId, id), { t: 'sent' });
}

/** Undo of a send (unsend): the draft is editable again. */
export async function clearDraftState(userId: string, id: string): Promise<void> {
  local.delete(keyOf(userId, id));
  try { await withTimeout(store().del(keyOf(userId, id))); } catch { /* expires anyway */ }
}

/**
 * Where did draft `id` go? Follows the replacement chain to the newest known
 * version (attachment id mapping composed along the way). null = unknown.
 */
export async function lookupDraftState(userId: string, id: string): Promise<DraftState | null> {
  let current = id;
  let att: Record<string, string> | null = null;
  let moved = false;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const e = await read(keyOf(userId, current));
    if (!e) break;
    if (e.t === 'sent') {
      if (!moved) return { kind: 'sent' };
      break; // the newest version is gone (sent): report the newest id we know
    }
    const step: Record<string, string> = e.att ?? {};
    if (att === null) {
      att = { ...step };
    } else {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(att)) { const n = step[v]; if (n) next[k] = n; }
      att = next;
    }
    current = e.id;
    moved = true;
  }
  return moved ? { kind: 'superseded', currentId: current, attachmentIds: att ?? {} } : null;
}

/** Tests only. */
export function resetDraftStateForTests(): void {
  local.clear();
}
