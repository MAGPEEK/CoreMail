/**
 * 9.3: SMTP, IMAP and POP3 always share one certificate — the BCP shows them as
 * one switch "Mail-Protokolle (SMTP · IMAP · POP3)". The API keeps accepting a
 * services array; the dialogs always send all three or none.
 */

export const MAIL_PROTOCOLS = ['SMTP', 'IMAP', 'POP3'] as const;

export const MAIL_PROTOCOLS_LABEL = 'Mail-Protokolle (SMTP · IMAP · POP3)';

/** True when the services contain any mail protocol (legacy partial sets count as on). */
export function hasMailProtocols(services: readonly string[] | null | undefined): boolean {
  return (services ?? []).some((s) => (MAIL_PROTOCOLS as readonly string[]).includes(s));
}

/** The services array the dialogs send: all three mail protocols or none. */
export function mailServicesFor(on: boolean): string[] {
  return on ? [...MAIL_PROTOCOLS] : [];
}

/**
 * Name of the other certificate that currently holds the mail protocols (it
 * loses them when the switch is saved as on) — the active protocol certificate
 * first; null when none.
 */
export function mailProtocolHolder(
  certs: ReadonlyArray<{ id: string; name: string; services: readonly string[]; isActiveProtocol?: boolean }> | undefined,
  currentCertId?: string,
): string | null {
  const others = (certs ?? []).filter((c) => c.id !== currentCertId && hasMailProtocols(c.services));
  const holder = others.find((c) => c.isActiveProtocol) ?? others[0];
  return holder?.name ?? null;
}
