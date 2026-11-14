/**
 * DKIM key helpers shared by every code path that creates a domain
 * (setup wizard, BCP domain create, EMS New-AcceptedDomain) and by the
 * DKIM record endpoints. Keys are generated at domain creation so outbound
 * mail is signed from the first message on — previously setup/EMS stored an
 * empty key and signing only started once an admin opened the DKIM page.
 */
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

/** Generate a fresh RSA-2048 DKIM private key (PKCS#8 PEM). */
export function generateDkimPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  return privateKey;
}

/** True when the stored key is missing/blank and must be (re)generated. */
export function needsDkimKey(privateKey: string | null | undefined): boolean {
  return !privateKey || privateKey.trim() === '';
}

export interface DkimDnsRecord {
  selector: string;
  dnsName:  string;
  dnsValue: string;
}

/**
 * Build the DKIM TXT record for a private key. RFC 6376 expects the bare
 * PKCS#1 RSAPublicKey in `p=` (v3.17.46), not the SPKI wrapper.
 */
export function dkimDnsRecord(privateKey: string, selector: string, domain: string): DkimDnsRecord {
  const der = createPublicKey(privateKey).export({ type: 'pkcs1', format: 'der' });
  return {
    selector,
    dnsName:  `${selector}._domainkey.${domain}`,
    dnsValue: `v=DKIM1; k=rsa; p=${Buffer.from(der).toString('base64')}`,
  };
}
