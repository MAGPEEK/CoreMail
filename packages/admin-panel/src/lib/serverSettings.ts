/**
 * BCP → Server (9.1.x review): pure helpers of the ServersPage.
 */

/** URL fields the "derive" button may change — nothing else of the form. */
export const DERIVED_URL_KEYS = ['owaUrl', 'easUrl', 'autodiscoverBase'] as const;
export type DerivedUrlKey = typeof DERIVED_URL_KEYS[number];

/**
 * Merges the answer of POST /admin/servers/settings/derive into the form.
 * The endpoint also returns suggestions (orgName 'CoreMail', IMAP/POP3/SMTP
 * ports) — taking the whole object overwrote the stored organisation name and
 * ports on the next save. Only the URL fields are taken over.
 */
export function mergeDerivedUrls<T extends Record<DerivedUrlKey, string>>(form: T, derived: Partial<Record<string, unknown>>): T {
  const next = { ...form };
  for (const k of DERIVED_URL_KEYS) {
    const v = derived[k];
    if (typeof v === 'string' && v) next[k] = v as T[typeof k];
  }
  return next;
}

/** Origin of the public web URL (for the JMAP discovery hint): "https://mail.example.com". */
export function publicOrigin(hostname: string, useHttps: boolean, httpPort: number): string {
  const std = (useHttps && httpPort === 443) || (!useHttps && httpPort === 80);
  return `${useHttps ? 'https' : 'http'}://${hostname}${std ? '' : `:${httpPort}`}`;
}
