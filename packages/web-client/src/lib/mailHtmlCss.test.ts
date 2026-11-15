import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUrl, normalizeCid, decodeCss, splitCssDeclarations, filterStyle, srcsetIsInlineOnly,
  neutralizeLayoutDeclaration, proxyableUrl, escapeHtml, MAX_MAIL_Z_INDEX,
} from './mailHtmlCss.ts';
import { base64UrlToBuffer, bufferToBase64Url } from './webauthn.ts';

const block = { allowExternal: false, resolveCid: () => null };
const allow = { allowExternal: true, resolveCid: () => null };

test('classifyUrl', () => {
  assert.equal(classifyUrl('https://t.example/p.gif'), 'external');
  assert.equal(classifyUrl('//t.example/p.gif'), 'external');
  assert.equal(classifyUrl('/relative.png'), 'external');
  assert.equal(classifyUrl('pixel.png'), 'external');
  assert.equal(classifyUrl(' \tht\ttp://x/'), 'external');
  assert.equal(classifyUrl('data:image/png;base64,AAAA'), 'inline');
  assert.equal(classifyUrl('  DATA:image/gif;base64,AAAA'), 'inline');
  assert.equal(classifyUrl('cid:logo@x'), 'cid');
  assert.equal(classifyUrl(''), 'inline');
});

test('normalizeCid', () => {
  assert.equal(normalizeCid('cid:<Logo@Example>'), 'logo@example');
  assert.equal(normalizeCid('<a@b>'), 'a@b');
});

test('decodeCss resolves escapes and comments', () => {
  assert.equal(decodeCss('\\75 rl(x)'), 'url(x)');
  assert.equal(decodeCss('u\\rl(x)'), 'url(x)');
  assert.equal(decodeCss('ur/**/l(x)'), 'url(x)');
});

test('splitCssDeclarations respects strings and parentheses', () => {
  assert.deepEqual(
    splitCssDeclarations('color:red; background:url("data:image/png;base64,AA") ; font: 12px "a;b"'),
    ['color:red', 'background:url("data:image/png;base64,AA")', 'font: 12px "a;b"'],
  );
});

// Payload corpus: every entry must lose its external reference when blocking
const EXTERNAL_STYLES = [
  'background-image:url(http://t/p.gif)',
  'background: #fff url("https://t/p.gif") no-repeat',
  "background:url('//t/p.gif')",
  'background:url(p.gif)',
  'BACKGROUND:URL(HTTP://T/P.GIF)',
  'background:\\75 rl(http://t/p.gif)',
  'background:u\\rl(http://t/p.gif)',
  'background:ur/**/l(http://t/p.gif)',
  'list-style-image:url(http://t/p.gif)',
  'border-image:url(http://t/p.gif) 30',
  'cursor:url(http://t/c.cur),auto',
  'content:url(http://t/p.gif)',
  'background-image:image-set("http://t/p.gif" 1x)',
  'background-image:-webkit-image-set("http://t/p.gif" 1x)',
  'background:cross-fade(url(http://t/a.png), url(http://t/b.png), 50%)',
  'mask:url(http://t/m.svg)',
  'background:url( http://t/p.gif )',
  'background:url(http://t/p.gif',
];

for (const css of EXTERNAL_STYLES) {
  test(`filterStyle blocks: ${css}`, () => {
    const res = filterStyle(`color:red; ${css}`, block);
    assert.equal(res.blocked, 1, res.style);
    assert.ok(!/t\/|p\.gif|http/i.test(res.style), `leaked: ${res.style}`);
    assert.match(res.style, /color:red/);
  });
}

test('filterStyle keeps external references when images are allowed', () => {
  const res = filterStyle('background:url(http://t/p.gif)', allow);
  assert.equal(res.blocked, 0);
  assert.match(res.style, /http:\/\/t\/p\.gif/);
});

test('filterStyle keeps data: URIs and rewrites cid: references', () => {
  const data = filterStyle('background:url(data:image/png;base64,AAAA)', block);
  assert.equal(data.blocked, 0);
  assert.match(data.style, /data:image\/png;base64,AAAA/);

  const cid = filterStyle('background:url(cid:logo@x)', { allowExternal: false, resolveCid: (c) => (c === 'logo@x' ? 'blob:http://h/1' : null) });
  assert.match(cid.style, /url\("blob:http:\/\/h\/1"\)/);

  const unresolved = filterStyle('color:red;background:url(cid:missing)', block);
  assert.equal(unresolved.style, 'color:red');
});

