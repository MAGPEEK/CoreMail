/**
 * Search command ([MS-ASCMD] 2.2.1.16).
 *
 *  - Store=Mailbox: Query with And / FreeText / EqualTo (CollectionId) /
 *    GreaterThan|LessThan (email:DateReceived), airsync:CollectionId and
 *    airsync:Class; Options Range, RebuildResults, DeepTraversal, BodyPreference.
 *    Scope: folders of the caller's own mailbox only.
 *  - Store=GAL: users + Shared Mailboxes of the caller's domain; Options Range
 *    (Picture is not supported and omitted).
 */
import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { parseRange, searchGal, type DirectoryEntry } from './directory.js';

export const SEARCH_STATUS = {
  SUCCESS: '1',
  INVALID_REQUEST: '2',
  SERVER_ERROR: '3',
  TOO_COMPLEX: '8',
} as const;

const kids = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

/** Parsed mailbox query. */
export interface MailboxQuery {
  collectionIds: string[];
  freeText: string[];
  after: Date | null;
  before: Date | null;
  classes: string[];
}

export class QueryError extends Error {
  constructor(public readonly status: string, msg: string) { super(msg); }
}

/** Pure: Store=Mailbox <Query> → MailboxQuery. Throws QueryError for unsupported/invalid parts. */
export function parseMailboxQuery(query: WbxmlElement): MailboxQuery {
  const q: MailboxQuery = { collectionIds: [], freeText: [], after: null, before: null, classes: [] };
  const comparison = (node: WbxmlElement, into: 'after' | 'before') => {
    const children = kids(node);
    const prop = children.find((c) => c.name !== 'Value');
    const value = getText(node, 'Value');
    if (prop?.name !== 'DateReceived') throw new QueryError(SEARCH_STATUS.TOO_COMPLEX, `unsupported comparison on ${prop?.name ?? '?'}`);
    const d = new Date(value);
    if (isNaN(d.getTime())) throw new QueryError(SEARCH_STATUS.INVALID_REQUEST, 'invalid date');
    q[into] = d;
  };
  const walk = (node: WbxmlElement) => {
    switch (node.name) {
      case 'Query':
      case 'And':
        for (const c of kids(node)) walk(c);
        if (node.text?.trim()) q.freeText.push(node.text.trim());
        break;
      case 'FreeText':
        if (node.text?.trim()) q.freeText.push(node.text.trim());
        break;
      case 'CollectionId':
        if (node.text) q.collectionIds.push(node.text);
        break;
      case 'Class':
        if (node.text) q.classes.push(node.text);
        break;
      case 'EqualTo': {
        const prop = kids(node).find((c) => c.name !== 'Value');
        const value = getText(node, 'Value');
        if (prop?.name !== 'CollectionId' || !value) throw new QueryError(SEARCH_STATUS.TOO_COMPLEX, `unsupported EqualTo on ${prop?.name ?? '?'}`);
        q.collectionIds.push(value);
        break;
      }
      case 'GreaterThan': comparison(node, 'after'); break;
      case 'LessThan': comparison(node, 'before'); break;
      default:
        throw new QueryError(SEARCH_STATUS.TOO_COMPLEX, `unsupported query element ${node.name}`);
    }
  };
  walk(query);
  if (q.collectionIds.length > 1 && new Set(q.collectionIds).size > 1) {
    throw new QueryError(SEARCH_STATUS.TOO_COMPLEX, 'more than one CollectionId');
  }
  return q;
}

/** Pure: ids of `rootId` and (deep) all its descendants. */
export function folderSubtree(folders: Array<{ id: string; parentId: string | null }>, rootId: string, deep: boolean): string[] {
  if (!deep) return [rootId];
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const f of folders) if (f.parentId === out[i] && !out.includes(f.id)) out.push(f.id);
  }
  return out;
}

interface BodyPref { type: number; truncationSize: number | null }

