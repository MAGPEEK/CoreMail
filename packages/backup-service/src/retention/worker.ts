/**
 * Managed Folder Assistant (MFA) — Exchange 2019 style retention.
 *
 * What the MFA does per run:
 *   1. Resolve the mailboxes of every enabled policy: GLOBAL (all active users and
 *      shared mailboxes), DOMAIN (users and shared mailboxes of the domain), USER.
 *      Mailboxes without a policy are processed too when a user put a personal tag
 *      on one of their folders or items (personal tags are offered to every user).
 *   2. Tags of several policies are merged per mailbox; for the same slot (the DPT,
 *      or the RPT of one default folder) the most specific assignment wins
 *      (USER > DOMAIN > GLOBAL), then the longest retention period, then the tag id
 *      — deterministic, never "whichever policy the database returned first".
 *   3. Effective tag of an item, nearest first:
 *        personal tag on the item
 *        → personal tag on its folder, else the RPT of its folder when that is a
 *          default folder (top level: INBOX, Sent, Trash, Junk, Drafts, Outbox, Archive)
 *        → the same for the parent folder, its parent, … (subfolders inherit)
 *        → the DPT.
 *      A disabled personal tag means "not processed" (Exchange semantics).
 *   4. If `createdAt (delivery) + tag.retentionDays <= now` the tag action runs
 *      (never the sender-controlled Date header, see ./expiry.ts; a restored item
 *      gets a grace period after its restore, `Message.restoredAt`):
 *        • MOVE_TO_ARCHIVE             — move to "Archive" (items already in the
 *                                        Archive folder or below it stay where they are)
 *        • DELETE_AND_ALLOW_RECOVERY   — move to "Recoverable Items/Deletions"
 *                                        (softDeletedAt), restorable in the webmail
 *        • PERMANENTLY_DELETE          — removed (expunge + purge)
 *        • MARK_AS_PAST_RETENTION_LIMIT — sets retentionExpiresAt once (no move)
 *        • legacy MOVE_TO_FOLDER       — move to the policy's targetFolder
 *   5. Recovery sweep (all mailboxes): items in Deletions whose softDeletedAt is
 *      older than DELETED_ITEM_RETENTION_DAYS (default 30 — the same window the
 *      webmail shows for "Gelöschte Elemente wiederherstellen"; 0 = keep) are
 *      purged; anything in "Recoverable Items/Purges" is purged.
 *   6. Throttling: RETENTION_WORK_CYCLE_SEC (default 24 h) per run; the run also
 *      stops between pages when its cluster lock is lost (AbortSignal).
 *
 * Every message write goes through the message store (moveMessages, touchMessages,
 * expunge — atomic UID/modSeq, realtime publish after commit); rows are removed
 * only through storage purgeRecoverableItems() (ActiveSync item state, objects).
 *
 * Legacy: a policy without tags (pre-v3.11) is treated like one tag: scope
 * ALL_ITEMS → DPT, INBOX / SENT_ITEMS / DELETED_ITEMS / JUNK → RPT of that folder.
 */

