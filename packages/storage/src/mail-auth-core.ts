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
 *
 * 10.5 (attack protection, docs/attack-protection.md):
 *  - Known clients (no lockout of victims by strangers): every successful login
 *    remembers the client network (IPv4 /24, IPv6 /56, hashed) and — when the
 *    front door knows one — the device id (ActiveSync DeviceId, hashed) for
 *    MAIL_AUTH_KNOWN_CLIENT_DAYS (30) per account. While the ACCOUNT is locked, a
 *    login from such a known network/device is still checked (failures keep
 *    counting per IP and per account); everybody else gets `locked`. The IP lock
 *    is never bypassed.
 *  - Every lock stores an info record next to it (same TTL): protocol, failures,
 *    strikes, time and — for accounts — the e-mail (the lock keys hold hashes only).
 *  - IP locks are counted in a 7-day window (`mailauth:ip:locks:<ip>`) for the
 *    repeat-offender escalation (attack-protection.ts).
 *  - `onLockoutEvent` reports failures, locks, refusals and known-client logins
 *    (security events, notifications). Hook errors are ignored.
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
  /**
   * 10.5: a stable client device id when the protocol has one (ActiveSync
   * DeviceId). Remembered per account after a successful login; a known device
   * may still log in while the account is locked by failures from elsewhere.
   */
  deviceId?: string | undefined;
}

/** 10.5: login surfaces reported by the lockout (mail protocols + web/API + admin MCP). */
export type LockoutProtocol = MailProtocol | 'web' | 'mcp';

/**
 * 10.5: what the shared lockout reports to `onLockoutEvent` (security events,
 * notifications, repeat-offender escalation). `account` is the normalised
 * login (e-mail) as typed — also for unknown accounts.
 */
export type LockoutEvent =
  | { kind: 'failure'; protocol: LockoutProtocol; ip: string | null; account: string | null; status: string }
  | {
      kind: 'lock'; scope: 'ip' | 'account'; protocol: LockoutProtocol; ip: string | null; account: string | null;
      strikes: number; lockSec: number; failures: number;
      /** IP locks only: number of locks of this IP in the 7-day window (incl. this one). */
      locksInWindow: number;
    }
  | { kind: 'refused'; scope: 'ip' | 'account'; protocol: LockoutProtocol; ip: string | null; account: string | null; retryAfterSec: number }
  | { kind: 'known_client'; protocol: LockoutProtocol; ip: string | null; account: string; via: 'network' | 'device' };

export type LockoutEventHook = (event: LockoutEvent) => void;

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
  /**
   * 10.5: how long a successful login keeps its network / device "known" for
   * the account (s). 0 disables the known-client exception (every login is
   * refused while the account is locked, the pre-10.5 behaviour).
   */
  knownClientTtlSec: number;
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
  knownClientTtlSec: 30 * 24 * 3600,
};

/** 10.5: window of the per-IP lock counter used by the repeat-offender escalation. */
export const REPEAT_LOCK_WINDOW_SEC = 7 * 24 * 3600;

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
  /** 10.5: lockout events (failures, locks, refusals, known clients). Errors are ignored. */
  onLockoutEvent?: LockoutEventHook;
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
 * 10.5: the eight 16-bit groups of an IPv6 address (`::` expanded, a trailing
 * dotted IPv4 part converted), or null when `raw` is not IPv6.
 */
export function ipv6Groups(raw: string): number[] | null {
  const ip = normalizeIp(raw);
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const b = v4.slice(1, 5).map(Number);
    text = `${text.slice(0, v4.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') as [string, string] : [text, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** 10.5: canonical text of eight IPv6 groups (no `::` compression — stable for hashing and CIDR text). */
export function formatIpv6Groups(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(':');
}

/**
 * 10.5: the client network a login is remembered for (known clients):
 * IPv4 → the /24, IPv6 → the /56 (a typical customer prefix). null for anything
 * that is not an IP address.
 */
export function clientNetworkOf(raw: string | null | undefined): string | null {
  const ip = normalizeIp(raw);
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  const g = ipv6Groups(ip);
  if (!g) return null;
  return `${formatIpv6Groups([g[0]!, g[1]!, g[2]!, g[3]! & 0xff00, 0, 0, 0, 0])}/56`;
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

/**
 * Redis keys of the shared lockout. `id` = the normalised client IP (scope ip)
 * or accountLockId(email) (scope acct). Exported for the admin view / unlock
 * (attack-protection.ts) — the only other reader and writer.
 */
export const LOCKOUT_KEYS = {
  fail: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:fail:${id}`,
  lock: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:lock:${id}`,
  strikes: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:strikes:${id}`,
  /** 10.5: JSON info record of a lock (same TTL as the lock) — for accounts the hash → e-mail mapping. */
  info: (scope: 'ip' | 'acct', id: string) => `mailauth:${scope}:info:${id}`,
  /** 10.5: IP locks within REPEAT_LOCK_WINDOW_SEC (repeat offenders). */
  locks: (ip: string) => `mailauth:ip:locks:${ip}`,
  /** 10.5: known client network / device of an account (hashed), TTL knownClientTtlSec. */
  knownNet: (acct: string, hash: string) => `mailauth:acct:known:${acct}:n:${hash}`,
  knownDevice: (acct: string, hash: string) => `mailauth:acct:known:${acct}:d:${hash}`,
} as const;
const KEY = LOCKOUT_KEYS;

