/**
 * Table ROPs (MS-OXCTABL 2.2.2): RopSetColumns, RopSortTable, RopRestrict,
 * RopQueryRows, RopSeekRow, RopQueryPosition — over hierarchy, contents and
 * attachment tables.
 *
 * A table is a snapshot taken when it is first used and re-taken after
 * RopSortTable / RopRestrict. Rows are filtered and sorted in memory.
 * Categorized sorts are answered flat (no header rows). In rows, strings are
 * cut to 255 characters and binaries to 510 bytes (the full value is read
 * from the object). QueryRows returns as many rows as fit into the output
 * buffer; when not even one fits, RopBufferTooSmall asks for more room.
 */
import { Ec, RopError, RopId } from '../codes.js';
import { defineRop, NeedsMoreSpace, objectOf, okResponse, type RopContext, type RopDef } from '../context.js';
import { lookupProperty, type LookupResult, type PropertyBag } from '../../props/bag.js';
import { compareValues, evaluateRestriction, parseRestriction, restrictionNodeCount } from '../../props/restriction.js';
import { writePropertyRow } from '../../props/row.js';
import { PropType, propTypeOf, Tag } from '../../props/tags.js';
import { BufferReader } from '../../wire/reader.js';
import { BufferWriter } from '../../wire/writer.js';
import { folderBag, messageSummaryBag } from '../../objects/props.js';
import { folderNode, refreshView } from './common.js';
import type { LogonState, SortOrder, TableState } from '../../objects/state.js';

const TABLE_STATUS_COMPLETE = 0x00;
const ORIGIN_BEGINNING = 0x00;
const ORIGIN_CURRENT = 0x01;
const ORIGIN_END = 0x02;
const QUERY_NO_ADVANCE = 0x01;
const MAX_TABLE_STRING = 255;
const MAX_TABLE_BINARY = 510;
const MAX_COLUMNS = 512;
export const MAX_RESTRICTION_NODES = 1024;
/** RopId + index + ReturnValue + Origin + RowCount. */
const QUERY_HEADER = 9;

async function sourceRows(ctx: RopContext, logon: LogonState, table: TableState): Promise<PropertyBag[]> {
  const src = table.source;
  if (src.kind === 'attachments') {
    return src.message.attachments.filter((a) => a.saved).map((a) => a.props);
  }
  const view = await refreshView(ctx.store, logon);
  const node = folderNode(logon, src.folderCounter);
  if (src.kind === 'hierarchy') {
    const entries = src.depth ? view.descendants(node.counter) : view.children(node.counter).map((n) => ({ node: n, depth: 1 }));
    return entries.map(({ node: child, depth }) => {
      const bag = folderBag(logon, child);
      bag.set(Tag.Depth, depth - 1);
      return bag;
    });
  }
  if (src.associated || !node.record) return [];
  const messages = await ctx.store.listMessages(node.record.id);
  return messages.map((m) => messageSummaryBag(logon, node.counter, m));
}

function valueFor(bag: PropertyBag, t: number): unknown {
  const r = lookupProperty(bag, t);
  return r.found && 'value' in r ? r.value : undefined;
}

export function sortRows(rows: PropertyBag[], sort: readonly SortOrder[]): PropertyBag[] {
  if (sort.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const s of sort) {
      const va = valueFor(a, s.tag);
      const vb = valueFor(b, s.tag);
      let c: number;
      if (va === undefined || vb === undefined) c = va === undefined ? (vb === undefined ? 0 : -1) : 1;
      else c = compareValues(va as never, vb as never) ?? 0;
      if (c !== 0) return s.descending ? -c : c;
    }
    return 0;
  });
}

/** The (cached) rows of a table after restriction and sort. */
export async function loadTableRows(ctx: RopContext, logon: LogonState, table: TableState): Promise<PropertyBag[]> {
  if (table.rows) return table.rows;
  let rows = await sourceRows(ctx, logon, table);
  const restriction = table.restriction;
  if (restriction) rows = rows.filter((bag) => evaluateRestriction(restriction, (t) => lookupProperty(bag, t)));
  table.rows = sortRows(rows, table.sort);
  table.position = Math.min(table.position, table.rows.length);
  return table.rows;
}

