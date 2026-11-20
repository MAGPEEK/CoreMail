/**
 * Shared credential check for every mail protocol (SMTP AUTH, IMAP, POP3,
 * ActiveSync, Autodiscover, JMAP Basic, CalDAV/CardDAV Basic).
 *
 * This file has NO runtime imports besides node built-ins: every dependency
 * (Prisma, Redis, password hashing) is injected. `mail-auth.ts` wires the real
 * implementations; tests and the protocol reviewer suites inject fakes.
 *
 * Rules (v7.0.0):
 *  - Login normalisation: trim, `DOMAIN\user` → `user`, lower-case, a bare
 *    user name is completed with the primary domain. Only active users.
 *  - Primary password via verifyPassword() (bcrypt(sha256(password + PEPPER))),
 *    app passwords (AppPassword.hash, same scheme) update lastUsedAt.
 *  - MFA: a user with TOTP enabled or WebAuthn credentials can NOT use the
 *    primary password on a mail protocol — only app passwords work. A correct
 *    primary password is reported as `mfa_app_password_required` (and counts
 *    as a failed attempt).
 *  - Brute-force protection shared by all protocols: Redis failure counters per
 *    client IP and per account, lockout with exponential backoff, checked on
 *    every attempt. A successful login resets the ACCOUNT counter only — never
 *    the per-IP counter (an attacker with one valid account must not be able to
 *    reset the IP budget).
 *  - Per-IP exemption (v8.1): only loopback by default; private ranges are
 *    counted like public ones (behind a reverse proxy or the Docker userland
 *    proxy every attacker would otherwise look exempt). Trusted internal
 *    networks are configured explicitly (createExemptIpMatcher /
 *    MAIL_AUTH_EXEMPT_CIDRS).
 *  - Unknown users are verified against a dummy hash (equal bcrypt cost).
 *  - Database errors → `error` (temporary failure), never `invalid`.
 *    Redis errors fail open (logged): mail keeps working while Redis is down.
 *  - Extension point for directory backends (LDAP …): registerExternalPasswordVerifier().
 */
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MailProtocol =
  | 'smtp' | 'imap' | 'pop3' | 'activesync' | 'autodiscover' | 'jmap' | 'caldav' | 'mapi';

export interface MailAuthContext {
  /** Client IP address (IPv4-mapped IPv6 is normalised). */
  ip?: string | undefined;
  protocol: MailProtocol;
}

export interface MailAuthUser {
  id: string;
  email: string;
  displayName: string;
  domainId: string;
  role: string;
  /** The user's mailbox (1:1), null if none is provisioned. */
  mailboxId: string | null;
}

export type MailAuthResult =
  | { status: 'ok'; user: MailAuthUser; method: 'password' | 'app_password' | 'external'; /** v7.1.0: the app password used (method app_password). */ appPasswordId?: string }
  | { status: 'invalid' }
  | { status: 'locked'; scope: 'ip' | 'account'; retryAfterSec: number }
  | { status: 'mfa_app_password_required' }
  | { status: 'error'; error: unknown }
  /**
   * 9.4: the credentials were correct, but the protocol is switched off for
   * the account (protocol-access.ts). Only returned by verifyMailCredentials()
   * (mail-auth.ts) — never before the credentials were verified.
   */
  | { status: 'protocol_disabled'; userId: string; protocol: string };

/** Minimal Redis surface (ioredis compatible). */
export interface MailAuthRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

interface UserRow {
  id: string;
  email: string;
  displayName?: string | null;
  domainId?: string | null;
  role?: string | null;
  active?: boolean;
  passwordHash?: string | null;
  authSource?: string | null;
  mfa?: { totpEnabled?: boolean | null; webAuthnCredentials?: unknown } | null;
  mailbox?: { id: string } | null;
}

