/**
 * X.509 certificate serial numbers for every certificate CoreMail signs itself
 * (self-signed defaults, test certificates).
 *
 * The serial is a DER INTEGER and must be positive and minimally encoded:
 * OpenSSL (node:crypto X509Certificate, TLS) refuses a certificate whose
 * serial starts with 0x00 followed by a byte < 0x80, or with 0xFF followed by
 * a byte >= 0x80 ("asn1 encoding routines::illegal padding"). node-forge
 * writes the serial hex as given (it only drops a single leading 0x00), so a
 * random serial with an unconstrained first byte fails now and then.
 *
 * The generated serial has a first byte in 0x01..0x7F: positive, never
 * padded, and exactly `length` bytes long (16..20, at most 20 octets).
 */
import { randomBytes } from 'node:crypto';

export const CERT_SERIAL_MIN_BYTES = 16;
export const CERT_SERIAL_MAX_BYTES = 20;

/** Source of random bytes (injectable for deterministic tests). */
export type RandomBytesSource = (size: number) => Uint8Array;

/**
 * Turns raw random bytes into a serial hex string whose first byte lies in
 * 0x01..0x7F; the remaining bytes are kept unchanged.
 */
export function certSerialHexFromBytes(bytes: Uint8Array): string {
  if (bytes.length < CERT_SERIAL_MIN_BYTES || bytes.length > CERT_SERIAL_MAX_BYTES) {
    throw new RangeError(`certificate serial must be ${CERT_SERIAL_MIN_BYTES}..${CERT_SERIAL_MAX_BYTES} bytes, got ${bytes.length}`);
  }
  const out = Buffer.from(bytes);
  out[0] = 0x01 + (out[0]! % 0x7f);
  return out.toString('hex');
}

/** A random, positive, minimally encoded certificate serial as a hex string. */
export function randomCertSerialHex(length = CERT_SERIAL_MIN_BYTES, random: RandomBytesSource = randomBytes): string {
  return certSerialHexFromBytes(random(length));
}
