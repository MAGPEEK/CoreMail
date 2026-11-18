/**
 * Request and response bodies of the address book endpoint
 * (MS-OXCMAPIHTTP 2.2.5.1 – 2.2.5.19). Every request ends with an auxiliary
 * buffer (size + bytes), which is skipped; responses carry none. A success
 * response starts with StatusCode 0 and the NSPI ErrorCode.
 */
import { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { parseRestriction, WIDE_RESTRICTION, type Restriction } from '../props/restriction.js';
import {
  AB_TRUE, readAbTaggedValue, readMidArray, readOptionalMidArray, readOptionalNames, readOptionalStat,
  readOptionalTagArray, writeAbRow, writeAbValueList, writeOptionalMidArray, writeStat, writeTagArray,
  type AbCell, type Stat,
} from './wire.js';
import type { PropValue } from '../props/values.js';

function skipAux(r: BufferReader): void {
  r.bytes(r.u32());
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface BindRequest { flags: number; state: Stat | null }
export function parseBind(body: Buffer): BindRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const state = readOptionalStat(r);
  skipAux(r);
  return { flags, state };
}

export function parseUnbind(body: Buffer): void {
  const r = new BufferReader(body);
  r.u32();
  skipAux(r);
}

export interface CompareMIdsRequest { state: Stat | null; mid1: number; mid2: number }
export function parseCompareMIds(body: Buffer): CompareMIdsRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const mid1 = r.u32();
  const mid2 = r.u32();
  skipAux(r);
  return { state, mid1, mid2 };
}

export interface DnToMIdRequest { names: string[] }
export function parseDnToMId(body: Buffer): DnToMIdRequest {
  const r = new BufferReader(body);
  r.u32();
  const names = readOptionalNames(r, false) ?? [];
  skipAux(r);
  return { names };
}

export interface GetMatchesRequest {
  state: Stat | null;
  mids: number[] | null;
  filter: Restriction | null;
  /** A property of an object opened as a table (link attributes); CoreMail has none. */
  propertyName: { guid: Buffer; id: number } | null;
  rowCount: number;
  columns: number[] | null;
}
export function parseGetMatches(body: Buffer): GetMatchesRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const mids = readOptionalMidArray(r);
  r.u32(); // InterfaceOptionFlags
  const filter = r.u8() !== 0 ? parseRestriction(r, WIDE_RESTRICTION) : null;
  const propertyName = r.u8() !== 0 ? { guid: r.bytes(16), id: r.u32() } : null;
  const rowCount = r.u32();
  const columns = readOptionalTagArray(r);
  skipAux(r);
  return { state, mids, filter, propertyName, rowCount, columns };
}

export interface GetPropListRequest { flags: number; mid: number; codePage: number }
export function parseGetPropList(body: Buffer): GetPropListRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const mid = r.u32();
  const codePage = r.u32();
  skipAux(r);
  return { flags, mid, codePage };
}

export interface GetPropsRequest { flags: number; state: Stat | null; tags: number[] | null }
export function parseGetProps(body: Buffer): GetPropsRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const state = readOptionalStat(r);
  const tags = readOptionalTagArray(r);
  skipAux(r);
  return { flags, state, tags };
}

export interface GetSpecialTableRequest { flags: number; state: Stat | null; version: number | null }
export function parseGetSpecialTable(body: Buffer): GetSpecialTableRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const state = readOptionalStat(r);
  const version = r.u8() !== 0 ? r.u32() : null;
  skipAux(r);
  return { flags, state, version };
}

export interface GetTemplateInfoRequest { flags: number; displayType: number; templateDn: string | null; codePage: number; localeId: number }
export function parseGetTemplateInfo(body: Buffer): GetTemplateInfoRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const displayType = r.u32();
  const templateDn = r.u8() !== 0 ? r.asciiZ() : null;
  const codePage = r.u32();
  const localeId = r.u32();
  skipAux(r);
  return { flags, displayType, templateDn, codePage, localeId };
}

export interface QueryRowsRequest { flags: number; state: Stat | null; explicitTable: number[]; rowCount: number; columns: number[] | null }
export function parseQueryRows(body: Buffer): QueryRowsRequest {
  const r = new BufferReader(body);
  const flags = r.u32();
  const state = readOptionalStat(r);
  const explicitTable = readMidArray(r);
  const rowCount = r.u32();
  const columns = readOptionalTagArray(r);
  skipAux(r);
  return { flags, state, explicitTable, rowCount, columns };
}

export interface QueryColumnsRequest { mapiFlags: number }
export function parseQueryColumns(body: Buffer): QueryColumnsRequest {
  const r = new BufferReader(body);
  r.u32();
  const mapiFlags = r.u32();
  skipAux(r);
  return { mapiFlags };
}

export interface ResolveNamesRequest { state: Stat | null; tags: number[] | null; names: string[] }
export function parseResolveNames(body: Buffer): ResolveNamesRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const tags = readOptionalTagArray(r);
  const names = readOptionalNames(r, true) ?? [];
  skipAux(r);
  return { state, tags, names };
}

export interface ResortRestrictionRequest { state: Stat | null; mids: number[] | null }
export function parseResortRestriction(body: Buffer): ResortRestrictionRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const mids = readOptionalMidArray(r);
  skipAux(r);
  return { state, mids };
}

export interface SeekEntriesRequest {
  state: Stat | null;
  target: { tag: number; value: PropValue } | null;
  explicitTable: number[] | null;
  columns: number[] | null;
}
export function parseSeekEntries(body: Buffer): SeekEntriesRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const target = r.u8() !== 0 ? readAbTaggedValue(r) : null;
  const explicitTable = readOptionalMidArray(r);
  const columns = readOptionalTagArray(r);
  skipAux(r);
  return { state, target, explicitTable, columns };
}

