/**
 * In-memory Prisma stand-in for the ActiveSync command tests, installed through
 * the `globalThis.__prisma` seam of @coremail/storage. Supports the query shapes
 * the commands use: equality, in/contains/equals (mode ignored → case-insensitive),
 * gt/lt/lte, OR/AND/NOT, relation filters (folder.mailbox, message.folder,
 * calendarEvent.calendar), select/include of those relations, increment updates,
 * count/aggregate and `$transaction(fn)`. Every call is logged in `calls`.
 * Test-only module.
 */
type Row = Record<string, unknown>;

export type Tables = Record<string, Row[]>;

const RELATIONS: Record<string, Record<string, { table: string; local: string; foreign: string; many?: boolean }>> = {
  folder: { mailbox: { table: 'mailbox', local: 'mailboxId', foreign: 'id' } },
  mailbox: { folders: { table: 'folder', local: 'id', foreign: 'mailboxId', many: true } },
  message: { folder: { table: 'folder', local: 'folderId', foreign: 'id' } },
  calendarEvent: { calendar: { table: 'calendar', local: 'calendarId', foreign: 'id' } },
};

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') { const x = BigInt(a as never); const y = BigInt(b as never); return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

export function createFakeDb(tables: Tables) {
  const calls: Array<{ model: string; op: string; args: Row }> = [];
  let seq = 0;
  const t = (name: string): Row[] => (tables[name] ??= []);

  function related(model: string, row: Row, rel: string): Row | Row[] | null | undefined {
    const r = RELATIONS[model]?.[rel];
    if (!r) return undefined;
    const rows = t(r.table).filter((x) => x[r.foreign] === row[r.local]);
    return r.many ? rows : (rows[0] ?? null);
  }

  function matchField(v: unknown, c: unknown): boolean {
    if (c === null) return v === null || v === undefined;
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
      const o = c as Row;
      if ('in' in o && !(o['in'] as unknown[]).includes(v)) return false;
      if ('not' in o && matchField(v, o['not'])) return false;
      if ('contains' in o && !(typeof v === 'string' && v.toLowerCase().includes(String(o['contains']).toLowerCase()))) return false;
      if ('equals' in o && !(typeof v === 'string' && v.toLowerCase() === String(o['equals']).toLowerCase())) return false;
      if ('lt' in o && !(cmp(v, o['lt']) < 0)) return false;
      if ('lte' in o && !(cmp(v, o['lte']) <= 0)) return false;
      if ('gt' in o && !(cmp(v, o['gt']) > 0)) return false;
      if ('gte' in o && !(cmp(v, o['gte']) >= 0)) return false;
      return true;
    }
    if (v instanceof Date && c instanceof Date) return v.getTime() === c.getTime();
    return v === c;
  }

  function match(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((w) => match(model, row, w));
      if (k === 'AND') return (c as Row[]).every((w) => match(model, row, w));
      if (k === 'NOT') return !match(model, row, c as Row);
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        const target = related(model, row, k);
        return !!target && !Array.isArray(target) && match(rel.table, target, c as Row);
      }
      return matchField(row[k], c);
    });
  }

  function shape(model: string, row: Row, args: Row): Row {
    const out: Row = { ...row };
    const spec = (args['select'] ?? args['include']) as Row | undefined;
    if (spec) {
      for (const [k, v] of Object.entries(spec)) {
        const rel = RELATIONS[model]?.[k];
        if (!rel || !v) continue;
        const target = related(model, row, k);
        const nested = typeof v === 'object' ? (v as Row) : {};
        out[k] = Array.isArray(target) ? target.map((x) => shape(rel.table, x, nested)) : target ? shape(rel.table, target, nested) : null;
      }
    }
    return out;
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
    return [...rows].sort((a, b) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0]!;
        const c = cmp(a[k], b[k]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  function applyData(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && 'increment' in (v as Row)) {
        const inc = (v as Row)['increment'];
        row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) + BigInt(inc as number) : (row[k] as number) + Number(inc);
      } else row[k] = v;
    }
  }

  function model(name: string) {
    const log = (op: string, args: Row) => calls.push({ model: name, op, args });
    const find = (args: Row = {}) => sortRows(t(name).filter((r) => match(name, r, args['where'] as Row)), args['orderBy']);
    return {
      findUnique: async (args: Row) => {
        log('findUnique', args);
        const where = { ...(args['where'] as Row) };
        for (const [k, v] of Object.entries(where)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && k.includes('_')) { delete where[k]; Object.assign(where, v); }
        }
        const r = t(name).find((x) => match(name, x, where));
        return r ? shape(name, r, args) : null;
      },
      findFirst: async (args: Row = {}) => { log('findFirst', args); const r = find(args)[0]; return r ? shape(name, r, args) : null; },
      findMany: async (args: Row = {}) => {
        log('findMany', args);
        const skip = (args['skip'] as number | undefined) ?? 0;
        const take = args['take'] as number | undefined;
        const rows = find(args).slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((r) => shape(name, r, args));
      },
      count: async (args: Row = {}) => { log('count', args); return find(args).length; },
      create: async (args: Row) => {
        log('create', args);
        const row: Row = { id: `${name}-${++seq}`, ...(args['data'] as Row) };
        t(name).push(row);
        return shape(name, row, args);
      },
      update: async (args: Row) => {
        log('update', args);
        const r = t(name).find((x) => match(name, x, args['where'] as Row));
        if (!r) throw new Error(`fake ${name}.update: not found ${JSON.stringify(args['where'])}`);
        applyData(r, args['data'] as Row);
        return shape(name, r, args);
      },
      createMany: async (args: Row) => {
        log('createMany', args);
        const rows = args['data'] as Row[];
        for (const data of rows) t(name).push({ ...data });
        return { count: rows.length };
      },
      deleteMany: async (args: Row = {}) => {
        log('deleteMany', args);
        const keep = t(name).filter((x) => !match(name, x, args['where'] as Row));
        const count = t(name).length - keep.length;
        tables[name] = keep;
        return { count };
      },
      updateMany: async (args: Row) => {
        log('updateMany', args);
        const rows = t(name).filter((x) => match(name, x, args['where'] as Row));
        for (const r of rows) applyData(r, args['data'] as Row);
        return { count: rows.length };
      },
      upsert: async (args: Row) => {
        log('upsert', args);
        const r = t(name).find((x) => match(name, x, args['where'] as Row));
        if (r) { applyData(r, args['update'] as Row); return r; }
        const row: Row = { id: `${name}-${++seq}`, ...(args['create'] as Row) };
        t(name).push(row);
        return row;
      },
      delete: async (args: Row) => {
        log('delete', args);
        const i = t(name).findIndex((x) => match(name, x, args['where'] as Row));
        if (i < 0) throw new Error(`fake ${name}.delete: not found`);
        return t(name).splice(i, 1)[0];
      },
      aggregate: async (args: Row) => {
        log('aggregate', args);
        const rows = find(args);
        const max: Row = {};
        for (const k of Object.keys((args['_max'] as Row | undefined) ?? {})) {
          max[k] = rows.reduce<unknown>((m, r) => (m === null || cmp(r[k], m) > 0 ? r[k] : m), null);
        }
        return { _max: max };
      },
    };
  }

  const db: Row = { $on: () => undefined, calls, tables };
  for (const name of ['user', 'emailAlias', 'userSettings', 'activeSyncDevice', 'activeSyncItem', 'mailbox', 'folder', 'message', 'attachment', 'sharedMailbox', 'sharedMailboxPerm','contact', 'calendar', 'calendarEvent', 'systemLog']) {
    db[name] = model(name);
  }
  db['$transaction'] = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  // Raw SQL: only the atomic syncKeys merge of commands/sync-keys.ts (jsonb `||`).
  db['$executeRaw'] = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ model: 'activeSyncDevice', op: '$executeRaw', args: { sql, values } });
    if (/UPDATE "active_sync_devices" SET "syncKeys" = \(CASE WHEN jsonb_typeof\("syncKeys"\) = 'object' THEN "syncKeys" ELSE '\{\}'::jsonb END\) \|\| \?::jsonb WHERE "id" = \?/.test(sql)) {
      const [json, id] = values as [string, string];
      const row = t('activeSyncDevice').find((r) => r['id'] === id);
      if (!row) return 0;
      const cur = row['syncKeys'];
      const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Row) : {};
      row['syncKeys'] = { ...base, ...(JSON.parse(json) as Row) };
      return 1;
    }
    throw new Error(`fake $executeRaw: unsupported SQL ${sql}`);
  };
  return db as Row & { calls: typeof calls; tables: Tables };
}

/** Install a fake as the Prisma client (must run before importing @coremail/storage). */
export function installFakeDb(tables: Tables) {
  process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
  process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
  process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
  const db = createFakeDb(tables);
  (globalThis as Record<string, unknown>)['__prisma'] = db;
  return db;
}

/** Client-style WBXML encoder for fixtures: [page, token, children | text]. */
export type WNode = [number, number, (WNode[] | string | undefined)?];
export function clientWbxml(root: WNode): Buffer {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, tok, kids]: WNode) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(tok | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    if (typeof kids === 'string') out.push(0x03, ...Buffer.from(kids, 'utf8'), 0x00); else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}

/** [page, token] of every tag in a WBXML buffer (header: 4 single-byte fields). */
export function wbxmlTags(buf: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 4, page = 0;
  while (i < buf.length) {
    const b = buf[i++]!;
    if (b === 0x00) { page = buf[i++]!; continue; }
    if (b === 0x01) continue;
    if (b === 0x03) { while (buf[i++] !== 0x00); continue; }
    out.push([page, b & 0x3f]);
  }
  return out;
}
