/**
 * 9.4: where desktop clients reach MAPI over HTTP, and whether CoreMail may
 * announce it. Shared by Autodiscover (the mapiHttp block, MS-OXDSCLI) and the
 * MAPI server (NSPI GetMailboxUrl / GetAddressBookUrl).
 *
 *  - URLs: the origin of the public webmail URL (BCP → Server) when it is
 *    https, else https://<public host name>; an unconfigured host name
 *    (mail.local, localhost …) gives no URLs.
 *  - Trusted HTTPS: desktop clients only build a MAPI profile against a certificate they
 *    trusts, and MAPI sends Basic credentials, so the block is announced only
 *    while the integrated HTTPS proxy serves a CA-issued certificate (Let's
 *    Encrypt production or an uploaded one; valid or expiring) — or the
 *    operator states that an external TLS terminator presents a trusted one
 *    (MAPI_HTTPS_TRUSTED=true).
 */
import { prisma } from './prisma/index.js';
import { selfSignedHostnameFrom } from './protocol-cert.js';

export interface MapiEndpoints {
  /** Mailbox endpoint (MailStore), e.g. https://mail.example.com/mapi/emsmdb/ */
  mailStore: string;
  /** Address book endpoint (AddressBook), e.g. https://mail.example.com/mapi/nspi/ */
  addressBook: string;
}

const FALLBACK_HOSTNAME = selfSignedHostnameFrom('');

/** Pure: the MAPI endpoint URLs for the public web settings, or null when no public host is configured. */
export function mapiEndpointsFor(s: { owaUrl?: string | null; publicHostname?: string | null }): MapiEndpoints | null {
  let origin: string | null = null;
  try {
    const u = new URL(s.owaUrl ?? '');
    if (u.protocol === 'https:' && selfSignedHostnameFrom(u.hostname) !== FALLBACK_HOSTNAME) origin = u.origin;
  } catch { /* not a URL — fall back to the host name */ }
  if (!origin) {
    const host = selfSignedHostnameFrom(s.publicHostname);
    if (host === FALLBACK_HOSTNAME) return null;
    origin = `https://${host}`;
  }
  return { mailStore: `${origin}/mapi/emsmdb/`, addressBook: `${origin}/mapi/nspi/` };
}

export interface HttpsCertFacts {
  type: string;
  status: string;
  acmeStaging: boolean;
}

/** Pure: a certificate clients trust without a warning (not self-signed, not Let's Encrypt staging, in force). */
export function isTrustedHttpsCertificate(c: HttpsCertFacts): boolean {
  if (c.type === 'SELF_SIGNED') return false;
  if (c.type === 'LETSENCRYPT' && c.acmeStaging) return false;
  return c.status === 'ACTIVE' || c.status === 'EXPIRING';
}

/** Trusted HTTPS for /mapi (see the module comment). A database error propagates (callers answer 503). */
export async function mapiHttpsTrusted(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env['MAPI_HTTPS_TRUSTED'] === 'true') return true;
  const cert = await prisma.certificate.findFirst({
    where: { isActiveHttps: true },
    select: { type: true, status: true, acmeStaging: true },
  });
  return cert ? isTrustedHttpsCertificate(cert) : false;
}
