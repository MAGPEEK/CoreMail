import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSE_FONTS, COMPOSE_FONT_SIZES_PT, FONT_SCRIPTS, GENERIC_FAMILIES, composeTextDefaults, findFont, fontsOf, sizeLabel, sizeValue,
} from './composeFonts.ts';

test('every font stack starts with the font itself and ends in a generic family', () => {
  for (const f of COMPOSE_FONTS) {
    const families = f.stack.split(',').map((s) => s.trim());
    assert.equal(families[0], `'${f.label}'`, f.label);
    assert.ok(GENERIC_FAMILIES.includes(families.at(-1)!), `${f.label} ends in a generic family: ${f.stack}`);
    assert.doesNotMatch(f.stack, /[;{}<>]|url\(/i, 'no CSS injection characters');
  }
  assert.equal(new Set(COMPOSE_FONTS.map((f) => f.label.toLowerCase())).size, COMPOSE_FONTS.length, 'labels unique');
});

test('fonts are grouped by script: Latin, CJK, others; each group is non-empty', () => {
  assert.deepEqual(FONT_SCRIPTS, ['latin', 'cjk', 'other']);
  for (const s of FONT_SCRIPTS) assert.ok(fontsOf(s).length > 0);
  assert.equal(fontsOf('latin').length + fontsOf('cjk').length + fontsOf('other').length, COMPOSE_FONTS.length);
  for (const name of ['Arial', 'Calibri', 'Segoe UI', 'Verdana', 'Microsoft YaHei', 'Meiryo', 'Malgun Gothic', 'Nirmala UI', 'Sylfaen']) {
    assert.ok(findFont(name), name);
  }
});

test('findFont matches a stored name or a CSS value (quoted or not), else null', () => {
  assert.equal(findFont('Calibri')?.label, 'Calibri');
  assert.equal(findFont('"Times New Roman", serif')?.label, 'Times New Roman');
  assert.equal(findFont(findFont('Arial Black')!.stack)?.label, 'Arial Black');
  assert.equal(findFont('Wingdings'), null);
  assert.equal(findFont(undefined), null);
  assert.equal(findFont(''), null);
});

test('font sizes are the fixed point steps 8 … 36', () => {
  assert.deepEqual(COMPOSE_FONT_SIZES_PT, [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36]);
  assert.equal(sizeValue(11), '11pt');
  assert.equal(sizeLabel('11pt'), '11 pt');
  assert.equal(sizeLabel('14px'), '14 px', 'older px values keep their unit');
});

test('defaults of new text: Settings → Verfassen, else Calibri 11 pt', () => {
  assert.deepEqual(composeTextDefaults({ fontFamily: '', fontSize: '' }), { fontFamily: findFont('Calibri')!.stack, fontSize: '11pt' });
  assert.deepEqual(composeTextDefaults({ fontFamily: 'Georgia', fontSize: '14pt' }), { fontFamily: findFont('Georgia')!.stack, fontSize: '14pt' });
  assert.deepEqual(composeTextDefaults({ fontFamily: 'Unknown', fontSize: '16px' }), { fontFamily: findFont('Calibri')!.stack, fontSize: '16px' });
  assert.equal(composeTextDefaults({ fontFamily: '', fontSize: '12em;color:red' }).fontSize, '11pt', 'only pt/px sizes');
});
