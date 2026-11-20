/**
 * BCP dashboard card "Zertifikat einrichten" (10.4.2, replaces the setup
 * wizard's certificate step and its "later" hint): shown while no trusted
 * certificate covers the public host name, until an admin dismisses it
 * ("Später", ServerSettings.setupCertificateHintDismissedAt), and only to
 * roles that may manage certificates (area servers, write).
 */
import { isDefaultHostname } from './cert-lifecycle.js';

export interface CertificateCardInput {
  /** ServerSettings.publicHostname. */
  publicHostname: string | null | undefined;
  /** The certificate the HTTPS server serves for that name is trusted (lib/served-https-cert.ts). */
  servedTrusted: boolean;
  dismissedAt: Date | null | undefined;
  /** The viewer may manage certificates (area servers, write). */
  canManageCertificates: boolean;
}

/** A host name a public CA can issue for: not a schema default / loopback name, at least one dot. */
export function isIssuableHostname(hostname: string | null | undefined): boolean {
  const h = (hostname ?? '').trim().toLowerCase();
  return !!h && h.includes('.') && !isDefaultHostname(h) && !h.endsWith('.localhost') && !h.endsWith('.local');
}

export function certificateCardVisible(i: CertificateCardInput): boolean {
  return i.canManageCertificates && !i.dismissedAt && !i.servedTrusted && isIssuableHostname(i.publicHostname);
}
