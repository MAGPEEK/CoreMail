/**
 * In-memory Prisma stand-in for the quota / recoverable-items / OOF tests
 * (installed through the globalThis.__prisma seam). Supports the where-clause
 * shapes those modules use: equality, in/not/lt/lte/gt/gte/startsWith/contains/has,
 * AND/OR/NOT and the relations message.folder, folder.mailbox.
 */
export type Row = Record<string, unknown>;

export interface FakeDb {
  users: Row[];
  sharedMailboxes: Row[];
  mailboxes: Row[];
  folders: Row[];
  messages: Row[];
  aliases: Row[];
  serverSettings: Row[];
  userSettings: Row[];
}

export function emptyDb(): FakeDb {
  return { users: [], sharedMailboxes: [], mailboxes: [], folders: [], messages: [], aliases: [], serverSettings: [], userSettings: [] };
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') { const x = BigInt(a as never); const y = BigInt(b as never); return x < y ? -1 : x > y ? 1 : 0; }
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}
const eq = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export function createFake(db: FakeDb) {
  let seq = 0;
  const relations: Record<string, Record<string, (row: Row) => Row | null>> = {
    messages: { folder: (r) => db.folders.find((f) => f['id'] === r['folderId']) ?? null },
    folders: { mailbox: (r) => db.mailboxes.find((m) => m['id'] === r['mailboxId']) ?? null },
  };
  const tableOf: Record<string, string> = { folder: 'folders', mailbox: 'mailboxes' };

  function matchField(v: unknown, c: unknown): boolean {
    if (c === null) return v === null || v === undefined;
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
      const o = c as Row;
      if ('in' in o && !(o['in'] as unknown[]).some((x) => eq(x, v))) return false;
      if ('not' in o) { if (o['not'] === null ? (v === null || v === undefined) : eq(v, o['not'])) return false; }
      if ('lt' in o && !(v !== null && v !== undefined && cmp(v, o['lt']) < 0)) return false;
      if ('lte' in o && !(v !== null && v !== undefined && cmp(v, o['lte']) <= 0)) return false;
      if ('gt' in o && !(v !== null && v !== undefined && cmp(v, o['gt']) > 0)) return false;
      if ('gte' in o && !(v !== null && v !== undefined && cmp(v, o['gte']) >= 0)) return false;
      if ('startsWith' in o && !String(v ?? '').startsWith(String(o['startsWith']))) return false;
      if ('contains' in o && !String(v ?? '').toLowerCase().includes(String(o['contains']).toLowerCase())) return false;
      if ('has' in o && !((v as unknown[] | undefined) ?? []).includes(o['has'])) return false;
      if ('equals' in o && !eq(v, o['equals'])) return false;
      return true;
    }
    return eq(v, c);
  }

  function match(table: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'AND') return (c as Row[]).every((w) => match(table, row, w));
      if (k === 'OR') return (c as Row[]).some((w) => match(table, row, w));
      if (k === 'NOT') return !match(table, row, c as Row);
      const rel = relations[table]?.[k];
      if (rel) { const r = rel(row); return !!r && match(tableOf[k]!, r, c as Row); }
      return matchField(row[k], c);
    });
  }

  function applyData(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Row)) {
        const inc = (v as Row)['increment'];
        row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) + BigInt(inc as number) : (row[k] as number) + Number(inc);
      } else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in (v as Row)) {
        const dec = (v as Row)['decrement'];
        row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) - BigInt(dec as number) : (row[k] as number) - Number(dec);
      } else row[k] = v;
    }
  }

  function project(table: string, row: Row, select?: Row): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      const rel = relations[table]?.[k];
      if (rel) {
        const r = rel(row);
        out[k] = r ? project(tableOf[k]!, r, (v as Row)['select'] as Row | undefined) : null;
      } else if (table === 'users' || table === 'sharedMailboxes') {
        if (k === 'mailbox') {
          const m = db.mailboxes.find((x) => (table === 'users' ? x['userId'] : x['sharedBoxId']) === row['id']);
          out[k] = m ? { id: m['id'] } : null;
        } else out[k] = row[k];
      } else out[k] = row[k];
    }
    return out;
  }

  function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const o of list) {
        const [k, spec] = Object.entries(o)[0]!;
        // { field: 'desc' } or { field: { sort: 'desc', nulls: 'last' } } (nulls always last here)
        const dir = typeof spec === 'object' && spec !== null ? (spec as Row)['sort'] : spec;
        const x = a[k]; const y = b[k];
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const c = cmp(x, y);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  function model(table: keyof FakeDb, defaults: () => Row = () => ({})) {
    const rows = (): Row[] => db[table];
    return {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const r = rows().find((x) => match(table, x, where));
        return r ? project(table, r, select) : null;
      },
      findFirst: async ({ where, select }: { where?: Row; select?: Row }) => {
        const r = rows().find((x) => match(table, x, where));
        return r ? project(table, r, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: { where?: Row; select?: Row; orderBy?: Row | Row[]; take?: number } = {}) => {
        let list = sortRows(rows().filter((x) => match(table, x, where)), orderBy);
        if (take !== undefined) list = list.slice(0, take);
        return list.map((r) => project(table, r, select));
      },
      count: async ({ where }: { where?: Row } = {}) => rows().filter((x) => match(table, x, where)).length,
      aggregate: async ({ where }: { where?: Row }) => {
        const list = rows().filter((x) => match(table, x, where));
        const sum = list.reduce((s, r) => s + Number(r['rawSize'] ?? 0), 0);
        const max = (f: string) => (list.length ? list.map((r) => r[f]).reduce((a, b) => (cmp(b, a) > 0 ? b : a)) : null);
        return { _sum: { rawSize: list.length ? sum : null }, _max: { modSeq: max('modSeq'), uid: max('uid') } };
      },
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: `${String(table)}${++seq}`, ...defaults(), ...data };
        rows().push(row);
        return { ...row };
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const r = rows().find((x) => match(table, x, where));
        if (!r) throw new Error(`${String(table)} not found`);
        if (table === 'messages' && 'uid' in data && rows().some((m) => m !== r && m['folderId'] === (data['folderId'] ?? r['folderId']) && m['uid'] === data['uid'])) {
          throw new Error('unique violation (folderId, uid)');
        }
        applyData(r, data);
        return project(table, r, select);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const list = rows().filter((x) => match(table, x, where));
        for (const r of list) applyData(r, data);
        return { count: list.length };
      },
      upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
        const r = rows().find((x) => match(table, x, where));
        if (r) { applyData(r, update); return { ...r }; }
        const row: Row = { id: `${String(table)}${++seq}`, ...defaults(), ...create };
        rows().push(row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const keep = rows().filter((x) => !match(table, x, where));
        const n = rows().length - keep.length;
        db[table].splice(0, db[table].length, ...keep);
        return { count: n };
      },
    };
  }

  const fake: Record<string, unknown> = {
    $on: () => undefined,
    user: model('users'),
    sharedMailbox: model('sharedMailboxes'),
    mailbox: model('mailboxes'),
    folder: model('folders'),
    message: model('messages', () => ({ flags: [], deletedAt: null, softDeletedAt: null, createdAt: new Date(), rawSize: 0 })),
    emailAlias: model('aliases'),
    serverSettings: model('serverSettings'),
    userSettings: model('userSettings'),
  };
  fake['$transaction'] = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fake);
  return fake;
}
