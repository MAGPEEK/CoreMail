/**
 * Shared WebDAV helpers for CalDAV + CardDAV: ETag / CTag / sync-token derivation,
 * conditional-request handling (RFC 7232 If-Match / If-None-Match) and a small
 * REPORT request classifier.
 */
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@coremail/core/logger';

const log = createLogger('dav');

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
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseCaldavUtc(v: string | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

/** Classify a REPORT body (namespace-prefix agnostic). */
export function parseReportRequest(body: unknown): ReportRequest {
  const xml = typeof body === 'string' ? body : '';
  const root = /<\s*(?:[\w-]+:)?([\w-]+)[\s>/]/.exec(xml.replace(/<\?xml[^>]*\?>/, '').trimStart());
  const rootName = root?.[1] ?? '';
  const kind: ReportKind =
    rootName === 'calendar-query' || rootName === 'calendar-multiget' ||
    rootName === 'addressbook-query' || rootName === 'addressbook-multiget' ||
    rootName === 'sync-collection'
      ? rootName
      : 'unknown';

  const hrefs = [...xml.matchAll(/<\s*(?:[\w-]+:)?href\s*>([^<]*)<\s*\/\s*(?:[\w-]+:)?href\s*>/g)]
    .map((m) => xmlUnescape((m[1] ?? '').trim()))
    .filter(Boolean);
  const tokenMatch = /<\s*(?:[\w-]+:)?sync-token\s*>([^<]*)</.exec(xml) ?? /<\s*(?:[\w-]+:)?sync-token\s*\/>/.exec(xml);
  const tr = /<\s*(?:[\w-]+:)?time-range\b([^>]*)\/?>/.exec(xml);
  const attr = (s: string, name: string): string | undefined => new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(s)?.[1];
  const hasProp = /<\s*(?:[\w-]+:)?prop\s*>/.test(xml);
  const compFilters = [...xml.matchAll(/<\s*(?:[\w-]+:)?comp-filter\b[^>]*name\s*=\s*"([^"]+)"/g)].map((m) => (m[1] ?? '').toUpperCase());

  return {
    kind,
    hrefs,
    syncToken: tokenMatch ? xmlUnescape((tokenMatch[1] ?? '').trim()) : null,
    timeRange: tr ? { start: parseCaldavUtc(attr(tr[1] ?? '', 'start')), end: parseCaldavUtc(attr(tr[1] ?? '', 'end')) } : null,
    wantsData: !hasProp || /(calendar|address)-data/.test(xml),
    compFilters,
  };
}

/** Last path segment without extension (`/dav/calendars/u/c/abc.ics` → `abc`). */
export function resourceIdFromHref(href: string, ext: '.ics' | '.vcf'): string {
  let path = href;
  try { path = new URL(href, 'http://x').pathname; } catch { /* keep raw */ }
  const last = decodeURIComponent(path.replace(/\/+$/, '').split('/').pop() ?? '');
  return last.endsWith(ext) ? last.slice(0, -ext.length) : last;
}

/** Express 4 does not catch rejected promises — answer 500 instead of crashing/hanging. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch((err: unknown) => {
      log.error({ err, method: req.method, path: req.path }, 'DAV handler failed');
      if (!res.headersSent) res.status(500).send('Internal Server Error');
    });
  };
}
