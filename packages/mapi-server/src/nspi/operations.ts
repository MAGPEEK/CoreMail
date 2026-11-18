/**
 * The address book operations (MS-OXNSPI 3.1.4.1, as carried by the
 * MS-OXCMAPIHTTP 2.2.5 request types) over one AddressBook snapshot.
 *
 * Positioning (MS-OXNSPI 3.1.4.5): CurrentRec names the start row
 * (MID_BEGINNING_OF_TABLE, MID_END_OF_TABLE, a MID, or MID_CURRENT for
 * fractional positioning NumPos/TotalRecs), then Delta moves it, clamped to
 * the table; the answer reports the end position (CurrentRec, NumPos,
 * TotalRecs exact, Delta 0). The only container is the Global Address List
 * (ContainerID 0); any other gives InvalidBookmark.
 *
 * Read-only directory: ModProps / ModLinkAtt answer NotSupported; there are
 * no distribution lists (a property opened as a table is empty) and no
 * address creation / details templates.
 */
import { WireFormatError } from '../wire/reader.js';
import { restrictionNodeCount } from '../props/restriction.js';
import { propIdOf, Tag } from '../props/tags.js';
import {
  AddressBook, AnrMid, CP_WINUNICODE, DEFAULT_COLUMNS, GAL_CONTAINER_ID, galHierarchyRow, Mid, NspiError,
  NSPI_SERVER_GUID, propertyList, type AbEntry, type CellOptions,
} from './address-book.js';
import {
  buildBindResponse, buildCompareMIdsResponse, buildDnToMIdResponse, buildGetPropListResponse, buildGetPropsResponse,
  buildGetSpecialTableResponse, buildGetTemplateInfoResponse, buildPlainResponse, buildQueryColumnsResponse,
  buildResolveNamesResponse, buildResortRestrictionResponse, buildTableResponse, buildUpdateStatResponse,
  buildUrlResponse, parseBind, parseCompareMIds, parseDnToMId, parseGetMatches, parseGetPropList, parseGetProps,
  parseGetSpecialTable, parseGetTemplateInfo, parseQueryColumns, parseQueryRows, parseResolveNames,
  parseResortRestriction, parseSeekEntries, parseUnbind, parseUpdateStat, parseUrlRequest, type AbRowSet,
} from './bodies.js';
import type { AbCell, Stat } from './wire.js';
import type { MapiEndpoints } from '@coremail/storage';

/** NspiUnbind success value (MS-OXNSPI 2.2.1.2 UnbindSuccess). */
const UNBIND_SUCCESS = 0x00000001;
const FLAG_EPHEMERAL_ID = 0x00000002;
const SPECIAL_TABLE_TEMPLATES = 0x00000002;
const SPECIAL_TABLE_UNICODE = 0x00000004;
const QUERY_COLUMNS_UNICODE = 0x80000000;
/** Version of the address book hierarchy table (one fixed container). */
export const HIERARCHY_VERSION = 1;
/** Rows per QueryRows / SeekEntries answer (Outlook pages with far fewer). */
export const MAX_ROWS_PER_REQUEST = 1000;
const MAX_FILTER_NODES = 1024;
const DEFAULT_CODEPAGE = 1252;

export interface NspiContext {
  /** The address book of the session (loaded on first use, cached by the caller). */
  book(): Promise<AddressBook>;
  /** Public MAPI endpoint URLs (null when no public host name is configured). */
  endpoints(): Promise<MapiEndpoints | null>;
}

type Operation = (body: Buffer, ctx: NspiContext) => Promise<Buffer>;

// ── Positioning ──────────────────────────────────────────────────────────────

/** Current Position of a STAT in `count` rows, or null when CurrentRec is not in the table. */
export function currentPosition(stat: Stat, count: number, indexOf: (mid: number) => number | undefined): number | null {
  let pos: number;
  if (stat.currentRec === Mid.Current) {
    pos = stat.totalRecs > 0 ? Math.floor((count * stat.numPos) / stat.totalRecs) : 0;
  } else if (stat.currentRec === Mid.BeginningOfTable) pos = 0;
  else if (stat.currentRec === Mid.EndOfTable) pos = count;
  else {
    const i = indexOf(stat.currentRec);
    if (i === undefined) return null;
    pos = i;
  }
  return Math.max(0, Math.min(count, Math.min(pos, count) + stat.delta));
}

