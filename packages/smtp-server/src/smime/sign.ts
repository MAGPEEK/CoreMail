/**
 * S/MIME Inline Signing
 *
 * Signs a raw email message using CMS SignedData (RFC 5652).
 * The result is a `multipart/signed` MIME message (detached signature)
 * which is compatible with Outlook, Apple Mail, Thunderbird.
 *
 * RFC 3851 / RFC 8551 (S/MIME 4.0)
 */

import forge from 'node-forge';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { loadP12FromMinio } from './loader.js';

const log = createLogger('smime:sign');

/**
 * Sign a raw RFC 2822 message for a given sender userId.
 * Returns the signed message bytes, or the original if no signing cert is available.
 */
export async function signMessageForUser(
  rawMessage: Buffer,
  userId: string,
): Promise<Buffer> {
  try {
    const cert = await prisma.userCertificate.findFirst({
      where: { userId, signingDefault: true },
    });

    if (!cert) {
      log.debug({ userId }, 'No default signing certificate — skipping S/MIME sign');
      return rawMessage;
    }

    const p12Password = process.env['SMIME_P12_PASSWORD'] ?? '';
    const { privateKey, certificate, chain } = await loadP12FromMinio(
      cert.storagePath,
      p12Password,
    );

    return signRaw(rawMessage, privateKey, certificate, chain);
  } catch (err) {
    log.warn({ err, userId }, 'S/MIME signing failed — sending unsigned');
    return rawMessage;
  }
}

/**
 * Core signing logic — creates multipart/signed with detached CMS signature.
 */
export function signRaw(
  rawMessage: Buffer,
  privateKey: forge.pki.rsa.PrivateKey,
  certificate: forge.pki.Certificate,
  chain: forge.pki.Certificate[] = [],
): Buffer {
  // Separate headers from body
  const msgStr = rawMessage.toString('binary');
  const headerEnd = msgStr.indexOf('\r\n\r\n');
  const originalHeaders = headerEnd >= 0 ? msgStr.slice(0, headerEnd) : '';
  const body = headerEnd >= 0 ? msgStr.slice(headerEnd + 4) : msgStr;

  // Canonicalize MIME body (CRLF, no trailing whitespace)
  const canonBody = canonicalize(body);

  // Build CMS SignedData using node-forge
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(canonBody, 'binary');

  p7.addCertificate(certificate);
  for (const c of chain) {
    p7.addCertificate(c);
  }

  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.signingTime, value: new Date() },
      { type: forge.pki.oids.messageDigest },
    ],
  });

  p7.sign({ detached: true });

  // DER-encode the signature
  const sigDer = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const sigBase64 = forge.util.encode64(sigDer, 76);

  // Build the multipart/signed message
  const boundary = `smime-boundary-${Date.now()}`;
  const lines: string[] = [];

  // Keep original headers but replace Content-Type
  const filteredHeaders = originalHeaders
    .split('\r\n')
    .filter((h) => !h.toLowerCase().startsWith('content-type:'))
    .join('\r\n');

  lines.push(filteredHeaders);
  lines.push(
    `Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${boundary}"`,
  );
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push(canonBody);
  lines.push(`--${boundary}`);
  lines.push('Content-Type: application/pkcs7-signature; name="smime.p7s"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('Content-Disposition: attachment; filename="smime.p7s"');
  lines.push('');
  lines.push(sigBase64);
  lines.push(`--${boundary}--`);

  const signedMsg = lines.join('\r\n');
  log.debug({ boundary }, 'Message signed with S/MIME (detached)');
  return Buffer.from(signedMsg, 'binary');
}

/**
 * RFC 2822 canonical CRLF line endings with no trailing whitespace per line.
 */
function canonicalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\r\n');
}
