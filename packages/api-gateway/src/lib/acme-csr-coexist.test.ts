/**
 * 10.6.1 regression: the Let's Encrypt CSR must still be created after the passkey library
 * (@simplewebauthn/server → @peculiar/x509 2.x) is loaded in the same process.
 *
 * acme-client uses @peculiar/x509 1.x; both register their algorithm providers in the shared
 * tsyringe container. With two copies of the @peculiar/asn1-* packages the CSR failed with
 * "Cannot get schema for 'AlgorithmIdentifier' target" (setup wizard + BCP certificate order).
 * The pnpm overrides in pnpm-workspace.yaml keep exactly one copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('acme-client creates a CSR after the passkey library was loaded', async () => {
  const storageReq = createRequire(path.resolve(process.cwd(), '../storage/package.json'));
  // loaded FIRST, as in the running gateway (passkey routes / startup migration)
  await import(pathToFileURL(storageReq.resolve('@simplewebauthn/server')).href);
  const acme = (await import('acme-client')).default;
  const [key, csr] = await acme.crypto.createCsr({ altNames: ['mail.example.com', 'autodiscover.example.com'] });
  assert.ok(key.toString().includes('PRIVATE KEY'));
  assert.ok(csr.toString().includes('CERTIFICATE REQUEST'));
});