/** The STAT reporting `pos` as the end position. */
export function statAt(stat: Stat, pos: number, rows: readonly AbEntry[]): Stat {
  return {
    ...stat, currentRec: pos >= rows.length ? Mid.EndOfTable : rows[pos]!.mid,
    delta: 0, numPos: pos, totalRecs: rows.length,
  };
}

function requireStat(stat: Stat | null): Stat {
  if (!stat) throw new WireFormatError('STAT required');
  return stat;
}

function unicodeFor(stat: Stat | null): boolean {
  return stat?.codePage === CP_WINUNICODE;
}

function rowSet(book: AddressBook, entries: readonly AbEntry[], columns: readonly number[], opts: CellOptions): AbRowSet {
  return { columns: [...columns], rows: entries.map((e) => book.cells(e, columns, opts)) };
}

/** Rows for an explicit MID list: unknown MIDs get NotFound errors in every column. */
function explicitRows(book: AddressBook, mids: readonly number[], columns: readonly number[], opts: CellOptions): AbRowSet {
  const rows = mids.map((mid): AbCell[] => {
    const e = book.entry(mid);
    return e ? book.cells(e, columns, opts) : columns.map((t) => ({ kind: 'error', tag: t, error: NspiError.NotFound }));
  });
  return { columns: [...columns], rows };
}

// ── Operations ───────────────────────────────────────────────────────────────

const bind: Operation = async (body) => {
  parseBind(body);
  return buildBindResponse(NspiError.Success, NSPI_SERVER_GUID);
};

const unbind: Operation = async (body) => {
  parseUnbind(body);
  return buildPlainResponse(UNBIND_SUCCESS);
};

const getSpecialTable: Operation = async (body) => {
  const req = parseGetSpecialTable(body);
  const codePage = req.state?.codePage ?? DEFAULT_CODEPAGE;
  if (req.flags & SPECIAL_TABLE_TEMPLATES) return buildGetSpecialTableResponse(NspiError.Success, codePage, null, []);
  const unicode = (req.flags & SPECIAL_TABLE_UNICODE) !== 0 || codePage === CP_WINUNICODE;
  const rows = req.version === HIERARCHY_VERSION ? [] : [galHierarchyRow(unicode)];
  return buildGetSpecialTableResponse(NspiError.Success, codePage, HIERARCHY_VERSION, rows);
};

const queryRows: Operation = async (body, ctx) => {
  const req = parseQueryRows(body);
  const stat = requireStat(req.state);
  if (stat.containerId !== GAL_CONTAINER_ID) return buildTableResponse(NspiError.InvalidBookmark, null, null);
  const book = await ctx.book();
  const columns = req.columns ?? DEFAULT_COLUMNS;
  const opts: CellOptions = { ephemeral: (req.flags & FLAG_EPHEMERAL_ID) !== 0, unicode: unicodeFor(stat) };
  if (req.explicitTable.length > 0) {
    return buildTableResponse(NspiError.Success, { ...stat, delta: 0 }, explicitRows(book, req.explicitTable, columns, opts));
  }
  const start = currentPosition(stat, book.table.length, (m) => book.indexOf(m));
  if (start === null) return buildTableResponse(NspiError.NotFound, null, null);
  const page = book.table.slice(start, start + Math.min(req.rowCount, MAX_ROWS_PER_REQUEST));
  return buildTableResponse(NspiError.Success, statAt(stat, start + page.length, book.table), rowSet(book, page, columns, opts));
};

