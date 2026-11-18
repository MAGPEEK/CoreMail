import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccessibility, collectA11yItems, jumpTarget, parseCssColor, type A11yItem, type DocLike, type NodeLike } from './composeA11y.ts';
import { TEXT_COLORS } from './composeFormat.ts';

test('jump target: pictures and tables selected whole, a paragraph at its first character, text at its start', () => {
  assert.deepEqual(jumpTarget({ kind: 'imageAlt', pos: 7, excerpt: '' }), { select: 'node', pos: 7 });
  assert.deepEqual(jumpTarget({ kind: 'tableHeader', pos: 20, excerpt: '' }), { select: 'node', pos: 20 });
  assert.deepEqual(jumpTarget({ kind: 'uppercase', pos: 4, excerpt: 'A B C D' }), { select: 'text', pos: 5 });
  assert.deepEqual(jumpTarget({ kind: 'contrast', pos: 9, excerpt: 'x', ratio: 2 }), { select: 'text', pos: 9 });
  assert.deepEqual(jumpTarget({ kind: 'emptyLink', pos: 3, excerpt: 'https://example.test/' }), { select: 'text', pos: 3 });
});

test('pictures without alt text and tables without a header row are reported', () => {
  const issues = checkAccessibility([
    { kind: 'image', pos: 5, alt: null },
    { kind: 'image', pos: 9, alt: '  ' },
    { kind: 'image', pos: 12, alt: 'Firmenlogo' },
    { kind: 'table', pos: 1, headerRow: false },
    { kind: 'table', pos: 30, headerRow: true },
  ]);
  assert.deepEqual(issues.map((i) => [i.kind, i.pos]), [['tableHeader', 1], ['imageAlt', 5], ['imageAlt', 9]], 'document order');
});

test('links without text are reported with their address', () => {
  const issues = checkAccessibility([
    { kind: 'link', pos: 3, text: ' ', href: 'https://example.test/' },
    { kind: 'link', pos: 8, text: 'Agenda', href: 'https://example.test/a' },
  ]);
  assert.deepEqual(issues, [{ kind: 'emptyLink', pos: 3, excerpt: 'https://example.test/' }]);
});

test('contrast: text colours below 4.5:1 against the highlight or white; unreadable colours are not judged', () => {
  const colored = (color: string | null, background: string | null, text = 'Hallo'): A11yItem => ({ kind: 'colored', pos: 2, text, color, background });
  const [gray] = checkAccessibility([colored('#999999', null)]);
  assert.equal(gray?.kind, 'contrast');
  assert.equal(gray?.ratio, 2.8);
  assert.deepEqual(checkAccessibility([colored('#000000', null)]), []);
  assert.equal(checkAccessibility([colored('#f1c232', null)]).length, 1, 'yellow on white');
  assert.equal(checkAccessibility([colored(null, '#073763')]).length, 1, 'default black on a dark highlight');
  assert.deepEqual(checkAccessibility([colored('#ffffff', '#073763')]), [], 'white on dark blue is fine');
  assert.deepEqual(checkAccessibility([colored('var(--x)', null)]), []);
  assert.deepEqual(checkAccessibility([colored('#999999', null, '   ')]), [], 'whitespace has nothing to read');
  // the palette: dark colours pass, the light ones are flagged
  const flagged = TEXT_COLORS.filter((c) => checkAccessibility([colored(c.hex, null)]).length > 0).map((c) => c.id);
  assert.deepEqual(flagged, ['gray', 'orange', 'yellow', 'teal']);
});

test('long runs of capitals (four words or more) are reported; acronyms and short runs are not', () => {
  const block = (text: string): A11yItem => ({ kind: 'block', pos: 0, text });
  assert.equal(checkAccessibility([block('Bitte LESEN SIE DIESE NACHRICHT sofort')])[0]?.excerpt, 'LESEN SIE DIESE NACHRICHT');
  assert.equal(checkAccessibility([block('ACHTUNG: DAS SYSTEM WIRD HEUTE GEWARTET')]).length, 1);
  assert.deepEqual(checkAccessibility([block('Die EU und die USA, NATO')]), []);
  assert.deepEqual(checkAccessibility([block('DREI WORTE HIER')]), []);
  assert.deepEqual(checkAccessibility([block('ABC DEF GHI JKlm')]), [], 'the last word is not all capitals');
  assert.equal(checkAccessibility([block('ÜBER ÄRGER UND ÖL')]).length, 1, 'umlauts count as letters');
});

