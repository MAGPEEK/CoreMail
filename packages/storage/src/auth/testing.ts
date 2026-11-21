/**
 * In-memory fakes for auth tests (infra-free): a minimal Prisma client for the
 * models the auth module touches, and a Redis stand-in. Install them BEFORE
 * importing @coremail/storage:
 *
 *   const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
 *   globalThis.__prisma = createFakePrisma(); globalThis.__authRedis = createFakeRedis();
 *
 * This module must not import anything from @coremail/storage itself.
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

function isPlainObject(v: unknown): v is Row {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b || (a == null && b == null);
}

function num(v: unknown): number {
  return v instanceof Date ? v.getTime() : Number(v);
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w as Row));
    if (k === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Row));
    const v = row[k];
    if (isPlainObject(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case 'in': return (arg as unknown[]).some((x) => eq(x, v));
          case 'lt': return v != null && num(v) < num(arg);
          case 'lte': return v != null && num(v) <= num(arg);
          case 'gt': return v != null && num(v) > num(arg);
          case 'gte': return v != null && num(v) >= num(arg);
          case 'not': return !eq(v, arg);
          case 'equals':
            return cond['mode'] === 'insensitive' && typeof v === 'string' && typeof arg === 'string'
              ? v.toLowerCase() === arg.toLowerCase() : eq(v, arg);
          case 'mode': return true;
          case 'has': return Array.isArray(v) && v.includes(arg);
          default: throw new Error(`fake prisma: unsupported operator ${op}`);
        }
      });
    }
    return eq(v, cond);
  });
}

function clone(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (isPlainObject(v) && 'increment' in v) row[k] = Number(row[k] ?? 0) + Number(v['increment']);
    else if (isPlainObject(v) && 'set' in v) row[k] = v['set'];
    else row[k] = Array.isArray(v) ? [...v] : v;
  }
}

type Defaults = () => Row;

const tick = () => new Promise<void>((r) => setImmediate(r));

export class FakeTable {
  rows: Row[] = [];
  constructor(
    private readonly defaults: Defaults,
    private readonly unique: string[] = ['id'],
    private readonly relations: Record<string, () => FakeTable> = {},
  ) {}

  private project(row: Row, args: { include?: Row } | undefined): Row {
    const out = clone(row);
    if (args?.include) {
      for (const rel of Object.keys(args.include)) {
        const table = this.relations[rel]?.();
        if (table) {
          const r = table.rows.find((x) => x['id'] === row[`${rel}Id`]);
          out[rel] = r ? clone(r) : null;
        }
      }
    }
    return out;
  }

  private checkUnique(row: Row, ignore?: Row): void {
    for (const key of this.unique) {
      if (row[key] == null) continue;
      if (this.rows.some((r) => r !== ignore && eq(r[key], row[key]))) {
        throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
      }
    }
  }

  findUnique = async (args: { where: Row; include?: Row }) => {
    await tick();
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? this.project(r, args) : null;
  };
  findFirst = async (args: { where?: Row; include?: Row } = {}) => {
    await tick();
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? this.project(r, args) : null;
  };
  findMany = async (args: { where?: Row; include?: Row } = {}) => {
    await tick();
    return this.rows.filter((x) => matches(x, args.where)).map((r) => this.project(r, args));
  };
  count = async (args: { where?: Row } = {}) => {
    await tick();
    return this.rows.filter((x) => matches(x, args.where)).length;
  };
  create = async (args: { data: Row }) => {
    await tick();
    const row: Row = { id: randomUUID(), ...this.defaults() };
    applyData(row, args.data);
    this.checkUnique(row);
    this.rows.push(row);
    return clone(row);
  };
  update = async (args: { where: Row; data: Row }) => {
    await tick();
    const r = this.rows.find((x) => matches(x, args.where));
    if (!r) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    const next = clone(r);
    applyData(next, args.data);
    this.checkUnique(next, r);
    Object.assign(r, next);
    return clone(r);
  };
  createMany = async (args: { data: Row[]; skipDuplicates?: boolean }) => {
    await tick();
    let count = 0;
    for (const d of args.data) {
      const row: Row = { id: randomUUID(), ...this.defaults() };
      applyData(row, d);
      try { this.checkUnique(row); } catch (err) { if (args.skipDuplicates) continue; throw err; }
      this.rows.push(row);
      count++;
    }
    return { count };
  };
  updateMany = async (args: { where?: Row; data: Row }) => {
    await tick();
    const hit = this.rows.filter((x) => matches(x, args.where));
    for (const r of hit) applyData(r, args.data);
    return { count: hit.length };
  };
  upsert = async (args: { where: Row; create: Row; update: Row }) => {
    await tick();
    const r = this.rows.find((x) => matches(x, args.where));
    if (r) { applyData(r, args.update); return clone(r); }
    const row: Row = { id: randomUUID(), ...this.defaults() };
    applyData(row, args.create);
    this.rows.push(row);
    return clone(row);
  };
  delete = async (args: { where: Row }) => {
    await tick();
    const i = this.rows.findIndex((x) => matches(x, args.where));
    if (i < 0) throw Object.assign(new Error('Record to delete not found'), { code: 'P2025' });
    return this.rows.splice(i, 1)[0];
  };
  deleteMany = async (args: { where?: Row } = {}) => {
    await tick();
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !matches(x, args.where));
    return { count: before - this.rows.length };
  };
}

export interface FakePrisma {
  $on: () => undefined;
  user: FakeTable;
  userMfa: FakeTable;
  session: FakeTable;
  appPassword: FakeTable;
  passwordResetToken: FakeTable;
  serverSettings: FakeTable;
  domain: FakeTable;
  ldapConfig: FakeTable;
  oidcProvider: FakeTable;
  mailbox: FakeTable;
  folder: FakeTable;
  calendar: FakeTable;
  protocolPolicy: FakeTable;
  webmailPolicy: FakeTable;
  trustedImageSender: FakeTable;
  contact: FakeTable;
  adminScope: FakeTable;
  mcpToken: FakeTable;
  mfaTrustedDevice: FakeTable;
  [k: string]: unknown;
}

/**
 * 9.4: the models the protocol switch check reads, for hand-written Prisma
 * fakes. `rows` is the live list of ProtocolPolicy rows (push / clear it in a
 * test, then call invalidateProtocolAccessCache()); a row's `domain` relation
 * is the domain `{ name }` for anonymous lookups. No serverSettings row =
 * JMAP on at the server level. Spread it first:
 * `{ ...fakeProtocolPolicies(policies), user: …, serverSettings: … }`.
 */
