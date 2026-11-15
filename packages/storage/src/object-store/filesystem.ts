/**
 * Filesystem object store (OBJECT_STORAGE=filesystem).
 *
 * Keys map to files under the root (`raw/ab/<sha>.eml` → `<root>/raw/ab/<sha>.eml`).
 * Rules:
 *  - keys are validated (no absolute paths, `..`, NUL, backslashes) and the
 *    resolved path must stay inside the root;
 *  - writes are atomic: temp file in the target directory → fsync → rename →
 *    fsync of the directory. A crash leaves at most a `.tmp-*` file, never a
 *    truncated object; readers see the old object or the complete new one;
 *  - content-addressed keys (`raw/<aa>/<sha256>.eml`) are written once — a
 *    concurrent second writer of the same content is a no-op;
 *  - delete is idempotent; reads and writes stream (large messages never need
 *    to fit in memory);
 *  - files 0640, directories 0750 (the app runs as `node`).
 */
import type { Stats } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ObjectNotFoundError, InvalidObjectKeyError,
  type InitResult, type ObjectInfo, type ObjectStat, type ObjectStore, type PutOptions,
} from './types.js';
import { TEMP_PREFIX, isContentAddressedKey, validateObjectKey, validateObjectPrefix } from './keys.js';

export interface FilesystemStoreOptions {
  fileMode?: number;
  dirMode?: number;
  /** fsync the directory after rename (default true; skipped on win32). */
  syncDirectories?: boolean;
  /** Test hook: runs after the temp file is complete, before the rename (simulates a crash when it throws). */
  beforeRename?: (tempPath: string, key: string) => void | Promise<void>;
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EEXIST', 'EBUSY']);

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export class FilesystemObjectStore implements ObjectStore {
  readonly driver = 'filesystem' as const;
  readonly root: string;
  readonly location: string;
  private readonly fileMode: number;
  private readonly dirMode: number;
  private readonly syncDirectories: boolean;
  private readonly beforeRename: FilesystemStoreOptions['beforeRename'];

  constructor(root: string, opts: FilesystemStoreOptions = {}) {
    if (!isAbsolute(root)) throw new Error(`filesystem store root must be absolute: ${root}`);
    this.root = resolve(root);
    this.location = this.root;
    this.fileMode = opts.fileMode ?? 0o640;
    this.dirMode = opts.dirMode ?? 0o750;
    this.syncDirectories = (opts.syncDirectories ?? true) && process.platform !== 'win32';
    this.beforeRename = opts.beforeRename;
  }

  /** Absolute path of `key`; throws InvalidObjectKeyError for unsafe keys. */
  pathFor(key: string): string {
    validateObjectKey(key);
    const p = resolve(this.root, ...key.split('/'));
    const rel = relative(this.root, p);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new InvalidObjectKeyError(key, 'resolves outside the storage root');
    }
    return p;
  }

