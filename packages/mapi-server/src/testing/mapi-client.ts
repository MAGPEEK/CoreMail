/**
 * Minimal MAPI over HTTP client for the tests and the e2e step (test-only).
 * Self-contained (no imports, erasable TypeScript only) so the e2e runner can
 * load it with Node's type stripping. Encodes Connect / Execute / Disconnect
 * bodies and the ROP requests the tests use, and decodes their responses
 * (MS-OXCMAPIHTTP, MS-OXCRPC, MS-OXCROPS, MS-OXCDATA).
 */

// ── Binary helpers ───────────────────────────────────────────────────────────

export class Writer {
  parts: Buffer[] = [];
  u8(v: number): this { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); this.parts.push(b); return this; }
  u16(v: number): this { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); this.parts.push(b); return this; }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  i32(v: number): this { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); this.parts.push(b); return this; }
  u64(v: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  bytes(b: Buffer): this { this.parts.push(Buffer.from(b)); return this; }
  asciiZ(s: string): this { return this.bytes(Buffer.from(`${s}\u0000`, 'latin1')); }
  utf16Z(s: string): this { return this.bytes(Buffer.from(`${s}\u0000`, 'utf16le')); }
  toBuffer(): Buffer { return Buffer.concat(this.parts); }
}

export class Reader {
  buf: Buffer;
  pos = 0;
  constructor(buf: Buffer) { this.buf = buf; }
  get remaining(): number { return this.buf.length - this.pos; }
  u8(): number { return this.buf.readUInt8(this.pos++); }
  u16(): number { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32(): number { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32(): number { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64(): bigint { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  bytes(n: number): Buffer { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return Buffer.from(b); }
  asciiZ(): string { const end = this.buf.indexOf(0, this.pos); const s = this.buf.toString('latin1', this.pos, end); this.pos = end + 1; return s; }
  utf16Z(): string {
    let end = this.pos;
    while (this.buf.readUInt16LE(end) !== 0) end += 2;
    const s = this.buf.toString('utf16le', this.pos, end);
    this.pos = end + 2;
    return s;
  }
}

// ── Property values ──────────────────────────────────────────────────────────

export const PT = { Integer32: 0x0003, Boolean: 0x000b, Integer64: 0x0014, String8: 0x001e, String: 0x001f, Time: 0x0040, Binary: 0x0102, ErrorCode: 0x000a, Unspecified: 0x0000 };
export const TAG = {
  DisplayName: 0x3001001f, FolderId: 0x67480014, Mid: 0x674a0014, Subject: 0x0037001f, Body: 0x1000001f,
  MessageFlags: 0x0e070003, ContentCount: 0x36020003, SenderEmailAddress: 0x0c1f001f, MessageClass: 0x001a001f,
  RecipientType: 0x0c150003, SmtpAddress: 0x39fe001f, DisplayTo: 0x0e04001f, NativeBody: 0x10160003,
  IpmSubtreeEntryId: 0x35e00102, EntryId: 0x0fff0102, Html: 0x10130102,
};

export type Value = number | bigint | boolean | string | Buffer | { error: number } | undefined;

export function writeValue(w: Writer, type: number, v: Value): void {
  if (type === PT.Integer32 || type === PT.ErrorCode) w.u32(v as number);
  else if (type === PT.Boolean) w.u8(v ? 1 : 0);
  else if (type === PT.Integer64) w.u64(v as bigint);
  else if (type === PT.String) w.utf16Z(v as string);
  else if (type === PT.String8) w.asciiZ(v as string);
  else if (type === PT.Binary) { w.u16((v as Buffer).length); w.bytes(v as Buffer); }
  else throw new Error(`client cannot encode type ${type}`);
}

export function readValue(r: Reader, type: number): Value {
  if (type === PT.Integer32 || type === PT.ErrorCode) return r.u32();
  if (type === PT.Boolean) return r.u8() !== 0;
  if (type === PT.Integer64 || type === PT.Time) return r.u64();
  if (type === PT.String) return r.utf16Z();
  if (type === PT.String8) return r.asciiZ();
  if (type === PT.Binary) return r.bytes(r.u16());
  throw new Error(`client cannot decode type ${type}`);
}

/** PropertyRow (standard or flagged) for `columns`. */
export function readRow(r: Reader, columns: number[]): Value[] {
  const flagged = r.u8() === 1;
  return columns.map((c) => {
    let type = c & 0xffff;
    if (type === PT.Unspecified) type = r.u16();
    if (flagged) {
      const flag = r.u8();
      if (flag === 1) return undefined;
      if (flag === 0x0a) return { error: r.u32() };
    }
    return readValue(r, type);
  });
}

// ── Extended buffers / envelope bodies ──────────────────────────────────────

export function wrapExtended(payload: Buffer): Buffer {
  return new Writer().u16(0).u16(0x0004).u16(payload.length).u16(payload.length).bytes(payload).toBuffer();
}

export function unwrapExtended(buf: Buffer): Buffer {
  const r = new Reader(buf);
  r.u16(); const flags = r.u16(); const size = r.u16(); r.u16();
  if (flags & 0x3) throw new Error('client does not decode compressed/obfuscated responses');
  return r.bytes(size);
}

export function connectBody(userDn: string): Buffer {
  return new Writer().asciiZ(userDn).u32(0).u32(1252).u32(0x0409).u32(0x0409).u32(0).toBuffer();
}

export function executeBody(ropBuffer: Buffer, maxRopOut = 0x40000): Buffer {
  const ext = wrapExtended(ropBuffer);
  return new Writer().u32(0x3).u32(ext.length).bytes(ext).u32(maxRopOut).u32(0).toBuffer();
}

export function disconnectBody(): Buffer { return new Writer().u32(0).toBuffer(); }

export interface MapiBody { metaTags: string[]; headers: Record<string, string>; body: Buffer }

/** Splits "PROCESSING / PENDING / DONE + headers + blank line + body". */
export function parseMapiBody(raw: Buffer): MapiBody {
  const metaTags: string[] = [];
  const headers: Record<string, string> = {};
  let pos = 0;
  const line = (): string => { const end = raw.indexOf('\r\n', pos); const s = raw.toString('latin1', pos, end); pos = end + 2; return s; };
  for (;;) {
    const l = line();
    metaTags.push(l);
    if (l === 'DONE') break;
    if (l !== 'PROCESSING' && l !== 'PENDING') throw new Error(`unexpected meta-tag ${l}`);
  }
  for (;;) {
    const l = line();
    if (l === '') break;
    const i = l.indexOf(':');
    headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { metaTags, headers, body: raw.subarray(pos) };
}

export function parseConnectResponse(body: Buffer): { statusCode: number; errorCode: number; dnPrefix: string; displayName: string } {
  const r = new Reader(body);
  const statusCode = r.u32(); const errorCode = r.u32();
  r.u32(); r.u32(); r.u32();
  return { statusCode, errorCode, dnPrefix: r.asciiZ(), displayName: r.utf16Z() };
}

export function parseExecuteResponse(body: Buffer): { statusCode: number; errorCode: number; ropBuffer: Buffer } {
  const r = new Reader(body);
  const statusCode = r.u32(); const errorCode = r.u32(); r.u32();
  const size = r.u32();
  return { statusCode, errorCode, ropBuffer: size > 0 ? unwrapExtended(r.bytes(size)) : Buffer.alloc(0) };
}

// ── ROP buffers ──────────────────────────────────────────────────────────────

export function ropInput(rops: Buffer[], handles: number[]): Buffer {
  const list = Buffer.concat(rops);
  const w = new Writer().u16(list.length + 2).bytes(list);
  for (const h of handles) w.u32(h);
  return w.toBuffer();
}

export function ropOutput(buf: Buffer): { responses: Reader; handles: number[] } {
  const size = buf.readUInt16LE(0);
  const handles: number[] = [];
  for (let p = size; p + 4 <= buf.length; p += 4) handles.push(buf.readUInt32LE(p));
  return { responses: new Reader(buf.subarray(2, size)), handles };
}

export const rop = {
  logon: (out: number, essdn = ''): Buffer => {
    const dn = essdn ? Buffer.from(`${essdn}\u0000`, 'ascii') : Buffer.alloc(0);
    return new Writer().u8(0xfe).u8(0).u8(out).u8(0x01).u32(0x01000000).u32(0).u16(dn.length).bytes(dn).toBuffer();
  },
  release: (index: number): Buffer => new Writer().u8(0x01).u8(0).u8(index).toBuffer(),
  getReceiveFolder: (index: number): Buffer => new Writer().u8(0x27).u8(0).u8(index).asciiZ('IPM.Note').toBuffer(),
  openFolder: (input: number, out: number, fid: bigint): Buffer => new Writer().u8(0x02).u8(0).u8(input).u8(out).u64(fid).u8(0).toBuffer(),
  getHierarchyTable: (input: number, out: number, flags = 0x40): Buffer => new Writer().u8(0x04).u8(0).u8(input).u8(out).u8(flags).toBuffer(),
  getContentsTable: (input: number, out: number, flags = 0x40): Buffer => new Writer().u8(0x05).u8(0).u8(input).u8(out).u8(flags).toBuffer(),
  setColumns: (index: number, tags: number[]): Buffer => {
    const w = new Writer().u8(0x12).u8(0).u8(index).u8(0).u16(tags.length);
    for (const t of tags) w.u32(t);
    return w.toBuffer();
  },
  queryRows: (index: number, count: number, forward = true): Buffer => new Writer().u8(0x15).u8(0).u8(index).u8(0).u8(forward ? 1 : 0).u16(count).toBuffer(),
  openMessage: (input: number, out: number, fid: bigint, mid: bigint, mode = 0x03): Buffer =>
    new Writer().u8(0x03).u8(0).u8(input).u8(out).u16(1252).u64(fid).u8(mode).u64(mid).toBuffer(),
  getPropertiesSpecific: (index: number, tags: number[], sizeLimit = 0): Buffer => {
    const w = new Writer().u8(0x07).u8(0).u8(index).u16(sizeLimit).u16(1).u16(tags.length);
    for (const t of tags) w.u32(t);
    return w.toBuffer();
  },
  openStream: (input: number, out: number, tag: number, mode = 0): Buffer => new Writer().u8(0x2b).u8(0).u8(input).u8(out).u32(tag).u8(mode).toBuffer(),
  readStream: (index: number, count: number): Buffer => new Writer().u8(0x2c).u8(0).u8(index).u16(count).toBuffer(),
  createMessage: (input: number, out: number, fid: bigint): Buffer => new Writer().u8(0x06).u8(0).u8(input).u8(out).u16(1252).u64(fid).u8(0).toBuffer(),
  setProperties: (index: number, values: Array<{ tag: number; value: Value }>): Buffer => {
    const vals = new Writer();
    for (const v of values) { vals.u32(v.tag); writeValue(vals, v.tag & 0xffff, v.value); }
    const body = vals.toBuffer();
    return new Writer().u8(0x0a).u8(0).u8(index).u16(body.length + 2).u16(values.length).bytes(body).toBuffer();
  },
  /** SMTP recipients with PidTagSmtpAddress as the one column. */
  modifyRecipients: (index: number, rows: Array<{ rowId: number; type: number; email: string; name: string }>): Buffer => {
    const w = new Writer().u8(0x0e).u8(0).u8(index).u16(1).u32(TAG.SmtpAddress).u16(rows.length);
    for (const row of rows) {
      const rr = new Writer().u16(0x0003 | 0x0008 | 0x0010 | 0x0200).utf16Z(row.email).utf16Z(row.name).u16(1).u8(0).utf16Z(row.email).toBuffer();
      w.u32(row.rowId).u8(row.type).u16(rr.length).bytes(rr);
    }
    return w.toBuffer();
  },
  saveChangesMessage: (responseIndex: number, index: number): Buffer => new Writer().u8(0x0c).u8(0).u8(responseIndex).u8(index).u8(0x02).toBuffer(),
  submitMessage: (index: number): Buffer => new Writer().u8(0x32).u8(0).u8(index).u8(0).toBuffer(),
  /** RopRegisterNotification on the whole store (types: NewMail 0x2, ObjectModified 0x10 …). */
  registerNotification: (input: number, out: number, types: number): Buffer =>
    new Writer().u8(0x29).u8(0).u8(input).u8(out).u16(types).u8(1).toBuffer(),

  // ── Incremental change synchronization (MS-OXCFXICS) ──
  /** RopSynchronizationConfigure: type 1 contents / 2 hierarchy. */
  syncConfigure: (input: number, out: number, type: number, flags: number, extraFlags = 0, tags: number[] = [], restriction: Buffer = Buffer.alloc(0)): Buffer => {
    const w = new Writer().u8(0x70).u8(0).u8(input).u8(out).u8(type).u8(flags & 0x01).u16(flags)
      .u16(restriction.length).bytes(restriction).u32(extraFlags).u16(tags.length);
    for (const t of tags) w.u32(t);
    return w.toBuffer();
  },
  uploadStateBegin: (index: number, stateTag: number, size: number): Buffer => new Writer().u8(0x75).u8(0).u8(index).u32(stateTag).u32(size).toBuffer(),
  uploadStateContinue: (index: number, data: Buffer): Buffer => new Writer().u8(0x76).u8(0).u8(index).u32(data.length).bytes(data).toBuffer(),
  uploadStateEnd: (index: number): Buffer => new Writer().u8(0x77).u8(0).u8(index).toBuffer(),
  /** RopFastTransferSourceGetBuffer; sizes ≥ 0xBABE go as BABE + MaximumBufferSize. */
  getBuffer: (index: number, size: number): Buffer => {
    const w = new Writer().u8(0x4e).u8(0).u8(index);
    return (size >= 0xbabe ? w.u16(0xbabe).u16(0xffff) : w.u16(size)).toBuffer();
  },
  getTransferState: (input: number, out: number): Buffer => new Writer().u8(0x82).u8(0).u8(input).u8(out).toBuffer(),
  openCollector: (input: number, out: number, contents: boolean): Buffer => new Writer().u8(0x7e).u8(0).u8(input).u8(out).u8(contents ? 1 : 0).toBuffer(),
  /** RopSynchronizationImportMessageChange with the four fixed properties. */
  importMessageChange: (input: number, out: number, sourceKey: Buffer, flags = 0): Buffer => {
    const changeKey = Buffer.concat([sourceKey.subarray(0, 16), Buffer.from([0, 0, 0, 0, 0, 1])]);
    const pcl = Buffer.concat([Buffer.from([changeKey.length]), changeKey]);
    const w = new Writer().u8(0x72).u8(0).u8(input).u8(out).u8(flags).u16(4);
    w.u32(0x65e00102).u16(sourceKey.length).bytes(sourceKey);
    w.u32(0x30080040).u64(0x01d9000000000000n);
    w.u32(0x65e20102).u16(changeKey.length).bytes(changeKey);
    w.u32(0x65e30102).u16(pcl.length).bytes(pcl);
    return w.toBuffer();
  },
  importReadStateChanges: (index: number, states: Array<{ sourceKey: Buffer; read: boolean }>): Buffer => {
    const body = new Writer();
    for (const s of states) body.u16(s.sourceKey.length).bytes(s.sourceKey).u8(s.read ? 1 : 0);
    const b = body.toBuffer();
    return new Writer().u8(0x80).u8(0).u8(index).u16(b.length).bytes(b).toBuffer();
  },
  /** RopSynchronizationImportDeletes (flags: 0x01 hierarchy, 0x02 hard delete). */
  importDeletes: (index: number, flags: number, sourceKeys: Buffer[]): Buffer => {
    const w = new Writer().u8(0x74).u8(0).u8(index).u8(flags).u16(1).u32(0x00001102).u32(sourceKeys.length);
    for (const k of sourceKeys) w.u16(k.length).bytes(k);
    return w.toBuffer();
  },
  importHierarchyChange: (index: number, parentKey: Buffer, sourceKey: Buffer, name: string): Buffer => {
    const changeKey = Buffer.concat([sourceKey.subarray(0, 16), Buffer.from([0, 0, 0, 0, 0, 2])]);
    const w = new Writer().u8(0x73).u8(0).u8(index).u16(6);
    w.u32(0x65e10102).u16(parentKey.length).bytes(parentKey);
    w.u32(0x65e00102).u16(sourceKey.length).bytes(sourceKey);
    w.u32(0x30080040).u64(0x01d9000000000000n);
    w.u32(0x65e20102).u16(changeKey.length).bytes(changeKey);
    w.u32(0x65e30102).u16(changeKey.length + 1).u8(changeKey.length).bytes(changeKey);
    w.u32(0x3001001f).utf16Z(name);
    return w.u16(1).u32(0x3613001f).utf16Z('IPF.Note').toBuffer();
  },
  importMessageMove: (index: number, sourceFolder: Buffer, sourceMessage: Buffer, destinationMessage: Buffer): Buffer => {
    const w = new Writer().u8(0x78).u8(0).u8(index);
    for (const b of [sourceFolder, sourceMessage, Buffer.alloc(0), destinationMessage, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])]) w.u32(b.length).bytes(b);
    return w.toBuffer();
  },
  getLocalReplicaIds: (index: number, count: number): Buffer => new Writer().u8(0x7f).u8(0).u8(index).u32(count).toBuffer(),
  /** RopSetMessageReadFlag (ReadFlags 0x00 read, 0x04 ClearReadFlag). */
  setMessageReadFlag: (responseIndex: number, inputIndex: number, read: boolean): Buffer =>
    new Writer().u8(0x11).u8(0).u8(responseIndex).u8(inputIndex).u8(read ? 0x00 : 0x04).toBuffer(),
};

/** GLOBCNT of a folder / message ID (2-byte replica ID, then the 6-byte counter big-endian). */
export function globcntOfId(id: bigint): bigint {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(id);
  return BigInt(b.readUIntBE(2, 6));
}

// ── ICS: FastTransfer streams and IDSETs ─────────────────────────────────────

export const ICS = {
  SyncContents: 0x01,
  SyncHierarchy: 0x02,
  FlagUnicode: 0x0001,
  FlagNoDeletions: 0x0002,
  FlagReadState: 0x0008,
  FlagNormal: 0x0020,
  FlagOnlySpecified: 0x0080,
  ExtraEid: 0x01,
  ExtraMessageSize: 0x02,
  ExtraCN: 0x04,
  IdsetGiven: 0x40170003,
  CnsetSeen: 0x67960102,
  CnsetSeenFai: 0x67da0102,
  CnsetRead: 0x67d20102,
  IdsetDeleted: 0x67e50102,
  IdsetNoLongerInScope: 0x40210102,
  IdsetRead: 0x402d0102,
  IdsetUnread: 0x402e0102,
  SourceKey: 0x65e00102,
  ParentSourceKey: 0x65e10102,
  ChangeKey: 0x65e20102,
  ChangeNumber: 0x67a40014,
  MessageFlags: 0x0e070003,
};

const MARKERS = new Set([
  0x40030003, 0x40040003, 0x40000003, 0x400e0003, 0x40120003, 0x40130003, 0x40140003, 0x40150003, 0x402f0003,
  0x403a0003, 0x403b0003, 0x40090003, 0x400b0003, 0x400a0003, 0x400c0003, 0x400d0003, 0x40100003, 0x40010003, 0x40020003,
]);
const FIXED_SIZES: Record<number, number> = { 0x0002: 2, 0x0003: 4, 0x0004: 4, 0x0005: 8, 0x0006: 8, 0x0007: 8, 0x000a: 4, 0x000b: 2, 0x0014: 8, 0x0040: 8, 0x0048: 16 };

export type FxToken = { marker: number } | { tag: number; value: bigint | number | boolean | string | Buffer | Array<Buffer | string | number | bigint> };

/** Lexical tokens of a FastTransfer stream (MS-OXCFXICS 2.2.4.1; MetaTagIdsetGiven is binary). */
export function readFxStream(buf: Buffer): FxToken[] {
  const r = new Reader(buf);
  const out: FxToken[] = [];
  const fixed = (type: number): bigint | number | boolean | Buffer => {
    if (type === 0x000b) return r.u16() !== 0;
    if (type === 0x0003 || type === 0x000a) return r.u32();
    if (type === 0x0002) return r.u16();
    if (type === 0x0014 || type === 0x0040) return r.u64();
    return r.bytes(FIXED_SIZES[type]!);
  };
  const variable = (type: number): string | Buffer => {
    const b = r.bytes(r.u32());
    if (type === 0x001f) return b.subarray(0, b.length - 2).toString('utf16le');
    if (type === 0x001e) return b.subarray(0, b.length - 1).toString('latin1');
    return b;
  };
  while (r.remaining > 0) {
    const tag = r.u32();
    if (MARKERS.has(tag)) { out.push({ marker: tag }); continue; }
    const type = tag & 0xffff;
    if (tag === ICS.IdsetGiven) { out.push({ tag, value: r.bytes(r.u32()) }); continue; }
    if (type & 0x1000) {
      const single = type & ~0x1000;
      const n = r.u32();
      const list: Array<Buffer | string | number | bigint> = [];
      for (let i = 0; i < n; i++) list.push(FIXED_SIZES[single] ? fixed(single) as number | bigint : variable(single));
      out.push({ tag, value: list });
    } else if (FIXED_SIZES[type]) {
      out.push({ tag, value: fixed(type) });
    } else {
      out.push({ tag, value: variable(type) });
    }
  }
  return out;
}

/** GLOBSET → GLOBCNT values (MS-OXCFXICS 2.2.2.6; every command). */
export function readGlobset(r: Reader): bigint[] {
  const stack: number[] = [];
  const pushes: number[] = [];
  const out: bigint[] = [];
  const value = (low: number[]): bigint => BigInt(Buffer.from([...stack, ...low]).readUIntBE(0, 6));
  for (;;) {
    const cmd = r.u8();
    if (cmd === 0x00) return out;
    if (cmd >= 0x01 && cmd <= 0x06) {
      stack.push(...r.bytes(cmd));
      if (stack.length === 6) { out.push(value([])); stack.length -= cmd; } else pushes.push(cmd);
    } else if (cmd === 0x50) {
      stack.length -= pushes.pop()!;
    } else if (cmd === 0x42) {
      const start = r.u8();
      const mask = r.u8();
      out.push(value([start]));
      for (let bit = 0; bit < 8; bit++) if (mask & (1 << bit)) out.push(value([start + 1 + bit]));
    } else if (cmd === 0x52) {
      const n = 6 - stack.length;
      const low = value([...r.bytes(n)]);
      const high = value([...r.bytes(n)]);
      for (let v = low; v <= high; v++) out.push(v);
    } else {
      throw new Error(`GLOBSET command 0x${cmd.toString(16)}`);
    }
  }
}

/** IDSET values: REPLGUID form (state properties) or REPLID form (deletions, read states). */
export function readIdset(buf: Buffer, guidForm: boolean): bigint[] {
  const r = new Reader(buf);
  const out: bigint[] = [];
  while (r.remaining > 0) {
    if (guidForm) r.bytes(16); else r.u16();
    out.push(...readGlobset(r));
  }
  return out;
}

export interface IcsMessage { header: Map<number, unknown>; props: Map<number, unknown>; recipients: Array<Map<number, unknown>>; attachments: Array<Map<number, unknown>> }

export interface IcsResult {
  messages: IcsMessage[];
  deleted: bigint[];
  noLongerInScope: bigint[];
  read: bigint[];
  unread: bigint[];
  /** The final state: state property tag → raw IDSET bytes. */
  state: Map<number, Buffer>;
  ended: boolean;
}

/** Interprets a contents or hierarchy synchronization stream (MS-OXCFXICS 2.2.4.2). */
export function decodeIcsStream(buf: Buffer): IcsResult {
  const res: IcsResult = { messages: [], deleted: [], noLongerInScope: [], read: [], unread: [], state: new Map(), ended: false };
  let target: Map<number, unknown> | null = null;
  let section = '';
  let message: IcsMessage | null = null;
  for (const t of readFxStream(buf)) {
    if ('marker' in t) {
      switch (t.marker) {
        case 0x40120003: // IncrSyncChg
          section = 'change';
          message = { header: new Map(), props: new Map(), recipients: [], attachments: [] };
          target = message.header;
          break;
        case 0x40150003: section = 'message'; target = message!.props; res.messages.push(message!); break; // IncrSyncMessage
        case 0x40030003: target = new Map(); message!.recipients.push(target); break; // StartRecip
        case 0x40000003: target = new Map(); message!.attachments.push(target); break; // NewAttach
        case 0x40040003: case 0x400e0003: target = message!.props; break;
        case 0x40130003: section = 'del'; target = null; break;
        case 0x402f0003: section = 'read'; target = null; break;
        case 0x403a0003: section = 'state'; target = null; break;
        case 0x403b0003: section = ''; break;
        case 0x40140003: res.ended = true; break;
        default: break;
      }
      continue;
    }
    if (section === 'del') {
      if (t.tag === ICS.IdsetDeleted) res.deleted.push(...readIdset(t.value as Buffer, false));
      if (t.tag === ICS.IdsetNoLongerInScope) res.noLongerInScope.push(...readIdset(t.value as Buffer, false));
    } else if (section === 'read') {
      if (t.tag === ICS.IdsetRead) res.read.push(...readIdset(t.value as Buffer, false));
      if (t.tag === ICS.IdsetUnread) res.unread.push(...readIdset(t.value as Buffer, false));
    } else if (section === 'state') {
      res.state.set(t.tag, t.value as Buffer);
    } else if (target) {
      target.set(t.tag, t.value);
    }
  }
  return res;
}

/** The folder changes of a hierarchy stream: every IncrSyncChg propList. */
export function decodeHierarchyStream(buf: Buffer): Array<Map<number, unknown>> {
  const folders: Array<Map<number, unknown>> = [];
  let current: Map<number, unknown> | null = null;
  for (const t of readFxStream(buf)) {
    if ('marker' in t) {
      current = t.marker === 0x40120003 ? new Map() : null;
      if (current) folders.push(current);
      continue;
    }
    if (current) current.set(t.tag, t.value);
  }
  return folders;
}

/** RopFastTransferSourceGetBuffer response: status + the buffer. */
export function decodeGetBuffer(r: Reader): { returnValue: number; status: number; data: Buffer } {
  const head = responseHead(r);
  const status = r.u16();
  r.u16(); r.u16(); r.u8();
  const data = r.bytes(r.u16());
  return { returnValue: head.returnValue, status, data };
}

/** RopNotify responses (and RopPending) after the regular responses of an Execute output. */
export function readNotifications(r: Reader): { notifications: Array<{ handle: number; logonId: number; flags: number; data: Buffer }>; pending: boolean } {
  const notifications: Array<{ handle: number; logonId: number; flags: number; data: Buffer }> = [];
  let pending = false;
  while (r.remaining > 0) {
    const ropId = r.u8();
    if (ropId === 0x6e) { r.u16(); pending = true; continue; }
    if (ropId !== 0x2a) throw new Error(`unexpected RopId 0x${ropId.toString(16)} among notifications`);
    const handle = r.u32();
    const logonId = r.u8();
    const flags = r.buf.readUInt16LE(r.pos);
    const type = flags & 0x0fff;
    const start = r.pos;
    r.u16();
    if (type === 0x0100) r.u16();
    else if (type === 0x0002) { r.u64(); r.u64(); r.u32(); const unicode = r.u8() === 1; if (unicode) r.utf16Z(); else r.asciiZ(); }
    else if (type === 0x0010) { r.u64(); r.u16(); if (flags & 0x1000) r.u32(); if (flags & 0x2000) r.u32(); }
    else throw new Error(`client cannot decode notification type 0x${type.toString(16)}`);
    notifications.push({ handle, logonId, flags, data: r.buf.subarray(start, r.pos) });
  }
  return { notifications, pending };
}

// ── Address book (NSPI) ──────────────────────────────────────────────────────

export const AB = {
  TRUE: 0xff,
  CP_WINUNICODE: 1200,
  CP_WESTERN: 1252,
  MID_BEGINNING_OF_TABLE: 0,
  MID_END_OF_TABLE: 2,
  MID_UNRESOLVED: 0,
  MID_AMBIGUOUS: 1,
};

export interface StatFields {
  sortType?: number; containerId?: number; currentRec?: number; delta?: number; numPos?: number;
  totalRecs?: number; codePage?: number; templateLocale?: number; sortLocale?: number;
}

export function writeStat(w: Writer, s: StatFields = {}): Writer {
  return w.u32(s.sortType ?? 0).u32(s.containerId ?? 0).u32(s.currentRec ?? 0).i32(s.delta ?? 0).u32(s.numPos ?? 0)
    .u32(s.totalRecs ?? 0).u32(s.codePage ?? AB.CP_WINUNICODE).u32(s.templateLocale ?? 0x0409).u32(s.sortLocale ?? 0x0409);
}

export function readStat(r: Reader): Required<StatFields> {
  return {
    sortType: r.u32(), containerId: r.u32(), currentRec: r.u32(), delta: r.i32(), numPos: r.u32(),
    totalRecs: r.u32(), codePage: r.u32(), templateLocale: r.u32(), sortLocale: r.u32(),
  };
}

function tagArray(w: Writer, tags: number[]): Writer {
  w.u32(tags.length);
  for (const t of tags) w.u32(t);
  return w;
}

export const nspiBody = {
  /** Bind names the session's 8-bit code page (never CP_WINUNICODE, MS-OXNSPI 3.1.4.1.1). */
  bind: (stat: StatFields = {}): Buffer => writeStat(new Writer().u32(0).u8(1), { codePage: AB.CP_WESTERN, ...stat }).u32(0).toBuffer(),
  unbind: (): Buffer => new Writer().u32(0).u32(0).toBuffer(),
  getSpecialTable: (flags = 0x4, version: number | null = null): Buffer => {
    const w = writeStat(new Writer().u32(flags).u8(1));
    if (version === null) w.u8(0); else w.u8(1).u32(version);
    return w.u32(0).toBuffer();
  },
  queryRows: (stat: StatFields, rowCount: number, columns: number[], explicit: number[] = []): Buffer => {
    const w = writeStat(new Writer().u32(0).u8(1), stat).u32(explicit.length);
    for (const m of explicit) w.u32(m);
    return tagArray(w.u32(rowCount).u8(1), columns).u32(0).toBuffer();
  },
  resolveNames: (names: string[], columns: number[], stat: StatFields = {}): Buffer => {
    const w = tagArray(writeStat(new Writer().u32(0).u8(1), stat).u8(1), columns).u8(1).u32(names.length);
    for (const n of names) w.utf16Z(n);
    return w.u32(0).toBuffer();
  },
  dnToMId: (dns: string[]): Buffer => {
    const w = new Writer().u32(0).u8(1).u32(dns.length);
    for (const d of dns) w.asciiZ(d);
    return w.u32(0).toBuffer();
  },
  getProps: (mid: number, tags: number[] | null, flags = 0): Buffer => {
    const w = writeStat(new Writer().u32(flags).u8(1), { currentRec: mid });
    if (tags) tagArray(w.u8(1), tags); else w.u8(0);
    return w.u32(0).toBuffer();
  },
};

/** AddressBookPropertyValue of a known type (MS-OXCMAPIHTTP 2.2.1.1; 32-bit binary counts). */
export function readAbValue(r: Reader, type: number): Value | string[] | null {
  const stringish = type === PT.String || type === PT.String8 || type === PT.Binary;
  if (type & 0x1000) {
    if (r.u8() === 0) return null;
    const n = r.u32();
    const out: string[] = [];
    for (let i = 0; i < n; i++) { if (r.u8() === 0) continue; out.push(r.utf16Z()); }
    return out;
  }
  if (stringish && r.u8() === 0) return null;
  if (type === PT.Binary) return r.bytes(r.u32());
  return readValue(r, type);
}

/** AddressBookPropertyRow for known columns. */
export function readAbRow(r: Reader, columns: number[]): Array<Value | string[] | null> {
  const flagged = r.u8() === 1;
  return columns.map((c) => {
    let type = c & 0xffff;
    if (type === PT.Unspecified) type = r.u16();
    if (flagged) {
      const flag = r.u8();
      if (flag === 1) return undefined;
      if (flag === 0x0a) return { error: r.u32() };
    }
    return readAbValue(r, type);
  });
}

function readMids(r: Reader): number[] | null {
  if (r.u8() === 0) return null;
  const n = r.u32();
  const mids: number[] = [];
  for (let i = 0; i < n; i++) mids.push(r.u32());
  return mids;
}

function readRowSet(r: Reader): { columns: number[]; rows: Array<Array<Value | string[] | null>> } | null {
  if (r.u8() === 0) return null;
  const n = r.u32();
  const columns: number[] = [];
  for (let i = 0; i < n; i++) columns.push(r.u32());
  const count = r.u32();
  const rows: Array<Array<Value | string[] | null>> = [];
  for (let i = 0; i < count; i++) rows.push(readAbRow(r, columns));
  return { columns, rows };
}

export const nspiDecode = {
  bind: (body: Buffer): { errorCode: number; serverGuid: Buffer } => {
    const r = new Reader(body); r.u32();
    return { errorCode: r.u32(), serverGuid: r.bytes(16) };
  },
  /** QueryRows / SeekEntries. */
  table: (body: Buffer) => {
    const r = new Reader(body); r.u32();
    const errorCode = r.u32();
    const stat = r.u8() !== 0 ? readStat(r) : null;
    return { errorCode, stat, rowSet: readRowSet(r) };
  },
  resolveNames: (body: Buffer) => {
    const r = new Reader(body); r.u32();
    const errorCode = r.u32();
    const codePage = r.u32();
    return { errorCode, codePage, mids: readMids(r), rowSet: readRowSet(r) };
  },
  dnToMId: (body: Buffer): { errorCode: number; mids: number[] | null } => {
    const r = new Reader(body); r.u32();
    return { errorCode: r.u32(), mids: readMids(r) };
  },
  getProps: (body: Buffer): { errorCode: number; values: Map<number, Value | string[] | null> | null } => {
    const r = new Reader(body); r.u32();
    const errorCode = r.u32();
    r.u32();
    if (r.u8() === 0) return { errorCode, values: null };
    const n = r.u32();
    const values = new Map<number, Value | string[] | null>();
    for (let i = 0; i < n; i++) {
      const type = r.u16();
      const id = r.u16();
      values.set(((id << 16) | type) >>> 0, type === PT.ErrorCode ? { error: r.u32() } : readAbValue(r, type));
    }
    return { errorCode, values };
  },
};

export const HANDLE_UNUSED = 0xffffffff;

/** Response header shared by every ROP response: RopId, handle index, ReturnValue. */
export function responseHead(r: Reader): { ropId: number; index: number; returnValue: number } {
  return { ropId: r.u8(), index: r.u8(), returnValue: r.u32() };
}

export function decodeLogon(r: Reader): { returnValue: number; folderIds: bigint[] } {
  const head = responseHead(r);
  if (head.returnValue !== 0) return { returnValue: head.returnValue, folderIds: [] };
  r.u8();
  const folderIds: bigint[] = [];
  for (let i = 0; i < 13; i++) folderIds.push(r.u64());
  r.u8(); r.bytes(16); r.u16(); r.bytes(16); r.bytes(8); r.u64(); r.u32();
  return { returnValue: 0, folderIds };
}

export function decodeQueryRows(r: Reader, columns: number[]): { returnValue: number; origin: number; rows: Value[][] } {
  const head = responseHead(r);
  if (head.returnValue !== 0) return { returnValue: head.returnValue, origin: 0, rows: [] };
  const origin = r.u8();
  const n = r.u16();
  const rows: Value[][] = [];
  for (let i = 0; i < n; i++) rows.push(readRow(r, columns));
  return { returnValue: 0, origin, rows };
}

export function decodeOpenMessage(r: Reader): { returnValue: number; subject: string; recipients: Array<{ type: number; email: string; name: string }> } {
  const head = responseHead(r);
  if (head.returnValue !== 0) return { returnValue: head.returnValue, subject: '', recipients: [] };
  r.u8();
  const typed = (): string => { const t = r.u8(); return t === 0x04 ? r.utf16Z() : t === 0x02 || t === 0x03 ? r.asciiZ() : ''; };
  const prefix = typed();
  const normalized = typed();
  r.u16();
  const cols = r.u16();
  for (let i = 0; i < cols; i++) r.u32();
  const n = r.u8();
  const recipients: Array<{ type: number; email: string; name: string }> = [];
  for (let i = 0; i < n; i++) {
    const type = r.u8(); r.u16(); r.u16();
    const row = new Reader(r.bytes(r.u16()));
    row.u16();
    recipients.push({ type, email: row.utf16Z(), name: row.utf16Z() });
  }
  return { returnValue: 0, subject: prefix + normalized, recipients };
}

// ── HTTP client ──────────────────────────────────────────────────────────────

export interface ClientResult { status: number; responseCode: number; mapi: MapiBody | null; text: string; headers: Headers }

export class MapiHttpClient {
  base: string;
  authorization: string;
  cookies = new Map<string, string>();
  counter = 0;
  clientInfo = '{11111111-2222-3333-4444-555555555555}';

  constructor(base: string, login: string, password: string) {
    this.base = base;
    this.authorization = `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;
  }

  async request(endpoint: 'emsmdb' | 'nspi', requestType: string, body: Buffer): Promise<ClientResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/mapi-http',
      'X-RequestType': requestType,
      'X-RequestId': `${this.clientInfo}:${++this.counter}`,
      'X-ClientInfo': this.clientInfo,
      'X-ClientApplication': 'CoreMail-Test/1.0',
      Authorization: this.authorization,
    };
    if (this.cookies.size > 0) headers['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.base}/mapi/${endpoint}/`, { method: 'POST', headers, body });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const raw = Buffer.from(await res.arrayBuffer());
    const headerCode = Number(res.headers.get('x-responsecode') ?? '-1');
    if (res.status !== 200 || headerCode !== 0) {
      return { status: res.status, responseCode: headerCode, mapi: null, text: raw.toString('utf8'), headers: res.headers };
    }
    const mapi = parseMapiBody(raw);
    return { status: res.status, responseCode: Number(mapi.headers['x-responsecode']), mapi, text: '', headers: res.headers };
  }

  connect(userDn = ''): Promise<ClientResult> { return this.request('emsmdb', 'Connect', connectBody(userDn)); }

  /** Executes ROPs; returns the ROP output (responses reader + handle table). */
  async execute(rops: Buffer[], handles: number[], maxRopOut = 0x40000): Promise<ClientResult & { rop: { responses: Reader; handles: number[] } | null; errorCode: number }> {
    const r = await this.request('emsmdb', 'Execute', executeBody(ropInput(rops, handles), maxRopOut));
    if (!r.mapi) return { ...r, rop: null, errorCode: -1 };
    const exec = parseExecuteResponse(r.mapi.body);
    return { ...r, rop: exec.ropBuffer.length > 0 ? ropOutput(exec.ropBuffer) : null, errorCode: exec.errorCode };
  }

  disconnect(): Promise<ClientResult> { return this.request('emsmdb', 'Disconnect', disconnectBody()); }
}
