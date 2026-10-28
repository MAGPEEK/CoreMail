/**
 * MAPI Binary Codec (v4.0.0)
 *
 * Buffer-Reader und -Writer für das MAPI/HTTP Wire-Format.
 * Alle Multi-Byte-Werte sind Little-Endian (Microsoft-Konvention).
 *
 * Siehe ARCHITECTURE.md für Format-Details.
 * Referenz: MS-OXCRPC §2.2 (Wire Format), MS-OXCROPS §2 (ROP-Stream).
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER_ASCII = new TextDecoder('ascii');
const TEXT_DECODER_UTF16LE = new TextDecoder('utf-16le');

/**
 * Liest sequentiell aus einem Buffer. Pointer (`offset`) wandert automatisch.
 * Wirft `RangeError` bei Over-Read.
 */
export class MapiReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  /** Aktuelle Position im Buffer. */
  get position(): number { return this.offset; }
  /** Restliche Bytes im Buffer. */
  get remaining(): number { return this.buf.length - this.offset; }
  /** Total-Länge des Buffers. */
  get length(): number { return this.buf.length; }
  /** Auf bestimmte Position springen. */
  seek(pos: number): void {
    if (pos < 0 || pos > this.buf.length) {
      throw new RangeError(`seek(${pos}) out of range [0..${this.buf.length}]`);
    }
    this.offset = pos;
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new RangeError(
        `MapiReader: tried to read ${bytes} bytes at offset ${this.offset}, buffer length ${this.buf.length}`,
      );
    }
  }

  // ── Primitive (LE) ────────────────────────────────────────────────────────

  readUint8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readUint16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  readUint32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  /** uint64 als BigInt (MAPI verwendet 64-bit Folder-IDs / Message-IDs). */
  readUint64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readInt8(): number {
    this.ensure(1);
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readInt32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  // ── Strings (null-terminated) ─────────────────────────────────────────────

  /**
   * Liest einen ASCII null-terminierten String (single-byte chars).
   * Konsumiert auch das Null-Byte.
   */
  readAsciiString(): string {
    const start = this.offset;
    let end = start;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    if (end >= this.buf.length) {
      throw new RangeError(`readAsciiString: no null terminator after offset ${start}`);
    }
    const str = TEXT_DECODER_ASCII.decode(this.buf.subarray(start, end));
    this.offset = end + 1; // konsumiert Null-Terminator
    return str;
  }

  /**
   * Liest einen UTF-16-LE null-terminierten String (2 Bytes pro Char,
   * Terminator = 2 Bytes 0x0000). Wird oft für Properties verwendet
   * (PT_UNICODE).
   */
  readUtf16String(): string {
    const start = this.offset;
    let end = start;
    while (end + 1 < this.buf.length) {
      if (this.buf[end] === 0 && this.buf[end + 1] === 0) break;
      end += 2;
    }
    if (end + 1 >= this.buf.length) {
      throw new RangeError(`readUtf16String: no null terminator after offset ${start}`);
    }
    const str = TEXT_DECODER_UTF16LE.decode(this.buf.subarray(start, end));
    this.offset = end + 2; // konsumiert Null-Terminator (2 Bytes)
    return str;
  }

  // ── GUIDs (16 Bytes, MS-DTYP §2.3.4.2) ────────────────────────────────────

  /** Liest eine GUID als Buffer (16 Bytes). */
  readGuid(): Buffer {
    this.ensure(16);
    const out = Buffer.from(this.buf.subarray(this.offset, this.offset + 16));
    this.offset += 16;
    return out;
  }

  /** Liest eine GUID und gibt die Standard-Schreibweise zurück: AABBCCDD-EEFF-GGHH-IIJJ-KKLLMMNNOOPP */
  readGuidString(): string {
    const g = this.readGuid();
    // MS-GUID-Format: Data1 (uint32 LE), Data2 (uint16 LE), Data3 (uint16 LE), Data4 (8 Bytes BE)
    const d1 = g.readUInt32LE(0).toString(16).padStart(8, '0');
    const d2 = g.readUInt16LE(4).toString(16).padStart(4, '0');
    const d3 = g.readUInt16LE(6).toString(16).padStart(4, '0');
    const d4 = g.subarray(8, 10).toString('hex');
    const d5 = g.subarray(10, 16).toString('hex');
    return `${d1}-${d2}-${d3}-${d4}-${d5}`;
  }

  // ── Buffer-Slice ───────────────────────────────────────────────────────────

  /** Liest n Bytes als raw Buffer. */
  readBuffer(n: number): Buffer {
    this.ensure(n);
    const out = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }
}

/**
 * Schreibt sequentiell in einen wachsenden Buffer.
 * Liefert via `.toBuffer()` das fertige Ergebnis.
 */
export class MapiWriter {
  private chunks: Buffer[] = [];
  private len = 0;

