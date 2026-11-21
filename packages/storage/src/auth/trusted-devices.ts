/**
 * 10.6: "Auf diesem Gerät für N Tage nicht mehr fragen" — remembered MFA devices.
 *
 * After a successful MFA step a browser client may ask to be remembered
 * (`rememberDevice: true` on POST /auth/mfa/verify) when the account's policy
 * allows it (mfa-policy.ts `rememberDays` — users / admins configured
 * separately, 0 = off). The server then sets a random device token in an
 * HttpOnly cookie per surface — like the refresh cookies cm_rt / cm_rt_bcp:
 *
 *   cm_mfa_dev=<token>     (webmail)   cm_mfa_dev_bcp=<token>   (BCP)
 *   Path=/auth; Max-Age=<days>; HttpOnly; SameSite=Strict[; Secure]
 *
 * and stores only sha256(token) in MfaTrustedDevice. A later password login
 * (POST /auth/login) of the same browser skips the MFA challenge only when ALL
 * of these hold: the cookie's hash matches a row, the row belongs to the user
 * whose password was just verified, the row's surface is the surface of the
 * request, it is neither revoked nor expired, and it is younger than the number
 * of days the policy allows NOW (lowering the setting shortens existing devices,
 * 0 switches remembering off for everybody). The session then counts as
 * MFA-verified.
 *
 * Never used for: mail protocols / app passwords, the admin CLI (no browser
 * client header → no surface), MCP tokens, SSO logins (their MFA challenge is not
 * skipped).
 *
 * Revoked (rows marked revokedAt) by: revokeAllSessions() — password change /
 * reset, "sign out everywhere", role change, deactivation, deletion, admin
 * revoke, LDAP sync — and by every `mfa-change` event (factor added or removed,
 * backup codes regenerated; invalidation.ts). Users revoke their own devices in
 * webmail Settings → Sicherheit, admins in BCP → Postfächer → Bearbeiten.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import {
  isBcpClient, isSecureRequest, isWebClient, readCookie, REFRESH_COOKIE_PATH, type CookieRequestLike,
} from './refresh-cookie.js';
import { normalizeIp } from '../mail-auth-core.js';

const log = createLogger('auth:trusted-devices');

export type DeviceSurface = 'webmail' | 'bcp';

export const TRUSTED_DEVICE_COOKIE = 'cm_mfa_dev';
export const TRUSTED_DEVICE_COOKIE_BCP = 'cm_mfa_dev_bcp';
/** At most this many active remembered devices per user (the oldest is revoked). */
export const MAX_TRUSTED_DEVICES_PER_USER = 20;

const DAY_MS = 86_400_000;

/** Surface of a browser request (`X-CoreMail-Client: web`, BCP: `X-CoreMail-App: bcp`); null = no browser client. */
export function deviceSurfaceOf(h: IncomingHttpHeaders): DeviceSurface | null {
  if (!isWebClient(h)) return null;
  return isBcpClient(h) ? 'bcp' : 'webmail';
}

export function trustedDeviceCookieName(surface: DeviceSurface): string {
  return surface === 'bcp' ? TRUSTED_DEVICE_COOKIE_BCP : TRUSTED_DEVICE_COOKIE;
}

/** The device cookie of this request's surface, or null (no browser client / no cookie). */
export function readTrustedDeviceCookie(req: CookieRequestLike): string | null {
  const surface = deviceSurfaceOf(req.headers);
  if (!surface) return null;
  const v = readCookie(req.headers, trustedDeviceCookieName(surface));
  return v && /^[A-Za-z0-9_-]{20,128}$/.test(v) ? v : null;
}

