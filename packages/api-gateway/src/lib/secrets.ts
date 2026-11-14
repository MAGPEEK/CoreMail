/**
 * Secret stripping for admin API responses (v6).
 *
 * Secrets are WRITE-ONLY: they are never returned; responses carry a boolean
 * `has<Field>` instead. On update an omitted or empty secret keeps the stored
 * value (see mergeWriteOnlySecret).
 */

/** ServerSettings columns that must never leave the server. */
export const SERVER_SETTINGS_SECRETS = ['tlsKey', 'setupTokenHash'] as const;

/** LdapConfig columns that must never leave the server. */
export const LDAP_SECRETS = ['bindPassword'] as const;

/** User columns that must never leave the server. */
export const USER_SECRETS = ['passwordHash'] as const;

function omit<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

export function publicServerSettings<T extends object>(s: T): Record<string, unknown> {
  const raw = s as Record<string, unknown>;
  return { ...omit(s, SERVER_SETTINGS_SECRETS), hasTlsKey: typeof raw['tlsKey'] === 'string' && raw['tlsKey'] !== '' };
}

export function publicLdapConfig<T extends object>(c: T): Record<string, unknown> {
  const raw = c as Record<string, unknown>;
  return { ...omit(c, LDAP_SECRETS), hasBindPassword: typeof raw['bindPassword'] === 'string' && raw['bindPassword'] !== '' };
}

export function publicUser<T extends object>(u: T): Record<string, unknown> {
  return omit(u, USER_SECRETS);
}

/**
 * Write-only semantics: `incoming` undefined / '' → keep `stored` (if any).
 * Returns the value to persist, or undefined when neither exists.
 */
export function mergeWriteOnlySecret(incoming: string | undefined | null, stored: string | undefined | null): string | undefined {
  if (typeof incoming === 'string' && incoming !== '') return incoming;
  return stored ?? undefined;
}
