/**
 * Production wiring of the shared mail-protocol credential check
 * (see mail-auth-core.ts for the rules).
 *
 *   const r = await verifyMailCredentials(login, password, { ip, protocol: 'imap' });
 *   switch (r.status) { case 'ok': … case 'invalid': … case 'locked': … case 'mfa_app_password_required': … case 'error': …
 *                       case 'protocol_disabled': … }
 *
 * 9.4: after a successful check the protocol switch of the account is applied
 * (protocol-access.ts): `protocol_disabled` when the protocol is off. A wrong
 * password never gets that answer — it is `invalid` as before. An app password
 * of an account whose webmail module "App-Passwörter" is off (webmail-policy.ts)
 * is `invalid` too, indistinguishable from a wrong one.
 * 10.5: with "MFA für alle Benutzer erzwingen" and its sub-option
 * `mfaEnforcementBlocksPrimaryPassword`, the primary password of an account
 * without MFA is `mfa_app_password_required` after the grace period
 * (auth/mfa-enforcement.ts); app passwords keep working.
 *
 * Environment (optional):
 *   MAIL_AUTH_IP_MAX_FAILURES (50)   MAIL_AUTH_IP_WINDOW_SEC (900)   MAIL_AUTH_IP_LOCK_SEC (900)
 *   MAIL_AUTH_ACCOUNT_MAX_FAILURES (10)   MAIL_AUTH_ACCOUNT_WINDOW_SEC (900)   MAIL_AUTH_ACCOUNT_LOCK_SEC (300)
 *   MAIL_AUTH_EXEMPT_CIDRS — comma-separated IPs/CIDRs exempt from the per-IP counter
 *     (default: none; loopback is always exempt). Since v8.1 private addresses are
 *     counted like public ones; MAIL_AUTH_LIMIT_PRIVATE_IPS is obsolete and ignored.
 *
 * Test seam: `globalThis.__mailAuthRedis` (like `globalThis.__prisma`) or
 * configureMailAuth({ redis, verifyPassword, ... }).
 */
import { randomBytes } from 'node:crypto';
import { createLogger, getRedisClient, hashPassword, verifyPassword } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { recordLastLogin } from './auth/last-login.js';
import { isProtocolAllowed, type AccessProtocol } from './protocol-access.js';
import { isWebmailFeatureEnabled } from './webmail-policy.js';
import { mailPrimaryPasswordBlocked } from './auth/mfa-enforcement.js';
import {
  createLoginLockout, createMailCredentialVerifier, createExemptIpMatcher,
  type LoginLockout, type MailAuthContext, type MailAuthDeps, type MailAuthLimits, type MailAuthPrisma,
  type MailAuthRedis, type MailAuthResult, type MailCredentialVerifier, type MailProtocol,
} from './mail-auth-core.js';

export * from './mail-auth-core.js';

declare global {
  // eslint-disable-next-line no-var
  var __mailAuthRedis: MailAuthRedis | null | undefined;
}

const log = createLogger('mail-auth');

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function limitsFromEnv(): Partial<MailAuthLimits> {
  const out: Partial<MailAuthLimits> = {};
  const set = (key: keyof MailAuthLimits, env: string) => { const v = envInt(env); if (v !== undefined) out[key] = v; };
  set('ipMaxFailures', 'MAIL_AUTH_IP_MAX_FAILURES');
  set('ipWindowSec', 'MAIL_AUTH_IP_WINDOW_SEC');
  set('ipLockBaseSec', 'MAIL_AUTH_IP_LOCK_SEC');
  set('accountMaxFailures', 'MAIL_AUTH_ACCOUNT_MAX_FAILURES');
  set('accountWindowSec', 'MAIL_AUTH_ACCOUNT_WINDOW_SEC');
  set('accountLockBaseSec', 'MAIL_AUTH_ACCOUNT_LOCK_SEC');
  return out;
}

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  // Same bcrypt cost as real hashes; computed once per process.
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('hex'));
  return dummyHashPromise;
}

let overrides: Partial<MailAuthDeps> = {};
let instance: MailCredentialVerifier | null = null;

/** Replaces dependencies (tests, special deployments). Resets the cached verifier. */
export function configureMailAuth(deps: Partial<MailAuthDeps>): void {
  overrides = { ...deps };
  instance = null;
}

function resolveRedis(): MailAuthRedis | null {
  if (globalThis.__mailAuthRedis !== undefined) return globalThis.__mailAuthRedis;
  return getRedisClient() as unknown as MailAuthRedis;
}

