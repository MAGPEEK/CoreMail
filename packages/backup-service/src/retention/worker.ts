/**
 * Managed Folder Assistant (MFA) — Exchange-2019-konform.
 *
 * Was der MFA pro Run tut:
 *   1. Für jede aktive Policy: bestimme betroffene Postfächer (GLOBAL/DOMAIN/USER).
 *   2. Für jedes Postfach: stelle sicher, dass die Recoverable-Items-Subordner
 *      (Recoverable Items, Recoverable Items/Deletions, /Purges) existieren.
 *   3. Für jede Mail im Postfach: berechne den effektiven Tag nach Hierarchie
 *        Personal (auf Item) → Personal (auf Folder) → RPT (für Ordner) → DPT (Policy)
 *   4. Wenn `date + tag.retentionDays < now` → führe Tag-Aktion aus:
 *        • MOVE_TO_ARCHIVE             — verschieben in "Archive"
 *        • DELETE_AND_ALLOW_RECOVERY   — verschieben in Recoverable Items/Deletions (Soft Delete, 14 Tage)
 *        • PERMANENTLY_DELETE          — verschieben in Recoverable Items/Purges
 *        • MARK_AS_PAST_RETENTION_LIMIT — nur Kennzeichnung
 *   5. Recovery-Sweep:
 *        • Items in /Deletions älter 14 Tage → /Purges
 *        • Items in /Purges + kein Legal Hold → DB-Delete (Speicherplatz frei)
 *   6. Throttling: WORK_CYCLE_SECONDS (default 24h, einstellbar via Env).
 *      Wenn überschritten, wird das Run-Limit gesetzt und der Run beendet.
 *
 * Legacy: wenn eine Policy noch ohne Tags ist (alte v3.10.0-Policies), wird die
 * alte `retentionDays/action/scope`-Logik einmalig wie ein synthetischer DPT
 * behandelt, damit nichts an Wirkung verloren geht.
 */

import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';

const log = createLogger('retention:mfa');

const DRY_RUN          = process.env['RETENTION_DRY_RUN'] === 'true';
const WORK_CYCLE_SEC   = parseInt(process.env['RETENTION_WORK_CYCLE_SEC'] ?? '86400', 10); // 24h
const DELETIONS_TTL_D  = parseInt(process.env['RETENTION_DELETIONS_TTL_DAYS'] ?? '14', 10);

const RECOVERABLE_ROOT      = 'Recoverable Items';
const RECOVERABLE_DELETIONS = 'Recoverable Items/Deletions';
const RECOVERABLE_PURGES    = 'Recoverable Items/Purges';
const ARCHIVE_NAME          = 'Archive';

export interface RetentionRunResult {
  runId:              string;
  policiesProcessed:  number;
  mailboxesScanned:   number;
  itemsScanned:       number;
  itemsArchived:      number;
  itemsSoftDeleted:   number;
  itemsHardDeleted:   number;
  itemsSkippedHold:   number;
  throttled:          boolean;
  errors:             string[];
}

// ── Public Entry ─────────────────────────────────────────────────────────────