/** Row lookup with the table truncation of long strings and binaries. */
function tableLookup(bag: PropertyBag, column: number): LookupResult {
  const r = lookupProperty(bag, column);
  if (!r.found || !('value' in r)) return r;
  const type = propTypeOf(r.tag);
  if ((type === PropType.String || type === PropType.String8) && typeof r.value === 'string' && r.value.length > MAX_TABLE_STRING) {
    return { ...r, value: r.value.slice(0, MAX_TABLE_STRING) };
  }
  if (type === PropType.Binary && Buffer.isBuffer(r.value) && r.value.length > MAX_TABLE_BINARY) {
    return { ...r, value: r.value.subarray(0, MAX_TABLE_BINARY) };
  }
  return r;
}

function invalidate(table: TableState): void {
  table.rows = null;
  table.position = 0;
}

// ── RopSetColumns ────────────────────────────────────────────────────────────

interface SetColumnsReq { inputIndex: number; columns: number[] }

export const ropSetColumns = defineRop<SetColumnsReq>({
  id: RopId.SetColumns,
  name: 'RopSetColumns',
  parse(r) {
    const inputIndex = r.u8();
    r.u8(); // SetColumnsFlags
    const n = r.u16();
    const columns: number[] = [];
    for (let i = 0; i < n; i++) columns.push(r.u32());
    return { inputIndex, columns };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { table } = objectOf(ctx, req.inputIndex, 'table');
    if (req.columns.length === 0 || req.columns.length > MAX_COLUMNS) throw new RopError(Ec.InvalidParameter, 'column count');
    table.columns = req.columns;
    return okResponse(RopId.SetColumns, req.inputIndex).u8(TABLE_STATUS_COMPLETE).toBuffer();
  },
});

// ── RopSortTable ─────────────────────────────────────────────────────────────

interface SortReq { inputIndex: number; sort: SortOrder[] }

const ORDER_DESCENDING = 0x01;

export const ropSortTable = defineRop<SortReq>({
  id: RopId.SortTable,
  name: 'RopSortTable',
  parse(r) {
    const inputIndex = r.u8();
    r.u8(); // SortTableFlags
    const n = r.u16();
    r.u16(); // CategoryCount
    r.u16(); // ExpandedCount
    const sort: SortOrder[] = [];
    for (let i = 0; i < n; i++) {
      const tag = r.u32();
      sort.push({ tag, descending: (r.u8() & ORDER_DESCENDING) !== 0 });
    }
    return { inputIndex, sort };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { table } = objectOf(ctx, req.inputIndex, 'table');
    table.sort = req.sort;
    invalidate(table);
    return okResponse(RopId.SortTable, req.inputIndex).u8(TABLE_STATUS_COMPLETE).toBuffer();
  },
});

// ── RopRestrict ──────────────────────────────────────────────────────────────

interface RestrictReq { inputIndex: number; restriction: Buffer }

export const ropRestrict = defineRop<RestrictReq>({
  id: RopId.Restrict,
  name: 'RopRestrict',
  parse(r) {
    const inputIndex = r.u8();
    r.u8(); // RestrictFlags
    const restriction = r.bytes(r.u16());
    if (restriction.length > 0) parseRestriction(new BufferReader(restriction)); // validated at parse time
    return { inputIndex, restriction };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { table } = objectOf(ctx, req.inputIndex, 'table');
    const restriction = req.restriction.length > 0 ? parseRestriction(new BufferReader(req.restriction)) : null;
    // Every row is tested against the whole tree: a huge filter would block the process.
    if (restriction && restrictionNodeCount(restriction) > MAX_RESTRICTION_NODES) {
      throw new RopError(Ec.TooComplex, 'restriction has too many nodes');
    }
    table.restriction = restriction;
    invalidate(table);
    return okResponse(RopId.Restrict, req.inputIndex).u8(TABLE_STATUS_COMPLETE).toBuffer();
  },
});

// ── RopQueryRows ─────────────────────────────────────────────────────────────

interface QueryReq { inputIndex: number; flags: number; forward: boolean; rowCount: number }

