/**
 * Shared WebDAV helpers for CalDAV + CardDAV: ETag / CTag / sync-token derivation,
 * conditional-request handling (RFC 7232 If-Match / If-None-Match), a
 * namespace-aware XML request parser, the REPORT request classifier and the
 * multistatus / DAV:error response builders.
 */
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { create } from 'xmlbuilder2';
import { createLogger } from '@coremail/core/logger';

const log = createLogger('dav');

export const NS_DAV = 'DAV:';
export const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav';
export const NS_CS = 'http://calendarserver.org/ns/';
export const NS_APPLE = 'http://apple.com/ns/ical/';

/**
 * RFC 4918 §10.1 compliance classes. Class 2 (LOCK) and `access-control` (the RFC
 * 3744 ACL method) are NOT implemented and therefore not advertised (v7.1.0).
 */
export const DAV_COMPLIANCE = '1, 3, calendar-access, addressbook';
export const DAV_ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCALENDAR, REPORT';

/** Strong ETag of a resource: changes whenever the row changes (updatedAt) or the id differs. */
export function etagFor(id: string, updatedAt: Date): string {
  const h = createHash('sha1').update(`${id}\0${updatedAt.getTime()}`).digest('hex').slice(0, 20);
  return `"${h}"`;
}

/**
 * Collection tag (CS:getctag, DAV:sync-token): derived from the member count and the
 * newest updatedAt — an edit bumps updatedAt, a delete changes the count, a create both.
 */
export function collectionTag(count: number, maxUpdatedAt: Date | null): string {
  return `${count}-${maxUpdatedAt ? maxUpdatedAt.getTime() : 0}`;
}

export const SYNC_TOKEN_PREFIX = 'http://coremail.invalid/ns/sync/';

export function syncTokenFor(ctag: string): string {
  return `${SYNC_TOKEN_PREFIX}${ctag}`;
}