export async function runRetentionPolicies(): Promise<RetentionRunResult> {
  const run = await prisma.managedFolderRun.create({
    data: { workCycleSeconds: WORK_CYCLE_SEC, startedAt: new Date() },
  });
  const startMs = Date.now();
  const result: RetentionRunResult = {
    runId: run.id,
    policiesProcessed: 0, mailboxesScanned: 0, itemsScanned: 0,
    itemsArchived: 0, itemsSoftDeleted: 0, itemsHardDeleted: 0,
    itemsSkippedHold: 0, throttled: false, errors: [],
  };

  const deadlineMs = startMs + WORK_CYCLE_SEC * 1000;
  log.info({ dryRun: DRY_RUN, workCycleSec: WORK_CYCLE_SEC, deletionsTtlDays: DELETIONS_TTL_D }, 'MFA Run gestartet');

  try {
    // ── Schritt 1: Policies mit Tag-Bindung ───────────────────────────────────
    const policies = await prisma.retentionPolicy.findMany({
      where: { enabled: true },
      include: { assignments: true, policyTags: { include: { tag: true } } },
    });

    const legalHolds = await prisma.legalHold.findMany({ where: { active: true } });
    const heldUserIds = new Set(legalHolds.flatMap((h) => h.mailboxIds));

    // ── Schritt 2: Mailbox → Policies-Mapping aus den Assignments ────────────
    // Hier reduzieren wir Policies-pro-User auf das, was wirklich angewendet wird.
    const userPolicies = await resolvePoliciesPerUser(policies);

    for (const [userId, applicablePolicies] of userPolicies.entries()) {
      if (Date.now() > deadlineMs) { result.throttled = true; break; }

      try {
        await applyForMailbox(userId, applicablePolicies, heldUserIds, result, deadlineMs);
        result.mailboxesScanned += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ userId, err }, 'Mailbox-Run fehlgeschlagen');
        result.errors.push(`User ${userId}: ${msg}`);
      }
    }
    result.policiesProcessed = policies.length;

    // ── Schritt 3: Recovery-Sweep (Deletions → Purges → Delete) ──────────────
    if (Date.now() <= deadlineMs) {
      const sweep = await sweepRecoverableItems(heldUserIds);
      result.itemsHardDeleted += sweep.purged;
    } else {
      result.throttled = true;
    }
  } catch (err) {
    log.error({ err }, 'MFA-Run abgebrochen mit Fehler');
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
      itemsSkippedHold: result.itemsSkippedHold,
      throttled:        result.throttled,
      ...(result.errors.length > 0 ? { errorMessage: result.errors.join('; ').slice(0, 4000) } : {}),
    },
  });

  log.info(result, 'MFA Run beendet');
  return result;
}

// ── Policies pro User auflösen ───────────────────────────────────────────────

type PolicyWithTags = Awaited<ReturnType<typeof prisma.retentionPolicy.findMany<{
  include: { assignments: true; policyTags: { include: { tag: true } } };
}>>>[number];

async function resolvePoliciesPerUser(policies: PolicyWithTags[]): Promise<Map<string, PolicyWithTags[]>> {
  const result = new Map<string, PolicyWithTags[]>();

  for (const policy of policies) {
    const userIds = new Set<string>();
    for (const a of policy.assignments) {
      if (a.target === 'GLOBAL') {
        const all = await prisma.user.findMany({ where: { active: true }, select: { id: true } });
        all.forEach((u) => userIds.add(u.id));
      } else if (a.target === 'DOMAIN' && a.targetId) {
        const dom = await prisma.domain.findUnique({ where: { name: a.targetId }, include: { users: { select: { id: true } } } });
        dom?.users.forEach((u) => userIds.add(u.id));
      } else if (a.target === 'USER' && a.targetId) {
        userIds.add(a.targetId);
      }
    }
    for (const userId of userIds) {
      const list = result.get(userId) ?? [];
      list.push(policy);
      result.set(userId, list);
    }
  }
  return result;
}

// ── Pro-Mailbox-Anwendung ────────────────────────────────────────────────────