/** Minimal Prisma surface used by the check. */
export interface MailAuthPrisma {
  user: { findFirst(args: unknown): Promise<unknown> };
  appPassword: {
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  domain: { findFirst(args: unknown): Promise<unknown> };
}

/**
 * Extension point for directory backends (LDAP / Active Directory, …).
 * Called for users without MFA whose local password and app passwords did not
 * match. Return true to accept the password, false to reject it; throwing is
 * treated as a temporary failure (`error`).
 */
export type ExternalPasswordVerifier = (
  user: { id: string; email: string; authSource: string },
  password: string,
  ctx: MailAuthContext,
) => Promise<boolean>;

export interface MailAuthLimits {
  ipMaxFailures: number;
  ipWindowSec: number;
  ipLockBaseSec: number;
  ipLockMaxSec: number;
  accountMaxFailures: number;
  accountWindowSec: number;
  accountLockBaseSec: number;
  accountLockMaxSec: number;
}

export const DEFAULT_MAIL_AUTH_LIMITS: MailAuthLimits = {
  ipMaxFailures: 50,
  ipWindowSec: 15 * 60,
  ipLockBaseSec: 15 * 60,
  ipLockMaxSec: 24 * 3600,
  accountMaxFailures: 10,
  accountWindowSec: 15 * 60,
  accountLockBaseSec: 5 * 60,
  accountLockMaxSec: 3600,
};

export interface MailAuthLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface MailAuthDeps {
  prisma: MailAuthPrisma;
  /** null disables the lockout (e.g. no Redis available). */
  redis: MailAuthRedis | null;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  /** A hash with the production cost factor; verified for unknown users (timing). */
  dummyHash(): Promise<string>;
  limits?: Partial<MailAuthLimits>;
  /**
   * IPs that are not subject to the per-IP counter. Default (v8.1): loopback
   * only — private peers are counted. Operators widen it with
   * createExemptIpMatcher(MAIL_AUTH_EXEMPT_CIDRS).
   */
  isExemptIp?: (ip: string) => boolean;
  /** External verifiers (default: the global registry). */
  externalVerifiers?: () => ExternalPasswordVerifier[];
  log?: MailAuthLogger;
  /** Called after every attempt (audit/attack dashboards). Errors are ignored. */
  onAttempt?: (event: MailAuthAttemptEvent) => void;
}

export interface MailAuthAttemptEvent {
  protocol: MailProtocol;
  ip: string | null;
  login: string;
  status: MailAuthResult['status'];
  userId?: string;
}

// ─── IP helpers ──────────────────────────────────────────────────────────────

const PRIVATE_V4: Array<[string, number]> = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['100.64.0.0', 10],
];
const PRIVATE_V6: Array<[string, number]> = [['fc00::', 7], ['fe80::', 10], ['::1', 128]];

