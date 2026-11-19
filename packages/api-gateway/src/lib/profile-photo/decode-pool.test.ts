/**
 * 10.2: image uploads are decoded in worker threads, at most two at a time per
 * process (profile photos and backgrounds share the slots).
 * Run: node --import tsx --test src/lib/profile-photo/decode-pool.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { encodePng, type RgbaImage } from '../branding/png.js';
import { createSlots } from './slots.js';
import { IMAGE_DECODE_CONCURRENCY, imageDecodeSlots, processImageUpload } from './decode-pool.js';
import { PhotoError, PHOTO_SIZE } from './image.js';

const grey = (w: number, h: number): RgbaImage => ({ width: w, height: h, data: Buffer.alloc(w * h * 4, 200) });

test('slots: never more than the capacity at once, waiting tasks run in arrival order, a failure frees its slot', async () => {
  assert.throws(() => createSlots(0), RangeError);
  const slots = createSlots(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const releases: Array<() => void> = [];
  const task = (id: number, fail = false) => slots.run(async () => {
    running++; peak = Math.max(peak, running); order.push(id);
    await new Promise<void>((resolve) => releases.push(resolve));
    running--;
    if (fail) throw new Error(`task ${id}`);
    return id;
  });
  const settled = Promise.allSettled([task(1, true), task(2), task(3), task(4)]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [1, 2], 'two start, two wait');
  assert.equal(slots.active, 2);
  assert.equal(slots.waiting, 2);
  while (releases.length) {
    releases.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  const results = await settled;
  assert.equal(results[0]!.status, 'rejected');
  assert.deepEqual(results.slice(1).map((r) => (r.status === 'fulfilled' ? r.value : null)), [2, 3, 4]);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(slots.active, 0);
  assert.equal(slots.waiting, 0);
});

test('worker: a photo upload becomes the 512×512 JPEG, a refused upload the same PhotoError', async () => {
  const out = await processImageUpload('photo', encodePng(grey(640, 480)));
  const img = jpeg.decode(out, { useTArray: true });
  assert.deepEqual([img.width, img.height], [PHOTO_SIZE, PHOTO_SIZE]);
  await assert.rejects(processImageUpload('background', encodePng(grey(64, 64))),
    (err: unknown) => err instanceof PhotoError && err.code === 'DIMENSIONS');
  await assert.rejects(processImageUpload('photo', Buffer.from('not an image')),
    (err: unknown) => err instanceof PhotoError && err.code === 'TYPE');
});

test('worker pool: photos and backgrounds share two decode slots per process', async () => {
  assert.equal(IMAGE_DECODE_CONCURRENCY, 2);
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, imageDecodeSlots.active); }, 1);
  try {
    const uploads = [
      processImageUpload('photo', encodePng(grey(600, 600))),
      processImageUpload('background', encodePng(grey(800, 600))),
      processImageUpload('photo', encodePng(grey(600, 600))),
      processImageUpload('background', encodePng(grey(800, 600))),
    ];
    assert.equal(imageDecodeSlots.active, 2, 'two decode at once');
    assert.equal(imageDecodeSlots.waiting, 2, 'the others wait');
    const outs = await Promise.all(uploads);
    assert.equal(outs.length, 4);
  } finally {
    clearInterval(watch);
  }
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(imageDecodeSlots.active, 0);
});
