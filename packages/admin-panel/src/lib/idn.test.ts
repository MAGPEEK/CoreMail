import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToASCII } from 'node:url';
import {
  punycodeDecode, describeDomain, describePattern, describeText, matchesDisplay, labelMixesScripts,
} from './idn.ts';

test('punycodeDecode: known vectors', () => {
  assert.equal(punycodeDecode('mller-kva'), 'müller');
  assert.equal(punycodeDecode('bcher-kva'), 'bücher');
  assert.equal(punycodeDecode('egbpdaj6bu4bxfgehfvwxn'), 'ليهمابتكلموشعربي؟');
  assert.equal(punycodeDecode('maana-pta'), 'mañana');
});

test('punycodeDecode round-trips whatever the platform encodes', () => {
  for (const word of ['münchen', 'сайт', '日本語', 'παράδειγμα', 'a-ü-b', 'ñandú']) {
    const ascii = domainToASCII(`${word}.example`);
    const label = ascii.split('.')[0]!;
    assert.equal(punycodeDecode(label.slice(4)), word, word);
  }
});

test('punycodeDecode: invalid input gives null', () => {
  assert.equal(punycodeDecode('mller-kv!'), null); // bad digit
  assert.equal(punycodeDecode('mller-k'), null); // truncated delta
  assert.equal(punycodeDecode('ü-abc'), null); // non-ASCII in the basic part
  assert.equal(punycodeDecode('99999999999'), null); // code point out of range
});

test('describeDomain: A-label shows as U-label with the A-label kept', () => {
  const d = describeDomain('xn--mller-kva.de');
  assert.deepEqual(d, { ascii: 'xn--mller-kva.de', unicode: 'müller.de', state: 'idn', mixedScript: false });
});

test('describeDomain: plain ASCII is unchanged, upper case is folded', () => {
  assert.deepEqual(describeDomain('Example.COM'), { ascii: 'example.com', unicode: 'example.com', state: 'ascii', mixedScript: false });
});

test('describeDomain: invalid xn-- label stays an A-label and is flagged', () => {
  const d = describeDomain('xn--!!!.example');
  assert.equal(d.state, 'invalid');
  assert.equal(d.unicode, 'xn--!!!.example');
  assert.equal(describeDomain('xn--abc-.example').state, 'invalid'); // decodes to ASCII only
  assert.equal(describeDomain('xn--.example').state, 'invalid');
});

test('describeDomain: wildcard labels pass through', () => {
  const d = describeDomain('*.xn--bcher-kva.example');
  assert.equal(d.unicode, '*.bücher.example');
  assert.equal(d.state, 'idn');
});

test('mixed scripts: Latin plus Cyrillic in one label is flagged', () => {
  const lookalike = domainToASCII('аpple.example'); // Cyrillic a + Latin pple
  assert.match(lookalike, /^xn--/);
  const d = describeDomain(lookalike);
  assert.equal(d.state, 'idn');
  assert.equal(d.mixedScript, true);
  assert.equal(d.unicode, 'аpple.example');
});

test('mixed scripts: single script, digits, hyphens and Japanese mixtures are fine', () => {
  assert.equal(labelMixesScripts('münchen'), false);
  assert.equal(labelMixesScripts('сайт-24'), false);
  assert.equal(labelMixesScripts('日本語かな'), false);
  assert.equal(labelMixesScripts('apple'), false);
  assert.equal(labelMixesScripts('аpple'), true);
  assert.equal(labelMixesScripts('αbc'), true);
  assert.equal(describeDomain(domainToASCII('сайт.example')).mixedScript, false);
});

test('describePattern: domain part of an address or wildcard pattern', () => {
  const d = describePattern('*@xn--mller-kva.de');
  assert.equal(d.unicode, '*@müller.de');
  assert.equal(d.ascii, '*@xn--mller-kva.de');
  assert.equal(describePattern('hans@xn--mller-kva.de').unicode, 'hans@müller.de');
  assert.equal(describePattern('xn--mller-kva.de').unicode, 'müller.de');
  assert.equal(describePattern('a@spam.example').state, 'ascii');
});

test('describeText never converts (regular expressions)', () => {
  assert.equal(describeText('^xn--mller-kva$').unicode, '^xn--mller-kva$');
});

test('matchesDisplay: matches the A-label and the U-label spelling', () => {
  const d = describePattern('info@xn--mller-kva.de');
  assert.equal(matchesDisplay(d, 'müller'), true);
  assert.equal(matchesDisplay(d, 'MÜLLER'), true);
  assert.equal(matchesDisplay(d, 'xn--mller'), true);
  assert.equal(matchesDisplay(d, 'schmidt'), false);
  assert.equal(matchesDisplay(d, '  '), true);
});