/** Account id of the lockout keys: sha256 of the normalised e-mail (32 hex chars). */
export const accountLockId = (email: string): string => createHash('sha256').update(email).digest('hex').slice(0, 32);
const accountId = accountLockId;

/** 10.5: hashed (account-bound) identifiers of a known network / device. */
const knownHash = (acct: string, kind: 'n' | 'd', value: string): string =>
  createHash('sha256').update(`${acct}\0${kind}\0${value}`).digest('hex').slice(0, 24);

/** 10.5: the info record stored next to a lock (JSON). */
export interface LockInfo {
  protocol: string;
  /** Failures counted in the window that triggered the lock. */
  failures: number;
  strikes: number;
  /** Lock duration in seconds. */
  lockSec: number;
  /** ISO time of the lock. */
  lockedAt: string;
  /** Account locks: the normalised login (e-mail); IP locks: the last login tried. */
  account: string | null;
  /** Account locks: the IP of the failure that triggered the lock; IP locks: the IP itself. */
  ip: string | null;
}

/** Caps attacker-supplied text that ends up in Redis / the database. */
const cap = (s: string | null | undefined, n = 254): string | null => (s ? String(s).slice(0, n) : null);

export function hasMfa(user: Pick<UserRow, 'mfa'>): boolean {
  const mfa = user.mfa;
  if (!mfa) return false;
  if (mfa.totpEnabled) return true;
  const creds = mfa.webAuthnCredentials;
  return Array.isArray(creds) && creds.length > 0;
}

/// ─── Shared lockout (mail protocols + web login, v8.1) ──────────────────────

interface LockoutCoreDeps {
  redis: MailAuthRedis | null;
  limits?: Partial<MailAuthLimits> | undefined;
  log?: MailAuthLogger | undefined;
  /** 10.5: lockout events (security events, notifications, escalation). */
  onLockoutEvent?: LockoutEventHook | undefined;
}

/** 10.5: context of one counted failure (who/where — for the lock info and the events). */
interface FailureContext {
  protocol: LockoutProtocol;
  /** Normalised client IP (null when unknown). */
  ip: string | null;
  /** Normalised login (e-mail) as typed, also for unknown accounts. */
  account: string | null;
}

