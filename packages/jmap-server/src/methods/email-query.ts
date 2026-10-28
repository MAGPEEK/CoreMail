/**
 * Email/query — filter (RFC 8621 §4.4.1) → Prisma WHERE, sorting, thread collapse.
 */
import { prisma } from '@coremail/storage';
import { unsupportedFilter, unsupportedSort, MethodError } from '../errors.js';
import { keywordToFlag } from '../mail/keywords.js';
import { ensureThreadIds } from '../mail/thread.js';
import type { AccountContext, JsonObject } from '../types.js';

type Where = Record<string, unknown>;

function contains(field: string, value: unknown): Where {
  return { [field]: { contains: String(value), mode: 'insensitive' } };
}

function addressFilter(field: 'toAddrs' | 'ccAddrs' | 'bccAddrs', value: unknown): Where {
  const v = String(value);
  return { [field]: { hasSome: [...new Set([v, v.toLowerCase()])] } };
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
      case 'before': and.push({ createdAt: { lt: new Date(String(v)) } }); break;
      case 'after': and.push({ createdAt: { gte: new Date(String(v)) } }); break;
      case 'minSize': and.push({ rawSize: { gte: Number(v) } }); break;
      case 'maxSize': and.push({ rawSize: { lt: Number(v) } }); break;
      case 'hasKeyword': and.push({ flags: { has: keywordToFlag(String(v)) } }); break;
      case 'notKeyword': and.push({ NOT: { flags: { has: keywordToFlag(String(v)) } } }); break;
      case 'text': and.push({ OR: [contains('subject', v), contains('fromAddr', v), contains('fromName', v), contains('bodyText', v)] }); break;
      case 'from': and.push({ OR: [contains('fromAddr', v), contains('fromName', v)] }); break;
      case 'to': and.push(addressFilter('toAddrs', v)); break;
      case 'cc': and.push(addressFilter('ccAddrs', v)); break;
      case 'bcc': and.push(addressFilter('bccAddrs', v)); break;
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

const SORT_FIELDS: Record<string, string> = {
  receivedAt: 'createdAt', sentAt: 'date', size: 'rawSize', subject: 'subject', from: 'fromAddr', to: 'toAddrs',
};

export interface SortSpec { field: string; asc: boolean; keyword?: string }

export function parseSort(sort: unknown): SortSpec[] {
  if (!Array.isArray(sort) || sort.length === 0) return [{ field: 'createdAt', asc: false }];
  const out: SortSpec[] = [];
  for (const s of sort as Array<JsonObject>) {
    const prop = String(s['property'] ?? '');
    const asc = s['isAscending'] !== false;
    if (prop === 'hasKeyword' || prop === 'allInThreadHaveKeyword' || prop === 'someInThreadHaveKeyword') {
      if (typeof s['keyword'] !== 'string') throw new MethodError('invalidArguments', 'keyword required');
      out.push({ field: 'hasKeyword', asc, keyword: keywordToFlag(s['keyword']) });
      continue;
    }
    const field = SORT_FIELDS[prop];
    if (!field || field === 'toAddrs') throw unsupportedSort(`Cannot sort by ${prop}`);
    out.push({ field, asc });
  }
  return out;
}

export interface QueryRow { id: string; threadId: string | null; inReplyTo: string | null; flags: string[] }

/**
 * Loads the sorted ids (max. 10 000) for filter + sort. hasKeyword sort
 * is applied in memory, everything else in the DB.
 */
export async function queryEmailIds(account: AccountContext, filter: unknown, sort: SortSpec[], collapseThreads: boolean): Promise<string[]> {
  const where: Where = { AND: [{ folder: { mailboxId: account.mailboxId } }, { deletedAt: null }, filterToWhere(filter)] };
  const dbSort = sort.filter((s) => s.field !== 'hasKeyword');
  const orderBy = [...dbSort.map((s) => ({ [s.field]: s.asc ? 'asc' : 'desc' })), { id: 'asc' }];
  const rows: QueryRow[] = await prisma.message.findMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: where as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orderBy: orderBy as any,
    take: 10_000,
    select: { id: true, threadId: true, inReplyTo: true, flags: true },
  });

  const kwSort = sort.find((s) => s.field === 'hasKeyword');
  if (kwSort) {
    // stable: messages with the keyword first (asc) or last (desc)
    rows.sort((a, b) => {
      const av = a.flags.includes(kwSort.keyword!) ? 1 : 0;
      const bv = b.flags.includes(kwSort.keyword!) ? 1 : 0;
      return kwSort.asc ? bv - av : av - bv;
    });
  }

  if (!collapseThreads) return rows.map((r) => r.id);
  const threads = await ensureThreadIds(rows, account.mailboxId);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const t = threads.get(r.id) ?? r.id;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(r.id);
  }
  return out;
}
