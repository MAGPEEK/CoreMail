import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverScale, initialCrop, clampCrop, panBy, zoomTo, cropRect, previewBox, cropKeyAction, wheelZoomFactor,
  photoFileError, MAX_ZOOM, MIN_ZOOM, PAN_STEP, PAN_STEP_LARGE, ZOOM_STEP, type CropGeometry, type CropState,
} from './avatarCrop.ts';

const land: CropGeometry = { imageWidth: 1200, imageHeight: 800, cropSize: 240 };
const portrait: CropGeometry = { imageWidth: 600, imageHeight: 900, cropSize: 240 };

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} ≈ ${b}`);

/** True when the scaled image covers the whole crop square. */
function covers(g: CropGeometry, s: CropState): boolean {
  const scale = coverScale(g) * s.zoom;
  return s.x <= 1e-9 && s.y <= 1e-9
    && s.x + g.imageWidth * scale >= g.cropSize - 1e-9 && s.y + g.imageHeight * scale >= g.cropSize - 1e-9;
}

test('cover scale: the shorter side fills the crop square at zoom 1', () => {
  near(coverScale(land), 240 / 800);
  near(coverScale(portrait), 240 / 600);
});

test('initial state: zoom 1, centred, covering', () => {
  const s = initialCrop(land);
  assert.equal(s.zoom, 1);
  near(s.x, (240 - 1200 * 0.3) / 2);
  near(s.y, 0);
  assert.ok(covers(land, s));
  const r = cropRect(land, s);
  near(r.size, 800);
  near(r.sx, 200);
  near(r.sy, 0);
});

test('clamp: pan and zoom can never uncover the circle', () => {
  const s = initialCrop(land);
  const far = panBy(land, s, 10_000, -10_000);
  assert.ok(covers(land, far));
  near(far.x, 0);
  const other = panBy(land, s, -10_000, 0);
  near(other.x, 240 - 1200 * 0.3);
  assert.equal(clampCrop(land, { zoom: 0.2, x: 5, y: 5 }).zoom, MIN_ZOOM);
  assert.equal(clampCrop(land, { zoom: 99, x: 0, y: 0 }).zoom, MAX_ZOOM);
  assert.equal(clampCrop(land, { zoom: Number.NaN, x: 0, y: 0 }).zoom, MIN_ZOOM);
  for (const zoom of [1, 1.5, 2.7, 4]) {
    for (const [dx, dy] of [[-999, -999], [999, 999], [13, -7]] as const) {
      assert.ok(covers(portrait, panBy(portrait, zoomTo(portrait, initialCrop(portrait), zoom), dx, dy)), `zoom ${zoom}`);
    }
  }
});

test('zoom keeps the anchor point in place (centre by default)', () => {
  const s = initialCrop(land);
  const z = zoomTo(land, s, 2);
  assert.equal(z.zoom, 2);
  // the image point at the centre of the square stays at the centre
  const before = (120 - s.x) / (coverScale(land) * 1);
  const after = (120 - z.x) / (coverScale(land) * 2);
  near(before, after);
  const r = cropRect(land, z);
  near(r.size, 400);
  near(r.sx + r.size / 2, 600, 'still centred horizontally');
  const anchored = zoomTo(land, z, 3, { x: 0, y: 0 });
  near(anchored.x, z.x * 1.5);
  assert.equal(zoomTo(land, z, 10).zoom, MAX_ZOOM);
});

test('crop rectangle stays inside the image at every edge', () => {
  for (const g of [land, portrait]) {
    for (const zoom of [1, 2, 4]) {
      for (const [dx, dy] of [[-1e6, -1e6], [1e6, 1e6], [0, 0]] as const) {
        const r = cropRect(g, panBy(g, zoomTo(g, initialCrop(g), zoom), dx, dy));
        assert.ok(r.sx >= 0 && r.sy >= 0, 'not left/above the image');
        assert.ok(r.sx + r.size <= g.imageWidth + 1e-6 && r.sy + r.size <= g.imageHeight + 1e-6, 'not right/below');
        near(r.size, Math.min(g.imageWidth, g.imageHeight) / zoom);
      }
    }
  }
});

test('preview boxes scale the same crop to 96, 40 and 28 px', () => {
  const s = zoomTo(land, initialCrop(land), 2);
  const r = cropRect(land, s);
  for (const size of [96, 40, 28]) {
    const b = previewBox(land, s, size);
    near(b.width, 1200 * size / r.size);
    near(-b.left, r.sx * size / r.size);
    near(b.height / b.width, 800 / 1200);
  }
});

test('keyboard: arrows move (Shift: larger steps), + / - zoom, other keys ignored', () => {
  assert.deepEqual(cropKeyAction('ArrowLeft', false), { pan: { x: -PAN_STEP, y: 0 } });
  assert.deepEqual(cropKeyAction('ArrowDown', true), { pan: { x: 0, y: PAN_STEP_LARGE } });
  assert.deepEqual(cropKeyAction('+', false), { zoomFactor: ZOOM_STEP });
  assert.deepEqual(cropKeyAction('-', false), { zoomFactor: 1 / ZOOM_STEP });
  assert.equal(cropKeyAction('Enter', false), null);
  assert.equal(cropKeyAction('Tab', false), null);
});

test('wheel: down zooms out, up zooms in, extreme deltas bounded', () => {
  assert.ok(wheelZoomFactor(100) < 1);
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.equal(wheelZoomFactor(0), 1);
  near(wheelZoomFactor(100_000), wheelZoomFactor(200));
});

test('file checks: JPEG/PNG/WebP up to 5 MB', () => {
  assert.equal(photoFileError({ type: 'image/jpeg', size: 1000 }), null);
  assert.equal(photoFileError({ type: 'image/PNG', size: 5 * 1024 * 1024 }), null);
  assert.equal(photoFileError({ type: 'image/webp', size: 10 }), null);
  assert.match(photoFileError({ type: 'image/gif', size: 10 })!, /JPEG, PNG oder WebP/);
  assert.match(photoFileError({ type: 'image/svg+xml', size: 10 })!, /JPEG/);
  assert.match(photoFileError({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })!, /5 MB/);
  assert.match(photoFileError({ type: 'image/png', size: 0 })!, /leer/);
});
