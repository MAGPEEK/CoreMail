/**
 * BCP dashboard card "Zertifikat einrichten" (10.4.2, replaces the setup
 * wizard's certificate step and its "later" hint): shown while no trusted
 * certificate covers the public host name, until an admin dismisses it
 * ("Später", ServerSettings.setupCertificateHintDismissedAt), and only to
 * roles that may manage certificates (area servers, write).
 *
 * 10.5 (local domain first): for a local / private host name
 * (lib/local-hostname.ts, e.g. mail.example.local from the setup wizard) the
 * card shows too, but offers no Let's Encrypt order — the BCP card then points
 * to Domains (add the real domain → make it primary → request a certificate).
 * Schema defaults (mail.local, mail.localhost, localhost) still show no card.
 */
import { isDefaultHostname } from './cert-lifecycle.js';
import { isLocalHostname } from './local-hostname.js';

export interface CertificateCardInput {
  /** ServerSettings.publicHostname (as configured). */
  publicHostname: string | null | undefined;
  /** The certificate the HTTPS server serves for that name is trusted (lib/served-https-cert.ts). */
  servedTrusted: boolean;
  dismissedAt: Date | null | undefined;
  /** The viewer may manage certificates (area servers, write). */
  canManageCertificates: boolean;
}

/** A host name a public CA can issue for: not a schema default, not a local / private name or IP address. */
export function isIssuableHostname(hostname: string | null | undefined): boolean {
  const h = (hostname ?? '').trim().toLowerCase();
  return !!h && h.includes('.') && !isDefaultHostname(h) && !isLocalHostname(h);
}

/** A configured local / private host name (the wizard's mail.example.local) — not a schema default. */
export function isLocalSetupHostname(hostname: string | null | undefined): boolean {
  const h = (hostname ?? '').trim().toLowerCase();
  return !!h && !isDefaultHostname(h) && isLocalHostname(h);
}

export function certificateCardVisible(i: CertificateCardInput): boolean {
  if (!i.canManageCertificates || i.dismissedAt || i.servedTrusted) return false;
  return isIssuableHostname(i.publicHostname) || isLocalSetupHostname(i.publicHostname);
}
