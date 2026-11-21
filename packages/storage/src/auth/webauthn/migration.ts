/**
 * 10.6: one-time backfill of the deprecated UserMfa.webAuthnCredentials JSON
 * (pre-10.6 security keys: `{ id, publicKey (base64 COSE), counter, name,
 * createdAt }`) into WebAuthnCredential rows of kind "security_key" with
 * userHandle null (second factor only — never a passwordless sign-in).
 *
 * Idempotent: each account is copied once (UserMfa.webAuthnMigratedAt — a key
 * removed afterwards is never re-imported) and credentials that already have a
 * row are skipped; runs at every api-gateway start under a Redis lock. A credential id that appears for more
 * than one user (§7.1 step 26 was never checked before 10.6, G3) is skipped for
 * ALL of them and alerted (error log + audit `passkey.migration_duplicate`).
 *
 * 10.6 review — fail closed:
 *  - Until an account is migrated, its legacy keys count as a second factor
 *    (legacy-security-keys.ts, used by every factor decision).
 *  - An entry that cannot be copied (unreadable, or a duplicate credential id)
 *    is never dropped silently: the account stays un-migrated with exactly these
 *    entries left in the JSON (the copied ones are removed from it, so a key
 *    removed later is never re-imported), keeps counting as MFA-enrolled, and
 *    is alerted (error log, audit `passkey.migration_pending`, security event
 *    PASSKEY_MIGRATION_PENDING on the attack dashboard; at most every 6 h per
 *    account and process). An admin resolves it with "MFA zurücksetzen" (clears
 *    the JSON) or by fixing the duplicate; the next run then completes it.
 *  - The start-up run is retried with backoff while the lock is busy or the
 *    run fails (startLegacyWebAuthnMigration), and a second-factor login of an
 *    account with pending legacy keys triggers a run first (migrate on read,
 *    migrateLegacyKeysOnRead — ceremonies.ts secondFactorOptions).
 * Together with legacy-security-keys.ts this is the only reader of
 * webAuthnCredentials (repo-hygiene guard).
 */
import { createLogger } from '@coremail/core';
import { cose, decodeCredentialPublicKey, isoBase64URL } from '@simplewebauthn/server/helpers';
import { prisma } from '../../prisma/index.js';
import { writeAuthAudit } from '../auth-audit.js';
import { publishUserAuthChange } from '../invalidation.js';
import { authRedis } from '../redis.js';
import { recordSecurityEvent } from '../../security-events.js';
import { LEGACY_SECURITY_KEY_SELECT, pendingLegacySecurityKeyIds } from '../../legacy-security-keys.js';
import { getRpConfig } from './rp.js';
import { MAX_CREDENTIAL_ID_BYTES } from './ceremonies.js';

const log = createLogger('auth:passkey-migration');

export const PASSKEY_MIGRATION_LOCK = 'auth:passkey:migration:lock';

interface LegacyCredential { id?: unknown; publicKey?: unknown; counter?: unknown; name?: unknown; createdAt?: unknown }

export interface MigrationResult {
  users: number; migrated: number; skipped: number; duplicates: number; invalid: number;
  /** 10.6 review: accounts left un-migrated (entries that cannot be copied — still counted as MFA). */
  pending: number;
}

/** Lock surface (tests inject a fake; default: the shared Redis client). */
export interface MigrationLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

type LockRedis = { set?(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(key: string): Promise<number> };

/** The shared Redis client (authRedis(): the auth module's client, test seam globalThis.__authRedis). */
function redisLock(): MigrationLock {
  return {
    async acquire() {
      try {
        const r = authRedis() as unknown as LockRedis;
        if (typeof r.set !== 'function') return false;
        return (await r.set(PASSKEY_MIGRATION_LOCK, String(process.pid), 'EX', 300, 'NX')) === 'OK';
      } catch (err) {
        log.warn({ err }, 'Passkey migration lock unavailable — retried later');
        return false;
      }
    },
    async release() {
      try { await (authRedis() as unknown as LockRedis).del(PASSKEY_MIGRATION_LOCK); } catch { /* expires */ }
    },
  };
}

/** Decodes one legacy entry; null when it cannot be used. */
export function parseLegacyCredential(c: LegacyCredential): { credentialId: string; publicKey: Buffer; algorithm: number; counter: number; name: string; createdAt: Date } | null {
  if (typeof c?.id !== 'string' || typeof c.publicKey !== 'string' || !isoBase64URL.isBase64URL(c.id)) return null;
  let idBytes: number;
  try { idBytes = isoBase64URL.toBuffer(c.id).length; } catch { return null; }
  if (idBytes === 0 || idBytes > MAX_CREDENTIAL_ID_BYTES) return null;
  const publicKey = Buffer.from(c.publicKey, 'base64');
  if (publicKey.length === 0) return null;
  let algorithm: unknown;
  try { algorithm = decodeCredentialPublicKey(new Uint8Array(publicKey)).get(cose.COSEKEYS.alg); } catch { return null; }
  if (typeof algorithm !== 'number') return null;
  const counter = typeof c.counter === 'number' && Number.isSafeInteger(c.counter) && c.counter >= 0 ? c.counter : 0;
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 100) : 'Security key';
  const created = typeof c.createdAt === 'string' ? new Date(c.createdAt) : null;
  return { credentialId: c.id, publicKey, algorithm, counter, name, createdAt: created && !Number.isNaN(created.getTime()) ? created : new Date() };
}