export function fakeProtocolPolicies(rows: Row[]): Record<string, unknown> {
  return {
    protocolPolicy: { findMany: async () => rows, count: async () => 0 },
    serverSettings: { findUnique: async () => null },
    // 9.4: the webmail module switches are checked with the same session (all defaults)
    webmailPolicy: { findMany: async () => [] },
    // 10.6: the MFA policy check reads the account (override, role) and its factors on
    // every request; unknown accounts are "satisfied" (refused elsewhere). Tests that
    // model users spread their own `user` / `userMfa` after this.
    user: { findUnique: async () => null },
    userMfa: { findUnique: async () => null },
  };
}

/** 9.4: fakeProtocolPolicies() without any switch (built-in defaults), for tests that do not care. */
export function noProtocolPolicies(): Record<string, unknown> {
  return fakeProtocolPolicies([]);
}

/** 9.4: defaults of a ProtocolPolicy row (every switch inherited). */
export function protocolPolicyDefaults(): Row {
  return {
    domainId: null, userId: null, updatedAt: new Date(),
    imap: 'INHERIT', pop3: 'INHERIT', smtp: 'INHERIT', activesync: 'INHERIT',
    jmap: 'INHERIT', dav: 'INHERIT', webmail: 'INHERIT', mapi: 'INHERIT',
  };
}

/** 9.4: defaults of a WebmailPolicy row (every feature and value inherited). */
export function webmailPolicyDefaults(): Row {
  return {
    domainId: null, userId: null, updatedAt: new Date(),
    calendar: 'INHERIT', contacts: 'INHERIT', tasks: 'INHERIT', notes: 'INHERIT', rules: 'INHERIT',
    signatures: 'INHERIT', categories: 'INHERIT', recoverItems: 'INHERIT', changePassword: 'INHERIT',
    themes: 'INHERIT', externalClients: 'INHERIT', appPasswords: 'INHERIT', sharedMailboxes: 'INHERIT', profilePhoto: 'INHERIT',
    blockedExtensions: null, downloadOnlyExtensions: null, maxUploadMb: null, externalImages: null,
  };
}

/**
 * 9.4: the models the webmail policy check reads, for hand-written Prisma
 * fakes (`rows` = the live WebmailPolicy rows; call
 * invalidateWebmailPolicyCache() after changing them). Spread it like
 * fakeProtocolPolicies().
 */
export function fakeWebmailPolicies(rows: Row[]): Record<string, unknown> {
  return {
    webmailPolicy: { findMany: async (args?: { where?: Row }) => rows.filter((r) => matches(r, args?.where)) },
    trustedImageSender: { findMany: async () => [] },
  };
}