const privateBlockList = new BlockList();
for (const [net, prefix] of PRIVATE_V4) privateBlockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of PRIVATE_V6) privateBlockList.addSubnet(net, prefix, 'ipv6');

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`, trims, strips an IPv6 zone. */
export function normalizeIp(ip: string | null | undefined): string {
  if (!ip) return '';
  let v = ip.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(v)) v = v.slice(7);
  return v;
}

/**
 * True for loopback, RFC 1918, CGNAT, link-local and IPv6 ULA/link-local
 * addresses. CIDR based (net.BlockList) — `172.32.x.x` or `172.200.x.x` are public.
 */
export function isPrivateOrLoopbackIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  const family = isIP(ip);
  if (family === 4) return privateBlockList.check(ip, 'ipv4');
  if (family === 6) return privateBlockList.check(ip, 'ipv6');
  return false;
}

/** True for 127.0.0.0/8 and ::1. */
export function isLoopbackIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

/**
 * Builds the per-IP brute-force exemption predicate: loopback (127.0.0.0/8,
 * ::1) is always exempt, plus every IP or CIDR of `raw` (comma/space separated,
 * e.g. MAIL_AUTH_EXEMPT_CIDRS="10.0.0.0/8, fd00::/8, 192.0.2.7"). Entries that
 * are not a valid IP/CIDR are ignored and returned in `invalid` (the caller logs
 * them) — a typo must never turn into "exempt everything".
 */
export function createExemptIpMatcher(raw: string | null | undefined): { isExempt: (ip: string) => boolean; invalid: string[] } {
  const list = new BlockList();
  const invalid: string[] = [];
  let entries = 0;
  for (const entry of (raw ?? '').split(/[\s,]+/).map((e) => e.trim()).filter(Boolean)) {
    const slash = entry.indexOf('/');
    const addr = normalizeIp(slash === -1 ? entry : entry.slice(0, slash));
    const family = isIP(addr);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefixText = slash === -1 ? String(maxPrefix) : entry.slice(slash + 1);
    const prefix = Number(prefixText);
    if (family === 0 || !/^\d{1,3}$/.test(prefixText) || prefix > maxPrefix) {
      invalid.push(entry);
      continue;
    }
    list.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
    entries++;
  }
  const isExempt = (rawIp: string): boolean => {
    const ip = normalizeIp(rawIp);
    if (isLoopbackIp(ip)) return true;
    if (entries === 0) return false;
    const family = isIP(ip);
    if (family === 4) return list.check(ip, 'ipv4');
    if (family === 6) return list.check(ip, 'ipv6');
    return false;
  };
  return { isExempt, invalid };
}

/**
 * Client IP for an HTTP request that may have been proxied by the api-gateway
 * (which runs on loopback in the same container). The X-Forwarded-For header
 * is only honoured when the direct peer is loopback/private (a proxy), and the
 * right-most entry is used (the address the nearest proxy saw).
 */
export function clientIpFromRequest(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  const peer = normalizeIp(remoteAddress);
  if (!peer || !isPrivateOrLoopbackIp(peer)) return peer;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header.split(',').map((h) => normalizeIp(h)).filter((h) => isIP(h) !== 0);
  return hops.length ? hops[hops.length - 1]! : peer;
}

// ─── External verifier registry (LDAP extension point) ──────────────────────

const externalRegistry = new Map<string, ExternalPasswordVerifier>();

/**
 * Registers a directory backend (e.g. 'ldap') for mail-protocol logins.
 * Re-registering a name replaces the previous verifier.
 */
export function registerExternalPasswordVerifier(name: string, verifier: ExternalPasswordVerifier): void {
  externalRegistry.set(name, verifier);
}

export function unregisterExternalPasswordVerifier(name: string): void {
  externalRegistry.delete(name);
}

export function listExternalPasswordVerifiers(): ExternalPasswordVerifier[] {
  return [...externalRegistry.values()];
}

// ─── In-memory Redis (tests, fallback) ───────────────────────────────────────

/** A tiny in-memory implementation of MailAuthRedis (TTL aware). */
export function createMemoryAuthRedis(now: () => number = Date.now): MailAuthRedis & { keys(): string[] } {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= now()) { store.delete(key); return undefined; }
    return e;
  };
  return {
    async incr(key) {
      const e = live(key);
      const n = (e ? parseInt(e.value, 10) || 0 : 0) + 1;
      store.set(key, { value: String(n), expiresAt: e?.expiresAt ?? null });
      return n;
    },
    async expire(key, seconds) {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = now() + seconds * 1000;
      return 1;
    },
    async ttl(key) {
      const e = live(key);
      if (!e) return -2;
      if (e.expiresAt === null) return -1;
      return Math.max(1, Math.ceil((e.expiresAt - now()) / 1000));
    },
    async set(key, value, _mode, seconds) {
      store.set(key, { value, expiresAt: now() + seconds * 1000 });
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    keys() { return [...store.keys()].filter((k) => live(k)); },
  };
}

// ─── Verifier ────────────────────────────────────────────────────────────────

export interface MailCredentialVerifier {
  verify(login: string, password: string, ctx: MailAuthContext): Promise<MailAuthResult>;
  /** Normalised login (e-mail form) or null; throws on database errors. */
  normalizeLogin(login: string): Promise<string | null>;
  /** Remaining lock time for an IP (0 = not locked). Redis errors → 0. */
  ipLockedFor(ip: string): Promise<number>;
}

const KEY = {
  fail: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:fail:${id}`,
  lock: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:lock:${id}`,
  strikes: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:strikes:${id}`,
};

const accountId = (email: string): string => createHash('sha256').update(email).digest('hex').slice(0, 32);

export function hasMfa(user: Pick<UserRow, 'mfa'>): boolean {
  const mfa = user.mfa;
  if (!mfa) return false;
  if (mfa.totpEnabled) return true;
  const creds = mfa.webAuthnCredentials;
  return Array.isArray(creds) && creds.length > 0;
}

