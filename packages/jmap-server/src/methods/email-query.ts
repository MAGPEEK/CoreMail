/**
 * Email/query — filter (RFC 8621 §4.4.1) → Prisma WHERE, sorting, thread collapse.
 *
 * Address conditions (to/cc/bcc and the address part of "text") need a substring
 * match over the elements of a String[] column, which Prisma cannot express. They
 * are compiled to an {@link ADDR_MATCH} placeholder that queryEmailIds() resolves
 * with one SQL query into an `id IN (…)` condition before the main query runs.
 */
import { prisma } from '@coremail/storage';
import { unsupportedFilter, unsupportedSort, MethodError } from '../errors.js';
import { flagVariants, hasKeywordFlag } from '../mail/keywords.js';
import { deriveMissingThreads } from '../mail/thread.js';
import { compareBy } from './common.js';
import type { AccountContext, JsonObject } from '../types.js';

type Where = Record<string, unknown>;

/** Placeholder key: `{ [ADDR_MATCH]: { fields, value } }` → `{ id: { in: […] } }`. */
export const ADDR_MATCH = '$addressContains';
export type AddressField = 'toAddrs' | 'ccAddrs' | 'bccAddrs';

function contains(field: string, value: unknown): Where {
  return { [field]: { contains: String(value), mode: 'insensitive' } };
}

function addressContains(fields: AddressField[], value: unknown): Where {
  return { [ADDR_MATCH]: { fields, value: String(value) } };
}

function dateArg(k: string, v: unknown): Date {
  const d = typeof v === 'string' ? new Date(v) : new Date(NaN);
  if (isNaN(d.getTime())) throw new MethodError('invalidArguments', `${k} must be a UTCDate`);
  return d;
}

function sizeArg(k: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new MethodError('invalidArguments', `${k} must be an UnsignedInt`);
  return v;
}

function hasKeywordWhere(v: unknown): Where {
  if (typeof v !== 'string') throw new MethodError('invalidArguments', 'keyword must be a String');
  const variants = flagVariants(v);
  return variants.length === 1 ? { flags: { has: variants[0] } } : { flags: { hasSome: variants } };
}

export function filterToWhere(filter: unknown): Where {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return {};
  const f = filter as JsonObject;
  if (typeof f['operator'] === 'string') {
    const conds = Array.isArray(f['conditions']) ? (f['conditions'] as unknown[]).map(filterToWhere) : [];
    switch (f['operator']) {
      case 'AND': return { AND: conds };
      case 'OR': return { OR: conds };
      case 'NOT': return { NOT: conds };
      default: throw unsupportedFilter(`Unknown operator ${f['operator']}`);
    }
  }
  const and: Where[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null) continue;
    switch (k) {
      case 'inMailbox': and.push({ folderId: String(v) }); break;
      case 'inMailboxOtherThan': and.push({ folderId: { notIn: (Array.isArray(v) ? v : [v]).map(String) } }); break;
      case 'before': and.push({ createdAt: { lt: dateArg(k, v) } }); break;
      case 'after': and.push({ createdAt: { gte: dateArg(k, v) } }); break;
      case 'minSize': and.push({ rawSize: { gte: sizeArg(k, v) } }); break;
      case 'maxSize': and.push({ rawSize: { lt: sizeArg(k, v) } }); break;
      case 'hasKeyword': and.push(hasKeywordWhere(v)); break;
      case 'notKeyword': and.push({ NOT: hasKeywordWhere(v) }); break;
      // RFC 8621 §4.4.1: text = From, To, Cc, Bcc, Subject and any text/* body part
      case 'text': and.push({ OR: [
        contains('subject', v), contains('fromAddr', v), contains('fromName', v),
        addressContains(['toAddrs', 'ccAddrs', 'bccAddrs'], v),
        contains('bodyText', v), contains('bodyHtml', v),
      ] }); break;
      case 'from': and.push({ OR: [contains('fromAddr', v), contains('fromName', v)] }); break;
      case 'to': and.push(addressContains(['toAddrs'], v)); break;
      case 'cc': and.push(addressContains(['ccAddrs'], v)); break;
      case 'bcc': and.push(addressContains(['bccAddrs'], v)); break;
      case 'subject': and.push(contains('subject', v)); break;
      case 'body': and.push({ OR: [contains('bodyText', v), contains('bodyHtml', v)] }); break;
      case 'hasAttachment': and.push(v ? { attachments: { some: {} } } : { attachments: { none: {} } }); break;
      case 'header':
      case 'allInThreadHaveKeyword':
      case 'someInThreadHaveKeyword':
      case 'noneInThreadHaveKeyword':
        throw unsupportedFilter(`Filter "${k}" is not supported`);
      default:
        throw unsupportedFilter(`Unknown filter condition "${k}"`);
    }
  }
  return and.length === 1 ? and[0]! : { AND: and };
}

