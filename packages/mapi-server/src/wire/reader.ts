/**
 * Little-endian binary reader for the MAPI over HTTP wire format
 * (MS-OXCMAPIHTTP request bodies, MS-OXCRPC extended buffers, MS-OXCROPS
 * ROP buffers). Every read is bounds-checked: running past the end throws
 * WireFormatError, which the callers map to "invalid request body" /
 * ecRpcFormat — a malformed request never reads foreign memory or loops.
 */

/** The input does not follow the wire format. */
export class WireFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireFormatError';
  }
}

const UTF16 = new TextDecoder('utf-16le');

export class BufferReader {
  private pos = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get position(): number { return this.pos; }
  get remaining(): number { return this.buf.length - this.pos; }
  get atEnd(): boolean { return this.pos >= this.buf.length; }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new WireFormatError(`read of ${n} bytes at ${this.pos} past end (${this.buf.length})`);
    }
  }

  u8(): number { this.need(1); return this.buf[this.pos++]!; }
  u16(): number { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64(): bigint { this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  i64(): bigint { this.need(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  f32(): number { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }

  /** `n` raw bytes (a copy, so the request buffer can be released). */
  bytes(n: number): Buffer {
    this.need(n);
    const out = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  /** Everything that is left. */
  rest(): Buffer { return this.bytes(this.remaining); }

  /** Null-terminated 8-bit string (the terminator is consumed). */
  asciiZ(encoding: BufferEncoding = 'latin1'): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new WireFormatError(`unterminated 8-bit string at ${this.pos}`);
    const s = this.buf.toString(encoding, this.pos, end);
    this.pos = end + 1;
    return s;
  }

  /** Null-terminated UTF-16LE string (the 2-byte terminator is consumed). */
  utf16Z(): string {
    let end = this.pos;
    while (end + 1 < this.buf.length && (this.buf[end] !== 0 || this.buf[end + 1] !== 0)) end += 2;
    if (end + 1 >= this.buf.length) throw new WireFormatError(`unterminated UTF-16 string at ${this.pos}`);
    const s = UTF16.decode(this.buf.subarray(this.pos, end));
    this.pos = end + 2;
    return s;
  }

  /** A sub-reader over the next `n` bytes; this reader skips them. */
  slice(n: number): BufferReader {
    return new BufferReader(this.bytes(n));
  }
}
