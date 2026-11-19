import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalDomainName, domainsAlignedRelaxed, isAlignedWithAny, organizationalDomain,
} from './domain-alignment.js';

const aligned = (a: string, b: string, expected: boolean): void => {
  assert.equal(domainsAlignedRelaxed(a, b), expected, `${a} ~ ${b}`);
  assert.equal(domainsAlignedRelaxed(b, a), expected, `${b} ~ ${a} (symmetric)`);
};

test('organizationalDomain follows the Public Suffix List (ICANN section)', () => {
  assert.equal(organizationalDomain('mail.shop.example.co.uk'), 'example.co.uk');
  assert.equal(organizationalDomain('example.co.uk'), 'example.co.uk');
  assert.equal(organizationalDomain('co.uk'), null, 'a public suffix has no organizational domain');
  assert.equal(organizationalDomain('uk'), null);
  assert.equal(organizationalDomain('mx.example.com.au'), 'example.com.au');
  assert.equal(organizationalDomain('com.au'), null);
  assert.equal(organizationalDomain('a.b.example.com'), 'example.com');
});

test('organizationalDomain honours the private section (DMARC uses the full list)', () => {
  assert.equal(organizationalDomain('alice.github.io'), 'alice.github.io');
  assert.equal(organizationalDomain('www.alice.github.io'), 'alice.github.io');
  assert.equal(organizationalDomain('github.io'), null);
});

test('unknown TLDs use the default rule "*": the last label is the suffix', () => {
  assert.equal(organizationalDomain('mail.corp.test'), 'corp.test');
  assert.equal(organizationalDomain('x.y.example.unknowntld'), 'example.unknowntld');
  assert.equal(organizationalDomain('test'), null);
});

test('canonical form: case, one trailing dot, IDN as A-labels', () => {
  assert.equal(canonicalDomainName('Mail.Example.COM.'), 'mail.example.com');
  assert.equal(canonicalDomainName('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(canonicalDomainName('example.com..'), null);
  assert.equal(canonicalDomainName('a..example.com'), null);
  assert.equal(canonicalDomainName(''), null);
  assert.equal(canonicalDomainName('.'), null);
  assert.equal(canonicalDomainName('example.com/path'), null);
  assert.equal(canonicalDomainName(`${'a'.repeat(64)}.example.com`), null);
  assert.equal(canonicalDomainName('192.0.2.1'), null, 'IP literals are no domain names');
  assert.equal(organizationalDomain('Mail.Example.CO.UK.'), 'example.co.uk');
});

test('a sibling registrable domain under a public suffix is never aligned', () => {
  aligned('evil.co.uk', 'co.uk', false);
  aligned('victim.co.uk', 'evil.co.uk', false);
  aligned('mail.victim.co.uk', 'evil.co.uk', false);
  aligned('victim.com.au', 'evil.com.au', false);
  aligned('evil.com.au', 'com.au', false);
  aligned('alice.github.io', 'bob.github.io', false);
  aligned('alice.github.io', 'github.io', false);
  aligned('corp.test', 'evilcorp.test', false);
  aligned('corp.test', 'corp.test.evil.example', false);
});

test('the same organization is aligned (equal, subdomain, sibling subdomain)', () => {
  aligned('example.co.uk', 'example.co.uk', true);
  aligned('example.co.uk', 'mail.example.co.uk', true);
  aligned('bounces.example.co.uk', 'mail.example.co.uk', true);
  aligned('example.com.au', 'mx.example.com.au', true);
  aligned('www.alice.github.io', 'alice.github.io', true);
  aligned('corp.test', 'mail.corp.test', true);
  aligned('Mail.Corp.Test.', 'corp.test', true);
});

test('a public suffix is aligned only with itself (strict match)', () => {
  aligned('co.uk', 'co.uk', true);
  aligned('CO.UK.', 'co.uk', true);
  aligned('co.uk', 'uk', false);
});

test('IDN: Unicode and A-label spellings are the same domain', () => {
  aligned('bücher.example', 'xn--bcher-kva.example', true);
  aligned('mail.bücher.example', 'xn--bcher-kva.example', true);
  aligned('a.公司.cn', 'mail.a.xn--55qx5d.cn', true);
  aligned('a.公司.cn', 'b.公司.cn', false);
  aligned('xn--55qx5d.cn', 'evil.xn--55qx5d.cn', false);
});

test('IP literals are aligned only on exact equality', () => {
  aligned('192.0.2.1', '192.0.2.1', true);
  aligned('[192.0.2.1]', '192.0.2.1', true);
  aligned('[IPv6:2001:db8::1]', '2001:db8::1', true);
  aligned('192.0.2.1', '192.0.2.2', false);
  aligned('2.1', '192.0.2.1', false);
  aligned('192.0.2.1', 'example.com', false);
});

test('empty or malformed names are never aligned', () => {
  aligned('', '', false);
  aligned('', 'example.com', false);
  aligned('a..example.com', 'example.com', false);
  aligned('example.com/x', 'example.com', false);
});

test('isAlignedWithAny', () => {
  assert.equal(isAlignedWithAny('example.co.uk', ['other.example', 'mail.example.co.uk']), true);
  assert.equal(isAlignedWithAny('example.co.uk', ['co.uk', 'evil.co.uk']), false);
  assert.equal(isAlignedWithAny('example.co.uk', []), false);
});
