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
};

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
  bind: (stat: StatFields = {}): Buffer => writeStat(new Writer().u32(0).u8(1), stat).u32(0).toBuffer(),
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
