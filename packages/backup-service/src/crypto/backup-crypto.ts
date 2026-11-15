/**
 * Client-side backup encryption (8.0.1): AES-256-GCM in independently
 * authenticated frames, so archives of any size are encrypted and decrypted
 * as streams.
 *
 * File layout (all integers big-endian):
 *
 *   header (34 bytes)
 *     0  4  magic "CMBK"
 *     4  1  format version (1)
 *     5  1  flags (0, reserved)
 *     6  4  frame size F (plaintext bytes per frame, default 64 KiB)
 *    10 16  random salt
 *    26  8  key id = HMAC-SHA256(master key, "coremail-backup-key-id")[0..8]
 *   frames
 *     ciphertext (F bytes; the last frame 0..F bytes) || 16-byte GCM tag
 *
 * - File key = HKDF-SHA256(master key, salt, "coremail-backup-v1 file key").
 *   A fresh salt per file means a fresh key per file, so the nonce can be a
 *   counter: 11-byte frame index || 1 byte "final frame" flag (STREAM
 *   construction). The flag makes truncation at a frame boundary detectable,
 *   the counter makes reordering/dropping frames detectable.
 * - Every frame authenticates the whole header as AAD (version, frame size,
 *   salt and key id cannot be swapped).
 * - There is always exactly one final frame (1..F bytes of plaintext; empty
 *   only for empty input). A frame is written as non-final only when more
 *   plaintext follows, so the decryptor treats the frame that ends the input
 *   as the final one.
 *
 * Master key: BACKUP_ENCRYPTION_KEY (32 bytes as 64 hex characters or base64).
 * Without it the key is derived from JWT_SECRET + PEPPER via HKDF (warning) —
 * rotating either of those secrets then makes older backups unreadable unless
 * the old secrets are kept. The decryptor picks the key by key id from a
 * keyring (configured key + derived key), so backups written before
 * BACKUP_ENCRYPTION_KEY was set stay readable.
 *
 * This module has no CoreMail imports (pure, unit-testable).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, type TransformCallback, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAGIC = Buffer.from('CMBK', 'ascii');
export const FORMAT_VERSION = 1;
export const HEADER_LENGTH = 34;
export const TAG_LENGTH = 16;
export const DEFAULT_FRAME_SIZE = 64 * 1024;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
/** Object key suffix of encrypted backups. */
export const ENCRYPTED_SUFFIX = '.enc';
/** S3 metadata value of encrypted backups (x-amz-meta-encryption). */
export const ENCRYPTION_METADATA = 'coremail-aes-256-gcm-v1';

const FILE_KEY_INFO = 'coremail-backup-v1 file key';
const KEY_ID_LABEL = 'coremail-backup-key-id';
const DERIVE_SALT = 'coremail-backup-key';
const DERIVE_INFO = 'coremail backup encryption key v1';

type Env = Record<string, string | undefined>;

export class BackupKeyConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupKeyConfigError'; }
}

export class BackupDecryptError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupDecryptError'; }
}

export interface BackupKey {
  key: Buffer;
  /** 8-byte key id stored in every file header. */
  id: Buffer;
  source: 'env' | 'derived';
}

export function keyId(master: Buffer): Buffer {
  return createHmac('sha256', master).update(KEY_ID_LABEL).digest().subarray(0, 8);
}

function makeKey(key: Buffer, source: BackupKey['source']): BackupKey {
  return { key, id: keyId(key), source };
}

/** Parses BACKUP_ENCRYPTION_KEY: 64 hex characters or base64 of exactly 32 bytes. */
export function parseKeyString(raw: string): Buffer {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  throw new BackupKeyConfigError('BACKUP_ENCRYPTION_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64 (openssl rand -base64 32)');
}

/** Key derived from JWT_SECRET + PEPPER (fallback), or null when they are missing. */
export function deriveFallbackKey(env: Env): Buffer | null {
  const jwt = env['JWT_SECRET'] ?? '';
  const pepper = env['PEPPER'] ?? '';
  if (!jwt || !pepper) return null;
  return Buffer.from(hkdfSync('sha256', Buffer.from(`${jwt}\u0000${pepper}`, 'utf8'), DERIVE_SALT, DERIVE_INFO, 32));
}

export interface BackupKeyring {
  /** Key used to encrypt new backups. */
  current: BackupKey;
  /** Every key a backup may have been written with (current first). */
  keys: BackupKey[];
}

