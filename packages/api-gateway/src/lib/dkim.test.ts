/**
 * DKIM key generation at domain creation + DNS record derivation.
 * Run: node --import tsx --test src/lib/dkim.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';
import { dkimDnsRecord, generateDkimPrivateKey, needsDkimKey } from './dkim.js';

test('generateDkimPrivateKey returns a usable RSA-2048 PKCS#8 PEM', () => {
  const pem = generateDkimPrivateKey();
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  const key = createPrivateKey(pem);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
  // the key signs, and its public half verifies
  const sig = createSign('sha256').update('dkim').sign(pem);
  assert.ok(createVerify('sha256').update('dkim').verify(createPublicKey(pem), sig));
  assert.equal(needsDkimKey(pem), false);
});

test('needsDkimKey flags the empty keys written by setup/EMS before the fix', () => {
  assert.equal(needsDkimKey(''), true);
  assert.equal(needsDkimKey('   \n'), true);
  assert.equal(needsDkimKey(null), true);
  assert.equal(needsDkimKey(undefined), true);
});

test('dkimDnsRecord publishes the PKCS#1 public key (RFC 6376, v3.17.46)', () => {
  const pem = generateDkimPrivateKey();
  const rec = dkimDnsRecord(pem, 'coremail', 'firma.de');
  assert.equal(rec.selector, 'coremail');
  assert.equal(rec.dnsName, 'coremail._domainkey.firma.de');
  const m = /^v=DKIM1; k=rsa; p=([A-Za-z0-9+/=]+)$/.exec(rec.dnsValue);
  assert.ok(m, rec.dnsValue);
  const der = Buffer.from(m[1]!, 'base64');
  const expected = createPublicKey(pem).export({ type: 'pkcs1', format: 'der' });
  assert.deepEqual(der, expected);
  // SPKI would start with the AlgorithmIdentifier SEQUENCE (rsaEncryption OID) — PKCS#1 must not
  assert.equal(der.includes(Buffer.from('2a864886f70d010101', 'hex')), false);
});
