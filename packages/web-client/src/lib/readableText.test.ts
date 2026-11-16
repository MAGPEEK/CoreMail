import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHexColor, readableTextOn } from './readableText.ts';
import { contrastRatio } from '../theme/contrast.ts';

test('parseHexColor: #rgb, #rrggbb, without #, invalid → null', () => {
  assert.deepEqual(parseHexColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHexColor('0078d4'), [0, 120, 212]);
  assert.equal(parseHexColor('rgb(0,0,0)'), null);
  assert.equal(parseHexColor(undefined), null);
});

test('readableTextOn: always >= 4.5:1 on user colours', () => {
  for (const c of ['#f59e0b', '#fde047', '#0078d4', '#111827', '#22c55e', '#ec4899', '#ffffff', '#7c3aed']) {
    const fg = parseHexColor(readableTextOn(c))!;
    assert.ok(contrastRatio(fg, parseHexColor(c)!) >= 4.5, c);
  }
  assert.equal(readableTextOn('#f59e0b'), '#000000'); // amber: white was 2.1:1
  assert.equal(readableTextOn('nonsense'), '#ffffff');
});