// ── Alerts (throttled per key and process) ────────────────────────────────────

const ALERT_INTERVAL_MS = 6 * 3600 * 1000;
const alerted = new Map<string, number>();

function shouldAlert(key: string, now = Date.now()): boolean {
  const last = alerted.get(key);
  if (last !== undefined && now - last < ALERT_INTERVAL_MS) return false;
  if (alerted.size > 10_000) alerted.clear();
  alerted.set(key, now);
  return true;
}

/** Tests: forget the alert throttle. */
export function resetMigrationAlertThrottle(): void {
  alerted.clear();
}

/** Copies the legacy JSON credentials into the table (see the module comment). */
export async function migrateLegacyWebAuthnCredentials(opts: { lock?: MigrationLock } = {}): Promise<MigrationResult | null> {
  const lock = opts.lock ?? redisLock();
  if (!(await lock.acquire())) return null;
  const result: MigrationResult = { users: 0, migrated: 0, skipped: 0, duplicates: 0, invalid: 0, pending: 0 };
  try {
    // each account once (webAuthnMigratedAt): a key removed after the copy is never re-imported
    const rows = await prisma.userMfa.findMany({
      where: { webAuthnMigratedAt: null, NOT: { webAuthnCredentials: { equals: [] } } },
      select: { userId: true, webAuthnCredentials: true },
    });
    const owners = new Map<string, Set<string>>();
    const parsed: Array<{ userId: string; raw: LegacyCredential; cred: NonNullable<ReturnType<typeof parseLegacyCredential>> }> = [];
    // entries of an account that cannot be copied — kept in the JSON, account stays un-migrated
    const problems = new Map<string, { entries: LegacyCredential[]; invalid: number; duplicates: number }>();
    const problemOf = (userId: string) => {
      let p = problems.get(userId);
      if (!p) { p = { entries: [], invalid: 0, duplicates: 0 }; problems.set(userId, p); }
      return p;
    };
    for (const r of rows) {
      const list = Array.isArray(r.webAuthnCredentials) ? (r.webAuthnCredentials as LegacyCredential[]) : [];
      if (list.length === 0) continue;
      result.users++;
      for (const c of list) {
        const p = parseLegacyCredential(c);
        if (!p) {
          result.invalid++;
          const pr = problemOf(r.userId);
          pr.entries.push(c);
          pr.invalid++;
          continue;
        }
        parsed.push({ userId: r.userId, raw: c, cred: p });
        const set = owners.get(p.credentialId) ?? new Set<string>();
        set.add(r.userId);
        owners.set(p.credentialId, set);
      }
    }
    const rp = parsed.length > 0 ? await getRpConfig() : null;
    const migratedUsers = new Set<string>();
    for (const { userId, raw, cred } of parsed) {
      const users = owners.get(cred.credentialId)!;
      if (users.size > 1) {
        result.duplicates++;
        const pr = problemOf(userId);
        pr.entries.push(raw);
        pr.duplicates++;
        continue;
      }
      const existing = await prisma.webAuthnCredential.findUnique({ where: { credentialId: cred.credentialId }, select: { userId: true } });
      if (existing) {
        if (existing.userId !== userId) {
          result.duplicates++;
          const pr = problemOf(userId);
          pr.entries.push(raw);
          pr.duplicates++;
          if (shouldAlert(`dup:${userId}:${cred.credentialId}`)) {
            log.error({ userId, otherUser: existing.userId }, 'Legacy security key id is already registered by another user — skipped');
            await writeAuthAudit({
              action: 'passkey.migration_duplicate', targetType: 'mailbox', targetId: userId,
              changes: { otherUser: existing.userId }, success: false, errorMsg: 'credential id registered by another user',
            });
          }
        } else {
          result.skipped++;
        }
        continue;
      }
      try {
        await prisma.webAuthnCredential.create({
          data: {
            userId, credentialId: cred.credentialId, publicKey: cred.publicKey, algorithm: cred.algorithm,
            signCount: BigInt(cred.counter), transports: [], rpId: rp!.rpID, userHandle: null, kind: 'security_key',
            discoverable: null, uvInitialized: false, backupEligible: null, backupState: false, aaguid: null,
            attestationFmt: 'none', name: cred.name, createdAt: cred.createdAt,
          },
        });
        result.migrated++;
        migratedUsers.add(userId);
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') { result.skipped++; continue; }
        throw err;
      }
    }
    const dupIds = [...owners.entries()].filter(([, u]) => u.size > 1);
    for (const [credentialId, users] of dupIds) {
      if (!shouldAlert(`dup:${credentialId}`)) continue;
      log.error({ users: [...users] }, 'Legacy security key id registered by several users — skipped for all of them');
      await writeAuthAudit({
        action: 'passkey.migration_duplicate', targetType: 'mailbox', targetId: [...users].join(','),
        changes: { users: [...users] }, success: false, errorMsg: 'credential id registered by several users',
      });
    }
    // complete accounts: migrated once and for all
    const complete = rows.map((r) => r.userId).filter((id) => !problems.has(id));
    if (complete.length) {
      await prisma.userMfa.updateMany({ where: { userId: { in: complete }, webAuthnMigratedAt: null }, data: { webAuthnMigratedAt: new Date() } });
    }
    // accounts with entries that cannot be copied: only those entries stay in the JSON
    // (the account keeps counting as MFA-enrolled), alerted
    for (const [userId, pr] of problems) {
      result.pending++;
      await prisma.userMfa.updateMany({
        where: { userId, webAuthnMigratedAt: null },
        data: { webAuthnCredentials: pr.entries as unknown as object[] },
      });
      if (shouldAlert(`pending:${userId}`)) {
        log.error({ userId, invalid: pr.invalid, duplicates: pr.duplicates },
          'Legacy security keys that cannot be migrated — the account keeps counting as MFA-enrolled; reset its MFA or resolve the duplicate');
        await writeAuthAudit({
          action: 'passkey.migration_pending', targetType: 'mailbox', targetId: userId,
          changes: { invalid: pr.invalid, duplicates: pr.duplicates }, success: false,
          errorMsg: 'legacy security keys could not be migrated',
        });
        recordSecurityEvent({
          type: 'PASSKEY_MIGRATION_PENDING', ip: null, protocol: 'web', target: userId,
          detail: { invalid: pr.invalid, duplicates: pr.duplicates }, important: true,
        });
      }
    }
    // mail-protocol credential caches must not keep a primary-password login of these users
    for (const userId of migratedUsers) await publishUserAuthChange(userId, 'mfa-change');
    if (result.migrated > 0 || result.duplicates > 0 || result.invalid > 0) {
      log.info(result, 'Legacy security keys migrated to the passkey table');
    }
    return result;
  } finally {
    await lock.release();
  }
}