const updateStat: Operation = async (body, ctx) => {
  const req = parseUpdateStat(body);
  const stat = requireStat(req.state);
  if (stat.containerId !== GAL_CONTAINER_ID) return buildUpdateStatResponse(NspiError.InvalidBookmark, null, null);
  const book = await ctx.book();
  const indexOf = (m: number): number | undefined => book.indexOf(m);
  const pos = currentPosition(stat, book.table.length, indexOf);
  const base = currentPosition({ ...stat, delta: 0 }, book.table.length, indexOf);
  if (pos === null || base === null) return buildUpdateStatResponse(NspiError.NotFound, null, null);
  return buildUpdateStatResponse(NspiError.Success, statAt(stat, pos, book.table), req.deltaRequested ? pos - base : null);
};

const seekEntries: Operation = async (body, ctx) => {
  const req = parseSeekEntries(body);
  const stat = requireStat(req.state);
  if (stat.containerId !== GAL_CONTAINER_ID) return buildTableResponse(NspiError.InvalidBookmark, null, null);
  // The table is sorted by display name: only that property can be sought.
  if (!req.target || propIdOf(req.target.tag) !== propIdOf(Tag.DisplayName) || typeof req.target.value !== 'string') {
    return buildTableResponse(NspiError.TooComplex, null, null);
  }
  const book = await ctx.book();
  const candidates = req.explicitTable ? book.visible(req.explicitTable) : book.table;
  const found = book.seek(candidates, req.target.value);
  if (found < 0) return buildTableResponse(NspiError.NotFound, null, null);
  const opts: CellOptions = { ephemeral: false, unicode: unicodeFor(stat) };
  const rows = req.columns ? rowSet(book, candidates.slice(found, found + MAX_ROWS_PER_REQUEST), req.columns, opts) : null;
  return buildTableResponse(NspiError.Success, statAt(stat, found, candidates), rows);
};

const getMatches: Operation = async (body, ctx) => {
  const req = parseGetMatches(body);
  const stat = requireStat(req.state);
  if (stat.containerId !== GAL_CONTAINER_ID) return buildTableResponse(NspiError.InvalidBookmark, null, null, null);
  const book = await ctx.book();
  // A property opened as a table (distribution list members …): CoreMail has none.
  const candidates = req.propertyName ? [] : req.mids ? book.visible(req.mids) : book.table;
  if (req.filter && restrictionNodeCount(req.filter) > MAX_FILTER_NODES) return buildTableResponse(NspiError.TooComplex, null, null, null);
  const matches = req.filter ? book.filter(candidates, req.filter) : [...candidates];
  if (matches.length > req.rowCount) return buildTableResponse(NspiError.TableTooBig, null, null, null);
  const opts: CellOptions = { ephemeral: false, unicode: unicodeFor(stat) };
  const out: Stat = { ...stat, currentRec: Mid.BeginningOfTable, delta: 0, numPos: 0, totalRecs: matches.length };
  const rows = req.columns ? rowSet(book, matches, req.columns, opts) : null;
  return buildTableResponse(NspiError.Success, out, rows, matches.map((e) => e.mid));
};

const resolveNames: Operation = async (body, ctx) => {
  const req = parseResolveNames(body);
  if (req.state && req.state.containerId !== GAL_CONTAINER_ID) return buildResolveNamesResponse(NspiError.InvalidBookmark, DEFAULT_CODEPAGE, null, null);
  const book = await ctx.book();
  const resolved: AbEntry[] = [];
  const mids = req.names.map((name) => {
    const hits = book.resolve(name);
    if (hits.length === 0) return AnrMid.Unresolved;
    if (hits.length > 1) return AnrMid.Ambiguous;
    resolved.push(hits[0]!);
    return hits[0]!.mid;
  });
  const opts: CellOptions = { ephemeral: false, unicode: true };
  const rows = rowSet(book, resolved, req.tags ?? DEFAULT_COLUMNS, opts);
  return buildResolveNamesResponse(NspiError.Success, req.state?.codePage ?? DEFAULT_CODEPAGE, mids, rows);
};

const dnToMId: Operation = async (body, ctx) => {
  const req = parseDnToMId(body);
  const book = await ctx.book();
  return buildDnToMIdResponse(NspiError.Success, req.names.map((dn) => book.entryByDn(dn)?.mid ?? 0));
};