function parseEtagList(header: string): string[] {
  return header.split(',').map((s) => s.trim().replace(/^W\//, '')).filter(Boolean);
}

/**
 * Evaluate If-Match / If-None-Match for a write (PUT/DELETE) or read (GET).
 * `currentEtag` is null when the resource does not exist.
 * Returns the status to answer with (412, or 304 for a GET If-None-Match hit), or null to proceed.
 */
export function checkPreconditions(
  method: string,
  headers: { ifMatch?: string | undefined; ifNoneMatch?: string | undefined },
  currentEtag: string | null,
): 304 | 412 | null {
  if (headers.ifMatch !== undefined) {
    const list = parseEtagList(headers.ifMatch);
    if (currentEtag === null) return 412;
    if (!list.includes('*') && !list.includes(currentEtag)) return 412;
  }
  if (headers.ifNoneMatch !== undefined) {
    const list = parseEtagList(headers.ifNoneMatch);
    const hit = currentEtag !== null && (list.includes('*') || list.includes(currentEtag));
    if (hit) return method === 'GET' || method === 'HEAD' ? 304 : 412;
  }
  return null;
}

export function preconditionHeaders(req: Request): { ifMatch?: string; ifNoneMatch?: string } {
  const ifMatch = req.get('If-Match');
  const ifNoneMatch = req.get('If-None-Match');
  return {
    ...(ifMatch !== undefined ? { ifMatch } : {}),
    ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
  };
}

// ─── XML request parsing ─────────────────────────────────────────────────────

/** Namespace-resolved XML element (CDATA, entities and attributes on any element handled). */
export interface XmlEl {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Concatenated text content (descendants included). */
  text: string;
}

interface DomNode {
  nodeType: number;
  namespaceURI: string | null;
  localName: string | null;
  textContent: string | null;
  childNodes: Iterable<DomNode>;
  attributes?: Iterable<{ localName: string; value: string }>;
}

function toXmlEl(node: DomNode): XmlEl {
  const attrs: Record<string, string> = {};
  for (const a of node.attributes ?? []) attrs[a.localName] = a.value;
  const children: XmlEl[] = [];
  for (const c of node.childNodes) if (c.nodeType === 1) children.push(toXmlEl(c));
  return { ns: node.namespaceURI ?? '', name: node.localName ?? '', attrs, children, text: node.textContent ?? '' };
}

/** Parse an XML request body. Null for an empty or malformed body. No entity expansion. */
export function parseXml(body: unknown): XmlEl | null {
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const root = create(body).root().node as unknown as DomNode;
    return root.nodeType === 1 ? toXmlEl(root) : null;
  } catch {
    return null;
  }
}

export function xmlChild(el: XmlEl | null | undefined, ns: string, name: string): XmlEl | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

export function xmlChildren(el: XmlEl | null | undefined, ns: string, name: string): XmlEl[] {
  return el ? el.children.filter((c) => c.ns === ns && c.name === name) : [];
}

function walk(el: XmlEl, visit: (e: XmlEl) => void): void {
  visit(el);
  for (const c of el.children) walk(c, visit);
}

export type ReportKind = 'calendar-query' | 'calendar-multiget' | 'addressbook-query' | 'addressbook-multiget' | 'sync-collection' | 'unknown';

export interface ReportRequest {
  kind: ReportKind;
  hrefs: string[];
  syncToken: string | null;
  timeRange: { start: Date | null; end: Date | null } | null;
  /** true when the client asked for calendar-data / address-data (or sent no prop list). */
  wantsData: boolean;
  /** Component names in comp-filters (e.g. VCALENDAR, VEVENT, VTODO). */
  compFilters: string[];
  /** CALDAV:filter / CARDDAV:filter element (null when absent). */
  filter: XmlEl | null;
  /** CALDAV:calendar-data / CARDDAV:address-data element of the prop list (expand, limit-recurrence-set). */
  dataElement: XmlEl | null;
  /** CARDDAV:limit/nresults (RFC 6352 §8.6.1). */
  limit: number | null;
}

export function parseCaldavUtc(v: string | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

const REPORT_NS: Record<string, string> = {
  'calendar-query': NS_CALDAV,
  'calendar-multiget': NS_CALDAV,
  'addressbook-query': NS_CARDDAV,
  'addressbook-multiget': NS_CARDDAV,
  'sync-collection': NS_DAV,
};

/** Classify a REPORT body (namespace-aware). */
export function parseReportRequest(body: unknown): ReportRequest {
  const root = parseXml(body);
  const empty: ReportRequest = {
    kind: 'unknown', hrefs: [], syncToken: null, timeRange: null, wantsData: true,
    compFilters: [], filter: null, dataElement: null, limit: null,
  };
  if (!root) return empty;
  const kind = (REPORT_NS[root.name] === root.ns ? root.name : 'unknown') as ReportKind;

  const prop = xmlChild(root, NS_DAV, 'prop');
  const dataElement = prop?.children.find((c) =>
    (c.ns === NS_CALDAV && c.name === 'calendar-data') || (c.ns === NS_CARDDAV && c.name === 'address-data')) ?? null;
  const filter = root.children.find((c) => c.name === 'filter' && (c.ns === NS_CALDAV || c.ns === NS_CARDDAV)) ?? null;

  const compFilters: string[] = [];
  let timeRange: ReportRequest['timeRange'] = null;
  if (filter) {
    walk(filter, (e) => {
      if (e.ns !== NS_CALDAV) return;
      if (e.name === 'comp-filter' && e.attrs['name']) compFilters.push(e.attrs['name'].toUpperCase());
      if (e.name === 'comp-filter' && !timeRange) {
        const tr = xmlChild(e, NS_CALDAV, 'time-range');
        if (tr) timeRange = { start: parseCaldavUtc(tr.attrs['start']), end: parseCaldavUtc(tr.attrs['end']) };
      }
    });
  }
  const token = xmlChild(root, NS_DAV, 'sync-token');
  const nresults = xmlChild(xmlChild(root, NS_CARDDAV, 'limit'), NS_CARDDAV, 'nresults');
  const n = nresults ? Number.parseInt(nresults.text.trim(), 10) : NaN;

  return {
    kind,
    hrefs: xmlChildren(root, NS_DAV, 'href').map((h) => h.text.trim()).filter(Boolean),
    syncToken: token ? token.text.trim() : null,
    timeRange,
    wantsData: !prop || dataElement !== null,
    compFilters,
    filter,
    dataElement,
    limit: Number.isFinite(n) && n > 0 ? n : null,
  };
}

/** Last path segment without extension (`/dav/calendars/u/c/abc.ics` → `abc`). */
export function resourceIdFromHref(href: string, ext: '.ics' | '.vcf'): string {
  let path = href;
  try { path = new URL(href, 'http://x').pathname; } catch { /* keep raw */ }
  const last = decodeURIComponent(path.replace(/\/+$/, '').split('/').pop() ?? '');
  return last.endsWith(ext) ? last.slice(0, -ext.length) : last;
}

// ─── Responses ───────────────────────────────────────────────────────────────

export type XmlNode = ReturnType<typeof create>;

export function xmlResponse(root: XmlNode): string {
  return root.end({ prettyPrint: false });
}

/** `<d:multistatus>` with every prefix the DAV routers use (d, c, ab, cs, ic). */
export function newMultistatus(): XmlNode {
  return create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:multistatus', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV, 'xmlns:ab': NS_CARDDAV, 'xmlns:cs': NS_CS, 'xmlns:ic': NS_APPLE });
}

export function sendMultistatus(res: Response, doc: XmlNode, status = 207): void {
  res.status(status).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(doc));
}

/**
 * Send a DAV:error body (RFC 4918 §16) with one precondition element, e.g.
 * `sendDavError(res, 403, 'c:supported-calendar-component')`. `fill` adds children.
 */
export function sendDavError(res: Response, status: number, element: string, fill?: (el: XmlNode) => void): void {
  const el = create({ version: '1.0', encoding: 'utf-8' })
    .ele('d:error', { 'xmlns:d': NS_DAV, 'xmlns:c': NS_CALDAV, 'xmlns:ab': NS_CARDDAV })
    .ele(element);
  fill?.(el);
  res.status(status).set('Content-Type', 'application/xml; charset=utf-8').send(xmlResponse(el.up()));
}

export function principalHref(userId: string): string {
  return `/dav/principals/${encodeURIComponent(userId)}/`;
}

/** DAV:current-user-principal (RFC 5397) — answered on every resource. */
export function appendCurrentUserPrincipal(prop: XmlNode, req: Request): void {
  const id = req.davUser?.userId;
  const el = prop.ele('d:current-user-principal');
  if (id) el.ele('d:href').txt(principalHref(id));
  else el.ele('d:unauthenticated');
}

/**
 * The `:userId` path segment must be the authenticated user's own id (every
 * collection lives below the user's own home). Answers 403 and returns false otherwise.
 */
export function requireOwnPath(req: Request, res: Response): boolean {
  const userId = (req.params as { userId?: string }).userId;
  if (!req.davUser || req.davUser.userId !== userId) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

/** Properties named in a PROPPATCH body: `set` and `remove` instructions in document order. */
export function parseProppatch(body: unknown): Array<{ op: 'set' | 'remove'; prop: XmlEl }> | null {
  const root = parseXml(body);
  if (!root || root.ns !== NS_DAV || root.name !== 'propertyupdate') return null;
  const out: Array<{ op: 'set' | 'remove'; prop: XmlEl }> = [];
  for (const c of root.children) {
    if (c.ns !== NS_DAV || (c.name !== 'set' && c.name !== 'remove')) continue;
    for (const prop of xmlChildren(c, NS_DAV, 'prop')) for (const p of prop.children) out.push({ op: c.name, prop: p });
  }
  return out;
}

const PREFIX: Record<string, string> = { [NS_DAV]: 'd', [NS_CALDAV]: 'c', [NS_CARDDAV]: 'ab', [NS_CS]: 'cs', [NS_APPLE]: 'ic' };

/**
 * Multistatus for a PROPPATCH / MKCALENDAR result: one propstat per status.
 * Properties of foreign namespaces get their own xmlns declaration.
 */
export function appendPropResults(response: XmlNode, results: Array<{ prop: XmlEl; status: number }>): void {
  const byStatus = new Map<number, XmlEl[]>();
  for (const r of results) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r.prop]);
  for (const [status, props] of byStatus) {
    const ps = response.ele('d:propstat');
    const prop = ps.ele('d:prop');
    for (const p of props) {
      const prefix = PREFIX[p.ns];
      if (prefix) prop.ele(`${prefix}:${p.name}`);
      else prop.ele(p.ns || null, p.name);
    }
    ps.ele('d:status').txt(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}`.trim());
  }
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 424: 'Failed Dependency' };

/** Express 4 does not catch rejected promises — answer 500 instead of crashing/hanging. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch((err: unknown) => {
      log.error({ err, method: req.method, path: req.path }, 'DAV handler failed');
      if (!res.headersSent) res.status(500).send('Internal Server Error');
    });
  };
}
