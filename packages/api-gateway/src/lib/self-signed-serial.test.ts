/**
 * Self-signed certificates always carry a serial OpenSSL accepts.
 *
 * Regression: createSelfSignedPem used `'00' + 16 random bytes`; node-forge
 * drops one leading 0x00, so a random first byte 0x00 followed by a byte
 * < 0x80 left a padded DER INTEGER and `new X509Certificate()` threw
 * "asn1 encoding routines::illegal padding" (about 1 in 512 certificates).
 * Every generated certificate is parsed with node:crypto here, including
 * injected edge-case random bytes, and the parsed serial must equal the one
 * that was written (no rewriting by node-forge).
 * Run: node --import tsx --test src/lib/self-signed-serial.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma({});

const { randomCertSerialHex } = await import('@coremail/core');
const { createSelfSignedPem } = await import('./protocol-cert-assign.js');

// One small key for the loops: the serial encoding does not depend on the key size,
// and the default RSA-2048 generation per certificate would make 2000+ runs slow.
const KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

async function parsedSerial(serialHex?: string): Promise<{ written: string | undefined; parsed: string }> {
  const { certPem } = await createSelfSignedPem(['mail.example.com'], 30, {
    keyPem: KEY_PEM, ...(serialHex !== undefined ? { serialHex } : {}),
  });
  return { written: serialHex, parsed: new X509Certificate(certPem).serialNumber };
}

test('the default path (fresh RSA-2048 key, random serial) yields a parseable 16-byte positive serial', async () => {
  const { certPem } = await createSelfSignedPem(['mail.example.com']);
  const serial = new X509Certificate(certPem).serialNumber;
  assert.match(serial, /^[0-7][0-9A-F]{31}$/);
});

test('2000 random serials: every certificate parses and keeps its serial', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const serialHex = randomCertSerialHex();
    const { parsed } = await parsedSerial(serialHex);
    assert.equal(parsed, serialHex.toUpperCase());
    seen.add(parsed);
  }
  assert.equal(seen.size, 2000);
});

test('edge-case random bytes (0x00 / 0x80 / 0xFF leads, every first byte) give parseable certificates', async () => {
  const sources: Uint8Array[] = [];
  for (let first = 0; first <= 0xff; first++) {
    for (const second of [0x00, 0x7f, 0x80, 0xff]) {
      const bytes = new Uint8Array(16).fill(0x5a);
      bytes[0] = first;
      bytes[1] = second;
      sources.push(bytes);
    }
  }
  for (const fill of [0x00, 0x80, 0xff]) sources.push(new Uint8Array(20).fill(fill));
  for (const bytes of sources) {
    const serialHex = randomCertSerialHex(bytes.length, () => bytes);
    const { parsed } = await parsedSerial(serialHex);
    assert.equal(parsed, serialHex.toUpperCase(), `random bytes ${Buffer.from(bytes).toString('hex')}`);
  }
});

test('the old serial scheme is the failure being fixed (padded INTEGER is refused by OpenSSL)', async () => {
  // '00' + random bytes starting 0x00 0x21 → node-forge writes 00 21 … → illegal padding
  await assert.rejects(parsedSerial('0000' + '21'.repeat(15)), /illegal padding/);
});
