/**
 * Follow-up state of the setup wizard (10.4). The wizard's certificate step
 * stores what the admin chose; "later" leaves a hint on the BCP dashboard until
 * a trusted certificate exists or an admin dismisses it.
 */
export const CERTIFICATE_CHOICES = ['letsencrypt', 'proxy', 'later'] as const;
export type CertificateChoice = (typeof CERTIFICATE_CHOICES)[number];

export function isCertificateChoice(v: unknown): v is CertificateChoice {
  return typeof v === 'string' && (CERTIFICATE_CHOICES as readonly string[]).includes(v);
}

/**
 * The dashboard hint: only after "later", only while no trusted certificate
 * exists (an admin may have issued one in BCP → SSL/TLS meanwhile) and only
 * until it was dismissed.
 */
export function certificateHintVisible(
  choice: string | null | undefined,
  dismissedAt: Date | null | undefined,
  hasTrustedCertificate: boolean,
): boolean {
  return choice === 'later' && !dismissedAt && !hasTrustedCertificate;
}
