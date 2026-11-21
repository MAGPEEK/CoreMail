/**
 * 10.6: one-time backfill of the deprecated UserMfa.webAuthnCredentials JSON
 * (pre-10.6 security keys: `{ id, publicKey (base64 COSE), counter, name,
 * createdAt }`) into WebAuthnCredential rows of kind "security_key" with
 * userHandle null (second factor only — never a passwordless sign-in).
 *
 * Idempotent: credentials that already have a row are skipped; runs at every
 * api-gateway start under a Redis lock. A credential id that appears for more
 * than one user (§7.1 step 26 was never checked before 10.6, G3) is skipped for
 * ALL of them and alerted (error log + audit `passkey.migration_duplicate`).
 * The JSON column itself is left untouched (deprecated until the next MAJOR).
 * This is the only reader of webAuthnCredentials (repo-hygiene guard).
 */
import { createLogger, getRedisClient } from '@coremail/core';
import { cose, decodeCredentialPublicKey, isoBase64URL } from '@simplewebauthn/server/helpers';
import { prisma } from '../../prisma/index.js';
import { writeAuthAudit } from '../auth-audit.js';
import { publishUserAuthChange } from '../invalidation.js';
import { getRpConfig } from './rp.js';
import { MAX_CREDENTIAL_ID_BYTES } from './ceremonies.js';

const log = createLogger('auth:passkey-migration');

export const PASSKEY_MIGRATION_LOCK = 'auth:passkey:migration:lock';

interface LegacyCredential { id?: unknown; publicKey?: unknown; counter?: unknown; name?: unknown; createdAt?: unknown }

export interface MigrationResult { users: number; migrated: number; skipped: number; duplicates: number; invalid: number }

/** Lock surface (tests inject a fake; default: the shared Redis client). */
export interface MigrationLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

function redisLock(): MigrationLock {
  return {
    async acquire() {
      try {
        const r = await getRedisClient().set(PASSKEY_MIGRATION_LOCK, String(process.pid), 'EX', 300, 'NX');
        return r === 'OK';
      } catch (err) {
        log.warn({ err }, 'Passkey migration lock unavailable — skipped this start');
        return false;
      }
    },
    async release() {
      try { await getRedisClient().del(PASSKEY_MIGRATION_LOCK); } catch { /* expires */ }
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

/** Copies the legacy JSON credentials into the table (see the module comment). */
export async function migrateLegacyWebAuthnCredentials(opts: { lock?: MigrationLock } = {}): Promise<MigrationResult | null> {
  const lock = opts.lock ?? redisLock();
  if (!(await lock.acquire())) return null;
  const result: MigrationResult = { users: 0, migrated: 0, skipped: 0, duplicates: 0, invalid: 0 };
  try {
    const rows = await prisma.userMfa.findMany({
      where: { NOT: { webAuthnCredentials: { equals: [] } } },
      select: { userId: true, webAuthnCredentials: true },
    });
    const owners = new Map<string, Set<string>>();
    const parsed: Array<{ userId: string; cred: NonNullable<ReturnType<typeof parseLegacyCredential>> }> = [];
    for (const r of rows) {
      const list = Array.isArray(r.webAuthnCredentials) ? (r.webAuthnCredentials as LegacyCredential[]) : [];
      if (list.length === 0) continue;
      result.users++;
      for (const c of list) {
        const p = parseLegacyCredential(c);
        if (!p) { result.invalid++; log.warn({ userId: r.userId }, 'Legacy security key skipped — unreadable entry'); continue; }
        parsed.push({ userId: r.userId, cred: p });
        const set = owners.get(p.credentialId) ?? new Set<string>();
        set.add(r.userId);
        owners.set(p.credentialId, set);
      }
    }
    if (parsed.length === 0) return result;
    const rp = await getRpConfig();
    const migratedUsers = new Set<string>();
    for (const { userId, cred } of parsed) {
      const users = owners.get(cred.credentialId)!;
      if (users.size > 1) {
        result.duplicates++;
        continue;
      }
      const existing = await prisma.webAuthnCredential.findUnique({ where: { credentialId: cred.credentialId }, select: { userId: true } });
      if (existing) {
        if (existing.userId !== userId) {
          result.duplicates++;
          log.error({ userId, otherUser: existing.userId }, 'Legacy security key id is already registered by another user — skipped');
          await writeAuthAudit({
            action: 'passkey.migration_duplicate', targetType: 'mailbox', targetId: userId,
            changes: { otherUser: existing.userId }, success: false, errorMsg: 'credential id registered by another user',
          });
        } else {
          result.skipped++;
        }
        continue;
      }
      try {
        await prisma.webAuthnCredential.create({
          data: {
            userId, credentialId: cred.credentialId, publicKey: cred.publicKey, algorithm: cred.algorithm,
            signCount: BigInt(cred.counter), transports: [], rpId: rp.rpID, userHandle: null, kind: 'security_key',
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
    for (const [, users] of dupIds) {
      log.error({ users: [...users] }, 'Legacy security key id registered by several users — skipped for all of them');
      await writeAuthAudit({
        action: 'passkey.migration_duplicate', targetType: 'mailbox', targetId: [...users].join(','),
        changes: { users: [...users] }, success: false, errorMsg: 'credential id registered by several users',
      });
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