test('parseCssColor: #rgb, #rrggbb, rgb() and rgba()', () => {
  assert.deepEqual(parseCssColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseCssColor('#1155CC'), [17, 85, 204]);
  assert.deepEqual(parseCssColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(parseCssColor('rgba(10,20,30,0.5)'), [10, 20, 30]);
  assert.equal(parseCssColor('rgb(300, 0, 0)'), null);
  assert.equal(parseCssColor('red'), null);
  assert.equal(parseCssColor(null), null);
});

// ── document walk with a minimal fake document ──────────────────────────────

type Spec = { type: string; attrs?: Record<string, unknown>; text?: string; marks?: Array<[string, Record<string, unknown>]>; children?: Spec[] };

function node(s: Spec): NodeLike {
  const children = (s.children ?? []).map(node);
  const textContent: string = s.text ?? children.map((c) => c.textContent).join('');
  const isText = s.type === 'text';
  return {
    type: { name: s.type },
    attrs: s.attrs ?? {},
    isText,
    isTextblock: s.type === 'paragraph' || s.type === 'heading',
    text: s.text,
    textContent,
    nodeSize: isText ? (s.text ?? '').length : 2 + children.reduce((n, c) => n + c.nodeSize, 0),
    marks: (s.marks ?? []).map(([name, attrs]) => ({ type: { name }, attrs })),
    firstChild: children[0] ?? null,
    forEach: (fn) => children.forEach(fn),
  };
}

/** ProseMirror-like descendants: positions count node boundaries, false skips the children. */
function doc(specs: Spec[]): DocLike {
  const walk = (nodes: NodeLike[], start: number, fn: (n: NodeLike, pos: number) => boolean | void, kids: Map<NodeLike, NodeLike[]>) => {
    let pos = start;
    for (const n of nodes) {
      const descend = fn(n, pos) !== false;
      if (descend && !n.isText) walk(kids.get(n) ?? [], pos + 1, fn, kids);
      pos += n.nodeSize;
    }
  };
  const kids = new Map<NodeLike, NodeLike[]>();
  const build = (s: Spec): NodeLike => {
    const n = node(s);
    kids.set(n, (s.children ?? []).map(build));
    return n;
  };
  const top = specs.map(build);
  return { descendants: (fn) => walk(top, 0, fn, kids) };
}

test('collectA11yItems: pictures, tables, blocks, coloured text, links merged across marks; quoted original skipped', () => {
  const link = (text: string, extra: Array<[string, Record<string, unknown>]> = []): Spec =>
    ({ type: 'text', text, marks: [['link', { href: 'https://example.test/' }], ...extra] });
  const d = doc([
    { type: 'paragraph', children: [
      { type: 'text', text: 'Grau', marks: [['textStyle', { color: '#999999' }]] },
      link('Mehr '), link('Info', [['bold', {}]]),
      { type: 'image', attrs: { alt: '' } },
    ] },
    { type: 'table', children: [
      { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }] }] },
    ] },
    { type: 'blockquote', attrs: { quote: '' }, children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'ZITAT IM ORIGINAL GANZ LAUT', marks: [['textStyle', { color: '#eeeeee' }]] }] },
    ] },
  ]);
  const items = collectA11yItems(d);
  assert.deepEqual(items.map((i) => i.kind), ['block', 'colored', 'link', 'image', 'table', 'block']);
  const l = items.find((i) => i.kind === 'link');
  assert.deepEqual(l && l.kind === 'link' ? l.text : null, 'Mehr Info');
  assert.deepEqual(checkAccessibility(items).map((i) => i.kind), ['contrast', 'imageAlt', 'tableHeader']);
});

test('collectA11yItems: a table whose first row has header cells passes', () => {
  const cell = (type: string): Spec => ({ type, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x' }] }] });
  const items = collectA11yItems(doc([{ type: 'table', children: [{ type: 'tableRow', children: [cell('tableHeader'), cell('tableHeader')] }] }]));
  assert.deepEqual(checkAccessibility(items), []);
});
