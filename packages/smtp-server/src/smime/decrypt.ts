/**
 * S/MIME Decryption
 *
 * Decrypts incoming S/MIME EnvelopedData messages (RFC 5652).
 * Requires the recipient's private key (PKCS#12 from MinIO).
 *
 * Called during inbound delivery when:
 *   Content-Type: application/pkcs7-mime; smime-type=enveloped-data
 */

import forge from 'node-forge';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { loadP12FromMinio } from './loader.js';

const log = createLogger('smime:decrypt');

export interface SmimeDecryptResult {
  encrypted: boolean;
  decrypted: boolean;
  plaintext?: Buffer;
  error?: string;
}

/**
 * Attempt to decrypt an S/MIME encrypted message for the given recipient userId.
 * Returns the decrypted message buffer, or the original if decryption is not possible.
 */
export async function decryptIncomingSmime(
  rawMessage: Buffer,
  recipientUserId: string,
): Promise<SmimeDecryptResult> {
  const msgStr = rawMessage.toString('utf8');
  const contentType = extractHeader(msgStr, 'content-type') ?? '';

  if (
    !contentType.toLowerCase().includes('application/pkcs7-mime') ||
    !contentType.toLowerCase().includes('enveloped-data')
  ) {
    return { encrypted: false, decrypted: false };
  }

  try {
    const cert = await prisma.userCertificate.findFirst({
      where: { userId: recipientUserId, encryptDefault: true },
    });

    if (!cert) {
      log.debug({ recipientUserId }, 'No encryption cert for decryption');
      return { encrypted: true, decrypted: false, error: 'No decryption certificate available' };
    }

    const p12Password = process.env['SMIME_P12_PASSWORD'] ?? '';
    const { privateKey, certificate } = await loadP12FromMinio(cert.storagePath, p12Password);

    // Extract the base64-encoded CMS body
    const bodyStart = msgStr.indexOf('\r\n\r\n');
    const b64 = bodyStart >= 0
      ? msgStr.slice(bodyStart + 4).replace(/[\r\n]/g, '')
      : msgStr.replace(/[\r\n]/g, '');

    const envelopedDer = forge.util.decode64(b64);
    const asn1 = forge.asn1.fromDer(envelopedDer);
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsEnvelopedData;

    p7.decrypt(certificate, privateKey);

    const plaintext = Buffer.from(p7.content?.bytes() ?? '', 'binary');
    log.debug({ recipientUserId, size: plaintext.length }, 'S/MIME message decrypted');

    return { encrypted: true, decrypted: true, plaintext };
  } catch (err) {
    log.warn({ err, recipientUserId }, 'S/MIME decryption failed');
    return {
      encrypted: true,
      decrypted: false,
      error: err instanceof Error ? err.message : 'Decryption failed',
    };
  }
}

function extractHeader(msgStr: string, headerName: string): string | undefined {
  const lines = msgStr.split(/\r?\n/);
  const prefix = headerName.toLowerCase() + ':';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.toLowerCase().startsWith(prefix)) {
      let value = line.slice(prefix.length).trim();
      let j = i + 1;
      while (j < lines.length && (lines[j]!.startsWith(' ') || lines[j]!.startsWith('\t'))) {
        value += ' ' + lines[j]!.trim();
        j++;
      }
      return value;
    }
    if (line === '' || line === '\r') break;
  }
  return undefined;
}
