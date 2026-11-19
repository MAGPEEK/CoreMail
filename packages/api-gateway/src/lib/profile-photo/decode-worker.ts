/**
 * Worker thread of decode-pool.ts: processes one image upload (`workerData`)
 * and posts the stored JPEG, or the PhotoError's code and message. Any other
 * error ends the worker with that error.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PhotoError, processBackgroundImage, processProfilePhoto } from './image.js';
import type { DecodeJob, DecodeResult } from './decode-pool.js';

const { kind, body } = workerData as DecodeJob;
const input = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
let result: DecodeResult;
try {
  const jpeg = kind === 'photo' ? processProfilePhoto(input) : processBackgroundImage(input);
  result = { ok: true, jpeg };
} catch (err) {
  if (!(err instanceof PhotoError)) throw err;
  result = { ok: false, code: err.code, message: err.message };
}
parentPort!.postMessage(result);