export function createFakePrisma(): FakePrisma {
  const p = {} as FakePrisma;
  p.$on = () => undefined;
  p.user = new FakeTable(() => ({
    role: 'USER', domainId: 'dom1', active: true, passwordHash: null, authSource: 'LOCAL', displayName: '',
  }), ['id', 'email']);
  p.userMfa = new FakeTable(() => ({
    totpSecret: null, totpEnabled: false, totpLastUsedStep: null, webAuthnCredentials: [],
    backupCodes: [], backupCodesUsed: 0, emailOtpEnabled: false,
  }), ['id', 'userId']);
  p.session = new FakeTable(() => ({
    userAgent: '', mfaVerified: false, createdAt: new Date(), lastUsedAt: new Date(),
  }), ['id', 'tokenHash']);
  p.appPassword = new FakeTable(() => ({ lastUsedAt: null, createdAt: new Date() }));
  p.passwordResetToken = new FakeTable(() => ({ usedAt: null, ipAddress: '', createdAt: new Date() }),
    ['id', 'tokenHash'], { user: () => p.user });
  p.serverSettings = new FakeTable(() => ({
    maintenanceMode: false, maintenanceMessage: '', minPasswordLength: 8, requireMfaForAdmins: false,
    publicHostname: 'mail.example.com', useHttps: true, httpPort: 443, selfServicePasswordReset: true,
  }));
  // v6.1: LDAP / OIDC / mailbox provisioning
  p.domain = new FakeTable(() => ({ active: true, primary: false, dkimPrivateKey: '', dkimSelector: 'coremail' }), ['id', 'name']);
  p.ldapConfig = new FakeTable(() => ({
    port: 636, ssl: true, userFilter: '(sAMAccountName={{username}})', groupFilter: null, attributeMap: {},
    syncEnabled: true, lastSyncAt: null, enabled: true, startTls: false, tlsVerify: true, tlsCaCert: null,
    allowLocalTakeover: false, syncIntervalMinutes: 1440, lastSyncResult: null, createdAt: new Date(),
  }), ['id', 'domainId'], { domain: () => p.domain });
  p.oidcProvider = new FakeTable(() => ({
    claimMap: {}, autoProvision: true, forcedDomains: [], active: true, scopes: 'openid email profile',
    requireEmailVerified: true, allowLinking: false, requireMfa: false, createdAt: new Date(),
  }), ['id'], { domain: () => p.domain });
  p.mailbox = new FakeTable(() => ({ uidValidity: 1, uidNext: 1, createdAt: new Date() }), ['id', 'userId', 'sharedBoxId']);
  p.folder = new FakeTable(() => ({ totalCount: 0, unreadCount: 0 }), ['id']);
  p.calendar = new FakeTable(() => ({ color: '#0078D4', isDefault: false, sortOrder: 0, syncToken: '' }));
  p.protocolPolicy = new FakeTable(protocolPolicyDefaults, ['id', 'domainId', 'userId'], { domain: () => p.domain });
  p.webmailPolicy = new FakeTable(webmailPolicyDefaults, ['id', 'domainId', 'userId']);
  p.trustedImageSender = new FakeTable(() => ({ createdAt: new Date() }));
  p.contact = new FakeTable(() => ({ email2: null }));
  // 9.5: admin management scopes (api-gateway admin guards read them for every non-org admin)
  p.adminScope = new FakeTable(() => ({ grantedBy: null, createdAt: new Date() }), ['id'], { domain: () => p.domain });
  // 10.3: admin MCP tokens (revokeAllSessions revokes them)
  p.mcpToken = new FakeTable(() => ({
    mode: 'read', mfaVerified: false, lastUsedAt: null, lastUsedIp: null, createdAt: new Date(), revokedAt: null, revokedReason: null,
  }), ['id', 'tokenHash'], { user: () => p.user });
  // 10.6: remembered MFA devices (revokeAllSessions / mfa-change revoke them)
  p.mfaTrustedDevice = new FakeTable(() => ({
    createdAt: new Date(), lastUsedAt: null, userAgent: '', ipPrefix: '', revokedAt: null, revokedReason: null,
  }), ['id', 'tokenHash'], { user: () => p.user });
  return p;
}

export class FakeRedis {
  store = new Map<string, { v: string; exp: number | null }>();
  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.exp !== null && e.exp < Date.now()) { this.store.delete(key); return undefined; }
    return e;
  }
  async get(key: string) { return this.live(key)?.v ?? null; }
  async setex(key: string, s: number, v: string) { this.store.set(key, { v, exp: Date.now() + s * 1000 }); return 'OK'; }
  /** SET key value [EX seconds] (the mail-auth lockout uses the EX form). */
  async set(key: string, v: string, mode?: string, seconds?: number) {
    const exp = mode === 'EX' && typeof seconds === 'number' ? Date.now() + seconds * 1000 : null;
    this.store.set(key, { v, exp });
    return 'OK';
  }
  async ttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    if (e.exp === null) return -1;
    return Math.max(1, Math.ceil((e.exp - Date.now()) / 1000));
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.live(k) && this.store.delete(k)) n++;
    return n;
  }
  async incr(key: string) {
    const e = this.live(key);
    const n = Number(e?.v ?? 0) + 1;
    this.store.set(key, { v: String(n), exp: e?.exp ?? null });
    return n;
  }
  async expire(key: string, s: number) {
    const e = this.live(key);
    if (!e) return 0;
    e.exp = Date.now() + s * 1000;
    return 1;
  }
}

export function createFakeRedis(): FakeRedis {
  return new FakeRedis();
}