  async init(): Promise<InitResult> {
    await mkdir(this.root, { recursive: true, mode: this.dirMode });
    const st = await stat(this.root);
    if (!st.isDirectory()) throw new Error(`STORAGE_PATH is not a directory: ${this.root}`);
    // Write probe: fails early (permissions, read-only mount) instead of on the first mail.
    const probe = join(this.root, `${TEMP_PREFIX}probe-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fh = await open(probe, 'wx', this.fileMode);
    try { await fh.write('ok'); await fh.sync(); } finally { await fh.close(); }
    await unlink(probe);
    return { lifecycle: false };
  }

  async put(key: string, data: Buffer, opts: PutOptions = {}): Promise<void> {
    await this.writeAtomic(key, opts, async (fh) => {
      let off = 0;
      while (off < data.length) {
        const { bytesWritten } = await fh.write(data, off, data.length - off);
        off += bytesWritten;
      }
    });
  }

  async putStream(key: string, stream: Readable, opts: PutOptions = {}): Promise<void> {
    const written = await this.writeAtomic(key, opts, async (fh) => {
      await pipeline(stream, new Writable({
        write(chunk: Buffer, _enc, cb) {
          fh.write(chunk).then(() => cb(), cb);
        },
      }));
    });
    // Write-once key already present: the stream was not consumed — release it.
    if (!written) stream.destroy();
  }

  /** Returns false when a content-addressed object already existed (nothing written). */
  private async writeAtomic(key: string, opts: PutOptions, writer: (fh: FileHandle) => Promise<void>): Promise<boolean> {
    const target = this.pathFor(key);
    const dir = dirname(target);
    const writeOnce = isContentAddressedKey(key) && !opts.overwrite;
    if (writeOnce && (await this.statPath(target))) return false;

    for (let attempt = 0; ; attempt++) {
      await mkdir(dir, { recursive: true, mode: this.dirMode });
      const tmp = join(dir, `${TEMP_PREFIX}${process.pid}-${randomBytes(8).toString('hex')}`);
      let fh: FileHandle;
      try {
        fh = await open(tmp, 'wx', this.fileMode);
      } catch (err) {
        // The directory was pruned between mkdir and open (cleaner) — retry.
        if (errCode(err) === 'ENOENT' && attempt < 3) continue;
        throw err;
      }
      try {
        await writer(fh);
        await fh.sync();
        await fh.chmod(this.fileMode).catch(() => undefined);
      } catch (err) {
        await fh.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw err;
      }
      await fh.close();
      // Crash simulation point (tests): a throw here leaves the temp file behind,
      // exactly like a process killed between write and rename.
      if (this.beforeRename) await this.beforeRename(tmp, key);
      try {
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true });
        // Windows refuses to replace a file another writer just renamed into
        // place; for write-once content the existing object is identical.
        if (writeOnce && RETRYABLE_RENAME.has(errCode(err) ?? '') && (await this.statPath(target))) return false;
        throw err;
      }
      await this.syncDir(dir);
      return true;
    }
  }

  private async syncDir(dir: string): Promise<void> {
    if (!this.syncDirectories) return;
    let fh: FileHandle | undefined;
    try {
      fh = await open(dir, 'r');
      await fh.sync();
    } catch {
      // Some filesystems (e.g. certain network mounts) refuse fsync on directories.
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async statPath(p: string): Promise<Stats | null> {
    try {
      const st = await stat(p);
      return st.isFile() ? st : null;
    } catch (err) {
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const p = this.pathFor(key);
    try {
      return await readFile(p);
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errCode(err) ?? '')) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    // Open first so a missing object rejects here instead of erroring the stream later.
    let fh: FileHandle;
    try {
      fh = await open(p, 'r');
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errCode(err) ?? '')) throw new ObjectNotFoundError(key);
      throw err;
    }
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close(); throw new ObjectNotFoundError(key); }
    // The stream owns the handle and closes it on end/destroy.
    return fh.createReadStream({ autoClose: true, highWaterMark: 256 * 1024 });
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const st = await this.statPath(this.pathFor(key));
    return st ? { size: st.size, lastModified: st.mtime } : null;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes(errCode(err) ?? '')) return;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    validateObjectPrefix(prefix);
    // Walk only the deepest directory fully named by the prefix.
    const slash = prefix.lastIndexOf('/');
    const baseKey = slash >= 0 ? prefix.slice(0, slash) : '';
    const baseDir = baseKey ? this.pathFor(baseKey) : this.root;
    for await (const info of this.walk(baseDir, baseKey)) {
      if (info.key.startsWith(prefix)) yield info;
    }
  }

  private async *walk(dir: string, keyPrefix: string): AsyncIterable<ObjectInfo> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes(errCode(err) ?? '')) return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(TEMP_PREFIX)) continue;
      const key = keyPrefix ? `${keyPrefix}/${e.name}` : e.name;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        yield* this.walk(p, key);
      } else if (e.isFile()) {
        let st: Stats;
        try { st = await stat(p); } catch { continue; } // deleted meanwhile
        yield { key, size: st.size, lastModified: st.mtime };
      }
    }
  }

  /**
   * Removes `.tmp-*` leftovers of crashed writes older than `maxAgeMs` and
   * prunes empty directories below the given prefixes. Returns the counts.
   */
  async cleanupLeftovers(maxAgeMs: number, now = Date.now(), pruneUnder: readonly string[] = []): Promise<{ tempFiles: number; dirs: number }> {
    let tempFiles = 0;
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { await visit(p); continue; }
        if (!e.name.startsWith(TEMP_PREFIX)) continue;
        try {
          const st = await stat(p);
          if (now - st.mtimeMs > maxAgeMs) { await rm(p, { force: true }); tempFiles++; }
        } catch { /* gone */ }
      }
    };
    await visit(this.root);
    let dirs = 0;
    for (const prefix of pruneUnder) {
      const base = this.pathFor(prefix.replace(/\/$/, ''));
      dirs += await this.pruneEmpty(base, false);
    }
    return { tempFiles, dirs };
  }

  private async pruneEmpty(dir: string, removeSelf: boolean): Promise<number> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const e of entries) if (e.isDirectory()) removed += await this.pruneEmpty(join(dir, e.name), true);
    if (removeSelf) {
      try { await rmdir(dir); removed++; } catch { /* not empty / raced with a writer */ }
    }
    return removed;
  }
}
