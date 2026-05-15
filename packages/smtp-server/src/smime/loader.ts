/**
 * S/MIME Certificate Loader
 *
 * Loads a user's PKCS#12 bundle from MinIO and extracts
 * the private key + certificate chain using node-forge.
 */

import forge from 'node-forge';
import { getMinioClient } from '@coremail/storage/minio';
import { createLogger } from '@coremail/core';

const log = createLogger('smime:loader');

const MINIO_BUCKET = process.env['MINIO_BUCKET'] ?? 'mail-attachments';

export interface LoadedCertificate {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
}

/**
 * Load a PKCS#12 bundle from MinIO and decrypt it.
 * The storagePath is stored in UserCertificate.storagePath.
 * The PKCS#12 password is stored encrypted in Vault or passed directly.
 *
 * For now the password comes from the environment variable SMIME_P12_PASSWORD
 * (per-user passwords would require a secrets manager — deferred to Phase 10).
 */
export async function loadP12FromMinio(
  storagePath: string,
  p12Password: string = '',
): Promise<LoadedCertificate> {
  const minio = getMinioClient();
  const stream = await minio.getObject(MINIO_BUCKET, storagePath);

  // Collect stream into buffer
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const p12Der = Buffer.concat(chunks).toString('binary');
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, p12Password);

  // forge.pki.oids has an index signature → use bracket access to satisfy TS4111
  const oids = forge.pki.oids as Record<string, string>;

  // Extract private key
  const keyBags = p12.getBags({ bagType: oids['pkcs8ShroudedKeyBag']! });
  const rawBags = keyBags[oids['pkcs8ShroudedKeyBag']!];
  if (!rawBags || rawBags.length === 0) {
    throw new Error('No private key found in PKCS#12 bundle');
  }
  const privateKey = rawBags[0]!.key as forge.pki.rsa.PrivateKey;
  if (!privateKey) {
    throw new Error('Failed to extract private key from PKCS#12 bundle');
  }

  // Extract certificate chain
  const certBags = p12.getBags({ bagType: oids['certBag']! });
  const rawCertBags = certBags[oids['certBag']!];
  if (!rawCertBags || rawCertBags.length === 0) {
    throw new Error('No certificate found in PKCS#12 bundle');
  }
  // exactOptionalPropertyTypes: forge.Bag has cert?: Certificate — cast to loosen the constraint
  const certs = (rawCertBags as Array<{ cert?: forge.pki.Certificate | undefined }>)
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => c !== undefined);

  log.debug({ storagePath, certs: certs.length }, 'PKCS#12 loaded');

  return {
    privateKey,
    certificate: certs[0]!,
    chain: certs.slice(1),
  };
}

/**
 * Convert a PEM-encoded public certificate (no private key) into a forge cert.
 * Used when encrypting a message for a recipient using their public cert.
 */
export function certFromPem(pem: string): forge.pki.Certificate {
  return forge.pki.certificateFromPem(pem);
}