test('filterStyle always drops script vectors', () => {
  for (const css of ['width:expression(alert(1))', 'background:url(javascript:alert(1))', '-moz-binding:url(x.xml#a)', 'behavior:url(x.htc)']) {
    assert.equal(filterStyle(css, allow).style, '', css);
  }
});

test('srcsetIsInlineOnly', () => {
  assert.equal(srcsetIsInlineOnly(''), true);
  assert.equal(srcsetIsInlineOnly('data:image/png;base64,AAAA 2x'), true);
  assert.equal(srcsetIsInlineOnly('http://t/a.png 1x'), false);
  assert.equal(srcsetIsInlineOnly('data:image/png;base64,AA 1x, http://t/a.png 2x'), false);
  assert.equal(srcsetIsInlineOnly('a.png'), false);
});

// ── Overlay phishing: mail CSS must not escape the body container ────────────
test('filterStyle neutralises position fixed/sticky (overlay phishing)', () => {
  const overlay = filterStyle('position:fixed; inset:0; z-index:9999; background:#fff', block);
  assert.ok(!/fixed/i.test(overlay.style), overlay.style);
  assert.match(overlay.style, /position: static/);
  assert.match(overlay.style, /z-index: 10\b/);
  assert.match(overlay.style, /inset:0/);

  for (const css of [
    'position: FIXED !important',
    'position:sticky',
    'position:-webkit-sticky',
    'pos\\69 tion:fixed',          // CSS escape
    'position:/**/fixed',          // comment
  ]) {
    const res = filterStyle(css, block);
    assert.equal(res.style, 'position: static', css);
  }
  // Other positioning stays (contained by the body container)
  assert.equal(filterStyle('position:absolute', block).style, 'position:absolute');
  assert.equal(filterStyle('position:relative', block).style, 'position:relative');
});

test('filterStyle clamps z-index', () => {
  assert.equal(filterStyle('z-index:2147483647', block).style, `z-index: ${MAX_MAIL_Z_INDEX}`);
  assert.equal(filterStyle('z-index:-5', block).style, 'z-index: 0');
  assert.equal(filterStyle('z-index:3', block).style, 'z-index: 3');
  assert.equal(filterStyle('z-index:auto', block).style, 'z-index: auto');
  assert.equal(filterStyle('z-index:99 !important', block).style, `z-index: ${MAX_MAIL_Z_INDEX}`);
  assert.equal(filterStyle('z-index:calc(1e9)', block).style, '');
  assert.equal(neutralizeLayoutDeclaration('color:red'), 'color:red');
});

test('filterStyle uses resolveExternal (image proxy blob URLs) instead of blocking', () => {
  const seen: string[] = [];
  const res = filterStyle('background:url(https://t/p.gif); color:red', {
    allowExternal: false,
    resolveCid: () => null,
    resolveExternal: (u) => { seen.push(u); return u === 'https://t/p.gif' ? 'blob:http://h/9' : null; },
  });
  assert.deepEqual(seen, ['https://t/p.gif']);
  assert.equal(res.blocked, 0);
  assert.match(res.style, /url\("blob:http:\/\/h\/9"\)/);
  assert.ok(!res.style.includes('https://t/'));

  const unresolved = filterStyle('background:url(https://t/x.gif)', { ...block, resolveExternal: () => null });
  assert.equal(unresolved.blocked, 1);
  assert.equal(unresolved.style, '');
});

test('proxyableUrl', () => {
  assert.equal(proxyableUrl('https://t.example/p.gif'), 'https://t.example/p.gif');
  assert.equal(proxyableUrl(' http://t.example/p.gif '), 'http://t.example/p.gif');
  assert.equal(proxyableUrl('//t.example/p.gif'), 'https://t.example/p.gif');
  assert.equal(proxyableUrl('ht\ttps://t.example/a'), 'https://t.example/a');
  assert.equal(proxyableUrl('/relative.png'), null);
  assert.equal(proxyableUrl('pixel.png'), null);
  assert.equal(proxyableUrl('javascript:alert(1)'), null);
  assert.equal(proxyableUrl('ftp://t/x'), null);
  assert.equal(proxyableUrl('https:///x'), null);
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('1')">&`), '&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt;&amp;');
  assert.equal(escapeHtml('"Evil" <x@y>'), '&quot;Evil&quot; &lt;x@y&gt;');
});

test('webauthn base64url round trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const s = bufferToBase64Url(bytes);
  assert.ok(!/[+/=]/.test(s));
  assert.deepEqual(new Uint8Array(base64UrlToBuffer(s)), bytes);
});
