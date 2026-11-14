/**
 * Directory sync (v6.1): creates, updates and deactivates CoreMail users of a
 * domain from its LDAP directory and provisions their mailboxes.
 *
 * - Never deletes users or mail data; "removal" = deactivation
 *   (`active=false`, `deactivatedBySync=true`, sessions revoked).
 * - Only accounts with authSource LDAP are touched. A LOCAL account with the
 *   same mail is a conflict unless the admin enabled `allowLocalTakeover`.
 * - Re-activates only accounts the sync itself deactivated (an admin's manual
 *   deactivation is respected).
 * - AD accounts with userAccountControl ACCOUNTDISABLE (0x2) count as disabled.
 * - Safety: if the directory returns no users at all, nobody is deactivated.
 */
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma, ensureMailboxProvisioned } from '@coremail/storage';
import { revokeAllSessions } from '@coremail/storage/auth';
import { buildSyncFilter } from './filter.js';
import {
  attrFirst, attrId, attrValues, mailAttr, nameAttr, serviceBind, toLdapSettings, uidAttr,
} from './client.js';
import { LDAP_EXTERNAL_ID_PREFIX } from './authenticate.js';

const log = createLogger('auth:ldap:sync');

export interface LdapSyncResult {
  domainId: string;
  found: number;
  created: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  skipped: number;
  conflicts: string[];
  finishedAt: string;
}

const ACCOUNTDISABLE = 0x2;

export async function syncLdapUsers(domainId: string): Promise<LdapSyncResult> {
  const row = await prisma.ldapConfig.findUnique({ where: { domainId } });
  if (!row) throw new Error('LDAP is not configured for this domain');
  const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { id: true, name: true } });
  if (!domain) throw new Error('Domain not found');
  const s = toLdapSettings(row);
  const suffix = `@${domain.name.toLowerCase()}`;

  const client = await serviceBind(s);
  let entries;
  try {
    ({ searchEntries: entries } = await client.search(s.userDN, {
      scope: 'sub',
      filter: buildSyncFilter(mailAttr(s), s.groupFilter),
      attributes: [mailAttr(s), nameAttr(s), uidAttr(s), 'entryUUID', 'userAccountControl'],
      explicitBufferAttributes: ['objectGUID'],
      paged: { pageSize: 500 },
    }));
  } finally {
    await client.unbind().catch(() => undefined);
  }

  const result: LdapSyncResult = {
    domainId, found: entries.length, created: 0, updated: 0, deactivated: 0, reactivated: 0, skipped: 0, conflicts: [],
    finishedAt: '',
  };
  const seen = new Set<string>();

  for (const entry of entries) {
    const email = attrValues(entry[mailAttr(s)]).map((m) => m.trim().toLowerCase()).find((m) => m.endsWith(suffix));
    if (!email) { result.skipped++; continue; }
    const disabled = (Number(attrFirst(entry['userAccountControl']) ?? 0) & ACCOUNTDISABLE) !== 0;
    const dirId = attrId(entry[uidAttr(s)]) ?? attrId(entry['entryUUID']);
    const externalId = dirId ? `${LDAP_EXTERNAL_ID_PREFIX}${dirId}` : undefined;
    const displayName = attrFirst(entry[nameAttr(s)])?.trim() || email;

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, authSource: true, active: true, externalId: true, deactivatedBySync: true, displayName: true },
    });

    if (!existing) {
      if (disabled) { result.skipped++; continue; }
      const u = await prisma.user.create({
        data: { email, displayName, passwordHash: null, role: 'USER', authSource: 'LDAP', domainId, ...(externalId ? { externalId } : {}) },
        select: { id: true },
      });
      await ensureMailboxProvisioned(u.id);
      seen.add(email);
      result.created++;
      continue;
    }

    const takeover = existing.authSource === 'LOCAL' && s.allowLocalTakeover;
    if (existing.authSource !== 'LDAP' && !takeover) { result.conflicts.push(email); continue; }
    if (existing.externalId && externalId && existing.externalId !== externalId) { result.conflicts.push(email); continue; }
    seen.add(email);

    const data: Record<string, unknown> = {};
    if (existing.displayName !== displayName) data['displayName'] = displayName;
    if (externalId && existing.externalId !== externalId) data['externalId'] = externalId;
    if (takeover) { data['authSource'] = 'LDAP'; data['passwordHash'] = null; }
    let deactivate = false;
    if (disabled && existing.active) {
      data['active'] = false; data['deactivatedBySync'] = true; deactivate = true;
    } else if (!disabled && !existing.active && existing.deactivatedBySync) {
      data['active'] = true; data['deactivatedBySync'] = false; result.reactivated++;
    }
    if (Object.keys(data).length > 0) {
      await prisma.user.update({ where: { id: existing.id }, data });
      if (!deactivate && !('active' in data)) result.updated++;
    }
    if (deactivate || takeover) await revokeAllSessions(existing.id, { reason: deactivate ? 'ldap-sync-disabled' : 'ldap-takeover' });
    if (deactivate) result.deactivated++;
    if (!disabled) await ensureMailboxProvisioned(existing.id);
  }

  // Accounts that vanished from the directory (or the sync filter) → deactivate.
  if (entries.length > 0) {
    const ldapUsers = await prisma.user.findMany({
      where: { domainId, authSource: 'LDAP', active: true },
      select: { id: true, email: true },
    });
    for (const u of ldapUsers) {
      if (seen.has(u.email.toLowerCase())) continue;
      await prisma.user.update({ where: { id: u.id }, data: { active: false, deactivatedBySync: true } });
      await revokeAllSessions(u.id, { reason: 'ldap-sync-removed' });
      result.deactivated++;
    }
  } else {
    log.warn({ domainId }, 'LDAP sync found no users — deactivation skipped (safety)');
  }

  result.finishedAt = new Date().toISOString();
  await prisma.ldapConfig.update({
    where: { domainId },
    data: { lastSyncAt: new Date(), lastSyncResult: { ok: true, ...result, conflicts: result.conflicts.slice(0, 50) } },
  });
  log.info({ ...result, conflicts: result.conflicts.length }, 'LDAP sync completed');
  return result;
}

