/**
 * The pre-v6 auth-service LDAP fallback, routed through the login-service
 * extension point: dynamically imports `@coremail/auth-ldap` and calls
 * `authenticateLdap(email, password)`. If the module is not resolvable or LDAP
 * is not configured, the step simply does not authenticate (same behaviour as
 * before). The LDAP/OIDC integration work replaces this with a proper step.
 */
import type { ExternalAuthenticator } from './login-service.js';

interface LdapModule {
  authenticateLdap(email: string, password: string): Promise<{ userId: string } | null>;
}

export function legacyLdapAuthenticator(): ExternalAuthenticator {
  return {
    name: 'ldap',
    async authenticate(email, password) {
      const specifier = '@coremail/auth-ldap';
      let mod: LdapModule;
      try {
        mod = (await import(specifier)) as LdapModule;
      } catch {
        return null; // auth-ldap not available
      }
      const r = await mod.authenticateLdap(email, password);
      return r ? { userId: r.userId } : null;
    },
  };
}
