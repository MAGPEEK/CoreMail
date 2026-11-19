/**
 * Address book endpoint (NSPI over MAPI/HTTP): byte fixtures of the wire
 * structures and request/response bodies (MS-OXCMAPIHTTP 2.2.1, 2.2.5),
 * the address book model (MIDs, sort, hidden entries, ANR) and the
 * operations (positioning, paging, version, limits).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { PropType, Tag } from '../props/tags.js';
import { readAbValue, readStat, writeAbRow, writeAbValue, writeAbValueList, writeStat, type Stat } from './wire.js';
import {
  buildBindResponse, buildTableResponse, parseBind, parseGetMatches, parseResolveNames, parseSeekEntries,
} from './bodies.js';
import {
  AbTag, AddressBook, AnrMid, ephemeralEntryId, GAL_DISPLAY_NAME, galHierarchyRow, Mid, NspiError, NSPI_SERVER_GUID,
} from './address-book.js';
import {
  bindCodePage, currentPosition, HIERARCHY_VERSION, MAX_FILTER_NODES, MAX_RESOLVE_NAMES, MAX_RESULT_CELLS, MAX_ROWS_PER_REQUEST, NSPI_OPERATIONS,
  pageRows, statAt, type NspiContext,
} from './operations.js';
import { legacyDnFor } from '@coremail/storage';
import { encoderFor, isBindCodePage } from './codepage.js';
import type { DirectoryRecord } from '../store/types.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const WESTERN = encoderFor(1252)!;
const bytes = (fn: (w: BufferWriter) => void): Buffer => { const w = new BufferWriter(); fn(w); return w.toBuffer(); };
const utf16z = (s: string): string => Buffer.from(`${s}\u0000`, 'utf16le').toString('hex');

const STAT: Stat = {
  sortType: 0, containerId: 0, currentRec: 0, delta: 0, numPos: 0, totalRecs: 0, codePage: 1200, templateLocale: 0x409, sortLocale: 0x409,
};
const STAT_HEX = '00000000 00000000 00000000 00000000 00000000 00000000 b0040000 09040000 09040000';

const RECORDS: DirectoryRecord[] = [
  { id: 'u-carol', kind: 'user', email: 'carol@example.test', displayName: 'Carol', aliases: [], hidden: false },
  { id: 'u-alice', kind: 'user', email: 'alice@example.test', displayName: 'alice Smith', aliases: ['info@example.test'], hidden: false },
  { id: 'u-bob', kind: 'user', email: 'bob@example.test', displayName: 'Bob', aliases: [], hidden: false },
  { id: 'u-hidden', kind: 'user', email: 'ghost@example.test', displayName: 'Ghost', aliases: [], hidden: true },
  { id: 's-team', kind: 'shared', email: 'team@example.test', displayName: 'Team Box', aliases: [], hidden: false },
];

// ── Wire ─────────────────────────────────────────────────────────────────────

test('STAT: 36 bytes in field order, round trip', () => {
  const w = new BufferWriter();
  writeStat(w, { ...STAT, currentRec: 0x10, delta: -2 });
  assert.equal(w.toBuffer().toString('hex'), hex('00000000 00000000 10000000 feffffff 00000000 00000000 b0040000 09040000 09040000').toString('hex'));
  assert.deepEqual(readStat(new BufferReader(w.toBuffer())), { ...STAT, currentRec: 0x10, delta: -2 });
});

test('AddressBookPropertyValue: HasValue before strings/binaries/multi-values, 32-bit counts; none before integers', () => {
  const enc = (type: number, v: Parameters<typeof writeAbValue>[2]): string => bytes((w) => writeAbValue(w, type, v)).toString('hex');
  assert.equal(enc(PropType.String, 'Ab'), `ff${utf16z('Ab')}`);
  assert.equal(enc(PropType.String8, 'Ab'), 'ff416200');
  assert.equal(enc(PropType.Binary, Buffer.from([1, 2])), 'ff020000000102');
  assert.equal(enc(PropType.Integer32, 6), '06000000');
  assert.equal(enc(PropType.Boolean, true), '01');
  assert.equal(enc(PropType.MultipleString, ['x', 'y']), `ff02000000ff${utf16z('x')}ff${utf16z('y')}`);
  assert.deepEqual(readAbValue(new BufferReader(hex('ff020000000102')), PropType.Binary), Buffer.from([1, 2]));
  assert.equal(readAbValue(new BufferReader(hex('00')), PropType.String), null, 'HasValue FALSE');
});

test('AddressBookPropertyRow: Flags 0 with plain values, Flags 1 with flagged values and error cells; PtypUnspecified carries the type', () => {
  const plain = bytes((w) => writeAbRow(w, [Tag.DisplayName, Tag.ObjectType], [
    { kind: 'value', tag: Tag.DisplayName, value: 'A' }, { kind: 'value', tag: Tag.ObjectType, value: 6 },
  ]));
  assert.equal(plain.toString('hex'), `00ff${utf16z('A')}06000000`);
  const flagged = bytes((w) => writeAbRow(w, [Tag.DisplayName, 0x3a060000], [
    { kind: 'value', tag: Tag.DisplayName, value: 'A' }, { kind: 'error', tag: 0x3a060000, error: NspiError.NotFound },
  ]));
  assert.equal(flagged.toString('hex'), `0100ff${utf16z('A')}0a000a0f010480`);
});

test('AddressBookPropertyValueList: count + type + id + value; an error is a PtypErrorCode value, a missing cell is left out', () => {
  const list = bytes((w) => writeAbValueList(w, [
    { kind: 'value', tag: Tag.SmtpAddress, value: 'b' },
    { kind: 'error', tag: 0x3a06001f, error: NspiError.NotFound },
    { kind: 'missing', tag: 0x3a11001f },
  ]));
  assert.equal(list.toString('hex'), `02000000 1f00fe39 ff${utf16z('b')} 0a00063a 0f010480`.replace(/\s/g, ''));
});

// ── Bodies ───────────────────────────────────────────────────────────────────

test('Bind request / response bodies', () => {
  assert.deepEqual(parseBind(hex(`00000000 01 ${STAT_HEX} 00000000`)), { flags: 0, state: STAT });
  assert.deepEqual(parseBind(hex('20000000 00 04000000 aabbccdd')), { flags: 0x20, state: null }, 'auxiliary buffer skipped');
  const r = buildBindResponse(0, NSPI_SERVER_GUID);
  assert.equal(r.toString('hex'), `0000000000000000${NSPI_SERVER_GUID.toString('hex')}00000000`);
});

test('GetMatches request: the filter uses 32-bit counts and 32-bit binary counts (MAPI over HTTP context)', () => {
  const anr = `04 04 1f000c36 1f000c36 ${utf16z('bo')}`;
  const and = `00 02000000 ${anr} 08 1f00fe39`;
  const body = hex(`00000000 01 ${STAT_HEX} 00 00000000 01 ${and} 00 32000000 01 01000000 1f000130 00000000`);
  const req = parseGetMatches(body);
  assert.equal(req.rowCount, 50);
  assert.deepEqual(req.columns, [0x3001001f]);
  assert.equal(req.filter?.type, 'and');
  const items = req.filter?.type === 'and' ? req.filter.items : [];
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { type: 'property', relop: 4, tag: 0x360c001f, value: { tag: 0x360c001f, value: 'bo' } });
});

test('ResolveNames and SeekEntries request bodies', () => {
  const rn = parseResolveNames(hex(`00000000 01 ${STAT_HEX} 01 01000000 1f000130 01 02000000 ${utf16z('bob')} ${utf16z('x@y')} 00000000`));
  assert.deepEqual(rn.names, ['bob', 'x@y']);
  assert.deepEqual(rn.tags, [0x3001001f]);
  const se = parseSeekEntries(hex(`00000000 01 ${STAT_HEX} 01 1f00 0130 ff${utf16z('Bo')} 00 00 00000000`));
  assert.deepEqual(se.target, { tag: 0x3001001f, value: 'Bo' });
  assert.equal(se.explicitTable, null);
  assert.equal(se.columns, null);
});

test('QueryRows-shaped response: StatusCode, ErrorCode, HasState+STAT, HasColumnsAndRows, columns, rows, aux', () => {
  const r = buildTableResponse(0, STAT, { columns: [Tag.ObjectType], rows: [[{ kind: 'value', tag: Tag.ObjectType, value: 6 }]] });
  assert.equal(r.toString('hex'), hex(`00000000 00000000 ff ${STAT_HEX} ff 01000000 0300fe0f 01000000 00 06000000 00000000`).toString('hex'));
  assert.equal(buildTableResponse(NspiError.InvalidBookmark, null, null).toString('hex'), '0000000005040480000000000000');
});

// ── Address book model ───────────────────────────────────────────────────────

test('MIDs: stable across snapshots, ≥ 0x10, unique; the table is sorted by display name without hidden entries', () => {
  const a = new AddressBook(RECORDS);
  const b = new AddressBook([...RECORDS].reverse());
  for (const r of RECORDS) {
    const ea = a.entryByDn(`/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=${r.id}`)!;
    assert.ok(ea.mid >= 0x10);
    assert.equal(b.entry(ea.mid)?.id, r.id, 'same MID in another snapshot');
  }
  assert.equal(new Set(RECORDS.map((r) => a.entryByDn(`/O=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/CN=Recipients/cn=${r.id}`)!.mid)).size, RECORDS.length);
  assert.deepEqual(a.table.map((e) => e.displayName), ['alice Smith', 'Bob', 'Carol', 'Team Box']);
  assert.equal(a.indexOf(a.entryByDn('/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=u-hidden')!.mid), undefined);
});

test('ANR: an exact address or alias wins; otherwise prefixes of names, words and local parts; hidden never', () => {
  const book = new AddressBook(RECORDS);
  assert.deepEqual(book.resolve('INFO@example.test').map((e) => e.id), ['u-alice']);
  assert.deepEqual(book.resolve('smtp:bob@example.test').map((e) => e.id), ['u-bob']);
  assert.deepEqual(book.resolve('smi').map((e) => e.id), ['u-alice'], 'second word of the display name');
  assert.deepEqual(book.resolve('team').map((e) => e.id), ['s-team']);
  assert.equal(book.resolve('ghost').length, 0);
  assert.equal(book.resolve('  ').length, 0);
  assert.equal(book.resolve('example').length, 0, 'the domain part is not a prefix match');
});

test('GetMatches filter: PidTagAnr nodes use ANR, other nodes the entry properties', () => {
  const book = new AddressBook(RECORDS);
  const anr = { type: 'property' as const, relop: 4, tag: AbTag.Anr, value: { tag: AbTag.Anr, value: 'ca' } };
  assert.deepEqual(book.filter(book.table, anr).map((e) => e.id), ['u-carol']);
  const exist = { type: 'content' as const, fuzzyLow: 1, fuzzyHigh: 1, tag: Tag.SmtpAddress, value: { tag: Tag.SmtpAddress, value: 'TEAM' } };
  assert.deepEqual(book.filter(book.table, exist).map((e) => e.id), ['s-team']);
});

test('EntryIDs: permanent (GUID_NSPI, display type, DN) by default, ephemeral (server GUID, MID) with fEphID', () => {
  const book = new AddressBook(RECORDS);
  const bob = book.resolve('bob')[0]!;
  const [perm] = book.cells(bob, [Tag.EntryId], { ephemeral: false, unicode: true, encode8: WESTERN });
  const permanent = (perm as { value: Buffer }).value;
  assert.equal(permanent.subarray(0, 28).toString('hex'), '00000000dca740c8c042101ab4b908002b2fe1820100000000000000');
  assert.equal(permanent.subarray(28).toString('latin1'), `${bob.dn}\u0000`);
  const [eph] = book.cells(bob, [Tag.EntryId], { ephemeral: true, unicode: true, encode8: WESTERN });
  const ephemeral = (eph as { value: Buffer }).value;
  const mid = Buffer.alloc(4);
  mid.writeUInt32LE(bob.mid);
  assert.equal(ephemeral.toString('hex'), `87000000${NSPI_SERVER_GUID.toString('hex')}0100000000000000${mid.toString('hex')}`);
  assert.deepEqual(ephemeral, ephemeralEntryId(bob.mid, 0));
});

test('hierarchy row: the GAL container in the prescribed column order, 8-bit name unless Unicode', () => {
  const row = galHierarchyRow(false);
  assert.deepEqual(row.map((c) => c.tag), [Tag.EntryId, AbTag.ContainerFlags, Tag.Depth, AbTag.ContainerId, 0x3001001e, AbTag.IsMaster]);
  assert.equal((row[4] as { value: string }).value, GAL_DISPLAY_NAME);
  const entryId = (row[0] as { value: Buffer }).value;
  assert.equal(entryId.readUInt32LE(24), 0x100, 'DT_CONTAINER');
  assert.equal(entryId.subarray(28).toString('latin1'), '/\u0000');
});

// ── Operations ───────────────────────────────────────────────────────────────

test('positioning: absolute (beginning / end / MID + Delta, clamped) and fractional (MID_CURRENT)', () => {
  const index = (m: number): number | undefined => (m === 0x50 ? 3 : undefined);
  assert.equal(currentPosition({ ...STAT, currentRec: Mid.BeginningOfTable }, 10, index), 0);
  assert.equal(currentPosition({ ...STAT, currentRec: Mid.EndOfTable }, 10, index), 10);
  assert.equal(currentPosition({ ...STAT, currentRec: 0x50, delta: 2 }, 10, index), 5);
  assert.equal(currentPosition({ ...STAT, currentRec: 0x50, delta: -9 }, 10, index), 0);
  assert.equal(currentPosition({ ...STAT, currentRec: 0x50, delta: 50 }, 10, index), 10);
  assert.equal(currentPosition({ ...STAT, currentRec: 0x99 }, 10, index), null);
  assert.equal(currentPosition({ ...STAT, currentRec: Mid.Current, numPos: 50, totalRecs: 100 }, 10, index), 5);
});

function ctxOf(book: AddressBook, revealed = new Set<string>()): NspiContext {
  return {
    book: async () => book, revealed, codePage: 1252,
    endpoints: async () => ({ mailStore: 'https://h.example.test/mapi/emsmdb/', addressBook: 'https://h.example.test/mapi/nspi/' }),
  };
}

const body = (fn: (w: BufferWriter) => void): Buffer => bytes(fn);
const withStat = (w: BufferWriter, s: Stat): BufferWriter => { w.u8(1); writeStat(w, s); return w; };

test('QueryRows pages through the table and reports the end position; an explicit table returns those MIDs', async () => {
  const book = new AddressBook(RECORDS);
  const ctx = ctxOf(book);
  const req = (s: Stat, n: number): Buffer => body((w) => { w.u32(0); withStat(w, s).u32(0).u32(n).u8(1).u32(1).u32(Tag.DisplayName).u32(0); });
  const r1 = new BufferReader(await NSPI_OPERATIONS['QueryRows']!(req(STAT, 3), ctx));
  r1.u32();
  assert.equal(r1.u32(), 0);
  r1.u8();
  const s1 = readStat(r1);
  assert.deepEqual([s1.numPos, s1.totalRecs, s1.delta, s1.currentRec], [3, 4, 0, book.table[3]!.mid]);
  const r2 = new BufferReader(await NSPI_OPERATIONS['QueryRows']!(req(s1, 3), ctx));
  r2.u32(); r2.u32(); r2.u8();
  assert.equal(readStat(r2).currentRec, Mid.EndOfTable);
  r2.u8(); r2.bytes(8);
  assert.equal(r2.u32(), 1, 'one row left');
});

test('GetSpecialTable: the GAL row and version; the same version again → no rows; templates → empty', async () => {
  const ctx = ctxOf(new AddressBook(RECORDS));
  const req = (flags: number, version: number | null): Buffer => body((w) => {
    w.u32(flags); withStat(w, STAT);
    if (version === null) w.u8(0); else w.u8(1).u32(version);
    w.u32(0);
  });
  const rowsOf = (buf: Buffer): { version: number | null; rows: number } => {
    const r = new BufferReader(buf);
    r.u32(); r.u32(); r.u32();
    const version = r.u8() ? r.u32() : null;
    const rows = r.u8() ? r.u32() : -1;
    return { version, rows };
  };
  assert.deepEqual(rowsOf(await NSPI_OPERATIONS['GetSpecialTable']!(req(0x4, null), ctx)), { version: HIERARCHY_VERSION, rows: 1 });
  assert.deepEqual(rowsOf(await NSPI_OPERATIONS['GetSpecialTable']!(req(0x4, HIERARCHY_VERSION), ctx)), { version: HIERARCHY_VERSION, rows: 0 });
  assert.deepEqual(rowsOf(await NSPI_OPERATIONS['GetSpecialTable']!(req(0x2, null), ctx)), { version: null, rows: 0 });
});

test('GetMatches: ANR filter → MIDs + rows; more matches than requested → TableTooBig; unknown container → InvalidBookmark', async () => {
  const book = new AddressBook(RECORDS);
  const ctx = ctxOf(book);
  const req = (s: Stat, needle: string, rowCount: number): Buffer => body((w) => {
    w.u32(0); withStat(w, s).u8(0).u32(0).u8(1);
    w.u8(0x04).u8(0x04).u32(AbTag.Anr).u32(AbTag.Anr).utf16Z(needle);
    w.u8(0).u32(rowCount).u8(1).u32(1).u32(Tag.SmtpAddress).u32(0);
  });
  const hit = new BufferReader(await NSPI_OPERATIONS['GetMatches']!(req(STAT, 'bob', 10), ctx));
  hit.u32();
  assert.equal(hit.u32(), 0);
  hit.u8(); const s = readStat(hit);
  assert.equal(s.totalRecs, 1);
  assert.equal(hit.u8(), 0xff);
  assert.equal(hit.u32(), 1);
  assert.equal(hit.u32(), book.resolve('bob')[0]!.mid);
  const many = new BufferReader(await NSPI_OPERATIONS['GetMatches']!(req(STAT, 'e', 0), ctx));
  many.u32();
  assert.equal(many.u32(), 0, '"e" matches nothing by prefix');
  const tooBig = new BufferReader(await NSPI_OPERATIONS['GetMatches']!(req(STAT, 'b', 0), ctx));
  tooBig.u32();
  assert.equal(tooBig.u32(), NspiError.TableTooBig);
  const other = new BufferReader(await NSPI_OPERATIONS['GetMatches']!(req({ ...STAT, containerId: 7 }, 'b', 10), ctx));
  other.u32();
  assert.equal(other.u32(), NspiError.InvalidBookmark);
});

test('SeekEntries on PidTagDisplayName, UpdateStat with delta, CompareMIds, ResortRestriction, URLs', async () => {
  const book = new AddressBook(RECORDS);
  const ctx = ctxOf(book);
  const seek = new BufferReader(await NSPI_OPERATIONS['SeekEntries']!(body((w) => {
    w.u32(0); withStat(w, STAT).u8(1).u16(PropType.String).u16(0x3001).u8(0xff).utf16Z('C').u8(0).u8(0).u32(0);
  }), ctx));
  seek.u32();
  assert.equal(seek.u32(), 0);
  seek.u8();
  const s = readStat(seek);
  assert.deepEqual([s.currentRec, s.numPos], [book.table[2]!.mid, 2], 'Carol is the first name at or after "C"');

  const upd = new BufferReader(await NSPI_OPERATIONS['UpdateStat']!(body((w) => {
    w.u32(0); withStat(w, { ...STAT, currentRec: book.table[1]!.mid, delta: 5 }).u8(1).u32(0);
  }), ctx));
  upd.u32(); upd.u32(); upd.u8();
  const us = readStat(upd);
  assert.deepEqual([us.currentRec, us.numPos], [Mid.EndOfTable, 4]);
  assert.equal(upd.u8(), 0xff);
  assert.equal(upd.i32(), 3, 'moved three rows (clamped at the end)');

  const cmp = new BufferReader(await NSPI_OPERATIONS['CompareMIds']!(body((w) => {
    w.u32(0).u8(0).u32(book.table[3]!.mid).u32(book.table[0]!.mid).u32(0);
  }), ctx));
  cmp.u32(); cmp.u32();
  assert.equal(cmp.i32(), 1);

  const resort = new BufferReader(await NSPI_OPERATIONS['ResortRestriction']!(body((w) => {
    w.u32(0); withStat(w, STAT).u8(1).u32(2).u32(book.table[3]!.mid).u32(book.table[0]!.mid).u32(0);
  }), ctx));
  resort.u32(); resort.u32(); resort.u8(); readStat(resort); resort.u8(); resort.u32();
  assert.deepEqual([resort.u32(), resort.u32()], [book.table[0]!.mid, book.table[3]!.mid]);

  const url = new BufferReader(await NSPI_OPERATIONS['GetMailboxUrl']!(body((w) => { w.u32(0).utf16Z('/o=x/cn=server').u32(0); }), ctx));
  url.u32(); url.u32();
  assert.equal(url.utf16Z(), 'https://h.example.test/mapi/emsmdb/');
});

test('ResolveNames: unresolved / ambiguous / resolved MIDs, rows only for resolved names', async () => {
  const book = new AddressBook([...RECORDS, { id: 'u-bobby', kind: 'user', email: 'bobby@example.test', displayName: 'Bobby', aliases: [], hidden: false }]);
  const r = new BufferReader(await NSPI_OPERATIONS['ResolveNames']!(body((w) => {
    w.u32(0); withStat(w, STAT).u8(1).u32(1).u32(Tag.SmtpAddress).u8(1).u32(3).utf16Z('bob').utf16Z('carol').utf16Z('zed').u32(0);
  }), ctxOf(book)));
  r.u32();
  assert.equal(r.u32(), 0);
  assert.equal(r.u32(), 1200);
  r.u8(); r.u32();
  assert.deepEqual([r.u32(), r.u32(), r.u32()], [AnrMid.Ambiguous, book.resolve('carol')[0]!.mid, AnrMid.Unresolved]);
  r.u8(); r.u32(); r.u32();
  assert.equal(r.u32(), 1, 'one row (carol)');
});

test('GetProps without tags returns every property; an unknown MID → NotFound; read-only operations → NotSupported', async () => {
  const book = new AddressBook(RECORDS);
  const ctx = ctxOf(book);
  const bob = book.resolve('bob')[0]!;
  const all = new BufferReader(await NSPI_OPERATIONS['GetProps']!(body((w) => { w.u32(0); withStat(w, { ...STAT, currentRec: bob.mid }).u8(0).u32(0); }), ctx));
  all.u32();
  assert.equal(all.u32(), 0);
  all.u32();
  assert.equal(all.u8(), 0xff);
  assert.ok(all.u32() >= 10);
  const none = new BufferReader(await NSPI_OPERATIONS['GetProps']!(body((w) => { w.u32(0); withStat(w, { ...STAT, currentRec: 0x10 }).u8(0).u32(0); }), ctx));
  none.u32();
  assert.equal(none.u32(), NspiError.NotFound);
  const mod = new BufferReader(await NSPI_OPERATIONS['ModProps']!(Buffer.alloc(0), ctx));
  mod.u32();
  assert.equal(mod.u32(), NspiError.NotSupported);
  assert.deepEqual(statAt(STAT, 0, []), { ...STAT, currentRec: Mid.EndOfTable, numPos: 0, totalRecs: 0 });
});

// ── Review fixes (hidden entries by MID, result bounds) ──────────────────────

test('hidden entries: a MID alone reveals nothing (GetProps, GetPropList, explicit QueryRows); after DNToMId, or for the own entry, it does', async () => {
  const book = new AddressBook(RECORDS);
  const ghost = book.entryByDn(legacyDnFor('u-hidden'))!;
  const getProps = async (c: NspiContext): Promise<number> => {
    const r = new BufferReader(await NSPI_OPERATIONS['GetProps']!(body((w) => {
      w.u32(0); withStat(w, { ...STAT, currentRec: ghost.mid }).u8(1).u32(1).u32(Tag.SmtpAddress).u32(0);
    }), c));
    r.u32();
    return r.u32();
  };
  const propList = async (c: NspiContext): Promise<number> => {
    const r = new BufferReader(await NSPI_OPERATIONS['GetPropList']!(body((w) => { w.u32(0).u32(ghost.mid).u32(1200).u32(0); }), c));
    r.u32();
    return r.u32();
  };
  const explicitCell = async (c: NspiContext): Promise<string | number> => {
    const r = new BufferReader(await NSPI_OPERATIONS['QueryRows']!(body((w) => {
      w.u32(0); withStat(w, STAT).u32(1).u32(ghost.mid).u32(1).u8(1).u32(1).u32(Tag.SmtpAddress).u32(0);
    }), c));
    r.u32();
    assert.equal(r.u32(), 0);
    r.u8(); readStat(r); r.u8(); r.u32(); r.u32();
    assert.equal(r.u32(), 1, 'one row per requested MID');
    if (r.u8() === 0) { r.u8(); return r.utf16Z(); }
    assert.equal(r.u8(), 0x0a, 'flagged error cell');
    return r.u32();
  };

  const stranger = ctxOf(book);
  assert.equal(await getProps(stranger), NspiError.NotFound, 'GetProps by a guessed MID');
  assert.equal(await propList(stranger), NspiError.NotFound, 'GetPropList by a guessed MID');
  assert.equal(await explicitCell(stranger), NspiError.NotFound, 'explicit QueryRows by a guessed MID');

  const dn = new BufferReader(await NSPI_OPERATIONS['DNToMId']!(body((w) => { w.u32(0).u8(1).u32(1).asciiZ(ghost.dn).u32(0); }), stranger));
  dn.u32(); dn.u32(); dn.u8(); dn.u32();
  assert.equal(dn.u32(), ghost.mid, 'the DN still resolves');
  assert.equal(await getProps(stranger), NspiError.Success, 'readable after DNToMId');
  assert.equal(await propList(stranger), NspiError.Success);
  assert.equal(await explicitCell(stranger), 'ghost@example.test');

  assert.equal(await getProps(ctxOf(book, new Set(['u-hidden']))), NspiError.Success, 'the own (hidden) entry is always readable');
  assert.equal(book.reachable(book.table[0]!.mid, new Set()), book.table[0], 'visible entries need no reveal');
});

test('result bounds: explicit MID lists / ResolveNames beyond the cell budget → TableTooBig, paged reads shrink, big filters → TooComplex', async () => {
  const book = new AddressBook(RECORDS);
  const ctx = ctxOf(book);
  const errorOf = (buf: Buffer): number => { const r = new BufferReader(buf); r.u32(); return r.u32(); };

  const columns = Array.from({ length: 200 }, () => Tag.DisplayName);
  const mids = Array.from({ length: 1000 }, () => book.table[0]!.mid);
  assert.ok(mids.length * columns.length > MAX_RESULT_CELLS);
  assert.equal(errorOf(await NSPI_OPERATIONS['QueryRows']!(body((w) => {
    w.u32(0); withStat(w, STAT).u32(mids.length);
    for (const m of mids) w.u32(m);
    w.u32(10).u8(1).u32(columns.length);
    for (const c of columns) w.u32(c);
    w.u32(0);
  }), ctx)), NspiError.TableTooBig);

  assert.equal(pageRows(5000, 10), MAX_ROWS_PER_REQUEST);
  assert.equal(pageRows(5000, 1000), MAX_RESULT_CELLS / 1000);
  assert.equal(pageRows(5000, MAX_RESULT_CELLS * 4), 1, 'always at least one row');
  assert.equal(pageRows(3, 10), 3);

  assert.equal(errorOf(await NSPI_OPERATIONS['ResolveNames']!(body((w) => {
    w.u32(0); withStat(w, STAT).u8(0).u8(1).u32(MAX_RESOLVE_NAMES + 1);
    for (let i = 0; i <= MAX_RESOLVE_NAMES; i++) w.utf16Z('x');
    w.u32(0);
  }), ctx)), NspiError.TableTooBig);

  assert.equal(errorOf(await NSPI_OPERATIONS['GetMatches']!(body((w) => {
    w.u32(0); withStat(w, STAT).u8(0).u32(0).u8(1);
    w.u8(0x01).u32(MAX_FILTER_NODES);
    for (let i = 0; i < MAX_FILTER_NODES; i++) w.u8(0x08).u32(Tag.DisplayName);
    w.u8(0).u32(100).u8(0).u32(0);
  }), ctx)), NspiError.TooComplex);
});

// ── 9.5 review: the code page of NspiBind ────────────────────────────────────

test('code pages: Western, Cyrillic and Shift-JIS encoders; unrepresentable characters become ?; Bind never accepts Unicode', () => {
  assert.deepEqual([...encoderFor(1252)!('Ä€')], [0xc4, 0x80]);
  assert.deepEqual([...encoderFor(1251)!('Иван')], [0xc8, 0xe2, 0xe0, 0xed]);
  assert.deepEqual([...encoderFor(932)!('日本')], [0x93, 0xfa, 0x96, 0x7b]);
  assert.equal(encoderFor(1252)!('Иx').toString('latin1'), '?x');
  assert.equal(encoderFor(20127)!('Ä a').toString('latin1'), '? a');
  assert.equal(isBindCodePage(1252), true);
  assert.equal(isBindCodePage(1200), false, 'CP_WINUNICODE is no session code page');
  assert.equal(isBindCodePage(4711), false, 'unknown code page');
});

test('8-bit strings: the request STAT code page, else the session code page — not a fixed Latin-1', async () => {
  const book = new AddressBook([{ id: 'u-ivan', kind: 'user', email: 'ivan@example.test', displayName: 'Иван', aliases: [], hidden: false }]);
  const ctx: NspiContext = { ...ctxOf(book), codePage: 1251 };
  const name8 = ((Tag.DisplayName & 0xffff0000) | PropType.String8) >>> 0;
  const query = async (codePage: number): Promise<Buffer> => {
    const r = new BufferReader(await NSPI_OPERATIONS['QueryRows']!(body((w) => {
      w.u32(0); withStat(w, { ...STAT, codePage }).u32(0).u32(10).u8(1).u32(1).u32(name8).u32(0);
    }), ctx));
    r.u32();
    assert.equal(r.u32(), 0);
    r.u8(); readStat(r); r.u8(); r.bytes(8);
    assert.equal(r.u32(), 1);
    assert.equal(r.u8(), 0, 'standard row');
    assert.equal(r.u8(), 0xff, 'HasValue');
    const out: number[] = [];
    for (let b = r.u8(); b !== 0; b = r.u8()) out.push(b);
    return Buffer.from(out);
  };
  assert.deepEqual([...await query(1251)], [0xc8, 0xe2, 0xe0, 0xed], 'STAT names windows-1251');
  assert.deepEqual([...await query(1200)], [0xc8, 0xe2, 0xe0, 0xed], 'Unicode STAT, 8-bit column: the bound code page');
  assert.equal((await query(1252)).toString('latin1'), '????', 'Western cannot represent Cyrillic');
});

test('Bind: CP_WINUNICODE or an unserved code page → InvalidCodepage; the session code page comes from the STAT', () => {
  const bind = (codePage: number): Buffer => body((w) => { w.u32(0); withStat(w, { ...STAT, codePage }).u32(0); });
  const unicode = bindCodePage(bind(1200));
  assert.equal(unicode.ok, false);
  if (!unicode.ok) assert.equal(unicode.response.readUInt32LE(4), NspiError.InvalidCodepage);
  assert.equal(bindCodePage(bind(4711)).ok, false);
  assert.deepEqual(bindCodePage(bind(1251)), { ok: true, codePage: 1251 });
  assert.deepEqual(bindCodePage(body((w) => { w.u32(0).u8(0).u32(0); })), { ok: true, codePage: 1252 }, 'no STAT: Western');
});