  /** Aktuelle Gesamtlänge des Buffers. */
  get length(): number { return this.len; }

  /** Gibt den fertigen Buffer zurück (Copy). */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.len);
  }

  private push(b: Buffer): void {
    this.chunks.push(b);
    this.len += b.length;
  }

  // ── Primitive (LE) ────────────────────────────────────────────────────────

  writeUint8(v: number): void {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    this.push(b);
  }
  writeUint16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v & 0xffff, 0);
    this.push(b);
  }
  writeUint32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.push(b);
  }
  writeUint64(v: bigint): void {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(v, 0);
    this.push(b);
  }
  writeInt8(v: number): void {
    const b = Buffer.allocUnsafe(1);
    b.writeInt8(v, 0);
    this.push(b);
  }
  writeInt32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v, 0);
    this.push(b);
  }

  // ── Strings ────────────────────────────────────────────────────────────────

  /** ASCII (single-byte) string mit null-terminator. */
  writeAsciiString(s: string): void {
    const b = Buffer.from(s, 'ascii');
    this.push(b);
    this.writeUint8(0); // null-terminator
  }

  /** UTF-16-LE string mit null-terminator (2 Bytes 0x0000). */
  writeUtf16String(s: string): void {
    // TextEncoder unterstützt UTF-16-LE nicht direkt — manuelle Codierung
    const b = Buffer.allocUnsafe(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      b.writeUInt16LE(s.charCodeAt(i), i * 2);
    }
    this.push(b);
    this.writeUint16(0); // null-terminator (2 Bytes)
  }

  // ── GUIDs ──────────────────────────────────────────────────────────────────

  /** Schreibt eine GUID (16 Bytes). */
  writeGuid(guid: Buffer): void {
    if (guid.length !== 16) {
      throw new TypeError(`writeGuid: expected 16 bytes, got ${guid.length}`);
    }
    this.push(Buffer.from(guid));
  }

  /** Parst die Standard-GUID-Schreibweise und schreibt sie. */
  writeGuidString(s: string): void {
    const clean = s.replace(/[{}-]/g, '');
    if (clean.length !== 32) {
      throw new TypeError(`writeGuidString: expected 32 hex chars, got ${clean.length}`);
    }
    const b = Buffer.allocUnsafe(16);
    // Data1 (4 Bytes LE), Data2 (2 Bytes LE), Data3 (2 Bytes LE), Data4 (8 Bytes BE)
    b.writeUInt32LE(parseInt(clean.slice(0, 8), 16), 0);
    b.writeUInt16LE(parseInt(clean.slice(8, 12), 16), 4);
    b.writeUInt16LE(parseInt(clean.slice(12, 16), 16), 6);
    Buffer.from(clean.slice(16, 32), 'hex').copy(b, 8);
    this.push(b);
  }

  // ── Buffer-Append ──────────────────────────────────────────────────────────

  /** Hängt einen vorhandenen Buffer an. */
  writeBuffer(b: Buffer): void {
    this.push(Buffer.from(b));
  }
}

/**
 * MAPI-Status- und Fehler-Codes (MS-OXCRPC §2.2.5).
 * Nicht erschöpfend — nur die Codes die wir aktuell verwenden.
 */
export const MapiStatusCode = {
  SUCCESS:                  0x00000000,
  EC_ERROR:                 0x00000001,
  EC_NOT_SUPPORTED:         0x80040102,
  EC_LOGIN_FAILURE:         0x80040111,
  EC_NO_ACCESS:             0x80070005,
  EC_NOT_FOUND:             0x8004010F,
  EC_OBJECT_NOT_FOUND:      0x80004005,
  EC_INVALID_PARAMETER:     0x80070057,
  EC_OUT_OF_MEMORY:         0x8007000E,
  EC_INVALID_SESSION:       0x80040115,
} as const;

/**
 * X-Response-Codes für den HTTP-Header `X-ResponseCode` (MS-OXCMAPIHTTP §2.2.3.4).
 */
export const ResponseCode = {
  SUCCESS:                  0,
  INVALID_VERB:             1,
  INVALID_PATH:             2,
  INVALID_HEADER:           3,
  INVALID_X_REQUEST_TYPE:   4,
  MISSING_HEADER:           5,
  ANONYMOUS_NOT_ALLOWED:    6,
  CONTEXT_NOT_FOUND:        13,
  INVALID_COOKIE:           14,
  EXPIRED_COOKIE:           20,
} as const;

/**
 * AUX-Header-Types (MS-OXCRPC §2.2.2.2). Wir senden minimal, damit Outlook
 * den Server als kompatibel erkennt.
 */
export const AuxType = {
  PERF_REQUESTID:    0x01,
  PERF_CLIENTINFO:   0x02,
  PERF_SERVERINFO:   0x03,
  PERF_SESSIONINFO:  0x04,
  CLIENT_CONTROL:    0x0A,
  OSVERSIONINFO:     0x18,
} as const;
