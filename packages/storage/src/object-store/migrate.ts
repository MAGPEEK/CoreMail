/**
 * Object storage migration (minio ↔ filesystem ↔ s3).
 *
 *  - streams every object of the source (never loads a whole message into memory);
 *  - verifies each copy: sha256 + size of what was read from the source must equal
 *    a re-read of the target; content-addressed raw keys must also match the
 *    sha256 in their name;
 *  - resumable: objects already present in the target with the same size are
 *    skipped (`verifyExisting` re-hashes them instead), so an interrupted run
 *    is simply started again;
 *  - dry run: lists and counts, writes nothing;
 *  - never deletes anything from the source.
 */
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { contentAddressOf } from './keys.js';
import type { ObjectInfo, ObjectStore } from './types.js';

export type MigrationPhase = 'listing' | 'copying' | 'done' | 'failed' | 'cancelled';

export interface MigrationError { key: string; error: string }

export interface MigrationProgress {
  phase: MigrationPhase;
  dryRun: boolean;
  from: string;
  to: string;
  scanned: number;
  copied: number;
  skipped: number;
  verified: number;
  failed: number;
  bytesScanned: number;
  bytesCopied: number;
  errors: MigrationError[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface MigrationOptions {
  source: ObjectStore;
  target: ObjectStore;
  dryRun?: boolean;
  /** Re-hash objects that already exist in the target (default: size comparison). */
  verifyExisting?: boolean;
  /** Restrict to key prefixes (default: everything). */
  prefixes?: readonly string[];
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: MigrationProgress) => void;
  /** Max. errors kept in the progress report (all are counted). */
  maxErrors?: number;
}

interface Digest { sha256: string; size: number }

async function hashStream(stream: Readable): Promise<Digest> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    h.update(b);
    size += b.length;
  }
  return { sha256: h.digest('hex'), size };
}

/** Pass-through that hashes what flows from source to target. */
function hashingTap(): { tap: Transform; result: () => Digest } {
  const h = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) { h.update(chunk); size += chunk.length; cb(null, chunk); },
  });
  let digest: Digest | null = null;
  return { tap, result: () => (digest ??= { sha256: h.digest('hex'), size }) };
}

export async function migrateObjects(opts: MigrationOptions): Promise<MigrationProgress> {
  const { source, target } = opts;
  const maxErrors = opts.maxErrors ?? 50;
  const p: MigrationProgress = {
    phase: 'listing', dryRun: !!opts.dryRun, from: source.driver, to: target.driver,
    scanned: 0, copied: 0, skipped: 0, verified: 0, failed: 0, bytesScanned: 0, bytesCopied: 0,
    errors: [], startedAt: new Date().toISOString(),
  };
  if (source.location === target.location && source.driver === target.driver) {
    return { ...p, phase: 'failed', error: 'source and target are the same store', finishedAt: new Date().toISOString() };
  }
  const emit = (): void => opts.onProgress?.({ ...p, errors: [...p.errors] });
  const fail = (key: string, err: unknown): void => {
    p.failed++;
    if (p.errors.length < maxErrors) p.errors.push({ key, error: err instanceof Error ? err.message : String(err) });
  };

  try {
    await target.init();
  } catch (err) {
    if (!opts.dryRun) return { ...p, phase: 'failed', error: `target not usable: ${(err as Error).message}`, finishedAt: new Date().toISOString() };
  }

  async function copyOne(obj: ObjectInfo): Promise<void> {
    const key = obj.key;
    const existing = await target.stat(key);
    if (existing && existing.size === obj.size) {
      if (!opts.verifyExisting) { p.skipped++; return; }
      const [a, b] = await Promise.all([source.getStream(key).then(hashStream), target.getStream(key).then(hashStream)]);
      if (a.sha256 === b.sha256 && a.size === b.size) { p.skipped++; p.verified++; return; }
      if (opts.dryRun) { p.copied++; p.bytesCopied += obj.size; return; } // would repair
    } else if (opts.dryRun) {
      p.copied++; p.bytesCopied += obj.size; return;
    }

    const { tap, result } = hashingTap();
    const src = await source.getStream(key);
    src.on('error', (e) => tap.destroy(e));
    src.pipe(tap);
    try {
      await target.putStream(key, tap, { size: obj.size, overwrite: true });
    } finally {
      src.destroy();
    }
    const read = result();
    const expect = contentAddressOf(key);
    if (expect && expect !== read.sha256) throw new Error(`source object does not match its content address (sha256 ${read.sha256})`);
    // Verify what landed in the target.
    const written = await hashStream(await target.getStream(key));
    if (written.sha256 !== read.sha256 || written.size !== read.size) {
      throw new Error(`verification failed: target sha256/size ${written.sha256}/${written.size} ≠ source ${read.sha256}/${read.size}`);
    }
    if (obj.size && read.size !== obj.size) throw new Error(`size changed during copy (listed ${obj.size}, read ${read.size})`);
    p.copied++;
    p.verified++;
    p.bytesCopied += read.size;
  }

  p.phase = 'copying';
  emit();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const inFlight = new Set<Promise<void>>();
  let lastEmit = Date.now();
  const prefixes = opts.prefixes?.length ? opts.prefixes : [''];
  try {
    for (const prefix of prefixes) {
      for await (const obj of source.list(prefix)) {
        if (opts.signal?.aborted) break;
        p.scanned++;
        p.bytesScanned += obj.size;
        const task: Promise<void> = copyOne(obj).catch((err) => fail(obj.key, err)).finally(() => { inFlight.delete(task); });
        inFlight.add(task);
        if (inFlight.size >= concurrency) await Promise.race(inFlight);
        if (Date.now() - lastEmit > 1000) { lastEmit = Date.now(); emit(); }
      }
      if (opts.signal?.aborted) break;
    }
    await Promise.all(inFlight);
  } catch (err) {
    await Promise.allSettled(inFlight);
    p.phase = 'failed';
    p.error = `listing the source failed: ${(err as Error).message}`;
    p.finishedAt = new Date().toISOString();
    emit();
    return p;
  }
  p.phase = opts.signal?.aborted ? 'cancelled' : p.failed > 0 ? 'failed' : 'done';
  if (p.phase === 'failed') p.error = `${p.failed} object(s) could not be copied — fix the cause and run the migration again (copied objects are skipped)`;
  p.finishedAt = new Date().toISOString();
  emit();
  return p;
}