/** Set-Cookie value carrying a device token for this request's surface. */
export function trustedDeviceCookieHeader(req: CookieRequestLike, surface: DeviceSurface, token: string, maxAgeSec: number): string {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${trustedDeviceCookieName(surface)}=${token}; Path=${REFRESH_COOKIE_PATH}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; SameSite=Strict${secure}`;
}

/** Set-Cookie value deleting the device cookie of a surface. */
export function clearTrustedDeviceCookieHeader(req: CookieRequestLike, surface: DeviceSurface): string {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${trustedDeviceCookieName(surface)}=; Path=${REFRESH_COOKIE_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secure}`;
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Short "browser · OS" summary of a User-Agent (shown in the device lists). */
export function userAgentSummary(ua: string | undefined): string {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
      : /Firefox\//.test(s) ? 'Firefox'
        : /Chrome\//.test(s) ? 'Chrome'
          : /Safari\//.test(s) ? 'Safari' : '';
  const os = /Windows/.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Mac OS X|Macintosh/.test(s) ? 'macOS'
        : /Android/.test(s) ? 'Android'
          : /Linux/.test(s) ? 'Linux' : '';
  const parts = [browser, os].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : s.slice(0, 60);
}

/** Network of an address: IPv4 /24, IPv6 /48 (never the full address). */
export function ipPrefixOf(ip: string | undefined): string {
  const v = normalizeIp(ip);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (v.includes(':')) {
    const [head = ''] = v.split('::');
    const groups = head.split(':').filter(Boolean).slice(0, 3);
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::/48`;
  }
  return '';
}

export interface TrustedDeviceRow {
  id: string;
  userId: string;
  tokenHash: string;
  surface: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  userAgent: string;
  ipPrefix: string;
  revokedAt: Date | null;
}

/** Pure: may `row` skip the MFA step of `userId` on `surface` at `now` with `allowedDays` (current policy)? */
export function trustedDeviceValid(
  row: Pick<TrustedDeviceRow, 'userId' | 'surface' | 'createdAt' | 'expiresAt' | 'revokedAt'> | null | undefined,
  userId: string, surface: DeviceSurface, allowedDays: number, now: Date,
): boolean {
  if (!row || allowedDays <= 0) return false;
  if (row.userId !== userId || row.surface !== surface || row.revokedAt) return false;
  const t = now.getTime();
  if (row.expiresAt.getTime() <= t) return false;
  return row.createdAt.getTime() + allowedDays * DAY_MS > t;
}

export interface IssuedTrustedDevice {
  token: string;
  id: string;
  expiresAt: Date;
  maxAgeSec: number;
}

/** Remembers a browser for `days` days; returns the raw token (cookie). */
export async function issueTrustedDevice(
  userId: string, surface: DeviceSurface, days: number,
  client: { ip?: string | undefined; userAgent?: string | undefined }, now = new Date(),
): Promise<IssuedTrustedDevice> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  // housekeeping: drop the user's expired / revoked rows
  await prisma.mfaTrustedDevice.deleteMany({
    where: { userId, OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
  });
  const row = await prisma.mfaTrustedDevice.create({
    data: {
      userId, tokenHash: hashDeviceToken(token), surface, expiresAt,
      userAgent: userAgentSummary(client.userAgent), ipPrefix: ipPrefixOf(client.ip),
    },
    select: { id: true },
  });
  const active = await prisma.mfaTrustedDevice.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, createdAt: true },
  });
  if (active.length > MAX_TRUSTED_DEVICES_PER_USER) {
    const oldest = [...active].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, active.length - MAX_TRUSTED_DEVICES_PER_USER).map((d) => d.id);
    await prisma.mfaTrustedDevice.updateMany({
      where: { id: { in: oldest } }, data: { revokedAt: now, revokedReason: 'limit' },
    });
  }
  log.info({ userId, surface, days }, 'MFA: device remembered');
  return { token, id: row.id, expiresAt, maxAgeSec: Math.floor(days * 86_400) };
}

/**
 * The remembered device of `token` when it may skip the MFA step of `userId`
 * on `surface` now (see trustedDeviceValid); records the use. null otherwise
 * (also for a token of another user — the row is left untouched).
 */
export async function checkTrustedDevice(
  token: string, userId: string, surface: DeviceSurface, allowedDays: number, now = new Date(),
): Promise<string | null> {
  if (!token || allowedDays <= 0) return null;
  const row = await prisma.mfaTrustedDevice.findUnique({ where: { tokenHash: hashDeviceToken(token) } }) as TrustedDeviceRow | null;
  if (!trustedDeviceValid(row, userId, surface, allowedDays, now)) {
    if (row && row.userId !== userId) log.warn({ userId, deviceOwner: row.userId }, 'MFA: remembered-device cookie of another account presented');
    return null;
  }
  await prisma.mfaTrustedDevice.updateMany({ where: { id: row!.id, revokedAt: null }, data: { lastUsedAt: now } });
  return row!.id;
}

export interface TrustedDeviceView {
  id: string;
  surface: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  userAgent: string;
  ipPrefix: string;
}

/** Active (not revoked, not expired) remembered devices of a user, newest first. */
export async function listTrustedDevices(userId: string, now = new Date()): Promise<TrustedDeviceView[]> {
  const rows = await prisma.mfaTrustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
  }) as TrustedDeviceRow[];
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({
      id: r.id, surface: r.surface, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null, userAgent: r.userAgent, ipPrefix: r.ipPrefix,
    }));
}

/** Revokes one remembered device of `userId`; false when there is no such active device. */
export async function revokeTrustedDevice(userId: string, id: string, reason: string): Promise<boolean> {
  const r = await prisma.mfaTrustedDevice.updateMany({
    where: { id, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
  });
  return r.count > 0;
}

/** Revokes every remembered device of a user. Never throws (returns 0 on errors). */
export async function revokeTrustedDevicesOfUser(userId: string, reason: string): Promise<number> {
  try {
    const r = await prisma.mfaTrustedDevice.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
    });
    if (r.count > 0) log.info({ userId, count: r.count, reason }, 'MFA: remembered devices revoked');
    return r.count;
  } catch (err) {
    log.warn({ err, userId, reason }, 'Could not revoke the remembered MFA devices');
    return 0;
  }
}
