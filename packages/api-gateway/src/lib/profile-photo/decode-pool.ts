/**
 * 10.2: image uploads (profile photo, webmail background) are decoded and
 * re-encoded in a worker thread, at most IMAGE_DECODE_CONCURRENCY at a time per
 * process; further uploads wait for a slot. The pure-JS decoders block for
 * seconds on a large picture and use up to their jpeg-js memory cap (photo
 * 128 MB, background 160 MB), so the event loop stays free and the decoders of
 * one process stay below IMAGE_DECODE_CONCURRENCY × the cap. A slot is held
 * until the worker has exited (its memory is gone with it).
 */
import { Worker } from 'node:worker_threads';
import { PhotoError, type PhotoErrorCode } from './image.js';
import { createSlots } from './slots.js';

/** Simultaneous image decodes per process (profile photos and backgrounds share them). */
export const IMAGE_DECODE_CONCURRENCY = 2;

export type ImageUploadKind = 'photo' | 'background';
export interface DecodeJob { kind: ImageUploadKind; body: Uint8Array }
export type DecodeResult = { ok: true; jpeg: Uint8Array } | { ok: false; code: PhotoErrorCode; message: string };

/** Shared by every image upload route of this process (exported for tests). */
export const imageDecodeSlots = createSlots(IMAGE_DECODE_CONCURRENCY);

// The image runs the compiled .js; dev and tests run this .ts source under tsx.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(FROM_SOURCE ? './decode-worker.ts' : './decode-worker.js', import.meta.url);

function startWorker(job: DecodeJob): Worker {
  if (!FROM_SOURCE) return new Worker(WORKER_URL, { workerData: job });
  // tsx's loader is not active in worker threads: register it there before loading the entry
  const tsx = import.meta.resolve('tsx/esm/api');
  const bootstrap = `import(${JSON.stringify(tsx)}).then((m) => { m.register(); return import(${JSON.stringify(WORKER_URL.href)}); });`;
  return new Worker(bootstrap, { eval: true, workerData: job });
}

function runWorker(job: DecodeJob): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let result: DecodeResult | null = null;
    let failure: Error | null = null;
    const worker = startWorker(job);
    worker.once('message', (msg: DecodeResult) => { result = msg; });
    worker.once('error', (err) => { failure = err; });
    worker.once('exit', (exitCode) => {
      if (result?.ok) resolve(Buffer.from(result.jpeg.buffer, result.jpeg.byteOffset, result.jpeg.byteLength));
      else if (result) reject(new PhotoError(result.code, result.message));
      else reject(failure ?? new Error(`image decode worker exited with code ${exitCode}`));
    });
  });
}

/** The stored JPEG of an upload (processProfilePhoto / processBackgroundImage in a worker). Rejects with PhotoError. */
export function processImageUpload(kind: ImageUploadKind, body: Buffer): Promise<Buffer> {
  return imageDecodeSlots.run(() => runWorker({ kind, body }));
}