import { prisma } from '@coremail/storage/prisma';
import {
  moveMessages, touchMessages, expunge, purgeRecoverableItems, refreshFolderCounters,
  deletedItemRetentionDays, folderParents, folderPath, announceFolderListChange,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { retentionDecision } from './expiry.js';

const log = createLogger('retention:mfa');

const RECOVERABLE_ROOT      = 'Recoverable Items';
const RECOVERABLE_DELETIONS = 'Recoverable Items/Deletions';
const RECOVERABLE_PURGES    = 'Recoverable Items/Purges';
const ARCHIVE_NAME          = 'Archive';
const DAY_MS                = 86_400_000;
/** Messages read per page of a folder. */
const PAGE_SIZE             = 2000;
/** Messages written per transaction. */
const BATCH_SIZE            = 500;

export interface RetentionRunResult {
  runId:              string;
  policiesProcessed:  number;
  mailboxesScanned:   number;
  itemsScanned:       number;
  itemsArchived:      number;
  itemsSoftDeleted:   number;
  /** Rows removed from the database in this run (permanent deletion + expired recoverable items). */
  itemsHardDeleted:   number;
  itemsMarked:        number;
  throttled:          boolean;
  errors:             string[];
}

// ── Tags (pure) ──────────────────────────────────────────────────────────────

export type TagType = 'DPT' | 'RPT' | 'PERSONAL';
export type TagAction =
  | 'MOVE_TO_ARCHIVE' | 'DELETE_AND_ALLOW_RECOVERY' | 'PERMANENTLY_DELETE' | 'MARK_AS_PAST_RETENTION_LIMIT'
  | 'MOVE_TO_FOLDER'; // legacy policies only

export interface EffectiveTag {
  id: string;
  name: string;
  type: TagType;
  action: TagAction;
  retentionDays: number;
  enabled: boolean;
  folderTarget: string | null;
  /** Legacy MOVE_TO_FOLDER: name of the target folder. */
  targetFolder?: string | null;
}

interface TagRow {
  id: string; name: string; type: string; action: string; retentionDays: number;
  folderTarget: string | null; enabled: boolean;
}

export interface PolicyRow {
  id: string;
  name: string;
  retentionDays: number;
  action: string;
  targetFolder: string | null;
  scope: string;
  assignments: Array<{ target: string; targetId: string }>;
  policyTags: Array<{ tag: TagRow }>;
}

/** Specificity of an assignment: USER overrides DOMAIN, DOMAIN overrides GLOBAL. */
export const ASSIGNMENT_RANK: Record<string, number> = { GLOBAL: 0, DOMAIN: 1, USER: 2 };

function toTag(t: TagRow): EffectiveTag {
  return {
    id: t.id, name: t.name, type: t.type as TagType, action: t.action as TagAction,
    retentionDays: t.retentionDays, enabled: t.enabled, folderTarget: t.folderTarget,
  };
}

const LEGACY_SCOPE_TARGET: Record<string, string | null> = {
  ALL_ITEMS: null, INBOX: 'INBOX', SENT_ITEMS: 'SENT_ITEMS', DELETED_ITEMS: 'DELETED_ITEMS', JUNK: 'JUNK_EMAIL',
};

/**
 * Pure: the synthetic tag of a legacy policy (no tags, retentionDays > 0), or
 * null. The legacy scope is kept: a "Junk, 14 days" policy must never act on
 * the whole mailbox.
 */
export function legacyTag(p: Pick<PolicyRow, 'id' | 'name' | 'retentionDays' | 'action' | 'targetFolder' | 'scope' | 'policyTags'>): EffectiveTag | null {
  if (p.policyTags.length > 0 || !(p.retentionDays > 0)) return null;
  if (!(p.scope in LEGACY_SCOPE_TARGET)) return null;
  const target = LEGACY_SCOPE_TARGET[p.scope] ?? null;
  let action: TagAction;
  if (p.action === 'ARCHIVE') action = 'MOVE_TO_ARCHIVE';
  else if (p.action === 'DELETE') action = 'PERMANENTLY_DELETE';
  else if (p.action === 'MOVE_TO_FOLDER' && p.targetFolder) action = 'MOVE_TO_FOLDER';
  else return null;
  return {
    id: `legacy:${p.id}`, name: `legacy:${p.name}`,
    type: target ? 'RPT' : 'DPT', action, retentionDays: p.retentionDays, enabled: true,
    folderTarget: target ?? 'ALL_OTHER',
    ...(action === 'MOVE_TO_FOLDER' ? { targetFolder: p.targetFolder } : {}),
  };
}

/** Pure: the DPT / RPT tags a policy contributes (enabled ones; personal tags apply from folders and items). */
export function policyTagsOf(p: PolicyRow): EffectiveTag[] {
  const legacy = legacyTag(p);
  if (legacy) return [legacy];
  return p.policyTags
    .map((pt) => toTag(pt.tag))
    .filter((t) => t.enabled && (t.type === 'DPT' || (t.type === 'RPT' && t.folderTarget !== null && t.folderTarget !== 'ALL_OTHER')));
}

export interface MergedTags {
  dpt: EffectiveTag | null;
  /** RPT per folder target (INBOX, SENT_ITEMS, …). */
  rpt: Map<string, EffectiveTag>;
}

/**
 * Pure: merges the tags of every policy that applies to a mailbox. Per slot (the
 * DPT, or the RPT of one folder target) the tag of the most specific assignment
 * wins, then the longest retention period (the safer choice), then the smaller id.
 */
export function mergePolicyTags(entries: ReadonlyArray<{ rank: number; tags: readonly EffectiveTag[] }>): MergedTags {
  const best = new Map<string, { rank: number; tag: EffectiveTag }>();
  const wins = (a: { rank: number; tag: EffectiveTag }, b: { rank: number; tag: EffectiveTag }): boolean =>
    a.rank !== b.rank ? a.rank > b.rank
      : a.tag.retentionDays !== b.tag.retentionDays ? a.tag.retentionDays > b.tag.retentionDays
        : a.tag.id < b.tag.id;
  for (const e of entries) {
    for (const tag of e.tags) {
      const slot = tag.type === 'DPT' ? 'DPT' : tag.type === 'RPT' && tag.folderTarget ? `RPT:${tag.folderTarget}` : null;
      if (!slot) continue;
      const cand = { rank: e.rank, tag };
      const cur = best.get(slot);
      if (!cur || wins(cand, cur)) best.set(slot, cand);
    }
  }
  const rpt = new Map<string, EffectiveTag>();
  for (const [slot, v] of best) if (slot.startsWith('RPT:')) rpt.set(slot.slice(4), v.tag);
  return { dpt: best.get('DPT')?.tag ?? null, rpt };
}

/** Pure: the default-folder target of a TOP-LEVEL folder name (subfolders inherit instead). */
export function defaultFolderTarget(name: string): string | null {
  const n = name.toLowerCase();
  if (n === 'inbox') return 'INBOX';
  if (n === 'sent' || n === 'sent items') return 'SENT_ITEMS';
  if (n === 'trash' || n === 'deleted items') return 'DELETED_ITEMS';
  if (n === 'junk' || n === 'junk e-mail' || n === 'spam') return 'JUNK_EMAIL';
  if (n === 'drafts') return 'DRAFTS';
  if (n === 'outbox') return 'OUTBOX';
  if (n === 'archive') return 'ARCHIVE';
  return null;
}

export interface FolderNode {
  id: string;
  name: string;
  displayName: string;
  parentId: string | null;
  retentionTagId: string | null;
}

export interface FolderRule {
  /** Recoverable Items (and below): never processed by the tag pass. */
  skip: boolean;
  /** Tag of the folder's items without an own personal tag (null = none). */
  tag: EffectiveTag | null;
  /** The folder and its ancestors, nearest first. */
  path: string[];
}

/** Pure: the effective folder tag of every folder of a mailbox (inheritance, see module doc). */
export function folderRules(
  folders: readonly FolderNode[],
  tagsById: ReadonlyMap<string, EffectiveTag>,
  merged: MergedTags,
): Map<string, FolderRule> {
  const parents = folderParents(folders);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, FolderRule>();
  for (const f of folders) {
    const path = folderPath(f.id, parents);
    if (path.some((id) => byId.get(id)?.name.startsWith(RECOVERABLE_ROOT))) {
      out.set(f.id, { skip: true, tag: null, path });
      continue;
    }
    let tag: EffectiveTag | null | undefined;
    for (const id of path) {
      const node = byId.get(id);
      if (!node) break;
      const personal = node.retentionTagId ? tagsById.get(node.retentionTagId) : undefined;
      if (personal && personal.type === 'PERSONAL') { tag = personal; break; }
      if (!parents.get(id)) {
        const target = defaultFolderTarget(node.name);
        const rpt = target ? merged.rpt.get(target) : undefined;
        if (rpt) { tag = rpt; break; }
      }
    }
    out.set(f.id, { skip: false, tag: tag === undefined ? merged.dpt : tag, path });
  }
  return out;
}

/** Pure: the tag that decides about one item (its own personal tag first). */
export function itemTag(itemTagId: string | null, rule: FolderRule, tagsById: ReadonlyMap<string, EffectiveTag>): EffectiveTag | null {
  const own = itemTagId ? tagsById.get(itemTagId) : undefined;
  // Only PERSONAL tags count on an item — runs before 10.2 wrote DPT/RPT ids there (MARK).
  if (own && own.type === 'PERSONAL') return own;
  return rule.tag;
}

// ── Public Entry ─────────────────────────────────────────────────────────────

export async function runRetentionPolicies(signal?: AbortSignal): Promise<RetentionRunResult> {
  const dryRun = process.env['RETENTION_DRY_RUN'] === 'true';
  const workCycleSec = positiveInt(process.env['RETENTION_WORK_CYCLE_SEC'], 86_400);
  const deletionsDays = deletedItemRetentionDays();
  const run = await prisma.managedFolderRun.create({
    data: { workCycleSeconds: workCycleSec, startedAt: new Date() },
  });
  const startMs = Date.now();
  const result: RetentionRunResult = {
    runId: run.id,
    policiesProcessed: 0, mailboxesScanned: 0, itemsScanned: 0,
    itemsArchived: 0, itemsSoftDeleted: 0, itemsHardDeleted: 0, itemsMarked: 0,
    throttled: false, errors: [],
  };
  const ctx: RunContext = { dryRun, deadlineMs: startMs + workCycleSec * 1000, result, ...(signal ? { signal } : {}) };

  log.info({ dryRun, workCycleSec, deletionsDays }, 'MFA run started');

  try {
    const policies = await prisma.retentionPolicy.findMany({
      where: { enabled: true },
      include: { assignments: true, policyTags: { include: { tag: true } } },
    }) as unknown as PolicyRow[];
    const tagsById = new Map((await prisma.retentionTag.findMany({
      select: { id: true, name: true, type: true, action: true, retentionDays: true, folderTarget: true, enabled: true },
    })).map((t) => [t.id, toTag(t as TagRow)]));

    const perMailbox = await resolvePoliciesPerMailbox(policies, tagsById);
    result.policiesProcessed = policies.length;

    for (const [mailboxId, applicable] of perMailbox) {
      if (stopped(ctx)) break;
      try {
        const merged = mergePolicyTags(applicable.map((a) => ({ rank: a.rank, tags: policyTagsOf(a.policy) })));
        await applyForMailbox(mailboxId, merged, tagsById, ctx);
        result.mailboxesScanned += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ mailboxId, err }, 'Mailbox run failed');
        result.errors.push(`Mailbox ${mailboxId}: ${msg}`);
      }
    }

    if (!stopped(ctx)) await sweepRecoverableItems(deletionsDays, ctx);
  } catch (err) {
    log.error({ err }, 'MFA run aborted with error');
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  await prisma.managedFolderRun.update({
    where: { id: run.id },
    data: {
      completedAt:      new Date(),
      mailboxesScanned: result.mailboxesScanned,
      itemsScanned:     result.itemsScanned,
      itemsArchived:    result.itemsArchived,
      itemsSoftDeleted: result.itemsSoftDeleted,
      itemsHardDeleted: result.itemsHardDeleted,
      throttled:        result.throttled,
      ...(result.errors.length > 0 ? { errorMessage: result.errors.join('; ').slice(0, 4000) } : {}),
    },
  });

  log.info(result, 'MFA run finished');
  return result;
}