/** Counter primitives keyed by scope + id (shared by the verifier and createLoginLockout). */
function lockoutCore(deps: LockoutCoreDeps) {
  const limits: MailAuthLimits = { ...DEFAULT_MAIL_AUTH_LIMITS, ...(deps.limits ?? {}) };
  const log = deps.log;

  const emit = (event: LockoutEvent): void => {
    try { deps.onLockoutEvent?.(event); } catch { /* hooks never break a login */ }
  };

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

  async function countFailure(scope: 'ip' | 'acct', id: string, ctx: FailureContext): Promise<void> {
    const redis = deps.redis;
    if (!redis) return;
    const max = scope === 'ip' ? limits.ipMaxFailures : limits.accountMaxFailures;
    const windowSec = scope === 'ip' ? limits.ipWindowSec : limits.accountWindowSec;
    const base = scope === 'ip' ? limits.ipLockBaseSec : limits.accountLockBaseSec;
    const lockCap = scope === 'ip' ? limits.ipLockMaxSec : limits.accountLockMaxSec;
    try {
      const failKey = KEY.fail(scope, id);
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, windowSec);
      if (n >= max) {
        const strikesKey = KEY.strikes(scope, id);
        const strikes = await redis.incr(strikesKey);
        await redis.expire(strikesKey, 24 * 3600);
        const lockSec = Math.min(lockCap, base * 2 ** Math.min(strikes - 1, 20));
        await redis.set(KEY.lock(scope, id), String(strikes), 'EX', lockSec);
        await redis.del(failKey);
        // 10.5: info record next to the lock (same TTL) — accounts are keyed by a
        // hash, the admin view needs the e-mail; IP locks keep the last login tried.
        const info: LockInfo = {
          protocol: ctx.protocol, failures: n, strikes, lockSec, lockedAt: new Date().toISOString(),
          account: cap(ctx.account), ip: ctx.ip,
        };
        await redis.set(KEY.info(scope, id), JSON.stringify(info), 'EX', lockSec);
        // 10.5: repeat offenders — IP locks counted in a 7-day window (from the first lock).
        let locksInWindow = 0;
        if (scope === 'ip') {
          const locksKey = KEY.locks(id);
          locksInWindow = await redis.incr(locksKey);
          if (locksInWindow === 1) await redis.expire(locksKey, REPEAT_LOCK_WINDOW_SEC);
        }
        log?.warn({ scope, failures: n, strikes, lockSec, protocol: ctx.protocol }, 'mail-auth: lockout');
        emit({
          kind: 'lock', scope: scope === 'ip' ? 'ip' : 'account', protocol: ctx.protocol, ip: ctx.ip,
          account: cap(ctx.account), strikes, lockSec, failures: n, locksInWindow,
        });
      }
    } catch (err) {
      log?.error({ err, scope }, 'mail-auth: Redis error while counting a failure');
    }
  }

  /** Counts one failure for the (non-exempt) IP and the account, reports it. */
  async function countLoginFailure(ipId: string | null, acctId: string | null, ctx: FailureContext, status: string): Promise<void> {
    await Promise.all([
      ipId ? countFailure('ip', ipId, ctx) : Promise.resolve(),
      acctId ? countFailure('acct', acctId, ctx) : Promise.resolve(),
    ]);
    emit({ kind: 'failure', protocol: ctx.protocol, ip: ctx.ip, account: cap(ctx.account), status });
  }

  /**
   * 10.5: has this account logged in successfully from the client's network
   * (IPv4 /24, IPv6 /56) or with this device id within knownClientTtlSec?
   * Redis errors → false (no exception from the lock: fail closed for the
   * exception, the lock itself already failed open when Redis is down).
   */
  async function knownClient(acctId: string, ip: string | null, deviceId: string | null | undefined): Promise<'network' | 'device' | null> {
    const redis = deps.redis;
    if (!redis || limits.knownClientTtlSec <= 0) return null;
    try {
      const net = clientNetworkOf(ip);
      if (net && (await redis.ttl(KEY.knownNet(acctId, knownHash(acctId, 'n', net)))) > 0) return 'network';
      const dev = (deviceId ?? '').trim();
      if (dev && (await redis.ttl(KEY.knownDevice(acctId, knownHash(acctId, 'd', dev)))) > 0) return 'device';
    } catch (err) {
      log?.error({ err }, 'mail-auth: Redis error while checking a known client');
    }
    return null;
  }

  /** 10.5: remembers the network / device of a successful login (refreshes the TTL). */
  async function rememberClient(acctId: string, ip: string | null, deviceId: string | null | undefined): Promise<void> {
    const redis = deps.redis;
    if (!redis || limits.knownClientTtlSec <= 0) return;
    try {
      const net = clientNetworkOf(ip);
      if (net) await redis.set(KEY.knownNet(acctId, knownHash(acctId, 'n', net)), '1', 'EX', limits.knownClientTtlSec);
      const dev = (deviceId ?? '').trim();
      if (dev) await redis.set(KEY.knownDevice(acctId, knownHash(acctId, 'd', dev.slice(0, 256))), '1', 'EX', limits.knownClientTtlSec);
    } catch { /* non-critical */ }
  }

  /**
   * The lock decision for one attempt: IP lock first (never bypassed), then the
   * account lock unless the client is known for the account (10.5).
   */
  async function decide(
    ipId: string | null, acctId: string, ctx: FailureContext, deviceId: string | null | undefined,
  ): Promise<{ locked: false } | { locked: true; scope: 'ip' | 'account'; retryAfterSec: number }> {
    const [ipTtl, acctTtl] = await Promise.all([
      ipId ? lockTtl('ip', ipId) : Promise.resolve(0),
      lockTtl('acct', acctId),
    ]);
    if (ipTtl > 0) {
      emit({ kind: 'refused', scope: 'ip', protocol: ctx.protocol, ip: ctx.ip, account: cap(ctx.account), retryAfterSec: Math.max(ipTtl, acctTtl) });
      return { locked: true, scope: 'ip', retryAfterSec: Math.max(ipTtl, acctTtl) };
    }
    if (acctTtl > 0) {
      const via = await knownClient(acctId, ctx.ip, deviceId);
      if (via && ctx.account) {
        log?.info({ protocol: ctx.protocol, via }, 'mail-auth: account locked — known client may still log in');
        emit({ kind: 'known_client', protocol: ctx.protocol, ip: ctx.ip, account: ctx.account, via });
        return { locked: false };
      }
      emit({ kind: 'refused', scope: 'account', protocol: ctx.protocol, ip: ctx.ip, account: cap(ctx.account), retryAfterSec: acctTtl });
      return { locked: true, scope: 'account', retryAfterSec: acctTtl };
    }
    return { locked: false };
  }

  return { lockTtl, countFailure, countLoginFailure, knownClient, rememberClient, decide, emit };
}

