/**
 * User.lastLoginAt (8.x) — set on every successful login: web/API password
 * login and MFA completion and SSO (all go through issueSession()) and the mail
 * protocols (verifyMailCredentials). Writes are throttled to at most one per
 * user per LAST_LOGIN_WRITE_INTERVAL_MS (5 min) and process, so a client that
 * re-authenticates on every IMAP connection does not turn logins into a write
 * load. Fire-and-forget: a failed write never fails a login.
 */
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';

const log = createLogger('auth:last-login');

export const LAST_LOGIN_WRITE_INTERVAL_MS = 5 * 60_000;
const MAX_TRACKED = 50_000;

/** userId → time of the last write (ms). */
const lastWrite = new Map<string, number>();

/** Clears the throttle state (tests). */
export function resetLastLoginThrottle(): void {
  lastWrite.clear();
}

/**
 * Records a successful login. Returns true when a write was issued, false when
 * it was throttled. Never throws (the write itself is awaited only for tests).
 */
export async function recordLastLogin(userId: string, now: number = Date.now()): Promise<boolean> {
  if (!userId) return false;
  const prev = lastWrite.get(userId);
  if (prev !== undefined && now - prev < LAST_LOGIN_WRITE_INTERVAL_MS) return false;
  if (lastWrite.size >= MAX_TRACKED) {
    for (const [k, t] of lastWrite) if (now - t >= LAST_LOGIN_WRITE_INTERVAL_MS) lastWrite.delete(k);
    if (lastWrite.size >= MAX_TRACKED) lastWrite.clear();
  }
  lastWrite.set(userId, now);
  try {
    // updateMany: no error when the user vanished meanwhile
    await prisma.user.updateMany({ where: { id: userId }, data: { lastLoginAt: new Date(now) } });
  } catch (err) {
    // Allow a retry on the next login instead of waiting out the interval.
    if (lastWrite.get(userId) === now) lastWrite.delete(userId);
    log.warn({ err, userId }, 'Could not record lastLoginAt');
  }
  return true;
}
