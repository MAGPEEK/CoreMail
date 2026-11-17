/**
 * Minimal ZIP reader for restoring CoreMail mailbox backups (9.3).
 *
 * Reads the central directory (archiver writes data descriptors, so the local
 * headers carry no sizes), supports the methods "stored" (0) and "deflate" (8)
 * and ZIP64 (archives > 4 GiB or > 65535 entries). Every entry is size-capped
 * before it is inflated and checked against its CRC-32 afterwards. Encrypted
 * entries are refused. No dependencies (node:fs + node:zlib only), unit-tested.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { inflateRaw, type ZlibOptions } from 'node:zlib';

/** Async inflate (libuv thread pool) — a large entry no longer blocks the event loop (9.3 review). */
const inflateRawAsync = promisify(inflateRaw) as (buf: Buffer, opts: ZlibOptions) => Promise<Buffer>;

export class ZipFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipFormatError'; }
}

export class ZipEntryTooLargeError extends Error {
  constructor(readonly entryName: string, readonly size: number, readonly max: number) {
    super(`ZIP entry ${entryName} is too large (${size} bytes, max ${max})`);
    this.name = 'ZipEntryTooLargeError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipLimits {
  /** Max. number of entries (default 1,000,000). */
  maxEntries?: number;
  /** Max. size of the central directory in bytes (default 256 MiB). */
  maxCentralDirectoryBytes?: number;
  /**
   * Max. total uncompressed size of all entries (declared and actually read;
   * default 64 GiB) — a ZIP bomb is refused when the archive is opened.
   */
  maxTotalUncompressedBytes?: number;
}

/** Upper bound of the deflate output for `n` input bytes (stored blocks: 5 bytes per 64 KiB) + slack. */
function maxCompressedFor(n: number): number {
  return n + Math.ceil(n / 16_384) * 5 + 1_024;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32 (IEEE 802.3), as stored in ZIP headers. */
export function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipFormatError('unexpected end of ZIP file');
    done += bytesRead;
  }
  return buf;
}

function u64(buf: Buffer, offset: number): number {
  const v = buf.readBigUInt64LE(offset);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('ZIP64 value out of range');
  return Number(v);
}