function getVerifier(): MailCredentialVerifier {
  if (!instance) {
    const exempt = createExemptIpMatcher(process.env['MAIL_AUTH_EXEMPT_CIDRS']);
    if (exempt.invalid.length) log.warn({ invalid: exempt.invalid }, 'mail-auth: ignoring invalid MAIL_AUTH_EXEMPT_CIDRS entries');
    instance = createMailCredentialVerifier({
      prisma: prisma as unknown as MailAuthPrisma,
      redis: resolveRedis(),
      verifyPassword,
      dummyHash,
      limits: limitsFromEnv(),
      isExemptIp: exempt.isExempt,
      log,
      ...overrides,
    });
  }
  return instance;
}

/** 9.4: the protocol switch a mail-protocol login is subject to (Autodiscover has none). */
export const MAIL_PROTOCOL_ACCESS: Readonly<Record<MailProtocol, AccessProtocol | null>> = {
  smtp: 'smtp', imap: 'imap', pop3: 'pop3', activesync: 'activesync', jmap: 'jmap', caldav: 'dav', mapi: 'mapi', autodiscover: null,
};

/** The shared credential check for all mail protocols. Never throws. */
export async function verifyMailCredentials(
  login: string,
  password: string,
  ctx: MailAuthContext,
): Promise<MailAuthResult> {
  try {
    const result = await getVerifier().verify(login, password, ctx);
    if (result.status !== 'ok') return result;
    const subject = { id: result.user.id, domainId: result.user.domainId };
    // 9.4 webmail policy: with the module "App-Passwörter" off, app passwords do
    // not work on any protocol. Answered exactly like a wrong password (`invalid`,
    // no oracle — checked before the protocol switch, whose answer would reveal
    // that the credential is right); an unreadable policy is `error` (temporary).
    if (result.method === 'app_password' && !(await isWebmailFeatureEnabled(subject, 'appPasswords'))) {
      log.warn({ userId: result.user.id, protocol: ctx.protocol, ip: ctx.ip }, 'mail-auth: app passwords are switched off for this account');
      return { status: 'invalid' };
    }
    // 10.5: "MFA für alle Benutzer erzwingen" with the sub-option "primary
    // password blocked on mail protocols": after the grace period an account
    // without MFA needs an app password, like an account with MFA. App
    // passwords keep working; with the sub-option off nothing changes.
    if (result.method !== 'app_password' && (await mailPrimaryPasswordBlocked(result.user.id))) {
      log.warn({ userId: result.user.id, protocol: ctx.protocol, ip: ctx.ip }, 'mail-auth: primary password blocked by the MFA enforcement');
      return { status: 'mfa_app_password_required' };
    }
    // 9.4: only after the credentials were verified (a wrong password stays `invalid`).
    const protocol = MAIL_PROTOCOL_ACCESS[ctx.protocol];
    if (protocol && !(await isProtocolAllowed(subject, protocol))) {
      log.warn({ userId: result.user.id, protocol, ip: ctx.ip }, 'mail-auth: protocol disabled for this account');
      return { status: 'protocol_disabled', userId: result.user.id, protocol };
    }
    // 8.x: User.lastLoginAt (throttled, fire-and-forget)
    void recordLastLogin(result.user.id);
    return result;
  } catch (error) {
    log.error({ err: error, protocol: ctx.protocol }, 'mail-auth: unexpected error');
    return { status: 'error', error };
  }
}

/** Remaining lock time (s) of a client IP; 0 when not locked. */
export async function mailAuthIpLockedFor(ip: string): Promise<number> {
  try {
    return await getVerifier().ipLockedFor(ip);
  } catch {
    return 0;
  }
}

let lockoutInstance: { lockout: LoginLockout; redis: MailAuthRedis | null } | null = null;

/**
 * v8.1: the mail-protocol lockout counters for other login front doors (the
 * web/API login in @coremail/storage/auth). Same Redis keys, limits (MAIL_AUTH_*)
 * and IP exemptions as verifyMailCredentials. Test seams: globalThis.__mailAuthRedis,
 * else globalThis.__authRedis (the auth-module fake), else the shared Redis client.
 */
export function sharedLoginLockout(): LoginLockout {
  const auth = (globalThis as { __authRedis?: unknown }).__authRedis;
  const redis = globalThis.__mailAuthRedis !== undefined
    ? globalThis.__mailAuthRedis
    : auth ? auth as MailAuthRedis : resolveRedis();
  if (!lockoutInstance || lockoutInstance.redis !== redis) {
    const exempt = createExemptIpMatcher(process.env['MAIL_AUTH_EXEMPT_CIDRS']);
    lockoutInstance = {
      redis,
      lockout: createLoginLockout({
        redis,
        limits: { ...limitsFromEnv(), ...(overrides.limits ?? {}) },
        isExemptIp: overrides.isExemptIp ?? exempt.isExempt,
        log,
      }),
    };
  }
  return lockoutInstance.lockout;
}