// ─── Shared lockout (mail protocols + web login, v8.1) ──────────────────────

interface LockoutCoreDeps {
  redis: MailAuthRedis | null;
  limits?: Partial<MailAuthLimits> | undefined;
  log?: MailAuthLogger | undefined;
}

/** Counter primitives keyed by scope + id (shared by the verifier and createLoginLockout). */
function lockoutCore(deps: LockoutCoreDeps) {
  const limits: MailAuthLimits = { ...DEFAULT_MAIL_AUTH_LIMITS, ...(deps.limits ?? {}) };
  const log = deps.log;

  async function lockTtl(scope: 'ip' | 'acct', id: string): Promise<number> {
    if (!deps.redis) return 0;
    try {
      const ttl = await deps.redis.ttl(KEY.lock(scope, id));
      return ttl > 0 ? ttl : 0;
    } catch (err) {
      log?.error({ err, scope }, 'mail-auth: Redis error while checking lock — failing open');
      return 0;
    }
  }

  async function countFailure(scope: 'ip' | 'acct', id: string): Promise<void> {
    const redis = deps.redis;
    if (!redis) return;
    const max = scope === 'ip' ? limits.ipMaxFailures : limits.accountMaxFailures;
    const windowSec = scope === 'ip' ? limits.ipWindowSec : limits.accountWindowSec;
    const base = scope === 'ip' ? limits.ipLockBaseSec : limits.accountLockBaseSec;
    const cap = scope === 'ip' ? limits.ipLockMaxSec : limits.accountLockMaxSec;
    try {
      const failKey = KEY.fail(scope, id);
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, windowSec);
      if (n >= max) {
        const strikesKey = KEY.strikes(scope, id);
        const strikes = await redis.incr(strikesKey);
        await redis.expire(strikesKey, 24 * 3600);
        const lockSec = Math.min(cap, base * 2 ** Math.min(strikes - 1, 20));
        await redis.set(KEY.lock(scope, id), String(strikes), 'EX', lockSec);
        await redis.del(failKey);
        log?.warn({ scope, failures: n, strikes, lockSec }, 'mail-auth: lockout');
      }
    } catch (err) {
      log?.error({ err, scope }, 'mail-auth: Redis error while counting a failure');
    }
  }

  return { lockTtl, countFailure };
}

export interface LoginLockoutDeps {
  redis: MailAuthRedis | null;
  limits?: Partial<MailAuthLimits> | undefined;
  /** IPs that skip the per-IP counter (default: loopback only, like mail since v8.1). */
  isExemptIp?: ((ip: string) => boolean) | undefined;
  log?: MailAuthLogger | undefined;
}

export interface LoginLockState {
  locked: boolean;
  scope?: 'ip' | 'account';
  retryAfterSec: number;
}

/**
 * The Redis failure counters of the mail-protocol check, usable by other login
 * front doors (v8.1: the web/API login). Same keys, limits and backoff as
 * verifyMailCredentials — a failure on the web counts against the mail budget
 * and vice versa. Accounts are keyed by the normalised e-mail.
 */
export interface LoginLockout {
  /** Lock state of an account (normalised e-mail) and an optional client IP. */
  check(email: string, ip?: string | null): Promise<LoginLockState>;
  /** Counts one failed attempt for the account and the (non-exempt) IP. */
  fail(email: string, ip?: string | null): Promise<void>;
  /** Resets the ACCOUNT counter (never the per-IP counter). */
  success(email: string): Promise<void>;
  /**
   * 10.3: remaining lock time (s) of a client IP alone, 0 when not locked —
   * for front doors without an account name (admin MCP bearer tokens).
   */
  ipLockedFor(ip: string | null | undefined): Promise<number>;
  /** 10.3: counts one failed attempt for the (non-exempt) client IP only. */
  failIp(ip: string | null | undefined): Promise<void>;
}