interface RunContext {
  dryRun: boolean;
  deadlineMs: number;
  signal?: AbortSignal;
  result: RetentionRunResult;
}

/** True (and the run marked throttled / failed) when the work cycle is over or the lock was lost. */
function stopped(ctx: RunContext): boolean {
  if (ctx.signal?.aborted) {
    if (!ctx.result.errors.includes('run lock lost — stopped')) ctx.result.errors.push('run lock lost — stopped');
    return true;
  }
  if (Date.now() > ctx.deadlineMs) { ctx.result.throttled = true; return true; }
  return false;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ── Resolve policies per mailbox ─────────────────────────────────────────────

interface Applicable { policy: PolicyRow; rank: number }

async function resolvePoliciesPerMailbox(
  policies: PolicyRow[],
  tagsById: ReadonlyMap<string, EffectiveTag>,
): Promise<Map<string, Applicable[]>> {
  const byMailbox = new Map<string, Map<string, Applicable>>();
  const add = (mailboxId: string | null | undefined, policy: PolicyRow, rank: number): void => {
    if (!mailboxId) return;
    const list = byMailbox.get(mailboxId) ?? new Map<string, Applicable>();
    const cur = list.get(policy.id);
    if (!cur || rank > cur.rank) list.set(policy.id, { policy, rank });
    byMailbox.set(mailboxId, list);
  };
  type Owner = { mailbox: { id: string } | null };
  let globalOwners: Owner[] | null = null;

  for (const policy of policies) {
    for (const a of policy.assignments) {
      const rank = ASSIGNMENT_RANK[a.target];
      if (rank === undefined) continue;
      if (a.target === 'GLOBAL') {
        globalOwners ??= [
          ...await prisma.user.findMany({ where: { active: true }, select: { id: true, mailbox: { select: { id: true } } } }),
          ...await prisma.sharedMailbox.findMany({ where: { active: true }, select: { id: true, mailbox: { select: { id: true } } } }),
        ];
        for (const o of globalOwners) add(o.mailbox?.id, policy, rank);
      } else if (a.target === 'DOMAIN' && a.targetId) {
        const dom = await prisma.domain.findUnique({ where: { name: a.targetId }, select: { id: true } });
        if (!dom) continue;
        const owners: Owner[] = [
          ...await prisma.user.findMany({ where: { domainId: dom.id }, select: { id: true, mailbox: { select: { id: true } } } }),
          ...await prisma.sharedMailbox.findMany({ where: { domainId: dom.id }, select: { id: true, mailbox: { select: { id: true } } } }),
        ];
        for (const o of owners) add(o.mailbox?.id, policy, rank);
      } else if (a.target === 'USER' && a.targetId) {
        const u = await prisma.user.findUnique({ where: { id: a.targetId }, select: { id: true, mailbox: { select: { id: true } } } });
        add(u?.mailbox?.id, policy, rank);
      }
    }
  }

  // Personal tags are offered to every user — a mailbox without a policy whose
  // owner tagged a folder or an item is processed for those tags.
  const personalIds = [...tagsById.values()].filter((t) => t.type === 'PERSONAL').map((t) => t.id);
  const out = new Map<string, Applicable[]>();
  for (const [mailboxId, list] of byMailbox) out.set(mailboxId, [...list.values()]);
  if (personalIds.length > 0) {
    const tagged = new Set<string>();
    for (const f of await prisma.folder.findMany({ where: { retentionTagId: { in: personalIds } }, select: { mailboxId: true } })) {
      tagged.add(f.mailboxId);
    }
    for (const m of await prisma.message.findMany({
      where: { retentionTagId: { in: personalIds }, deletedAt: null },
      select: { folder: { select: { mailboxId: true } } },
      distinct: ['folderId'],
    })) tagged.add(m.folder.mailboxId);
    for (const mailboxId of tagged) if (!out.has(mailboxId)) out.set(mailboxId, []);
  }
  return out;
}

// ── Per-mailbox application ──────────────────────────────────────────────────

type Bucket = 'archive' | 'softDelete' | 'hardDelete' | `folder:${string}`;

async function applyForMailbox(
  mailboxId: string,
  merged: MergedTags,
  tagsById: ReadonlyMap<string, EffectiveTag>,
  ctx: RunContext,
): Promise<void> {
  const folders: FolderNode[] = await prisma.folder.findMany({
    where: { mailboxId },
    select: { id: true, name: true, displayName: true, parentId: true, retentionTagId: true },
  });
  const rules = folderRules(folders, tagsById, merged);
  const archive = folders.find((f) => f.name === ARCHIVE_NAME) ?? folders.find((f) => f.displayName === 'Archiv') ?? null;
  const byName = (name: string) => folders.find((f) => f.name === name) ?? folders.find((f) => f.displayName === name) ?? null;
  const anyPersonal = [...tagsById.values()].some((t) => t.type === 'PERSONAL');
  const touched = new Set<string>();
  let foldersCreated = false;
  let deletionsId: string | null = folders.find((f) => f.name === RECOVERABLE_DELETIONS)?.id ?? null;

  const deletionsFolder = async (): Promise<string> => {
    if (deletionsId) return deletionsId;
    const rootId = await ensureFolder(mailboxId, folders, RECOVERABLE_ROOT, 'Recoverable Items', null);
    deletionsId = await ensureFolder(mailboxId, folders, RECOVERABLE_DELETIONS, 'Deletions', rootId);
    foldersCreated = true;
    return deletionsId;
  };

  try {
    for (const folder of folders) {
      const rule = rules.get(folder.id);
      if (!rule || rule.skip) continue;
      // No folder tag and no personal tag that an item could carry: nothing to do here.
      if (!rule.tag && !anyPersonal) continue;
      let cursor: string | undefined;
      for (;;) {
        if (stopped(ctx)) return;
        const page = await prisma.message.findMany({
          where: { folderId: folder.id, deletedAt: null, softDeletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, createdAt: true, restoredAt: true, retentionTagId: true, retentionExpiresAt: true },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
        });
        if (page.length === 0) break;
        cursor = page[page.length - 1]!.id;
        ctx.result.itemsScanned += page.length;

        const buckets = new Map<Bucket, string[]>();
        const marks: Array<{ id: string; expiresAt: Date }> = [];
        const now = new Date();
        for (const m of page) {
          const tag = itemTag(m.retentionTagId, rule, tagsById);
          if (!tag || !tag.enabled) continue;
          const { expired, expiresAt } = retentionDecision(m.createdAt, tag, now, m.restoredAt);
          if (!expired || !expiresAt) continue;
          let bucket: Bucket | null = null;
          switch (tag.action) {
            case 'MOVE_TO_ARCHIVE':
              // Items in the Archive folder (or below it) are archived already.
              if (archive && !rule.path.includes(archive.id)) bucket = 'archive';
              break;
            case 'MOVE_TO_FOLDER': {
              const target = tag.targetFolder ? byName(tag.targetFolder) : null;
              if (target && !rule.path.includes(target.id) && !target.name.startsWith(RECOVERABLE_ROOT)) bucket = `folder:${target.id}`;
              break;
            }
            case 'DELETE_AND_ALLOW_RECOVERY': bucket = 'softDelete'; break;
            case 'PERMANENTLY_DELETE': bucket = 'hardDelete'; break;
            case 'MARK_AS_PAST_RETENTION_LIMIT':
              if (m.retentionExpiresAt?.getTime() !== expiresAt.getTime()) marks.push({ id: m.id, expiresAt });
              break;
          }
          if (bucket) buckets.set(bucket, [...(buckets.get(bucket) ?? []), m.id]);
        }

        for (const [bucket, ids] of buckets) {
          for (const chunk of chunks(ids, BATCH_SIZE)) {
            if (bucket === 'hardDelete') {
              if (ctx.dryRun) { ctx.result.itemsHardDeleted += chunk.length; continue; }
              ctx.result.itemsHardDeleted += await hardDelete(mailboxId, chunk);
            } else if (bucket === 'softDelete') {
              if (!ctx.dryRun) {
                const target = await deletionsFolder();
                await prisma.$transaction((tx) => moveMessages(tx, chunk, target, {
                  targetMailboxId: mailboxId, sourceMailboxId: mailboxId, data: { softDeletedAt: new Date() },
                }));
                touched.add(target);
              }
              ctx.result.itemsSoftDeleted += chunk.length;
            } else {
              const target = bucket === 'archive' ? archive!.id : bucket.slice('folder:'.length);
              if (!ctx.dryRun) {
                await prisma.$transaction((tx) => moveMessages(tx, chunk, target, { targetMailboxId: mailboxId, sourceMailboxId: mailboxId }));
                touched.add(target);
              }
              ctx.result.itemsArchived += chunk.length;
            }
            if (!ctx.dryRun) touched.add(folder.id);
          }
        }
        for (const part of chunks(marks, BATCH_SIZE)) {
          if (!ctx.dryRun) {
            await prisma.$transaction(async (tx) => {
              for (const { id, expiresAt } of part) await touchMessages(tx, [id], { retentionExpiresAt: expiresAt }, { mailboxId });
            });
          }
          ctx.result.itemsMarked += part.length;
        }
        if (page.length < PAGE_SIZE) break;
      }
    }
  } finally {
    if (touched.size > 0) await refreshFolderCounters(touched);
    if (foldersCreated) announceFolderListChange(mailboxId);
  }
}

/** Removes live rows for good: expunge (message store: modSeq, realtime), then purge (rows, item state, objects). */
async function hardDelete(mailboxId: string, ids: string[]): Promise<number> {
  await prisma.$transaction((tx) => expunge(tx, ids, { mailboxId }));
  return purgeRecoverableItems(mailboxId, ids);
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── Recovery sweep ───────────────────────────────────────────────────────────

async function sweepRecoverableItems(deletionsDays: number, ctx: RunContext): Promise<void> {
  // 1. Deletions: softDeletedAt older than the deleted-item retention → removed.
  //    0 days = kept until purged by hand (like DELETED_ITEM_RETENTION_DAYS=0 for tombstones).
  if (deletionsDays > 0) {
    const cutoff = new Date(Date.now() - deletionsDays * DAY_MS);
    const deletionFolders = await prisma.folder.findMany({ where: { name: RECOVERABLE_DELETIONS }, select: { id: true, mailboxId: true } });
    for (const df of deletionFolders) {
      if (stopped(ctx)) return;
      try {
        await purgeFolder(df, { softDeletedAt: { lt: cutoff } }, ctx);
      } catch (err) {
        log.error({ err, mailboxId: df.mailboxId }, 'Recoverable items sweep failed');
        ctx.result.errors.push(`Mailbox ${df.mailboxId}: sweep: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // 2. Purges (filled by runs before 10.2, or by a client): removed.
  const purgeFolders = await prisma.folder.findMany({ where: { name: RECOVERABLE_PURGES }, select: { id: true, mailboxId: true } });
  for (const pf of purgeFolders) {
    if (stopped(ctx)) return;
    try {
      await purgeFolder(pf, {}, ctx);
    } catch (err) {
      log.error({ err, mailboxId: pf.mailboxId }, 'Purges sweep failed');
      ctx.result.errors.push(`Mailbox ${pf.mailboxId}: purge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function purgeFolder(f: { id: string; mailboxId: string }, where: { softDeletedAt?: { lt: Date } }, ctx: RunContext): Promise<void> {
  for (;;) {
    const ids = (await prisma.message.findMany({
      where: { folderId: f.id, deletedAt: null, ...where },
      select: { id: true },
      take: BATCH_SIZE,
    })).map((m) => m.id);
    if (ids.length === 0) return;
    if (ctx.dryRun) { ctx.result.itemsHardDeleted += ids.length; return; }
    ctx.result.itemsHardDeleted += await hardDelete(f.mailboxId, ids);
    if (ids.length < BATCH_SIZE || stopped(ctx)) return;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The folder `name` of the mailbox — created (hidden for IMAP subscriptions) when missing. */
async function ensureFolder(mailboxId: string, folders: FolderNode[], name: string, displayName: string, parentId: string | null): Promise<string> {
  const found = folders.find((f) => f.name === name);
  if (found) return found.id;
  let created: FolderNode;
  try {
    created = await prisma.folder.create({
      data: { mailboxId, name, displayName, ...(parentId ? { parentId } : {}), subscribed: false },
      select: { id: true, name: true, displayName: true, parentId: true, retentionTagId: true },
    });
  } catch (err) {
    // Created meanwhile (unique mailboxId + name): use that one.
    const existing = await prisma.folder.findFirst({
      where: { mailboxId, name },
      select: { id: true, name: true, displayName: true, parentId: true, retentionTagId: true },
    });
    if (!existing) throw err;
    created = existing;
  }
  folders.push(created);
  return created.id;
}
