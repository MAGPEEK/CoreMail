/**
 * One-time setup token (v6).
 *
 * POST /api/v1/setup/complete creates the first admin. Without protection the
 * first visitor of a fresh installation owns the server. Now:
 *
 *  - At api-gateway start, while setup is pending, a random token is generated,
 *    printed to the log and stored as sha256 hash (ServerSettings.setupTokenHash).
 *    It is regenerated on every start while setup is pending (the plain token
 *    is never stored). Multi-instance deployments set SETUP_TOKEN instead.
 *  - SETUP_TOKEN env (≥ 16 chars) replaces the generated token.
 *  - ServerSettings.setupCompletedAt is the persistent "setup done" flag:
 *    claimed atomically in the setup transaction, never cleared. Existing
 *    installations (users present, flag null) are backfilled at start.
 *  - 10.4: with a mounted secrets directory (COREMAIL_SECRETS_DIR, default
 *    /secrets) the generated token is ALSO written to <dir>/setup-token (0600)
 *    and the log only names that file. The file is deleted when the setup is
 *    completed (or found completed at start). Token checks are unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@coremail/storage';
import { safeEqual } from '@coremail/core';
import { removeSetupTokenFile, setupTokenFileBanner, writeSetupTokenFile } from './setup-secrets.js';

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function envSetupToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env['SETUP_TOKEN'] ?? '').trim();
  return t.length >= 16 ? t : null;
}

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
}

async function ensureSettingsRow(): Promise<{ setupCompletedAt: Date | null; setupTokenHash: string | null }> {
  try {
    return await prisma.serverSettings.upsert({
      where: { id: 'singleton' }, create: { id: 'singleton' }, update: {},
      select: { setupCompletedAt: true, setupTokenHash: true },
    });
  } catch {
    // concurrent create (P2002) — the row exists now
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' }, select: { setupCompletedAt: true, setupTokenHash: true },
    });
    return s ?? { setupCompletedAt: null, setupTokenHash: null };
  }
}

/** Setup is required only if it was never completed AND no user exists. */
export async function isSetupRequired(): Promise<boolean> {
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { setupCompletedAt: true } });
  if (s?.setupCompletedAt) return false;
  return (await prisma.user.count()) === 0;
}

/**
 * Called once at api-gateway start. Returns the plain token when one was
 * generated (for tests); it is also written to the log.
 */
export async function initSetupToken(log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const s = await ensureSettingsRow();
  if (s.setupCompletedAt) {
    if (s.setupTokenHash) {
      await prisma.serverSettings.update({ where: { id: 'singleton' }, data: { setupTokenHash: null } });
    }
    await removeSetupTokenFile(env); // stale file of an earlier start
    return null;
  }
  const users = await prisma.user.count();
  if (users > 0) {
    // Installation from before v6 — mark setup as completed for good.
    await prisma.serverSettings.update({
      where: { id: 'singleton' }, data: { setupCompletedAt: new Date(), setupTokenHash: null },
    });
    await removeSetupTokenFile(env);
    log.info({}, 'Setup flag backfilled (users already exist)');
    return null;
  }

  const fromEnv = envSetupToken(env);
  if (fromEnv) {
    await prisma.serverSettings.update({ where: { id: 'singleton' }, data: { setupTokenHash: hashSetupToken(fromEnv) } });
    // A file from an earlier start would hold a token that no longer works.
    await removeSetupTokenFile(env);
    log.warn({}, 'Initial setup pending — use the SETUP_TOKEN from the environment in the setup wizard');
    return null;
  }

  const token = randomBytes(24).toString('base64url');
  await prisma.serverSettings.update({ where: { id: 'singleton' }, data: { setupTokenHash: hashSetupToken(token) } });
  // 10.4: a mounted secrets directory receives the token — then the log only
  // names the file (logs are often shipped elsewhere; the file is 0600).
  if (await writeSetupTokenFile(token, env)) {
    log.warn({}, setupTokenFileBanner(env));
    return token;
  }
  log.warn(
    { setupToken: token },
    `\n════════════════════════════════════════════════════════════════════\n` +
    `  CoreMail initial setup is pending.\n` +
    `  One-time setup token:  ${token}\n` +
    `  Enter it in the setup wizard (http://<server>:3000/bcp/).\n` +
    `  A new token is generated on every restart until setup is done.\n` +
    `════════════════════════════════════════════════════════════════════`,
  );
  return token;
}

/** Constant-time check of a presented token against SETUP_TOKEN / the stored hash. */
export async function verifySetupToken(given: unknown, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (typeof given !== 'string' || given.length === 0 || given.length > 256) return false;
  const fromEnv = envSetupToken(env);
  if (fromEnv) return safeEqual(given, fromEnv);
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { setupTokenHash: true } });
  if (!s?.setupTokenHash) return false;
  return safeEqual(hashSetupToken(given), s.setupTokenHash);
}