// ── Start-up run with retries (api-gateway) ───────────────────────────────────

/** Backoff of the start-up run while the lock is busy / unavailable or a run fails (the last value repeats). */
export const MIGRATION_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000, 900_000];

export interface MigrationScheduleOptions {
  lock?: MigrationLock;
  delaysMs?: readonly number[];
  /** Tests: a timer that runs at once / records the delay. */
  setTimer?: (fn: () => void, ms: number) => void;
}

/**
 * Runs the backfill now and, while the lock is busy / Redis unavailable or the
 * run throws, again with backoff (forever — legacy keys count as MFA meanwhile,
 * so a delay never weakens anything). `done` resolves with the first completed
 * run; `stop()` ends the retries.
 */
export function startLegacyWebAuthnMigration(opts: MigrationScheduleOptions = {}): { done: Promise<MigrationResult>; stop(): void } {
  const delays = opts.delaysMs && opts.delaysMs.length > 0 ? opts.delaysMs : MIGRATION_RETRY_DELAYS_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref(); });
  let stopped = false;
  let resolveDone!: (r: MigrationResult) => void;
  const done = new Promise<MigrationResult>((resolve) => { resolveDone = resolve; });
  const attempt = (n: number): void => {
    if (stopped) return;
    void migrateLegacyWebAuthnCredentials(opts.lock ? { lock: opts.lock } : {})
      .then((r) => r, (err: unknown) => { log.error({ err }, 'Legacy security key migration failed — retried'); return null; })
      .then((r) => {
        if (r) { resolveDone(r); return; }
        if (stopped) return;
        const ms = delays[Math.min(n, delays.length - 1)]!;
        log.info({ attempt: n + 1, retryInMs: ms }, 'Legacy security key migration not run (lock busy or failed) — retrying');
        setTimer(() => attempt(n + 1), ms);
      });
  };
  attempt(0);
  return { done, stop: () => { stopped = true; } };
}

// ── Migrate on read (second-factor login) ─────────────────────────────────────

/**
 * Before a second-factor ceremony: when the account still has legacy keys that
 * were not copied, run the backfill now (under the lock; never throws). An
 * entry that cannot be copied stays pending — the account still needs its
 * other factors (TOTP / backup codes) or an admin reset.
 */
export async function migrateLegacyKeysOnRead(userId: string, opts: { lock?: MigrationLock } = {}): Promise<void> {
  try {
    const mfa = await prisma.userMfa.findUnique({ where: { userId }, select: LEGACY_SECURITY_KEY_SELECT });
    if (pendingLegacySecurityKeyIds(mfa).length === 0) return;
    await migrateLegacyWebAuthnCredentials(opts.lock ? { lock: opts.lock } : {});
  } catch (err) {
    log.warn({ err, userId }, 'Legacy security key migration on login failed');
  }
}