/**
 * Loads the keyring from the environment. Throws BackupKeyConfigError for an
 * invalid BACKUP_ENCRYPTION_KEY (fail closed) or when no key can be built.
 * `warn` is called once when the derived fallback key is in use.
 */
export function loadKeyring(env: Env = process.env, warn: (msg: string) => void = () => undefined): BackupKeyring {
  const raw = (env['BACKUP_ENCRYPTION_KEY'] ?? '').trim();
  const derived = deriveFallbackKey(env);
  if (raw) {
    const current = makeKey(parseKeyString(raw), 'env');
    const keys = [current];
    if (derived && !derived.equals(current.key)) keys.push(makeKey(derived, 'derived'));
    return { current, keys };
  }
  if (!derived) throw new BackupKeyConfigError('No backup encryption key: set BACKUP_ENCRYPTION_KEY (openssl rand -hex 32)');
  warn('BACKUP_ENCRYPTION_KEY is not set — backups are encrypted with a key derived from JWT_SECRET + PEPPER. '
    + 'Set BACKUP_ENCRYPTION_KEY (openssl rand -hex 32) and store it OFF this server: without it encrypted backups cannot be restored.');
  const current = makeKey(derived, 'derived');
  return { current, keys: [current] };
}

function fileKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, FILE_KEY_INFO, 32));
}

function nonce(index: bigint, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(index, 3); // bytes 0..10 = 11-byte big-endian counter (top 3 bytes stay 0)
  n[11] = final ? 1 : 0;
  return n;
}

export function buildHeader(frameSize: number, salt: Buffer, id: Buffer): Buffer {
  const h = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(h, 0);
  h[4] = FORMAT_VERSION;
  h[5] = 0;
  h.writeUInt32BE(frameSize, 6);
  salt.copy(h, 10);
  id.copy(h, 26);
  return h;
}

/** True when `buf` starts with the encrypted-backup magic. */
export function isEncrypted(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypting transform: plaintext in, header + frames out. */
export function createEncryptStream(key: BackupKey, opts: { frameSize?: number; salt?: Buffer } = {}): Transform {
  const frameSize = opts.frameSize ?? DEFAULT_FRAME_SIZE;
  if (!Number.isInteger(frameSize) || frameSize < 1 || frameSize > MAX_FRAME_SIZE) throw new RangeError(`frame size out of range: ${frameSize}`);
  const salt = opts.salt ?? randomBytes(16);
  const header = buildHeader(frameSize, salt, key.id);
  const fk = fileKey(key.key, salt);
  let index = 0n;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let headerSent = false;

  const sealFrame = (plain: Buffer, final: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', fk, nonce(index, final));
    c.setAAD(header);
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    index++;
    return out;
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) { this.push(header); headerSent = true; }
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen > frameSize) {
        let buf = Buffer.concat(pending, pendingLen);
        // Keep at least one byte back: a frame is only non-final when more data follows.
        while (buf.length > frameSize) {
          this.push(sealFrame(buf.subarray(0, frameSize), false));
          buf = buf.subarray(frameSize);
        }
        pending = [buf];
        pendingLen = buf.length;
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerSent) { this.push(header); headerSent = true; }
      this.push(sealFrame(Buffer.concat(pending, pendingLen), true));
      pending = [];
      pendingLen = 0;
      fk.fill(0);
      cb();
    },
  });
}

export interface HeaderInfo { version: number; frameSize: number; keySource: BackupKey['source'] }

/**
 * Decrypting transform. Emits 'header' (HeaderInfo) once the header is
 * validated and the key is found; errors with BackupDecryptError on a wrong
 * key, a foreign file, truncation or any modified byte. Plaintext of a frame
 * is only released after that frame's tag verified.
 */
