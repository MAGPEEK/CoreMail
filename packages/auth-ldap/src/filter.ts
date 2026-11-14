/**
 * LDAP search-filter helpers (RFC 4515).
 *
 * User input is ESCAPED, never stripped: `*`, `(`, `)`, `\` and NUL become
 * `\2a`, `\28`, `\29`, `\5c`, `\00`. Stripping (the pre-v6.1 behaviour) turned
 * e.g. `a*b` into `ab`, i.e. a different but still valid login name.
 */

export function escapeLdapFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\5c'; break;
      case '*': out += '\\2a'; break;
      case '(': out += '\\28'; break;
      case ')': out += '\\29'; break;
      case '\0': out += '\\00'; break;
      default: out += ch;
    }
  }
  return out;
}

/**
 * Fills the configured user filter. Placeholders (all escaped):
 *   {{username}} — local part of the login e-mail (e.g. sAMAccountName, uid)
 *   {{email}}    — the full login e-mail (e.g. `(mail={{email}})`, userPrincipalName)
 *   {{domain}}   — the domain part
 */
export function buildUserFilter(template: string, email: string): string {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at + 1) : '';
  const filled = template
    .replace(/\{\{username\}\}/g, escapeLdapFilterValue(local))
    .replace(/\{\{email\}\}/g, escapeLdapFilterValue(email))
    .replace(/\{\{domain\}\}/g, escapeLdapFilterValue(domain));
  return filled.startsWith('(') ? filled : `(${filled})`;
}

/** Filter for the directory sync: persons with a mail attribute, optionally restricted by `groupFilter`. */
export function buildSyncFilter(mailAttribute: string, groupFilter?: string | null): string {
  const attr = mailAttribute.replace(/[^A-Za-z0-9;.-]/g, '');
  const base = `(objectClass=person)(${attr}=*)`;
  const extra = groupFilter?.trim();
  if (!extra) return `(&${base})`;
  return `(&${base}${extra.startsWith('(') ? extra : `(${extra})`})`;
}
