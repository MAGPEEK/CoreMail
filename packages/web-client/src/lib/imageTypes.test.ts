import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterImageType, mapLimit, MAX_PROXIED_IMAGES, PROXY_CONCURRENCY } from './imageTypes.ts';

test('rasterImageType allows only raster images (no SVG/HTML blob documents)', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']) {
    assert.equal(rasterImageType(t), t);
  }
  assert.equal(rasterImageType('IMAGE/PNG; charset=binary'), 'image/png');
  assert.equal(rasterImageType('image/jpg'), 'image/jpeg');
  assert.equal(rasterImageType('image/pjpeg'), 'image/jpeg');
  for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/octet-stream', 'image/x-icon', '', null, undefined]) {
    assert.equal(rasterImageType(t), null, String(t));
  }
});

test('mapLimit keeps order, limits concurrency and maps failures to null', async () => {
  let inFlight = 0;
  let peak = 0;
  const res = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], PROXY_CONCURRENCY, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    inFlight--;
    if (n === 4) throw new Error('broken image');
    return n * 2;
  });
  assert.deepEqual(res, [2, 4, 6, null, 10, 12, 14, 16, 18, 20]);
  assert.ok(peak <= PROXY_CONCURRENCY, `peak ${peak}`);
  assert.equal(await mapLimit([], 4, async () => 1).then((r) => r.length), 0);
});

test('image proxy limits', () => {
  assert.equal(MAX_PROXIED_IMAGES, 50);
  assert.equal(PROXY_CONCURRENCY, 4);
});