const getProps: Operation = async (body, ctx) => {
  const req = parseGetProps(body);
  const stat = requireStat(req.state);
  const book = await ctx.book();
  const entry = book.entry(stat.currentRec);
  if (!entry) return buildGetPropsResponse(NspiError.NotFound, stat.codePage, null);
  const opts: CellOptions = { ephemeral: (req.flags & FLAG_EPHEMERAL_ID) !== 0, unicode: unicodeFor(stat) };
  const cells = req.tags ? book.cells(entry, req.tags, opts) : book.allCells(entry, opts);
  const code = cells.some((c) => c.kind !== 'value') ? NspiError.ErrorsReturned : NspiError.Success;
  return buildGetPropsResponse(code, stat.codePage, cells);
};

const getPropList: Operation = async (body, ctx) => {
  const req = parseGetPropList(body);
  const entry = (await ctx.book()).entry(req.mid);
  if (!entry) return buildGetPropListResponse(NspiError.NotFound, null);
  return buildGetPropListResponse(NspiError.Success, propertyList(entry, req.codePage === CP_WINUNICODE));
};

const queryColumns: Operation = async (body, ctx) => {
  const req = parseQueryColumns(body);
  const sample = (await ctx.book()).table[0];
  const unicode = (req.mapiFlags & QUERY_COLUMNS_UNICODE) !== 0;
  return buildQueryColumnsResponse(NspiError.Success, sample ? propertyList(sample, unicode) : []);
};

const compareMIds: Operation = async (body, ctx) => {
  const req = parseCompareMIds(body);
  const book = await ctx.book();
  const a = book.indexOf(req.mid1);
  const b = book.indexOf(req.mid2);
  if (a === undefined || b === undefined) return buildCompareMIdsResponse(NspiError.GeneralFailure, 0);
  return buildCompareMIdsResponse(NspiError.Success, Math.sign(a - b));
};

const resortRestriction: Operation = async (body, ctx) => {
  const req = parseResortRestriction(body);
  const stat = requireStat(req.state);
  const book = await ctx.book();
  const sorted = book.visible(req.mids ?? []).sort((x, y) => book.indexOf(x.mid)! - book.indexOf(y.mid)!);
  const pos = Math.max(0, sorted.findIndex((e) => e.mid === stat.currentRec));
  return buildResortRestrictionResponse(NspiError.Success, statAt(stat, sorted.length === 0 ? 0 : pos, sorted), sorted.map((e) => e.mid));
};

const getTemplateInfo: Operation = async (body) => {
  const req = parseGetTemplateInfo(body);
  return buildGetTemplateInfoResponse(NspiError.NotFound, req.codePage, null);
};

const readOnly: Operation = async () => buildPlainResponse(NspiError.NotSupported);

const getMailboxUrl: Operation = async (body, ctx) => {
  parseUrlRequest(body);
  const urls = await ctx.endpoints();
  return urls ? buildUrlResponse(NspiError.Success, urls.mailStore) : buildUrlResponse(NspiError.NotFound, '');
};

const getAddressBookUrl: Operation = async (body, ctx) => {
  parseUrlRequest(body);
  const urls = await ctx.endpoints();
  return urls ? buildUrlResponse(NspiError.Success, urls.addressBook) : buildUrlResponse(NspiError.NotFound, '');
};

/** Request type → operation (every NSPI request type except PING). */
export const NSPI_OPERATIONS: Readonly<Record<string, Operation>> = {
  Bind: bind,
  Unbind: unbind,
  CompareMIds: compareMIds,
  DNToMId: dnToMId,
  GetMatches: getMatches,
  GetPropList: getPropList,
  GetProps: getProps,
  GetSpecialTable: getSpecialTable,
  GetTemplateInfo: getTemplateInfo,
  ModLinkAtt: readOnly,
  ModProps: readOnly,
  QueryColumns: queryColumns,
  QueryRows: queryRows,
  ResolveNames: resolveNames,
  ResortRestriction: resortRestriction,
  SeekEntries: seekEntries,
  UpdateStat: updateStat,
  GetMailboxUrl: getMailboxUrl,
  GetAddressBookUrl: getAddressBookUrl,
};
