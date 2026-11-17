/**
 * 9.3 branding helpers: strict SVG sanitiser (hostile samples), colour contrast
 * + hue-preserving suggestion, magic bytes / dimensions per slot, index.html
 * injection (escaping for script context).
 * Run: node --import tsx --test src/lib/branding/branding-lib.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg, SvgUnsafeError } from './svg.js';
import { colorWarning, suggestAccessibleColor, contrastRatio, hexToRgb, LIGHT_SURFACE, DARK_SURFACE, rgbChannels } from './color.js';
import { validateAsset, AssetError, rasterDimensions, sniffRaster } from './image.js';
import { renderBrandedIndex, jsonForScript } from './html.js';
import { AssetLru } from './asset-cache.js';
import type { PublicBranding } from '@coremail/storage';
import { fakePng, fakeJpeg, fakeWebpLossless, fakeWebpExtended } from './test-fixtures.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: test -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="120" height="40" viewBox="0 0 120 40" inkscape:version="1.3">
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><script>alert(1)</script></rdf:RDF></metadata>
  <defs>
    <linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#0078d4"/><stop offset="1" stop-color="#00bcf2"/></linearGradient>
    <style><![CDATA[ .a { fill: #fff; } .b > .c { stroke: red } ]]></style>
  </defs>
  <title>Acme &amp; Co</title>
  <g class="a" transform="translate(2 2)" style="fill:url(#g1);opacity:.9">
    <rect width="36" height="36" rx="6" fill="url('#g1')"/>
    <use xlink:href="#g1"/>
    <path d="M10 10 L20 20 Z" stroke="#fff" stroke-width="2"/>
    <text x="44" y="26" font-family="Arial" font-size="18">Acme &lt;Mail&gt; &#169;</text>
  </g>
</svg>`;

const unsafe = (svg: string, re?: RegExp) => assert.throws(() => sanitizeSvg(svg), (e: unknown) => e instanceof SvgUnsafeError && (!re || re.test(e.message)), svg.slice(0, 120));

const wrap = (inner: string, rootAttrs = '') => `<svg xmlns="http://www.w3.org/2000/svg"${rootAttrs}>${inner}</svg>`;

// ── SVG ───────────────────────────────────────────────────────────────────────

test('svg: a typical logo passes; metadata/comments dropped; output re-serialised', () => {
  const out = sanitizeSvg(LOGO);
  assert.equal(out.width, 120);
  assert.equal(out.height, 40);
  assert.match(out.svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg" xmlns:xlink="http:\/\/www.w3.org\/1999\/xlink" width="120"/);
  assert.doesNotMatch(out.svg, /metadata|rdf|script|inkscape|Generator/);
  assert.match(out.svg, /<title>Acme &amp; Co<\/title>/);
  assert.match(out.svg, /Acme &lt;Mail&gt; ©/);
  assert.match(out.svg, /\.b &gt; \.c/);
  // idempotent: the output passes again unchanged
  assert.equal(sanitizeSvg(out.svg).svg, out.svg);
});

test('svg: Inkscape- and Figma-style exports pass', () => {
  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="210mm" height="50mm" viewBox="0 0 210 50" version="1.1" id="svg1"
   inkscape:version="1.3 (0e150ed, 2023-07-21)" sodipodi:docname="logo.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" inkscape:zoom="0.7"><inkscape:page x="0" y="0" width="210" height="50" id="page2"/></sodipodi:namedview>
  <defs id="defs1"/>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <text xml:space="preserve" style="font-size:10.5833px;line-height:1.25;font-family:sans-serif;stroke-width:0.264583" x="10" y="30" id="text1"><tspan sodipodi:role="line" id="tspan1" x="10" y="30">Acme</tspan></text>
    <path style="fill:#0078d4;fill-opacity:1;stroke:none" d="m 150,10 h 40 v 30 h -40 z" id="rect1"/>
  </g>
</svg>`;
  const ink = sanitizeSvg(inkscape);
  assert.ok(Math.abs(ink.width! - 793.7) < 0.1);
  assert.doesNotMatch(ink.svg, /sodipodi|inkscape|namedview/);
  const figma = `<svg width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1_2)" filter="url(#filter0_d_1_2)"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 0H40V40H0V0Z" fill="#0078D4"/></g>
<defs>
<filter id="filter0_d_1_2" x="-4" y="0" width="48" height="48" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dy="4"/><feGaussianBlur stdDeviation="2"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1_2"/>
</filter>
<clipPath id="clip0_1_2"><rect width="40" height="40" fill="white"/></clipPath>
</defs>
</svg>`;
  assert.equal(sanitizeSvg(figma).width, 120);
});

test('svg: viewBox-only size, units, BOM', () => {
  assert.deepEqual(sanitizeSvg(wrap('<rect width="1" height="1"/>', ' viewBox="0 0 64 32"')).width, 64);
  const s = sanitizeSvg(wrap('', ' width="10mm" height="1in"'));
  assert.ok(Math.abs(s.width! - 37.795) < 0.01 && s.height === 96);
  assert.equal(sanitizeSvg(wrap('', ' width="100%"')).width, null);
  assert.equal(sanitizeSvg('\ufeff' + wrap('<g/>')).svg.includes('<g/>'), true);
});

test('svg: scripts, handlers, foreignObject, images, links, animation → refused', () => {
  unsafe(wrap('<script>alert(1)</script>'), /script/);
  unsafe(wrap('<script xlink:href="https://evil/x.js"/>'), /script/);
  unsafe('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', /event handler/);
  unsafe(wrap('<rect ONCLICK="alert(1)"/>'), /event handler/);
  unsafe(wrap('<g><circle r="1" onmouseover="x()"/></g>'), /event handler/);
  unsafe(wrap('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject>'), /foreignObject/);
  unsafe(wrap('<switch><foreignObject requiredExtensions="x"/><text>t</text></switch>'), /foreignObject/);
  unsafe(wrap('<image href="https://tracker.example/p.png"/>'), /images/);
  unsafe(wrap('<image href="data:image/png;base64,AAAA"/>'), /images/);
  unsafe(wrap('<a href="javascript:alert(1)"><text>x</text></a>'), /links/);
  unsafe(wrap('<set attributeName="href" to="javascript:alert(1)"/>'), /animation/);
  unsafe(wrap('<animate attributeName="x" values="1;2"/>'), /animation/);
  unsafe(wrap('<iframe src="https://evil"/>'), /iframe/);
  unsafe(wrap('<blink/>'), /not allowed/);
  unsafe(wrap('<svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script>'), /not allowed/);
  unsafe(wrap('<SCRIPT>alert(1)</SCRIPT>'), /not allowed/);
});

test('svg: external / javascript / data hrefs → refused; #fragment allowed', () => {
  unsafe(wrap('<use href="https://evil.example/sprite.svg#a"/>'), /#fragment/);
  unsafe(wrap('<use xlink:href="sprite.svg#a"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'), /#fragment/);
  unsafe(wrap('<use href="javascript:alert(1)"/>'), /#fragment/);
  unsafe(wrap('<use href=" data:image/svg+xml;base64,PHN2Zz4="/>'), /#fragment/);
  unsafe(wrap('<use href="&#106;avascript:alert(1)"/>'), /#fragment/);
  unsafe(wrap('<rect href="#a"/>'), /not allowed on <rect>/);
  assert.match(sanitizeSvg(wrap('<defs><g id="a"/></defs><use href="#a"/>')).svg, /<use href="#a"\/>/);
});

test('svg: DOCTYPE / ENTITY (XXE, billion laughs), processing instructions, unknown entities → refused', () => {
  unsafe('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>', /DOCTYPE/);
  unsafe('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"/>', /DOCTYPE/);
  unsafe('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><svg>&lol2;</svg>', /DOCTYPE/);
  unsafe(wrap('<!DOCTYPE x>'), /DOCTYPE/);
  unsafe(wrap('<text>&nbsp;</text>'), /entity/);
  unsafe(wrap('<text>a & b</text>'), /&/);
  unsafe('<?xml-stylesheet href="https://evil/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>', /processing instructions/);
  unsafe(wrap('<?php echo 1; ?>'), /processing instructions/);
  unsafe('<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"/>', /UTF-8/);
});

test('svg: CSS — style element url()/@import, style attribute external url(), escapes, expression', () => {
  unsafe(wrap('<style>@import url(https://evil/x.css);</style>'), /url\(|@import/);
  unsafe(wrap('<style>@import "https://evil/x.css";</style>'), /@import/);
  unsafe(wrap('<style>.a{background:url(https://evil/p.png)}</style>'), /url\(/);
  unsafe(wrap('<style>.a{fill:url(#g)}</style>'), /url\(/);
  unsafe(wrap('<style>@font-face{font-family:x;src:local(x)}</style>'), /@-rules|resource/);
  unsafe(wrap('<style>.a{background:image-set("https://evil/p.png" 1x)}</style>'), /resource/);
  unsafe(wrap('<style>.a{background:u\\72l(https://evil)}</style>'), /backslash/);
  unsafe(wrap('<style><g/></style>'), /text only/);
  unsafe(wrap('<rect style="fill:url(https://evil/p.png#x)"/>'), /url\(#id\)/);
  unsafe(wrap('<rect style="behavior:url(#x)"/>'), /behavior/);
  unsafe(wrap('<rect style="width:expression(alert(1))"/>'), /expression/);
  unsafe(wrap('<rect fill="url(data:image/png;base64,AAAA)"/>'), /data:|url/);
  unsafe(wrap('<rect fill="url(&quot;https://evil&quot;)"/>'), /url\(#id\)/);
  unsafe(wrap('<rect filter="url(#f"/>'), /url\(#id\)/);
  unsafe(wrap('<rect style="fill:red;@import x"/>'), /@-rules/);
  unsafe(wrap('<style type="text/javascript">x</style>'), /text\/css/);
  assert.match(sanitizeSvg(wrap('<rect fill="url(#g)" style="fill:url( \'#g\' )"/>')).svg, /url\(#g\)/);
});

test('svg: malformed / structural abuse and limits', () => {
  unsafe('<html><script>alert(1)</script></html>', /root element/);
  unsafe('', /no <svg>/);
  unsafe('just text', /text outside/);
  unsafe(wrap('<rect>') , /mismatched|unclosed/);
  unsafe(wrap('') + wrap(''), /more than one root/);
  unsafe('<svg xmlns="http://www.w3.org/2000/svg" width=10/>', /quoted/);
  unsafe('<svg xmlns="http://www.w3.org/2000/svg" x="1" x="2"/>', /duplicate/);
  unsafe('<svg xmlns="http://www.w3.org/1999/xhtml"/>', /SVG namespace/);
  unsafe('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://evil"/>', /XLink/);
  unsafe('<svg xmlns="http://www.w3.org/2000/svg" data-x="a<b"/>', /"<"/);
  unsafe(wrap('<rect unknownattr="1"/>'), /attribute unknownattr/);
  unsafe(wrap('<g>'.repeat(80) + '</g>'.repeat(80)), /nested too deeply/);
  unsafe(wrap('<use href="#a"/>'.repeat(501)), /<use>/);
});

test('svg: <use> limits — at most 50, no <use> of an element that is or contains <use>', () => {
  const defs = '<defs><path id="p" d="M0 0h1v1z"/></defs>';
  assert.doesNotThrow(() => sanitizeSvg(wrap(defs + '<use href="#p"/>'.repeat(50))));
  unsafe(wrap(defs + '<use href="#p"/>'.repeat(51)), /too many <use> elements \(at most 50\)/);
  // exponential instancing: groups of <use> referencing the previous group
  unsafe(wrap('<defs><g id="a"><path d="M0 0h1v1z"/></g><g id="b"><use href="#a"/><use href="#a"/></g></defs><use href="#b"/>'), /contains <use>/);
  unsafe(wrap('<defs><g id="a"><path d="M0 0h1v1z"/></g><g id="b"><g><use xlink:href="#a"/></g></g></defs><use xlink:href="#b"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'), /contains <use>/);
  // a <use> referencing a <use> (chain) and self / ancestor references
  unsafe(wrap(defs + '<use id="u" href="#p"/><use href="#u"/>'), /is or contains <use>/);
  unsafe(wrap('<g id="loop"><use href="#loop"/></g>'), /contains <use>/);
  unsafe(wrap('<use id="self" href="#self"/>'), /contains <use>/);
  // duplicate ids: any element carrying the id counts
  unsafe(wrap('<defs><path id="d" d="M0 0h1v1z"/><g id="d"><use href="#p"/></g><path id="p" d="M0 0h1v1z"/></defs><use href="#d"/>'), /contains <use>/);
  // one level of instancing, a missing target and gradient hrefs stay allowed
  assert.doesNotThrow(() => sanitizeSvg(wrap('<defs><g id="a"><path d="M0 0h1v1z"/><rect width="1" height="1"/></g></defs><use href="#a"/><use href="#a"/><use href="#missing"/>')));
  assert.doesNotThrow(() => sanitizeSvg(wrap('<defs><linearGradient id="g"/><linearGradient id="h" href="#g"/></defs><use href="#g"/>')));
  unsafe(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]) as unknown as string, /UTF-8/);
  unsafe(wrap('<g/>') + ' '.repeat(600 * 1024), /too large/);
  unsafe(wrap('<text>a\u0000b</text>'), /NUL/);
  unsafe(wrap('<!-- unterminated'), /unterminated comment/);
  unsafe(wrap('<![CDATA[x'), /CDATA/);
});

// ── Colour ────────────────────────────────────────────────────────────────────

test('colour: contrast formula and warnings on light/dark surfaces', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
  assert.equal(rgbChannels('#0078d4'), '0 120 212');
  assert.equal(colorWarning('primaryColor', '#0078d4'), null);
  for (const hex of ['#ffff00', '#ffffff', '#000000', '#0a0a40', '#e0e0e0', '#ff0000']) {
    const w = colorWarning('primaryColor', hex);
    const rgb = hexToRgb(hex);
    const ok = contrastRatio(rgb, LIGHT_SURFACE) >= 3 && contrastRatio(rgb, DARK_SURFACE) >= 3;
    if (ok) { assert.equal(w, null, hex); continue; }
    assert.ok(w, hex);
    assert.equal(w.field, 'primaryColor');
    assert.match(w.message, /3:1/);
    assert.match(w.suggestion, /^#[0-9a-f]{6}$/);
    const s = hexToRgb(w.suggestion);
    assert.ok(contrastRatio(s, LIGHT_SURFACE) >= 3, `${hex} → ${w.suggestion} light`);
    assert.ok(contrastRatio(s, DARK_SURFACE) >= 3, `${hex} → ${w.suggestion} dark`);
  }
});

test('colour: suggestion keeps the hue (yellow stays yellow-ish, blue stays blue)', () => {
  const y = hexToRgb(suggestAccessibleColor('#ffff00'));
  assert.ok(y[0] > y[2] && y[1] > y[2], `yellow → ${y}`);
  const b = hexToRgb(suggestAccessibleColor('#0a0a40'));
  assert.ok(b[2] > b[0] && b[2] > b[1], `navy → ${b}`);
  assert.equal(suggestAccessibleColor('#0078d4'), '#0078d4');
});

// ── Images ────────────────────────────────────────────────────────────────────

test('image: magic bytes and dimensions of PNG / JPEG / WebP', () => {
  assert.equal(sniffRaster(fakePng(1, 1)), 'png');
  assert.equal(sniffRaster(fakeJpeg(1, 1)), 'jpeg');
  assert.equal(sniffRaster(fakeWebpLossless(1, 1)), 'webp');
  assert.equal(sniffRaster(Buffer.from('<svg/>')), null);
  assert.deepEqual(rasterDimensions(fakePng(300, 100), 'png'), { width: 300, height: 100 });
  assert.deepEqual(rasterDimensions(fakeJpeg(640, 480), 'jpeg'), { width: 640, height: 480 });
  assert.deepEqual(rasterDimensions(fakeWebpLossless(200, 50), 'webp'), { width: 200, height: 50 });
  assert.deepEqual(rasterDimensions(fakeWebpExtended(5000, 7), 'webp'), { width: 5000, height: 7 });
  assert.equal(rasterDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg'), null);
});

test('image: slot rules — type, size, dimensions, square favicon, jpeg only for the login background', () => {
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof AssetError ? e.code : String(e); } };
  assert.equal(code(() => validateAsset('logoLight', 'image/png', fakePng(300, 100))), 'ok');
  assert.equal(code(() => validateAsset('logoLight', 'image/png; charset=binary', fakePng(300, 100))), 'ok');
  assert.equal(code(() => validateAsset('logoLight', 'image/gif', fakePng(1, 1))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', undefined, fakePng(1, 1))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', 'image/jpeg', fakeJpeg(10, 10))), 'TYPE');
  assert.equal(code(() => validateAsset('loginBackground', 'image/jpeg', fakeJpeg(1920, 1080))), 'ok');
  assert.equal(code(() => validateAsset('logoLight', 'image/png', Buffer.from(LOGO))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', 'image/svg+xml', fakePng(1, 1))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', 'image/webp', fakePng(1, 1))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', 'image/png', Buffer.alloc(0))), 'TYPE');
  assert.equal(code(() => validateAsset('logoLight', 'image/png', fakePng(10, 10, 600 * 1024))), 'SIZE');
  assert.equal(code(() => validateAsset('loginBackground', 'image/png', fakePng(10, 10, 600 * 1024))), 'ok');
  assert.equal(code(() => validateAsset('loginBackground', 'image/png', fakePng(10, 10, 2 * 1024 * 1024))), 'SIZE');
  assert.equal(code(() => validateAsset('logoLight', 'image/png', fakePng(5000, 10))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('logoLight', 'image/png', fakePng(0, 10))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('favicon', 'image/png', fakePng(64, 32))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('favicon', 'image/png', fakePng(2048, 2048))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('favicon', 'image/png', fakePng(64, 64))), 'ok');
  assert.equal(code(() => validateAsset('favicon', 'image/svg+xml', Buffer.from(wrap('', ' viewBox="0 0 32 32"')))), 'ok');
  assert.equal(code(() => validateAsset('favicon', 'image/svg+xml', Buffer.from(wrap('', ' viewBox="0 0 64 32"')))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('logoLight', 'image/svg+xml', Buffer.from(wrap('', ' width="9000" height="10"')))), 'DIMENSIONS');
  assert.equal(code(() => validateAsset('logoLight', 'image/svg+xml', Buffer.from(wrap('<script/>')))), 'SVG_UNSAFE');
  const v = validateAsset('logoLight', 'image/svg+xml', Buffer.from(LOGO));
  assert.equal(v.ext, 'svg');
  assert.equal(v.contentType, 'image/svg+xml');
  assert.doesNotMatch(v.data.toString(), /metadata/);
});

// ── index.html ────────────────────────────────────────────────────────────────

const BRAND: PublicBranding = {
  version: 7, productName: 'Acme </title><script>alert(1)</script>', primaryColor: '#112233', headerColor: null,
  allowUserAccent: true, showPoweredBy: false, loginText: '</script><script>alert(2)</script>\u2028',
  footerLinks: [{ label: 'Impressum', url: 'https://example.org/impressum' }],
  assets: { logoLight: `/branding/assets/${'b'.repeat(64)}.svg`, logoDark: null, favicon: null, loginBackground: null },
};
const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>CoreMail — Mail Web Access</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

test('html: title, favicon, colour var and escaped JSON before </head>', () => {
  const html = renderBrandedIndex(TEMPLATE, BRAND);
  assert.match(html, /<title>Acme &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  assert.doesNotMatch(html, /\/favicon\.svg/);
  assert.match(html, new RegExp(`<link rel="icon" type="image/svg\\+xml" href="/branding/assets/${'b'.repeat(64)}\\.svg" />`));
  assert.match(html, /<style id="cm-brand">:root\{--brand-primary:17 34 51\}<\/style>/);
  const m = /<script id="cm-branding" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m);
  assert.doesNotMatch(m[1]!, /[<>&\u2028]/);
  assert.deepEqual(JSON.parse(m[1]!), BRAND);
  assert.ok(html.indexOf('cm-branding') < html.indexOf('</head>'));
  assert.equal((html.match(/<script/g) ?? []).length, 2, 'only the bundle script and the JSON block');
  // re-rendering a rendered page does not duplicate the blocks
  const twice = renderBrandedIndex(html, BRAND);
  assert.equal((twice.match(/id="cm-brand"/g) ?? []).length, 1);
  assert.equal((twice.match(/id="cm-branding"/g) ?? []).length, 1);
  assert.equal((twice.match(/rel="icon"/g) ?? []).length, 1);
});

test('html: no favicon/logo keeps the built-in icon; missing title / icon tags are added', () => {
  const plain = renderBrandedIndex(TEMPLATE, { ...BRAND, productName: 'CoreMail', assets: { logoLight: null, logoDark: null, favicon: null, loginBackground: null } });
  assert.match(plain, /href="\/favicon\.svg"/);
  assert.match(plain, /<title>CoreMail<\/title>/);
  const bcp = renderBrandedIndex('<html><head><meta charset="UTF-8" /></head><body></body></html>', { ...BRAND, assets: { ...BRAND.assets, favicon: `/branding/assets/${'c'.repeat(64)}.png` } });
  assert.match(bcp, /<title>Acme/);
  assert.match(bcp, /type="image\/png" href="\/branding\/assets\/c{64}\.png"/);
  assert.equal(jsonForScript({ a: '</script>&' }), '{"a":"\\u003c/script\\u003e\\u0026"}');
});

// ── Asset LRU ─────────────────────────────────────────────────────────────────

test('asset LRU: bounded by entries and bytes, least recently used evicted first', () => {
  const lru = new AssetLru(3, 100);
  const buf = (n: number) => Buffer.alloc(n, 1);
  lru.set('a', buf(10)); lru.set('b', buf(10)); lru.set('c', buf(10));
  assert.ok(lru.get('a'), 'a used → most recent');
  lru.set('d', buf(10));
  assert.equal(lru.get('b'), undefined, 'b was least recently used');
  assert.deepEqual([lru.size, lru.bytes], [3, 30]);
  lru.set('e', buf(90));
  assert.ok(lru.get('e'));
  assert.ok(lru.bytes <= 100 && lru.size <= 3, `${lru.size} / ${lru.bytes}`);
  assert.equal(lru.get('a'), undefined);
  lru.set('huge', buf(101));
  assert.equal(lru.get('huge'), undefined, 'larger than the byte budget → not cached');
  lru.set('e', buf(5));
  assert.equal(lru.get('e')!.length, 5, 'replacing a key updates its size');
  lru.clear();
  assert.deepEqual([lru.size, lru.bytes], [0, 0]);
});