export function createLoginLockout(deps: LoginLockoutDeps): LoginLockout {
  const isExempt = deps.isExemptIp ?? isLoopbackIp;
  const { lockTtl, countFailure } = lockoutCore(deps);
  const ipKey = (raw: string | null | undefined): string | null => {
    const ip = normalizeIp(raw);
    return ip && isIP(ip) !== 0 && !isExempt(ip) ? ip : null;
  };
  return {
    async check(email, rawIp) {
      const ipId = ipKey(rawIp);
      const [ipTtl, acctTtl] = await Promise.all([
        ipId ? lockTtl('ip', ipId) : Promise.resolve(0),
        lockTtl('acct', accountId(email)),
      ]);
      if (ipTtl > 0 || acctTtl > 0) {
        return { locked: true, scope: ipTtl > 0 ? 'ip' : 'account', retryAfterSec: Math.max(ipTtl, acctTtl) };
      }
      return { locked: false, retryAfterSec: 0 };
    },
    async fail(email, rawIp) {
      const ipId = ipKey(rawIp);
      await Promise.all([ipId ? countFailure('ip', ipId) : Promise.resolve(), countFailure('acct', accountId(email))]);
    },
    async success(email) {
      if (!deps.redis) return;
      try { await deps.redis.del(KEY.fail('acct', accountId(email))); } catch { /* non-critical */ }
    },
    async ipLockedFor(rawIp) {
      const ipId = ipKey(rawIp);
      return ipId ? lockTtl('ip', ipId) : 0;
    },
    async failIp(rawIp) {
      const ipId = ipKey(rawIp);
      if (ipId) await countFailure('ip', ipId);
    },
  };
}