export interface LoginLockoutDeps {
  redis: MailAuthRedis | null;
  limits?: Partial<MailAuthLimits> | undefined;
  /** IPs that skip the per-IP counter (default: loopback only, like mail since v8.1). */
  isExemptIp?: ((ip: string) => boolean) | undefined;
  log?: MailAuthLogger | undefined;
  /** 10.5: lockout events. */
  onLockoutEvent?: LockoutEventHook | undefined;
  /** 10.5: the login surface reported in events (default 'web'). */
  protocol?: LockoutProtocol | undefined;
}

export interface LoginLockState {
  locked: boolean;
  scope?: 'ip' | 'account';
  retryAfterSec: number;
}

/** 10.5: optional client details of a front door (known-client exception). */
export interface LoginClientHints {
  /** Stable device id (ActiveSync DeviceId); web logins have none. */
  deviceId?: string | null | undefined;
}

/**
 * The Redis failure counters of the mail-protocol check, usable by other login
 * front doors (v8.1: the web/API login). Same keys, limits and backoff as
 * verifyMailCredentials — a failure on the web counts against the mail budget
 * and vice versa. Accounts are keyed by the normalised e-mail.
 */
export interface LoginLockout {
  /**
   * Lock state of an account (normalised e-mail) and an optional client IP.
   * 10.5: an account lock does not apply to a client known for the account
   * (successful login from its network / device within knownClientTtlSec).
   */
  check(email: string, ip?: string | null, hints?: LoginClientHints): Promise<LoginLockState>;
  /** Counts one failed attempt for the account and the (non-exempt) IP. */
  fail(email: string, ip?: string | null): Promise<void>;
  /**
   * Resets the ACCOUNT counter (never the per-IP counter). 10.5: with the client
   * IP (and device) the client is remembered as known for the account.
   */
  success(email: string, ip?: string | null, hints?: LoginClientHints): Promise<void>;
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
  const protocol: LockoutProtocol = deps.protocol ?? 'web';
  const core = lockoutCore(deps);
  const ipKey = (raw: string | null | undefined): string | null => {
    const ip = normalizeIp(raw);
    return ip && isIP(ip) !== 0 && !isExempt(ip) ? ip : null;
  };
  const ctxOf = (email: string | null, rawIp: string | null | undefined): FailureContext => {
    const ip = normalizeIp(rawIp);
    return { protocol, ip: ip && isIP(ip) !== 0 ? ip : null, account: email };
  };
  return {
    async check(email, rawIp, hints) {
      const d = await core.decide(ipKey(rawIp), accountId(email), ctxOf(email, rawIp), hints?.deviceId);
      return d.locked ? { locked: true, scope: d.scope, retryAfterSec: d.retryAfterSec } : { locked: false, retryAfterSec: 0 };
    },
    async fail(email, rawIp) {
      await core.countLoginFailure(ipKey(rawIp), accountId(email), ctxOf(email, rawIp), 'invalid');
    },
    async success(email, rawIp, hints) {
      if (!deps.redis) return;
      const acct = accountId(email);
      try { await deps.redis.del(KEY.fail('acct', acct)); } catch { /* non-critical */ }
      const ip = normalizeIp(rawIp);
      if (ip || hints?.deviceId) await core.rememberClient(acct, ip || null, hints?.deviceId);
    },
    async ipLockedFor(rawIp) {
      const ipId = ipKey(rawIp);
      return ipId ? core.lockTtl('ip', ipId) : 0;
    },
    async failIp(rawIp) {
      await core.countLoginFailure(ipKey(rawIp), null, ctxOf(null, rawIp), 'invalid');
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

  const core = lockoutCore({ redis: deps.redis, limits: deps.limits, log, onLockoutEvent: deps.onLockoutEvent });
  const { lockTtl } = core;

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
    const failCtx: FailureContext = { protocol: ctx.protocol, ip: ip && isIP(ip) !== 0 ? ip : null, account: email ?? cap(String(login ?? '')) };

    // 1) Lockout check — on every attempt, before any password work.
    //    10.5: an account lock does not apply to a known client of the account.
    const decision = await core.decide(ipId, acctId, failCtx, ctx.deviceId);
    if (decision.locked) {
      report('locked', email ?? '');
      return { status: 'locked', scope: decision.scope, retryAfterSec: decision.retryAfterSec };
    }

    const fail = async (status: 'invalid' | 'mfa_app_password_required', userId?: string): Promise<MailAuthResult> => {
      await core.countLoginFailure(ipId, acctId, failCtx, status);
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
      // 10.5: remember the client (network / device) for the known-client exception.
      await core.rememberClient(acctId, failCtx.ip, ctx.deviceId);
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