function parseBodyPreference(options: WbxmlElement | undefined): BodyPref | null {
  const pref = kids(options).find((c) => c.name === 'BodyPreference');
  if (!pref) return null;
  const type = Number(getText(pref, 'Type') || '1');
  const size = Number(getText(pref, 'TruncationSize'));
  return { type: type === 2 ? 2 : 1, truncationSize: Number.isFinite(size) && size > 0 ? size : null };
}

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

interface MsgRow {
  id: string; folderId: string; subject: string; fromAddr: string; fromName: string; toAddrs: string[];
  ccAddrs: string[]; date: Date; flags: string[]; bodyText: string; bodyHtml: string;
}

function mailboxResult(m: MsgRow, body: BodyPref | null): WbxmlElement {
  const from = m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${m.fromAddr}>` : m.fromAddr;
  const props: WbxmlElement[] = [
    el('Subject', m.subject || '(no subject)'),
    el('DateReceived', m.date.toISOString()),
    el('DisplayTo', m.toAddrs.join('; ')),
    el('To', m.toAddrs.join(', ')),
    ...(m.ccAddrs.length ? [el('Cc', m.ccAddrs.join(', '))] : []),
    el('From', from),
    el('Importance', '1'),
    el('Read', m.flags.includes('\\Seen') ? '1' : '0'),
    el('MessageClass', 'IPM.Note'),
  ];
  if (body) {
    const full = body.type === 2 ? (m.bodyHtml || m.bodyText) : (m.bodyText || htmlToText(m.bodyHtml));
    const size = Buffer.byteLength(full, 'utf8');
    let data = full;
    if (body.truncationSize !== null && size > body.truncationSize) {
      data = Buffer.from(full, 'utf8').subarray(0, body.truncationSize).toString('utf8').replace(/�+$/, '');
    }
    props.push(el('AirSyncBase:Body', undefined, [
      el('Type', String(body.type)),
      el('EstimatedDataSize', String(size)),
      el('Truncated', data.length < full.length ? '1' : '0'),
      ...(data ? [el('Data', data)] : []),
    ]));
  }
  return el('Result', undefined, [
    el('Class', 'Email'),
    el('LongId', m.id),
    el('CollectionId', m.folderId),
    el('Properties', undefined, props),
  ]);
}

function galResult(e: DirectoryEntry): WbxmlElement {
  const at = e.email.indexOf('@');
  return el('Result', undefined, [el('Properties', undefined, [
    el('GAL:DisplayName', e.displayName),
    ...(e.phone ? [el('GAL:Phone', e.phone)] : []),
    ...(e.title ? [el('GAL:Title', e.title)] : []),
    ...(e.company ? [el('GAL:Company', e.company)] : []),
    el('GAL:Alias', at > 0 ? e.email.slice(0, at) : e.email),
    ...(e.mobilePhone ? [el('GAL:MobilePhone', e.mobilePhone)] : []),
    el('GAL:EmailAddress', e.email),
  ])]);
}

function storeResponse(status: string, results: WbxmlElement[], range: [number, number] | null, total: number): WbxmlElement {
  const children: WbxmlElement[] = [el('Status', status)];
  if (status === SEARCH_STATUS.SUCCESS) {
    if (results.length === 0) children.push(el('Result'));
    else children.push(...results, el('Range', `${range![0]}-${range![0] + results.length - 1}`));
    children.push(el('Total', String(total)));
  }
  return el('Search', undefined, [
    el('Status', SEARCH_STATUS.SUCCESS),
    el('Response', undefined, [el('Store', undefined, children)]),
  ]);
}

async function searchMailbox(store: WbxmlElement, userId: string): Promise<WbxmlElement> {
  const queryEl = getChild(store, 'Query');
  if (!queryEl) return storeResponse(SEARCH_STATUS.INVALID_REQUEST, [], null, 0);
  const options = getChild(store, 'Options');
  const range = parseRange(getText(options ?? { name: 'Options' }, 'Range'));
  if (!range) return storeResponse(SEARCH_STATUS.INVALID_REQUEST, [], null, 0);
  let q: MailboxQuery;
  try { q = parseMailboxQuery(queryEl); } catch (err) {
    return storeResponse(err instanceof QueryError ? err.status : SEARCH_STATUS.INVALID_REQUEST, [], null, 0);
  }
  if (q.classes.some((c) => c !== 'Email')) return storeResponse(SEARCH_STATUS.SUCCESS, [], range, 0);

  // Scope: folders of the caller's own mailbox.
  const mailbox = await prisma.mailbox.findFirst({
    where: { userId },
    select: { id: true, userId: true, folders: { select: { id: true, parentId: true } } },
  });
  if (!mailbox || mailbox.userId !== userId) return storeResponse(SEARCH_STATUS.SERVER_ERROR, [], null, 0);
  const deep = !!getChild(options ?? { name: 'Options' }, 'DeepTraversal');
  let folderIds = mailbox.folders.map((f) => f.id);
  if (q.collectionIds.length) {
    const target = q.collectionIds[0]!;
    // Unknown and foreign folders answer alike (no existence oracle).
    if (!folderIds.includes(target)) return storeResponse(SEARCH_STATUS.INVALID_REQUEST, [], null, 0);
    folderIds = folderSubtree(mailbox.folders, target, deep);
  }

  const and: object[] = [];
  for (const t of q.freeText) {
    and.push({ OR: [
      { subject: { contains: t, mode: 'insensitive' } },
      { bodyText: { contains: t, mode: 'insensitive' } },
      { fromAddr: { contains: t, mode: 'insensitive' } },
      { fromName: { contains: t, mode: 'insensitive' } },
    ] });
  }
  if (q.after) and.push({ date: { gt: q.after } });
  if (q.before) and.push({ date: { lt: q.before } });
  const where = { folderId: { in: folderIds }, deletedAt: null, ...(and.length ? { AND: and } : {}) };

  const [total, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      skip: range[0],
      take: range[1] - range[0] + 1,
      select: {
        id: true, folderId: true, subject: true, fromAddr: true, fromName: true, toAddrs: true, ccAddrs: true,
        date: true, flags: true, bodyText: true, bodyHtml: true,
      },
    }),
  ]);
  const body = parseBodyPreference(options);
  // Defence in depth: never return a row outside the scoped folders.
  const scoped = (rows as MsgRow[]).filter((r) => folderIds.includes(r.folderId));
  return storeResponse(SEARCH_STATUS.SUCCESS, scoped.map((m) => mailboxResult(m, body)), range, total);
}

async function searchGalStore(store: WbxmlElement, userId: string): Promise<WbxmlElement> {
  const query = getText(store, 'Query').trim();
  const range = parseRange(getText(getChild(store, 'Options') ?? { name: 'Options' }, 'Range'));
  if (!query || !range) return storeResponse(SEARCH_STATUS.INVALID_REQUEST, [], null, 0);
  const entries = await searchGal(userId, query);
  const page = entries.slice(range[0], range[1] + 1);
  return storeResponse(SEARCH_STATUS.SUCCESS, page.map(galResult), range, entries.length);
}

export async function handleSearch(body: WbxmlElement, userId: string): Promise<Buffer> {
  const store = getChild(body, 'Store');
  if (body.name !== 'Search' || !store) {
    return encodeWbxml(el('Search', undefined, [el('Status', SEARCH_STATUS.INVALID_REQUEST)]));
  }
  const name = getText(store, 'Name').toLowerCase();
  if (name === 'mailbox') return encodeWbxml(await searchMailbox(store, userId));
  if (name === 'gal') return encodeWbxml(await searchGalStore(store, userId));
  // Document library and other stores are not supported.
  return encodeWbxml(storeResponse(SEARCH_STATUS.INVALID_REQUEST, [], null, 0));
}