/**
 * MS-OXCTABL 3.2.5.5, Processing RopQueryRows: no rows left in the read
 * direction after the returned ones → BOOKMARK_END (forward) /
 * BOOKMARK_BEGINNING (backward), else BOOKMARK_CURRENT. `position` is where
 * the read ended — also with NoAdvance, which only keeps the cursor where it was.
 */
function originOf(position: number, count: number, forward: boolean): number {
  if (forward) return position >= count ? ORIGIN_END : ORIGIN_CURRENT;
  return position <= 0 ? ORIGIN_BEGINNING : ORIGIN_CURRENT;
}

export const ropQueryRows = defineRop<QueryReq>({
  id: RopId.QueryRows,
  name: 'RopQueryRows',
  parse: (r) => ({ inputIndex: r.u8(), flags: r.u8(), forward: r.u8() !== 0, rowCount: r.u16() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, table } = objectOf(ctx, req.inputIndex, 'table');
    // MS-OXCTABL, Processing RopQueryRows: ecNullObject when RopSetColumns was not sent.
    if (table.columns.length === 0) throw new RopError(Ec.NullObject, 'RopSetColumns first');
    const rows = await loadTableRows(ctx, logon, table);
    const start = table.position;
    // Rows nearest the cursor first; a backward read is returned in table order.
    const order: number[] = [];
    if (req.forward) for (let i = start; i < rows.length && order.length < req.rowCount; i++) order.push(i);
    else for (let i = start - 1; i >= 0 && order.length < req.rowCount; i--) order.push(i);

    const encoded: Buffer[] = [];
    let total = 0;
    for (const i of order) {
      const row = new BufferWriter(256);
      writePropertyRow(row, table.columns, (c) => tableLookup(rows[i]!, c));
      if (QUERY_HEADER + total + row.length > ctx.budget) {
        if (encoded.length === 0) throw new NeedsMoreSpace(QUERY_HEADER + row.length);
        break;
      }
      encoded.push(row.toBuffer());
      total += row.length;
    }
    if (!req.forward) encoded.reverse();
    const sent = encoded.length;
    const end = req.forward ? start + sent : start - sent;
    // NoAdvance (0x01): "the server MUST NOT change the position of the cursor"
    if ((req.flags & QUERY_NO_ADVANCE) === 0) table.position = end;
    return okResponse(RopId.QueryRows, req.inputIndex)
      .u8(originOf(end, rows.length, req.forward)).u16(sent).bytes(Buffer.concat(encoded)).toBuffer();
  },
});

// ── RopSeekRow / RopQueryPosition ────────────────────────────────────────────

interface SeekReq { inputIndex: number; origin: number; rowCount: number; wantMoved: boolean }

export const ropSeekRow = defineRop<SeekReq>({
  id: RopId.SeekRow,
  name: 'RopSeekRow',
  parse: (r) => ({ inputIndex: r.u8(), origin: r.u8(), rowCount: r.i32(), wantMoved: r.u8() !== 0 }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, table } = objectOf(ctx, req.inputIndex, 'table');
    const rows = await loadTableRows(ctx, logon, table);
    const base = req.origin === ORIGIN_BEGINNING ? 0 : req.origin === ORIGIN_END ? rows.length : table.position;
    const target = Math.max(0, Math.min(rows.length, base + req.rowCount));
    const sought = target - base;
    table.position = target;
    return okResponse(RopId.SeekRow, req.inputIndex).u8(sought !== req.rowCount ? 1 : 0).i32(sought).toBuffer();
  },
});

interface PositionReq { inputIndex: number }

export const ropQueryPosition = defineRop<PositionReq>({
  id: RopId.QueryPosition,
  name: 'RopQueryPosition',
  parse: (r) => ({ inputIndex: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, table } = objectOf(ctx, req.inputIndex, 'table');
    const rows = await loadTableRows(ctx, logon, table);
    return okResponse(RopId.QueryPosition, req.inputIndex).u32(table.position).u32(rows.length).toBuffer();
  },
});

export const tableRops: RopDef[] = [ropSetColumns, ropSortTable, ropRestrict, ropQueryRows, ropSeekRow, ropQueryPosition];