export function createDecryptStream(keyring: Pick<BackupKeyring, 'keys'>): Transform {
  let header: Buffer | null = null;
  let fk: Buffer | null = null;
  let frameSize = 0;
  let index = 0n;
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const open = (frame: Buffer, final: boolean): Buffer => {
    const d = createDecipheriv('aes-256-gcm', fk!, nonce(index, final));
    d.setAAD(header!);
    d.setAuthTag(frame.subarray(frame.length - TAG_LENGTH));
    try {
      const out = Buffer.concat([d.update(frame.subarray(0, frame.length - TAG_LENGTH)), d.final()]);
      index++;
      return out;
    } catch {
      throw new BackupDecryptError(`backup is corrupted, truncated or was modified (authentication failed in frame ${index})`);
    }
  };

  const parseHeader = (h: Buffer, stream: Transform): void => {
    if (!h.subarray(0, 4).equals(MAGIC)) throw new BackupDecryptError('not an encrypted CoreMail backup (bad magic)');
    if (h[4] !== FORMAT_VERSION) throw new BackupDecryptError(`unsupported backup encryption format version ${h[4]}`);
    const fs = h.readUInt32BE(6);
    if (fs < 1 || fs > MAX_FRAME_SIZE) throw new BackupDecryptError(`invalid frame size ${fs} in backup header`);
    const id = h.subarray(26, 34);
    const key = keyring.keys.find((k) => k.id.length === id.length && timingSafeEqual(k.id, id));
    if (!key) {
      throw new BackupDecryptError(`backup was encrypted with a different key (key id ${id.toString('hex')}); `
        + 'set BACKUP_ENCRYPTION_KEY to the key that was active when the backup was made');
    }
    header = Buffer.from(h);
    frameSize = fs;
    fk = fileKey(key.key, h.subarray(10, 26));
    stream.emit('header', { version: FORMAT_VERSION, frameSize, keySource: key.source } satisfies HeaderInfo);
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        pending.push(chunk);
        pendingLen += chunk.length;
        let buf = Buffer.concat(pending, pendingLen);
        if (!header) {
          if (buf.length < HEADER_LENGTH) { pending = [buf]; cb(); return; }
          parseHeader(buf.subarray(0, HEADER_LENGTH), this);
          buf = buf.subarray(HEADER_LENGTH);
        }
        const step = frameSize + TAG_LENGTH;
        // A full frame is non-final only when more bytes follow it.
        while (buf.length > step) {
          this.push(open(buf.subarray(0, step), false));
          buf = buf.subarray(step);
        }
        pending = [buf];
        pendingLen = buf.length;
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!header) throw new BackupDecryptError('encrypted backup is truncated (incomplete header)');
        const rest = Buffer.concat(pending, pendingLen);
        if (rest.length < TAG_LENGTH || rest.length > frameSize + TAG_LENGTH) {
          throw new BackupDecryptError('encrypted backup is truncated or has trailing data');
        }
        this.push(open(rest, true));
        fk?.fill(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Pipes `source` through a decryptor and resolves once the header was
 * accepted (right key, valid format) — callers can still answer with an HTTP
 * error before streaming. Later frame errors surface as stream errors.
 */
export function openDecryptedStream(source: Readable, keyring: Pick<BackupKeyring, 'keys'>): Promise<Transform> {
  const dec = createDecryptStream(keyring);
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => { dec.off('header', onHeader); source.unpipe(dec); source.destroy(); reject(err); };
    const onHeader = (): void => { dec.off('error', onError); resolve(dec); };
    dec.once('header', onHeader);
    dec.once('error', onError);
    source.once('error', (err) => dec.destroy(err));
    source.pipe(dec);
  });
}

/** Encrypts a file (streaming). */
export async function encryptFile(src: string, dst: string, key: BackupKey, opts: { frameSize?: number } = {}): Promise<void> {
  await pipeline(createReadStream(src), createEncryptStream(key, opts), createWriteStream(dst, { mode: 0o600 }));
}

/** Decrypts a file (streaming); a failure leaves a partial `dst` the caller must delete. */
export async function decryptFile(src: string, dst: string, keyring: Pick<BackupKeyring, 'keys'>): Promise<void> {
  await pipeline(createReadStream(src), createDecryptStream(keyring), createWriteStream(dst, { mode: 0o600 }));
}

/** True when the file starts with the encrypted-backup magic. */
export async function isEncryptedFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, MAGIC.length, 0);
    return isEncrypted(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Download file name and content type of a stored backup object. */
export function downloadDescriptor(key: string, storedContentType?: string, plainContentType?: string): { encrypted: boolean; filename: string; contentType: string } {
  const encrypted = key.endsWith(ENCRYPTED_SUFFIX);
  const base = key.split('/').pop() || 'backup.bin';
  const filename = (encrypted ? base.slice(0, -ENCRYPTED_SUFFIX.length) : base) || 'backup.bin';
  const byExt = filename.endsWith('.zip') ? 'application/zip' : filename.endsWith('.mbox') ? 'application/mbox' : 'application/octet-stream';
  const contentType = encrypted ? (plainContentType || byExt) : (storedContentType || byExt);
  // Content-Disposition safety: no quotes, backslashes or control characters in the name.
  return { encrypted, filename: filename.replace(/["\\\r\n\u0000-\u001f]/g, '_'), contentType };
}
