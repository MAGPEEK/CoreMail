/**
 * S/MIME Encryption
 *
 * Encrypts a raw email message using CMS EnvelopedData (RFC 5652).
 * The result is application/pkcs7-mime; smime-type=enveloped-data.
 *
 * RFC 3851 / RFC 8551 (S/MIME 4.0)
 * Algorithm: AES-256-CBC (recipient key wrapped with RSA-OAEP)
 */

import forge from 'node-forge';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { getMinioClient } from '@coremail/storage/minio';

const log = createLogger('smime:encrypt');
const MINIO_BUCKET = process.env['MINIO_BUCKET'] ?? 'mail-attachments';

/**
 * Encrypt an outgoing message for a recipient by their email address.
 * Looks up the recipient's encryption certificate from UserCertificate table.
 * Returns original message if no cert is found (encryption is opportunistic).
 */
export async function encryptMessageForRecipient(
  rawMessage: Buffer,
  recipientEmail: string,
): Promise<Buffer> {
  try {
    const recipientUser = await prisma.user.findUnique({ where: { email: recipientEmail } });
    if (!recipientUser) {
      log.debug({ recipientEmail }, 'Recipient not found locally — cannot encrypt');
      return rawMessage;
    }

    const cert = await prisma.userCertificate.findFirst({
      where: { userId: recipientUser.id, encryptDefault: true },
    });

    if (!cert) {
      log.debug({ recipientEmail }, 'No encryption cert for recipient — skipping');
      return rawMessage;
    }

    // Load the public certificate PEM from MinIO (stored alongside P12)
    const pemPath = cert.storagePath.replace(/\.p12$/, '.pem');
    let recipientCert: forge.pki.Certificate;
    try {
      const minio = getMinioClient();
      const stream = await minio.getObject(MINIO_BUCKET, pemPath);
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      recipientCert = forge.pki.certificateFromPem(Buffer.concat(chunks).toString('utf8'));
    } catch {
      log.debug({ pemPath }, 'No PEM file found — cannot encrypt');
      return rawMessage;
    }

    return encryptRaw(rawMessage, recipientCert);
  } catch (err) {
    log.warn({ err, recipientEmail }, 'S/MIME encryption failed — sending unencrypted');
    return rawMessage;
  }
}

/**
 * Core encryption: wraps the entire message in CMS EnvelopedData.
 */
export function encryptRaw(
  rawMessage: Buffer,
  recipientCert: forge.pki.Certificate,
): Buffer {
  // Build PKCS#7 EnvelopedData
  const p7 = forge.pkcs7.createEnvelopedData();
  p7.content = forge.util.createBuffer(rawMessage.toString('binary'), 'binary');

  p7.addRecipient(recipientCert);
  p7.encrypt();

  const envelopedDer = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const envelopedBase64 = forge.util.encode64(envelopedDer, 76);

  // Extract headers from original message
  const msgStr = rawMessage.toString('binary');
  const headerEnd = msgStr.indexOf('\r\n\r\n');
  const originalHeaders = headerEnd >= 0 ? msgStr.slice(0, headerEnd) : '';

  // Keep transport headers, replace content headers
  const transportHeaders = originalHeaders
    .split('\r\n')
    .filter((h) => {
      const lower = h.toLowerCase();
      return (
        lower.startsWith('from:') ||
        lower.startsWith('to:') ||
        lower.startsWith('cc:') ||
        lower.startsWith('date:') ||
        lower.startsWith('message-id:') ||
        lower.startsWith('subject:') ||
        lower.startsWith('mime-version:')
      );
    })
    .join('\r\n');

  const lines: string[] = [];
  lines.push(transportHeaders);
  lines.push('Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('Content-Disposition: attachment; filename="smime.p7m"');
  lines.push('');
  lines.push(envelopedBase64);

  log.debug({ recipient: (recipientCert.subject.getField('emailAddress') as { value: string } | null)?.value }, 'Message encrypted with S/MIME');
  return Buffer.from(lines.join('\r\n'), 'binary');
}
