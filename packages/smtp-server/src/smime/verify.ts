/**
 * S/MIME Signature Verification
 *
 * Verifies incoming S/MIME signed messages (RFC 8551).
 * Supports both:
 *   - multipart/signed  (detached signature)
 *   - application/pkcs7-mime; smime-type=signed-data  (opaque signed)
 *
 * The verification result is stored as a JSON header `X-Smime-Verify`
 * on the stored message for the OWA frontend to display.
 */

import forge from 'node-forge';
import { createLogger } from '@coremail/core';

const log = createLogger('smime:verify');

// node-forge's PkcsSignedData type is incomplete — augment locally
type P7Signed = forge.pkcs7.PkcsSignedData & {
  verify(): void;
  signers: Array<{ serialNumber: string }>;
  certificates: forge.pki.Certificate[];
};

export interface SmimeVerifyResult {
  signed: boolean;
  valid: boolean;
  signerEmail?: string;
  signerName?: string;
  notBefore?: string;
  notAfter?: string;
  error?: string;
}

/**
 * Attempt to verify S/MIME signature in a raw message buffer.
 * Returns a result object — never throws (errors are captured in result.error).
 */
export async function verifyIncomingSmime(rawMessage: Buffer): Promise<SmimeVerifyResult> {
  const msgStr = rawMessage.toString('utf8');
  const contentTypeLine = extractHeader(msgStr, 'content-type');

  if (!contentTypeLine) {
    return { signed: false, valid: false };
  }

  const lower = contentTypeLine.toLowerCase();
  const isMultipartSigned = lower.includes('multipart/signed') &&
    lower.includes('application/pkcs7-signature');
  const isOpaqueSigned = lower.includes('application/pkcs7-mime') &&
    lower.includes('signed-data');

  if (!isMultipartSigned && !isOpaqueSigned) {
    return { signed: false, valid: false };
  }

  try {
    if (isMultipartSigned) {
      return verifyDetachedSignature(msgStr);
    } else {
      return verifyOpaqueSignature(msgStr);
    }
  } catch (err) {
    log.warn({ err }, 'S/MIME verification error');
    return {
      signed: true,
      valid: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

function verifyDetachedSignature(msgStr: string): SmimeVerifyResult {
  // Extract boundary
  const boundaryMatch = msgStr.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) {
    return { signed: true, valid: false, error: 'No boundary parameter found' };
  }
  const boundary = boundaryMatch[1]!.trim();

  // Split into parts
  const parts = msgStr.split(`--${boundary}`).slice(1); // skip preamble
  if (parts.length < 2) {
    return { signed: true, valid: false, error: 'Expected at least 2 MIME parts' };
  }

  const bodyPart = parts[0]!;
  const sigPart = parts[1]!;

  // Extract base64 signature from sig part
  const sigHeaderEnd = sigPart.indexOf('\r\n\r\n');
  const sigBody = sigHeaderEnd >= 0 ? sigPart.slice(sigHeaderEnd + 4) : sigPart;
  const sigBase64 = sigBody.replace(/[\r\n]/g, '').replace(/--$/, '').trim();

  if (!sigBase64) {
    return { signed: true, valid: false, error: 'Empty signature part' };
  }

  const sigDer = forge.util.decode64(sigBase64);
  const asn1 = forge.asn1.fromDer(sigDer);
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as unknown as P7Signed;

  // Set content for verification
  const bodyHeaderEnd = bodyPart.indexOf('\r\n\r\n');
  const bodyContent = bodyHeaderEnd >= 0 ? bodyPart.slice(bodyHeaderEnd + 4) : bodyPart;
  p7.content = forge.util.createBuffer(
    bodyContent.replace(/\r?\n--$/, '').trimEnd() + '\r\n',
    'utf8',
  );

  p7.verify();

  return buildResultFromP7(p7);
}

function verifyOpaqueSignature(msgStr: string): SmimeVerifyResult {
  // Extract base64 body
  const bodyStart = msgStr.indexOf('\r\n\r\n');
  const b64 = bodyStart >= 0
    ? msgStr.slice(bodyStart + 4).replace(/[\r\n]/g, '')
    : msgStr.replace(/[\r\n]/g, '');

  const der = forge.util.decode64(b64);
  const asn1 = forge.asn1.fromDer(der);
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as unknown as P7Signed;
  p7.verify();
  return buildResultFromP7(p7);
}

function buildResultFromP7(p7: P7Signed): SmimeVerifyResult {
  const signer = p7.signers?.[0];
  const certs: forge.pki.Certificate[] = p7.certificates ?? [];
  const signerCert = certs.find((c) => c.serialNumber === signer?.serialNumber) ?? certs[0];

  const signerEmail = signerCert ? getEmailFromCert(signerCert) : undefined;
  const signerName  = signerCert ? getNameFromCert(signerCert)  : undefined;

  return {
    signed: true,
    valid: true,
    // exactOptionalPropertyTypes: only spread when value is defined
    ...(signerEmail !== undefined ? { signerEmail } : {}),
    ...(signerName  !== undefined ? { signerName  } : {}),
    ...(signerCert
      ? {
          notBefore: signerCert.validity.notBefore.toISOString(),
          notAfter:  signerCert.validity.notAfter.toISOString(),
        }
      : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractHeader(msgStr: string, headerName: string): string | undefined {
  const lines = msgStr.split(/\r?\n/);
  const prefix = headerName.toLowerCase() + ':';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.toLowerCase().startsWith(prefix)) {
      // Collect folded header lines
      let value = line.slice(prefix.length).trim();
      let j = i + 1;
      while (j < lines.length && (lines[j]!.startsWith(' ') || lines[j]!.startsWith('\t'))) {
        value += ' ' + lines[j]!.trim();
        j++;
      }
      return value;
    }
    // Empty line = end of headers
    if (line === '' || line === '\r') break;
  }
  return undefined;
}

function getEmailFromCert(cert: forge.pki.Certificate): string | undefined {
  // Try Subject Alternative Name first
  const sanExt = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; value: string }> } | null;
  if (sanExt?.altNames) {
    const emailSan = sanExt.altNames.find((n) => n.type === 1);
    if (emailSan) return emailSan.value;
  }
  // Fallback: emailAddress in Subject
  const emailAttr = cert.subject.getField('emailAddress');
  return emailAttr?.value as string | undefined;
}

function getNameFromCert(cert: forge.pki.Certificate): string | undefined {
  const cn = cert.subject.getField('CN');
  return cn?.value as string | undefined;
}