const SORT_FIELDS: Record<string, keyof SortRow> = {
  receivedAt: 'createdAt', sentAt: 'date', size: 'rawSize', subject: 'subject', from: 'fromAddr',
};

export interface SortSpec { field: string; asc: boolean; keyword?: string }

/** Only the sort properties advertised in emailQuerySortOptions (session.ts) are accepted. */
export function parseSort(sort: unknown): SortSpec[] {
  if (!Array.isArray(sort) || sort.length === 0) return [{ field: 'createdAt', asc: false }];
  const out: SortSpec[] = [];
  for (const s of sort as Array<JsonObject>) {
    const prop = String(s['property'] ?? '');
    const asc = s['isAscending'] !== false;
    if (prop === 'hasKeyword') {
      if (typeof s['keyword'] !== 'string') throw new MethodError('invalidArguments', 'keyword required');
      out.push({ field: 'hasKeyword', asc, keyword: s['keyword'] });
      continue;
    }
    const field = SORT_FIELDS[prop];
    if (!field) throw unsupportedSort(`Cannot sort by ${prop}`);
    out.push({ field, asc });
  }
  return out;
}

export interface SortRow {
  id: string; threadId: string | null; flags: string[];
  createdAt: Date; date: Date; rawSize: number; subject: string; fromAddr: string;
}

const cmpValue = (a: unknown, b: unknown): number => {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
};

/** Comparator chain for the sort specs (first spec is primary), id as final tie-break. */
export function sortComparator(sort: SortSpec[]): (a: SortRow, b: SortRow) => number {
  return compareBy<SortRow>([
    ...sort.map((s) => {
      const dir = s.asc ? 1 : -1;
      if (s.field === 'hasKeyword') {
        // RFC 8621 §4.4.2: ascending = messages without the keyword first
        return (a: SortRow, b: SortRow) => dir * ((hasKeywordFlag(a.flags, s.keyword!) ? 1 : 0) - (hasKeywordFlag(b.flags, s.keyword!) ? 1 : 0));
      }
      const f = s.field as keyof SortRow;
      return (a: SortRow, b: SortRow) => dir * cmpValue(a[f], b[f]);
    }),
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  ]);
}

/** Replace ADDR_MATCH placeholders by `id IN (…)` (one SQL query each). */
async function resolveAddressMatches(where: unknown, mailboxId: string): Promise<unknown> {
  if (Array.isArray(where)) return Promise.all(where.map((w) => resolveAddressMatches(w, mailboxId)));
  if (!where || typeof where !== 'object' || where instanceof Date) return where;
  const obj = where as Where;
  const ph = obj[ADDR_MATCH] as { fields: AddressField[]; value: string } | undefined;
  if (ph) {
    const pattern = `%${ph.value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const cols = ph.fields.map((f) => `array_to_string(m."${f}", E'\\n') ILIKE $2`).join(' OR ');
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT m."id" FROM "messages" m JOIN "folders" f ON f."id" = m."folderId" WHERE f."mailboxId" = $1 AND (${cols})`,
      mailboxId, pattern,
    );
    return { id: { in: rows.map((r) => r.id) } };
  }
  const out: Where = {};
  for (const [k, v] of Object.entries(obj)) out[k] = await resolveAddressMatches(v, mailboxId);
  return out;
}

/**
 * All matching ids in sort order (RFC 8620 §5.5: total and position cover the whole
 * result — no server-side cap). Sorting is done in the database unless a hasKeyword
 * comparator is involved; then the whole comparator chain runs in memory.
 */
export async function queryEmailIds(account: AccountContext, filter: unknown, sort: SortSpec[], collapseThreads: boolean): Promise<string[]> {
  const filterWhere = await resolveAddressMatches(filterToWhere(filter), account.mailboxId);
  const where: Where = { AND: [{ folder: { mailboxId: account.mailboxId } }, { deletedAt: null }, filterWhere] };
  const inMemory = sort.some((s) => s.field === 'hasKeyword');
  if (collapseThreads) await deriveMissingThreads(account.mailboxId);
  const rows = await prisma.message.findMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: where as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orderBy: (inMemory ? [{ id: 'asc' }] : [...sort.map((s) => ({ [s.field]: s.asc ? 'asc' : 'desc' })), { id: 'asc' }]) as any,
    select: inMemory
      ? { id: true, threadId: true, flags: true, createdAt: true, date: true, rawSize: true, subject: true, fromAddr: true }
      : { id: true, threadId: true },
  }) as Array<Pick<SortRow, 'id' | 'threadId'> & Partial<SortRow>>;
  if (inMemory) (rows as SortRow[]).sort(sortComparator(sort));

  if (!collapseThreads) return rows.map((r) => r.id);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const t = r.threadId ?? r.id;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(r.id);
  }
  return out;
}
