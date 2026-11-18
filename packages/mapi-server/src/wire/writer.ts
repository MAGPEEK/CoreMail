/** Little-endian binary writer (growable buffer) for MAPI responses. */

export class BufferWriter {
  private buf: Buffer;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = Buffer.allocUnsafe(Math.max(16, initialCapacity));
  }

  get length(): number { return this.len; }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v: number): this { this.ensure(1); this.buf[this.len++] = v & 0xff; return this; }
  u16(v: number): this { this.ensure(2); this.buf.writeUInt16LE(v & 0xffff, this.len); this.len += 2; return this; }
  u32(v: number): this { this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; return this; }
  i32(v: number): this { this.ensure(4); this.buf.writeInt32LE(v | 0, this.len); this.len += 4; return this; }
  u64(v: bigint): this { this.ensure(8); this.buf.writeBigUInt64LE(BigInt.asUintN(64, v), this.len); this.len += 8; return this; }
  i64(v: bigint): this { this.ensure(8); this.buf.writeBigInt64LE(BigInt.asIntN(64, v), this.len); this.len += 8; return this; }
  f32(v: number): this { this.ensure(4); this.buf.writeFloatLE(v, this.len); this.len += 4; return this; }
  f64(v: number): this { this.ensure(8); this.buf.writeDoubleLE(v, this.len); this.len += 8; return this; }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Null-terminated 8-bit string. */
  asciiZ(s: string, encoding: BufferEncoding = 'latin1'): this {
    return this.bytes(Buffer.from(s, encoding)).u8(0);
  }

  /** Null-terminated UTF-16LE string. */
  utf16Z(s: string): this {
    return this.bytes(Buffer.from(s, 'utf16le')).u16(0);
  }

  /** Overwrites a 16-bit value written earlier (size fields). */
  patchU16(offset: number, v: number): void {
    this.buf.writeUInt16LE(v & 0xffff, offset);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}
