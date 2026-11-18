/**
 * S/MIME verification with messages signed by node-forge inside the test.
 * Run: node --import tsx --test src/smime/verify.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { X509Certificate } from 'node:crypto';
import { randomCertSerialHex } from '@coremail/core/cert-serial';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';

const { verifyIncomingSmime, splitMultipart } = await import('./verify.js');
const { evaluateTrust } = await import('./cms-verify.js');

function makeCert(cn: string, email: string, keys: forge.pki.rsa.KeyPair, issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }, ca = false) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomCertSerialHex();
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const subject = [{ name: 'commonName', value: cn }, ...(email ? [{ name: 'emailAddress', value: email }] : [])];
  cert.setSubject(subject);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: ca },
    ...(email ? [{ name: 'subjectAltName', altNames: [{ type: 1, value: email }] }, { name: 'extKeyUsage', emailProtection: true }] : []),
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  return cert;
}

const keys = forge.pki.rsa.generateKeyPair(1024);
const cert = makeCert('Alice Sender', 'alice@sender.example', keys);

function signDetached(content: string, signerCert = cert, signerKey = keys.privateKey, extra: forge.pki.Certificate[] = []): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content, 'raw');
  p7.addCertificate(signerCert);
  for (const c of extra) p7.addCertificate(c);
  p7.addSigner({
    key: signerKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids['sha256']!,
    authenticatedAttributes: [
      { type: forge.pki.oids['contentType']!, value: forge.pki.oids['data']! },
      { type: forge.pki.oids['messageDigest']! },
      { type: forge.pki.oids['signingTime']!, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes()).replace(/(.{76})/g, '$1\r\n');
}

const innerPart = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello Bob,\r\nthis mail is signed.\r\n';

function multipartSigned(inner: string, sigB64: string, from = 'Alice Sender <alice@sender.example>'): Buffer {
  return Buffer.from([
    `From: ${from}`, 'To: bob@local.example', 'Subject: signed', 'MIME-Version: 1.0',
    'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256;',
    ' boundary="----=_sig_1"', '', 'This is an S/MIME signed message', '',
    '------=_sig_1', inner.replace(/\r\n$/, ''),
    '------=_sig_1', 'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="smime.p7s"', '', sigB64,
    '------=_sig_1--', '',
  ].join('\r\n'), 'latin1');
}

test('splitMultipart returns the exact part bytes incl. MIME headers', () => {
  const parts = splitMultipart('pre\r\n--b\r\nA: 1\r\n\r\nx\r\n--b\r\nB\r\n--b--\r\n', 'b');
  assert.deepEqual(parts, ['A: 1\r\n\r\nx', 'B']);
});

test('valid detached signature with self-signed cert → valid, not trusted, signer reported', async () => {
  // the signed content is the first part without the CRLF before the delimiter
  const signed = innerPart.replace(/\r\n$/, '');
  const r = await verifyIncomingSmime(multipartSigned(innerPart, signDetached(signed)));
  assert.equal(r.signed, true);
  assert.equal(r.valid, true, r.error);
  assert.equal(r.trusted, false);
  assert.equal(r.status, 'valid-untrusted');
  assert.equal(r.trust, 'untrusted');
  assert.match(r.trustReason ?? '', /self-signed/);
  assert.equal(r.signerEmail, 'alice@sender.example');
  assert.equal(r.signerName, 'Alice Sender');
  assert.equal(r.fromMatches, true);
  assert.equal(r.digestAlgorithm, 'sha256');
  assert.equal(r.emailProtectionEku, true);
  assert.ok(r.signingTime);
});

test('modified content → invalid', async () => {
  const sig = signDetached(innerPart.replace(/\r\n$/, ''));
  const r = await verifyIncomingSmime(multipartSigned(innerPart.replace('Hello Bob', 'Hello Eve'), sig));
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
  assert.match(r.error ?? '', /modified/);
});

test('signature by a different key than the included certificate → invalid', async () => {
  const other = forge.pki.rsa.generateKeyPair(1024);
  const r = await verifyIncomingSmime(multipartSigned(innerPart, signDetached(innerPart.replace(/\r\n$/, ''), cert, other.privateKey)));
  assert.equal(r.valid, false);
  assert.match(r.error ?? '', /invalid signature/);
});

test('From header differing from the certificate address is reported', async () => {
  const r = await verifyIncomingSmime(multipartSigned(innerPart, signDetached(innerPart.replace(/\r\n$/, '')), 'mallory@evil.example'));
  assert.equal(r.valid, true);
  assert.equal(r.fromMatches, false);
});

test('opaque signed-data (enveloped content) verifies', async () => {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(innerPart, 'raw');
  p7.addCertificate(cert);
  p7.addSigner({ key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids['sha256']!,
    authenticatedAttributes: [{ type: forge.pki.oids['contentType']!, value: forge.pki.oids['data']! }, { type: forge.pki.oids['messageDigest']! }] });
  p7.sign();
  const b64 = forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes()).replace(/(.{76})/g, '$1\r\n');
  const raw = Buffer.from(['From: alice@sender.example', 'Subject: opaque', 'MIME-Version: 1.0',
    'Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"', 'Content-Transfer-Encoding: base64', '', b64, ''].join('\r\n'));
  const r = await verifyIncomingSmime(raw);
  assert.equal(r.valid, true, r.error);
  assert.equal(r.signerEmail, 'alice@sender.example');
});

test('chain building: leaf issued by an included intermediate under a trusted root', () => {
  const rootKeys = forge.pki.rsa.generateKeyPair(1024);
  const root = makeCert('Test Root', '', rootKeys, undefined, true);
  const interKeys = forge.pki.rsa.generateKeyPair(1024);
  const inter = makeCert('Test Intermediate', '', interKeys, { cert: root, key: rootKeys.privateKey }, true);
  const leaf = makeCert('Leaf', 'leaf@x.example', keys, { cert: inter, key: interKeys.privateKey });
  const x = (c: forge.pki.Certificate) => new X509Certificate(forge.pki.certificateToPem(c));
  assert.equal(evaluateTrust(x(leaf), [x(inter)], new Date(), [x(root)]).trust, 'trusted');
  assert.equal(evaluateTrust(x(leaf), [], new Date(), [x(root)]).trust, 'untrusted');
  assert.equal(evaluateTrust(x(leaf), [x(inter)], new Date(), []).trust, 'untrusted');
});

test('not signed → signed:false', async () => {
  const r = await verifyIncomingSmime(Buffer.from('From: a@b.c\r\nContent-Type: text/plain\r\n\r\nhi\r\n'));
  assert.deepEqual(r, { signed: false, valid: false });
});
