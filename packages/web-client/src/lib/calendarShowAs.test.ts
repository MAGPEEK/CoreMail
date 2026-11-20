import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALENDAR_COLOR, OOF_COLOR, applyShowAsVars, normalizeShowAs, showAsBarStyle, showAsLook } from './calendarShowAs.ts';
import { parseHexColor, readableTextOn } from './readableText.ts';
import { contrastRatio } from '../theme/contrast.ts';

const BLUE = '#0078D4';
const YELLOW = '#FFD700';

test('BUSY: solid fill in the calendar colour with readable text (unchanged look)', () => {
  const look = showAsLook('BUSY', BLUE);
  assert.deepEqual(look, {
    backgroundColor: BLUE, textColor: readableTextOn(BLUE), borderColor: 'transparent', classNames: [], cssVars: {},
  });
  assert.equal(showAsLook('BUSY', YELLOW).textColor, '#000000');
});

test('missing or unknown showAs renders as BUSY', () => {
  assert.equal(normalizeShowAs(undefined), 'BUSY');
  assert.equal(normalizeShowAs(null), 'BUSY');
  assert.equal(normalizeShowAs('bogus'), 'BUSY');
  assert.deepEqual(showAsLook(undefined, BLUE), showAsLook('BUSY', BLUE));
  assert.deepEqual(showAsLook(null, BLUE), showAsLook('BUSY', BLUE));
});

test('missing calendar colour falls back to the default calendar colour', () => {
  assert.equal(showAsLook('BUSY', undefined).backgroundColor, DEFAULT_CALENDAR_COLOR);
  assert.equal(showAsLook('FREE', null).borderColor, DEFAULT_CALENDAR_COLOR);
});

test('TENTATIVE: striped class, tint of the calendar colour, solid edge, foreground text', () => {
  const look = showAsLook('TENTATIVE', BLUE);
  assert.deepEqual(look.classNames, ['cm-show-tentative']);
  assert.equal(look.borderColor, BLUE);
  assert.equal(look.backgroundColor, `color-mix(in srgb, ${BLUE} 20%, rgb(var(--surface)))`);
  assert.equal(look.textColor, 'rgb(var(--fg))');
  assert.deepEqual(look.cssVars, { '--cm-cal': BLUE });
});

test('FREE: surface background, calendar-colour border, foreground text', () => {
  const look = showAsLook('FREE', BLUE);
  assert.deepEqual(look.classNames, ['cm-show-free']);
  assert.equal(look.backgroundColor, 'rgb(var(--surface))');
  assert.equal(look.borderColor, BLUE);
  assert.equal(look.textColor, 'rgb(var(--fg))');
  assert.deepEqual(look.cssVars, { '--cm-cal': BLUE });
});

test('OOF: always purple, regardless of the calendar colour, dashed class', () => {
  for (const c of [BLUE, YELLOW, '#000000', '#ffffff', undefined]) {
    const look = showAsLook('OOF', c);
    assert.equal(look.backgroundColor, OOF_COLOR);
    assert.deepEqual(look.classNames, ['cm-show-oof']);
    assert.equal(look.borderColor, 'var(--cm-oof-edge)');
    assert.deepEqual(look.cssVars, { '--cm-cal': OOF_COLOR });
  }
});

test('OOF text reaches WCAG AA (>= 4.5:1) on the purple fill', () => {
  const look = showAsLook('OOF', BLUE);
  const ratio = contrastRatio(parseHexColor(look.textColor)!, parseHexColor(OOF_COLOR)!);
  assert.ok(ratio >= 4.5, `contrast ${ratio.toFixed(2)}`);
  assert.equal(look.textColor, '#ffffff');
});

test('day agenda bar follows the same rule', () => {
  assert.deepEqual(showAsBarStyle('BUSY', BLUE), { backgroundColor: BLUE });
  assert.deepEqual(showAsBarStyle(undefined, BLUE), { backgroundColor: BLUE });
  assert.deepEqual(showAsBarStyle('OOF', BLUE), { backgroundColor: OOF_COLOR });
  assert.deepEqual(showAsBarStyle('FREE', BLUE), { backgroundColor: 'rgb(var(--surface))', border: `1px solid ${BLUE}` });
  const tentative = showAsBarStyle('TENTATIVE', BLUE);
  assert.match(tentative['backgroundImage']!, /^repeating-linear-gradient\(45deg, #0078D4 /);
  assert.match(tentative['backgroundColor']!, /color-mix\(in srgb, #0078D4 20%/);
});

test('applyShowAsVars sets only custom properties', () => {
  const set: Array<[string, string]> = [];
  const el = { style: { setProperty: (n: string, v: string) => { set.push([n, v]); } } } as unknown as HTMLElement;
  applyShowAsVars(el, { '--cm-cal': BLUE, color: 'red', '--x': 3 });
  applyShowAsVars(el, undefined);
  assert.deepEqual(set, [['--cm-cal', BLUE]]);
});
