/**
 * Test-only in-memory Prisma model (9.5 scope tests) for installFakePrisma():
 * evaluates the `where` shapes the admin routes use — equality, `in`, `not`,
 * `contains` / `startsWith` / `endsWith` (with `mode: 'insensitive'`), `gte` /
 * `lte`, `AND` / `OR` / `NOT` and nested relation filters on embedded objects
 * (a row stores its relations as plain nested objects). `select` is applied one
 * level deep (nested selects copy the embedded object as-is).
 */
import { applySelect } from './fake-prisma.js';

export type Row = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

const OPS = new Set(['in', 'notIn', 'not', 'equals', 'contains', 'startsWith', 'endsWith', 'gte', 'lte', 'gt', 'lt', 'mode']);

const isPlainObject = (v: unknown): v is Row =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function matchOps(value: unknown, ops: Row): boolean {
  const insensitive = ops['mode'] === 'insensitive';
  const norm = (v: unknown): unknown => (insensitive && typeof v === 'string' ? v.toLowerCase() : v);
  const v = norm(value);
  for (const [op, raw] of Object.entries(ops)) {
    const arg = norm(raw);
    if (op === 'mode') continue;
    if (op === 'in' && !(raw as unknown[]).map(norm).includes(v)) return false;
    if (op === 'notIn' && (raw as unknown[]).map(norm).includes(v)) return false;
    if (op === 'equals' && v !== arg) return false;
    if (op === 'not' && (isPlainObject(raw) ? matchOps(value, raw) : v === arg)) return false;
    if (op === 'contains' && !(typeof v === 'string' && v.includes(String(arg)))) return false;
    if (op === 'startsWith' && !(typeof v === 'string' && v.startsWith(String(arg)))) return false;
    if (op === 'endsWith' && !(typeof v === 'string' && v.endsWith(String(arg)))) return false;
    if (op === 'gte' && !((v as number) >= (arg as number))) return false;
    if (op === 'lte' && !((v as number) <= (arg as number))) return false;
    if (op === 'gt' && !((v as number) > (arg as number))) return false;
    if (op === 'lt' && !((v as number) < (arg as number))) return false;
  }
  return true;
}

/** Does `row` match a Prisma `where`? */
export function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matchesWhere(row, w as Row))) return false;
    } else if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matchesWhere(row, w))) return false;
    } else if (key === 'NOT') {
      if (matchesWhere(row, cond as Row)) return false;
    } else if (isPlainObject(cond)) {
      const keys = Object.keys(cond);
      if (keys.length > 0 && keys.every((k) => OPS.has(k))) {
        if (!matchOps(row[key], cond)) return false;
      } else {
        const nested = row[key];
        if (!isPlainObject(nested) || !matchesWhere(nested, cond)) return false;
      }
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

/** Prisma-like methods over `rows` (mutated in place). */
export function memoryModel(rows: Row[]): Record<string, Fn> {
  const find = (where?: Row) => rows.filter((r) => matchesWhere(r, where));
  return {
    findMany: (a) => {
      const q = (a ?? {}) as { where?: Row; select?: Row; skip?: number; take?: number };
      const hit = find(q.where).slice(q.skip ?? 0, q.take !== undefined ? (q.skip ?? 0) + q.take : undefined);
      return hit.map((r) => applySelect({ ...r }, q.select));
    },
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const r = find(q.where)[0];
      return r ? applySelect({ ...r }, q.select) : null;
    },
    findFirst: (a) => {
      const q = (a ?? {}) as { where?: Row; select?: Row };
      const r = find(q.where)[0];
      return r ? applySelect({ ...r }, q.select) : null;
    },
    count: (a) => find((a as { where?: Row } | undefined)?.where).length,
    create: (a) => {
      const q = a as { data: Row; select?: Row };
      const row = { id: `id${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`, ...q.data };
      rows.push(row);
      return applySelect({ ...row }, q.select);
    },
    createMany: (a) => {
      const data = (a as { data: Row[] }).data;
      for (const d of data) rows.push({ id: `id${rows.length + 1}`, ...d });
      return { count: data.length };
    },
    update: (a) => {
      const q = a as { where: Row; data: Row; select?: Row };
      const r = find(q.where)[0];
      if (!r) throw Object.assign(new Error('Record not found'), { code: 'P2025', clientVersion: '5', name: 'PrismaClientKnownRequestError' });
      Object.assign(r, q.data);
      return applySelect({ ...r }, q.select);
    },
    updateMany: (a) => {
      const q = a as { where?: Row; data: Row };
      const hit = find(q.where);
      for (const r of hit) Object.assign(r, q.data);
      return { count: hit.length };
    },
    delete: (a) => {
      const r = find((a as { where: Row }).where)[0];
      if (!r) throw Object.assign(new Error('Record not found'), { code: 'P2025', clientVersion: '5', name: 'PrismaClientKnownRequestError' });
      rows.splice(rows.indexOf(r), 1);
      return { ...r };
    },
    deleteMany: (a) => {
      const hit = find((a as { where?: Row } | undefined)?.where);
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { count: hit.length };
    },
  };
}