async function applyForMailbox(
  userId: string,
  policies: PolicyWithTags[],
  heldUserIds: Set<string>,
  result: RetentionRunResult,
  deadlineMs: number,
): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({
    where: { userId },
    include: { folders: { select: { id: true, name: true, displayName: true, retentionTagId: true } } },
  });
  if (!mailbox) return;

  // Recoverable-Items-Struktur sicherstellen
  const recovery = await ensureRecoverableItems(mailbox.id, mailbox.folders);
  // Folder-Map nach Refresh
  const folders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: { id: true, name: true, displayName: true, retentionTagId: true },
  });

  // Effektive Tags pro Policy nach Hierarchie zusammensammeln
  // Für die Auswertung pro Message brauchen wir:
  //   - DPT (max 1 pro Policy)
  //   - RPT pro folderTarget
  // Personal-Tags kommen aus Message.retentionTagId und Folder.retentionTagId direkt.
  const dpts: PolicyWithTags['policyTags'][number]['tag'][] = [];
  const rptByTarget = new Map<string, PolicyWithTags['policyTags'][number]['tag']>();
  for (const p of policies) {
    for (const pt of p.policyTags) {
      if (!pt.tag.enabled) continue;
      if (pt.tag.type === 'DPT') dpts.push(pt.tag);
      else if (pt.tag.type === 'RPT' && pt.tag.folderTarget) rptByTarget.set(pt.tag.folderTarget, pt.tag);
    }
  }

  // Legacy: Policies ohne Tags → synthetischer DPT, damit alte Policies weiter wirken
  for (const p of policies) {
    if (p.policyTags.length === 0 && p.retentionDays > 0) {
      dpts.push({
        id: `legacy:${p.id}`, name: `legacy:${p.name}`, description: '',
        type: 'DPT' as const,
        action: legacyToTagAction(p.action),
        retentionDays: p.retentionDays,
        folderTarget: null,
        enabled: true, isSystem: true,
        createdBy: '', createdAt: new Date(), updatedAt: new Date(),
      });
    }
  }

  // Schleife über Postfach-Ordner (außer Recoverable Items selbst)
  const skipFolderIds = new Set([recovery.rootId, recovery.deletionsId, recovery.purgesId]);
  for (const folder of folders) {
    if (skipFolderIds.has(folder.id)) continue;
    if (Date.now() > deadlineMs) { result.throttled = true; return; }

    // Bestimme den auf den Ordner passenden RPT-Tag
    const folderTarget   = mapFolderNameToTarget(folder.name);
    const rpt            = folderTarget ? rptByTarget.get(folderTarget) ?? null : null;
    const folderPersonalTag = folder.retentionTagId
      ? await prisma.retentionTag.findUnique({ where: { id: folder.retentionTagId } })
      : null;

    // Hole alle nicht-soft-gelöschten Items in diesem Ordner
    const messages = await prisma.message.findMany({
      where: { folderId: folder.id, deletedAt: null, softDeletedAt: null },
      select: { id: true, date: true, retentionTagId: true, rawSize: true },
    });
    result.itemsScanned += messages.length;

    for (const m of messages) {
      // Hierarchie: Personal-on-Item → Personal-on-Folder → RPT → DPT[0]
      const personalTag = m.retentionTagId
        ? await prisma.retentionTag.findUnique({ where: { id: m.retentionTagId } })
        : null;
      const effective = personalTag ?? folderPersonalTag ?? rpt ?? dpts[0] ?? null;
      if (!effective || !effective.enabled) continue;

      const expiresAt = new Date(m.date.getTime() + effective.retentionDays * 86400_000);
      if (expiresAt > new Date()) continue; // noch nicht abgelaufen

      const isHeld = heldUserIds.has(userId);

      if (effective.action === 'PERMANENTLY_DELETE') {
        if (isHeld) { result.itemsSkippedHold += 1; continue; }
        if (!DRY_RUN) await moveMessage(m.id, recovery.purgesId);
        result.itemsHardDeleted += 1;
      } else if (effective.action === 'DELETE_AND_ALLOW_RECOVERY') {
        if (isHeld) { result.itemsSkippedHold += 1; continue; }
        if (!DRY_RUN) {
          await prisma.message.update({
            where: { id: m.id },
            data: { folderId: recovery.deletionsId, softDeletedAt: new Date() },
          });
        }
        result.itemsSoftDeleted += 1;
      } else if (effective.action === 'MOVE_TO_ARCHIVE') {
        const archiveFolder = folders.find((f) => f.name === ARCHIVE_NAME || f.displayName === 'Archiv');
        if (archiveFolder) {
          if (!DRY_RUN) await moveMessage(m.id, archiveFolder.id);
          result.itemsArchived += 1;
        }
      } else if (effective.action === 'MARK_AS_PAST_RETENTION_LIMIT') {
        if (!DRY_RUN) {
          await prisma.message.update({
            where: { id: m.id },
            data: { retentionTagId: effective.id.startsWith('legacy:') ? null : effective.id, retentionExpiresAt: expiresAt },
          });
        }
      }
    }
  }
}

