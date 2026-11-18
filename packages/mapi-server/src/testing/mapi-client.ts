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
