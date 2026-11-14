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
          case 'equals': return eq(v, arg);
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
  findMany = async (args: { where?: Row } = {}) => {
    await tick();
    return this.rows.filter((x) => matches(x, args.where)).map((r) => clone(r));
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
  [k: string]: unknown;
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
  async set(key: string, v: string) { this.store.set(key, { v, exp: null }); return 'OK'; }
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