// ── Lock + scheduler ──────────────────────────────────────────────────────────

const LOCK_PREFIX = 'ldap:sync:lock:';
const LOCK_TTL_SECONDS = 30 * 60;

export interface SyncLock {
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

const redisLock: SyncLock = {
  async acquire(key, ttl) {
    return (await getRedisClient().set(key, String(process.pid), 'EX', ttl, 'NX')) === 'OK';
  },
  async release(key) {
    await getRedisClient().del(key);
  },
};

export class LdapSyncBusyError extends Error {
  constructor() { super('An LDAP sync for this domain is already running'); this.name = 'LdapSyncBusyError'; }
}

/** Runs `syncLdapUsers` under a Redis lock (one sync per domain cluster-wide). */
export async function runLdapSyncLocked(domainId: string, lock: SyncLock = redisLock): Promise<LdapSyncResult> {
  const key = `${LOCK_PREFIX}${domainId}`;
  if (!(await lock.acquire(key, LOCK_TTL_SECONDS))) throw new LdapSyncBusyError();
  try {
    return await syncLdapUsers(domainId);
  } catch (err) {
    await prisma.ldapConfig.update({
      where: { domainId },
      data: { lastSyncResult: { ok: false, error: (err as Error).message, finishedAt: new Date().toISOString() } },
    }).catch(() => undefined);
    throw err;
  } finally {
    await lock.release(key).catch(() => undefined);
  }
}

/** Domains whose scheduled sync is due. */
export async function dueLdapSyncs(now = new Date()): Promise<string[]> {
  const rows = await prisma.ldapConfig.findMany({ where: { syncEnabled: true, enabled: true } });
  return rows
    .filter((r) => {
      const interval = Math.max(15, r.syncIntervalMinutes ?? 1440) * 60_000;
      return !r.lastSyncAt || now.getTime() - new Date(r.lastSyncAt).getTime() >= interval;
    })
    .map((r) => r.domainId);
}

let timer: NodeJS.Timeout | null = null;

/** Checks every 5 minutes which domains are due (interval `syncIntervalMinutes`, default daily). */
export function startLdapSyncScheduler(tickMs = 5 * 60_000): () => void {
  if (timer) return () => undefined;
  const tick = async () => {
    try {
      for (const domainId of await dueLdapSyncs()) {
        await runLdapSyncLocked(domainId).catch((err: unknown) => {
          if (!(err instanceof LdapSyncBusyError)) log.error({ err, domainId }, 'Scheduled LDAP sync failed');
        });
      }
    } catch (err) {
      log.error({ err }, 'LDAP sync scheduler tick failed');
    }
  };
  timer = setInterval(() => { void tick(); }, tickMs);
  timer.unref();
  setTimeout(() => { void tick(); }, 60_000).unref();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