async function moveMessage(messageId: string, targetFolderId: string): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { folderId: targetFolderId },
  });
}

// ── Recovery-Sweep ───────────────────────────────────────────────────────────

async function sweepRecoverableItems(heldUserIds: Set<string>): Promise<{ purged: number }> {
  const cutoff = new Date(Date.now() - DELETIONS_TTL_D * 86400_000);

  // 1. Deletions älter als TTL → Purges
  const deletionFolders = await prisma.folder.findMany({
    where: { name: RECOVERABLE_DELETIONS },
    include: { mailbox: { select: { userId: true } } },
  });
  for (const df of deletionFolders) {
    const purgeFolder = await prisma.folder.findFirst({ where: { mailboxId: df.mailboxId, name: RECOVERABLE_PURGES } });
    if (!purgeFolder) continue;
    await prisma.message.updateMany({
      where: { folderId: df.id, softDeletedAt: { lt: cutoff } },
      data:  { folderId: purgeFolder.id },
    });
  }

  // 2. Purges + kein Hold → DB-Delete + Quota-Freigabe
  let purged = 0;
  const purgeFolders = await prisma.folder.findMany({
    where: { name: RECOVERABLE_PURGES },
    include: { mailbox: { select: { userId: true } } },
  });
  for (const pf of purgeFolders) {
    const ownerId = pf.mailbox.userId;
    if (!ownerId) continue; // Shared- oder Resource-Mailbox — Quota wird dort nicht pro User abgerechnet
    if (heldUserIds.has(ownerId)) continue;

    const toDelete = await prisma.message.findMany({
      where: { folderId: pf.id },
      select: { id: true, rawSize: true },
    });
    if (toDelete.length === 0) continue;
    const totalSize = toDelete.reduce((s, m) => s + m.rawSize, 0);
    const ids = toDelete.map((m) => m.id);

    if (!DRY_RUN) {
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { id: { in: ids } } }),
        prisma.user.update({ where: { id: ownerId }, data: { usedBytes: { decrement: totalSize } } }),
      ]);
    }
    purged += ids.length;
  }
  return { purged };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureRecoverableItems(
  mailboxId: string,
  existing: { id: string; name: string }[],
): Promise<{ rootId: string; deletionsId: string; purgesId: string }> {
  async function getOrCreate(name: string, displayName: string, parentId: string | null): Promise<string> {
    const found = existing.find((f) => f.name === name);
    if (found) return found.id;
    // Higher UID gerendet kollidiert mit message.uid — Folder hat keine uid-Spalte, daher OK
    const created = await prisma.folder.create({
      data: {
        mailboxId, name, displayName,
        ...(parentId ? { parentId } : {}),
        subscribed: false, // hidden für IMAP
      },
      select: { id: true, name: true },
    });
    existing.push(created);
    return created.id;
  }
  const rootId      = await getOrCreate(RECOVERABLE_ROOT,      'Recoverable Items', null);
  const deletionsId = await getOrCreate(RECOVERABLE_DELETIONS, 'Deletions',         rootId);
  const purgesId    = await getOrCreate(RECOVERABLE_PURGES,    'Purges',            rootId);
  return { rootId, deletionsId, purgesId };
}

function mapFolderNameToTarget(name: string): string | null {
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

function legacyToTagAction(legacy: string): 'MOVE_TO_ARCHIVE' | 'DELETE_AND_ALLOW_RECOVERY' | 'PERMANENTLY_DELETE' {
  switch (legacy) {
    case 'ARCHIVE':       return 'MOVE_TO_ARCHIVE';
    case 'DELETE':        return 'PERMANENTLY_DELETE';
    case 'MOVE_TO_FOLDER':return 'MOVE_TO_ARCHIVE';
    default:              return 'DELETE_AND_ALLOW_RECOVERY';
  }
}
