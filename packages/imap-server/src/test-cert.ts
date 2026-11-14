/**
 * TEST-ONLY: throw-away self-signed certificate for loopback TLS tests.
 * Never imported by production code.
 */
import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

export function selfSignedTestCert(commonName = 'localhost'): { cert: Buffer; key: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(privateKey) };
}