export interface ZipFile {
  entries: ZipEntry[];
  /** Uncompressed content of an entry (rejects above `maxBytes`, on CRC mismatch or an unsupported method). */
  read(entry: ZipEntry, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** True when the buffer starts like a ZIP archive (local file header or empty archive). */
export function looksLikeZip(head: Buffer): boolean {
  return head.length >= 4 && (head.readUInt32LE(0) === SIG_LOCAL || head.readUInt32LE(0) === SIG_EOCD);
}

export async function openZip(path: string, limits: ZipLimits = {}): Promise<ZipFile> {
  const maxEntries = limits.maxEntries ?? 1_000_000;
  const maxCd = limits.maxCentralDirectoryBytes ?? 256 * 1024 * 1024;
  const maxTotal = limits.maxTotalUncompressedBytes ?? 64 * 1024 ** 3;
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < EOCD_MIN) throw new ZipFormatError('not a ZIP archive (file too small)');
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipFormatError('not a ZIP archive (no end of central directory)');
    const eocdPos = size - tailLen + eocd;
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (eocdPos < 20) throw new ZipFormatError('ZIP64 locator missing');
      const loc = await readAt(fh, eocdPos - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new ZipFormatError('ZIP64 locator missing');
      const z64Pos = u64(loc, 8);
      const z64 = await readAt(fh, z64Pos, 56);
      if (z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipFormatError('ZIP64 end of central directory missing');
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (count > maxEntries) throw new ZipFormatError(`too many ZIP entries (${count}, max ${maxEntries})`);
    if (cdSize > maxCd) throw new ZipFormatError(`ZIP central directory too large (${cdSize} bytes)`);
    if (cdOffset + cdSize > size) throw new ZipFormatError('ZIP central directory outside the file');
    // Every central record has at least 46 bytes: a huge declared count with a
    // small directory is refused before anything is allocated.
    if (count * 46 > cdSize) throw new ZipFormatError(`corrupt ZIP central directory (${count} entries in ${cdSize} bytes)`);

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    const nameLens: number[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError('corrupt ZIP central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) throw new ZipFormatError('corrupt ZIP central directory');
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = nameBuf.toString(flags & 0x0800 ? 'utf8' : 'latin1');
      // ZIP64 extended information (header id 0x0001): only the fields that are 0xFFFFFFFF, in this order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= e + 4 + len) { uncompressedSize = u64(cd, q); q += 8; }
          if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) { compressedSize = u64(cd, q); q += 8; }
          if (localHeaderOffset === 0xffffffff && q + 8 <= e + 4 + len) { localHeaderOffset = u64(cd, q); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
      nameLens.push(nameLen);
      p = end;
    }

    // 9.3 review — ZIP bomb guards before any entry is read:
    //  - the declared uncompressed sizes must fit the total budget;
    //  - local headers must not be shared or overlap (one compressed stream
    //    referenced by many entries is the classic overlapping-entry bomb) and
    //    must lie before the central directory. The span used is a lower bound
    //    (local header + central name length + compressed data).
    let declared = 0;
    for (const e of entries) {
      declared += e.uncompressedSize;
      if (declared > maxTotal) throw new ZipFormatError(`ZIP archive expands to more than ${maxTotal} bytes`);
    }
    const byOffset = entries
      .map((e, i) => ({ start: e.localHeaderOffset, end: e.localHeaderOffset + 30 + nameLens[i]! + e.compressedSize, name: e.name }))
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < byOffset.length; i++) {
      const cur = byOffset[i]!;
      if (cur.end > cdOffset) throw new ZipFormatError(`ZIP entry ${cur.name} overlaps the central directory`);
      const next = byOffset[i + 1];
      if (next && next.start < cur.end) throw new ZipFormatError(`ZIP entries ${cur.name} and ${next.name} overlap`);
    }
    let consumed = 0;

    const read = async (entry: ZipEntry, maxBytes: number): Promise<Buffer> => {
      if (entry.flags & 0x0001) throw new ZipFormatError(`ZIP entry ${entry.name} is encrypted`);
      if (entry.uncompressedSize > maxBytes) throw new ZipEntryTooLargeError(entry.name, entry.uncompressedSize, maxBytes);
      if (entry.method !== 0 && entry.method !== 8) throw new ZipFormatError(`ZIP entry ${entry.name}: unsupported compression method ${entry.method}`);
      // The compressed size is bounded by the entry limit as well (nothing larger is read into memory).
      const maxCompressed = entry.method === 0 ? maxBytes : maxCompressedFor(maxBytes);
      if (entry.compressedSize > maxCompressed) throw new ZipEntryTooLargeError(entry.name, entry.compressedSize, maxBytes);
      if (consumed + entry.uncompressedSize > maxTotal) throw new ZipFormatError(`ZIP archive expands to more than ${maxTotal} bytes`);
      const lh = await readAt(fh, entry.localHeaderOffset, 30);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ZipFormatError(`ZIP entry ${entry.name}: bad local header`);
      const dataStart = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (dataStart + entry.compressedSize > cdOffset) throw new ZipFormatError(`ZIP entry ${entry.name} is truncated`);
      const data = entry.compressedSize ? await readAt(fh, dataStart, entry.compressedSize) : Buffer.alloc(0);
      let out: Buffer;
      if (entry.method === 0) {
        out = data;
      } else {
        try {
          out = await inflateRawAsync(data, { maxOutputLength: Math.max(1, maxBytes) });
        } catch (err) {
          if (err instanceof RangeError || (err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ZipEntryTooLargeError(entry.name, maxBytes + 1, maxBytes);
          }
          throw new ZipFormatError(`ZIP entry ${entry.name} is corrupt (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (out.length !== entry.uncompressedSize) throw new ZipFormatError(`ZIP entry ${entry.name}: size mismatch`);
      if (crc32(out) !== entry.crc32) throw new ZipFormatError(`ZIP entry ${entry.name}: CRC mismatch`);
      consumed += out.length;
      return out;
    };

    return { entries, read, close: () => fh.close() };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}