export interface UpdateStatRequest { state: Stat | null; deltaRequested: boolean }
export function parseUpdateStat(body: Buffer): UpdateStatRequest {
  const r = new BufferReader(body);
  r.u32();
  const state = readOptionalStat(r);
  const deltaRequested = r.u8() !== 0;
  skipAux(r);
  return { state, deltaRequested };
}

/** GetMailboxUrl (ServerDn) and GetAddressBookUrl (UserDn): Flags + one UTF-16 DN. */
export function parseUrlRequest(body: Buffer): { dn: string } {
  const r = new BufferReader(body);
  r.u32();
  const dn = r.utf16Z();
  skipAux(r);
  return { dn };
}

// ── Responses ────────────────────────────────────────────────────────────────

/** Rows of a result set: the columns and one cell list per row. */
export interface AbRowSet { columns: number[]; rows: AbCell[][] }

function head(errorCode: number, capacity = 64): BufferWriter {
  return new BufferWriter(capacity).u32(0).u32(errorCode >>> 0);
}

function end(w: BufferWriter): Buffer {
  return w.u32(0).toBuffer();
}

function optionalStat(w: BufferWriter, state: Stat | null): void {
  if (!state) { w.u8(0); return; }
  w.u8(AB_TRUE);
  writeStat(w, state);
}

function optionalRowSet(w: BufferWriter, set: AbRowSet | null): void {
  if (!set) { w.u8(0); return; }
  w.u8(AB_TRUE);
  writeTagArray(w, set.columns);
  w.u32(set.rows.length);
  for (const row of set.rows) writeAbRow(w, set.columns, row);
}

export function buildBindResponse(errorCode: number, serverGuid: Buffer): Buffer {
  return end(head(errorCode).bytes(serverGuid));
}

/** Unbind, ModLinkAtt, ModProps: StatusCode, ErrorCode, auxiliary buffer. */
export function buildPlainResponse(errorCode: number): Buffer {
  return end(head(errorCode));
}

export function buildCompareMIdsResponse(errorCode: number, result: number): Buffer {
  return end(head(errorCode).i32(result));
}

export function buildDnToMIdResponse(errorCode: number, mids: number[] | null): Buffer {
  const w = head(errorCode);
  writeOptionalMidArray(w, mids);
  return end(w);
}

/** GetMatches, QueryRows and SeekEntries share this shape (GetMatches adds the MIDs). */
export function buildTableResponse(errorCode: number, state: Stat | null, rows: AbRowSet | null, mids?: number[] | null): Buffer {
  const w = head(errorCode, 256);
  optionalStat(w, state);
  if (mids !== undefined) writeOptionalMidArray(w, mids);
  optionalRowSet(w, rows);
  return end(w);
}

export function buildGetPropListResponse(errorCode: number, tags: number[] | null): Buffer {
  const w = head(errorCode);
  if (tags) { w.u8(AB_TRUE); writeTagArray(w, tags); } else w.u8(0);
  return end(w);
}

export function buildGetPropsResponse(errorCode: number, codePage: number, values: AbCell[] | null): Buffer {
  const w = head(errorCode, 256).u32(codePage);
  if (values) { w.u8(AB_TRUE); writeAbValueList(w, values); } else w.u8(0);
  return end(w);
}

export function buildGetSpecialTableResponse(errorCode: number, codePage: number, version: number | null, rows: AbCell[][] | null): Buffer {
  const w = head(errorCode, 256).u32(codePage);
  if (version === null) w.u8(0); else w.u8(AB_TRUE).u32(version);
  if (!rows) w.u8(0);
  else {
    w.u8(AB_TRUE).u32(rows.length);
    for (const row of rows) writeAbValueList(w, row);
  }
  return end(w);
}

export function buildGetTemplateInfoResponse(errorCode: number, codePage: number, row: AbCell[] | null): Buffer {
  const w = head(errorCode).u32(codePage);
  if (row) { w.u8(AB_TRUE); writeAbValueList(w, row); } else w.u8(0);
  return end(w);
}

export function buildQueryColumnsResponse(errorCode: number, columns: number[] | null): Buffer {
  return buildGetPropListResponse(errorCode, columns);
}

export function buildResolveNamesResponse(errorCode: number, codePage: number, mids: number[] | null, rows: AbRowSet | null): Buffer {
  const w = head(errorCode, 256).u32(codePage);
  writeOptionalMidArray(w, mids);
  optionalRowSet(w, rows);
  return end(w);
}

export function buildResortRestrictionResponse(errorCode: number, state: Stat | null, mids: number[] | null): Buffer {
  const w = head(errorCode);
  optionalStat(w, state);
  writeOptionalMidArray(w, mids);
  return end(w);
}

export function buildUpdateStatResponse(errorCode: number, state: Stat | null, delta: number | null): Buffer {
  const w = head(errorCode);
  optionalStat(w, state);
  if (delta === null) w.u8(0); else w.u8(AB_TRUE).i32(delta);
  return end(w);
}

export function buildUrlResponse(errorCode: number, url: string): Buffer {
  return end(head(errorCode).utf16Z(url));
}

/** Failure response body (MS-OXCMAPIHTTP *.3): non-zero StatusCode, auxiliary buffer. */
export function buildFailureBody(statusCode: number): Buffer {
  return new BufferWriter(8).u32(statusCode).u32(0).toBuffer();
}