export function createMailCredentialVerifier(deps: MailAuthDeps): MailCredentialVerifier {
  const isExempt = deps.isExemptIp ?? isLoopbackIp;
  const externals = deps.externalVerifiers ?? listExternalPasswordVerifiers;
  const log = deps.log;

  const safeVerify = async (password: string, hash: string): Promise<boolean> => {
    try { return await deps.verifyPassword(password, hash); } catch { return false; }
  };
  const burnDummy = async (password: string): Promise<void> => {
    try { await deps.verifyPassword(password, await deps.dummyHash()); } catch { /* timing only */ }
  };

  async function normalizeLogin(login: string): Promise<string | null> {
    let name = (login ?? '').trim();
    const bs = name.lastIndexOf('\\');
    if (bs !== -1) name = name.slice(bs + 1);
    name = name.trim().toLowerCase();
    if (!name || /[\s\0]/.test(name)) return null;
    if (!name.includes('@')) {
      const primary = await deps.prisma.domain.findFirst({
        where: { primary: true, active: true },
        select: { name: true },
      }) as { name?: string } | null;
      if (primary?.name) name = `${name}@${primary.name.toLowerCase()}`;
    }
    return name;
  }

  const { lockTtl, countFailure } = lockoutCore({ redis: deps.redis, limits: deps.limits, log });

  async function verify(login: string, password: string, ctx: MailAuthContext): Promise<MailAuthResult> {
    const ip = normalizeIp(ctx.ip);
    const ipId = ip && !isExempt(ip) ? ip : null;
    const report = (status: MailAuthResult['status'], email: string, userId?: string) => {
      try {
        deps.onAttempt?.({ protocol: ctx.protocol, ip: ip || null, login: email, status, ...(userId ? { userId } : {}) });
      } catch { /* ignore */ }
    };

    let email: string | null;
    try {
      email = await normalizeLogin(login);
    } catch (error) {
      log?.error({ err: error, protocol: ctx.protocol }, 'mail-auth: database error (domain lookup)');
      report('error', String(login ?? ''));
      return { status: 'error', error };
    }
    const acctId = accountId(email ?? `invalid:${String(login ?? '')}`);

    // 1) Lockout check — on every attempt, before any password work.
    const [ipTtl, acctTtl] = await Promise.all([
      ipId ? lockTtl('ip', ipId) : Promise.resolve(0),
      lockTtl('acct', acctId),
    ]);
    if (ipTtl > 0 || acctTtl > 0) {
      const scope = ipTtl > 0 ? 'ip' : 'account';
      report('locked', email ?? '');
      return { status: 'locked', scope, retryAfterSec: Math.max(ipTtl, acctTtl) };
    }

    const fail = async (status: 'invalid' | 'mfa_app_password_required', userId?: string): Promise<MailAuthResult> => {
      await Promise.all([ipId ? countFailure('ip', ipId) : Promise.resolve(), countFailure('acct', acctId)]);
      log?.warn({ protocol: ctx.protocol, ip, login: email, status }, 'mail-auth: login failed');
      report(status, email ?? '', userId);
      return { status };
    };

    if (!email || !password) {
      if (password) await burnDummy(password);
      return fail('invalid');
    }

    // 2) User lookup (active users only).
    let user: UserRow | null;
    let appPasswords: Array<{ id: string; hash: string }>;
    try {
      user = await deps.prisma.user.findFirst({
        where: { email, active: true },
        select: {
          id: true, email: true, displayName: true, domainId: true, role: true, active: true,
          passwordHash: true, authSource: true,
          mfa: { select: { totpEnabled: true, webAuthnCredentials: true } },
          mailbox: { select: { id: true } },
        },
      }) as UserRow | null;
      if (user && user.active === false) user = null;
      appPasswords = user
        ? ((await deps.prisma.appPassword.findMany({
            where: { userId: user.id },
            select: { id: true, hash: true },
          })) as Array<{ id: string; hash: string }> | null) ?? []
        : [];
    } catch (error) {
      log?.error({ err: error, protocol: ctx.protocol }, 'mail-auth: database error');
      report('error', email);
      return { status: 'error', error };
    }

    if (!user) {
      await burnDummy(password);
      return fail('invalid');
    }

    const succeed = async (method: 'password' | 'app_password' | 'external', appPasswordId?: string): Promise<MailAuthResult> => {
      if (appPasswordId) {
        void Promise.resolve()
          .then(() => deps.prisma.appPassword.update({ where: { id: appPasswordId }, data: { lastUsedAt: new Date() } }))
          .catch((err: unknown) => log?.warn({ err }, 'mail-auth: lastUsedAt update failed'));
      }
      // Reset the ACCOUNT counter only. The per-IP counter is never reset by a
      // success, otherwise one valid account would refill an attacker's budget.
      if (deps.redis) {
        try { await deps.redis.del(KEY.fail('acct', acctId)); } catch { /* non-critical */ }
      }
      report('ok', user!.email, user!.id);
      return {
        status: 'ok',
        method,
        ...(appPasswordId ? { appPasswordId } : {}),
        user: {
          id: user!.id,
          email: user!.email,
          displayName: user!.displayName ?? user!.email,
          domainId: user!.domainId ?? '',
          role: user!.role ?? 'USER',
          mailboxId: user!.mailbox?.id ?? null,
        },
      };
    };

    const matchAppPassword = async (): Promise<string | null> => {
      for (const ap of appPasswords) {
        if (await safeVerify(password, ap.hash)) return ap.id;
      }
      return null;
    };

    if (hasMfa(user)) {
      // MFA accounts: app passwords only.
      const apId = await matchAppPassword();
      if (apId) return succeed('app_password', apId);
      const primaryOk = user.passwordHash ? await safeVerify(password, user.passwordHash) : (await burnDummy(password), false);
      return fail(primaryOk ? 'mfa_app_password_required' : 'invalid', user.id);
    }

    if (user.passwordHash) {
      if (await safeVerify(password, user.passwordHash)) return succeed('password');
    } else {
      await burnDummy(password);
    }
    const apId = await matchAppPassword();
    if (apId) return succeed('app_password', apId);

    // 3) Extension point: directory backends (LDAP …) for non-local users.
    const authSource = user.authSource ?? 'LOCAL';
    if (authSource !== 'LOCAL') {
      for (const ext of externals()) {
        let ok: boolean;
        try {
          ok = await ext({ id: user.id, email: user.email, authSource }, password, ctx);
        } catch (error) {
          log?.error({ err: error, protocol: ctx.protocol }, 'mail-auth: external verifier error');
          report('error', email, user.id);
          return { status: 'error', error };
        }
        if (ok) return succeed('external');
      }
    }

    return fail('invalid', user.id);
  }

  return {
    verify,
    normalizeLogin,
    async ipLockedFor(rawIp: string) {
      const ip = normalizeIp(rawIp);
      if (!ip || isExempt(ip)) return 0;
      return lockTtl('ip', ip);
    },
  };
}
