/**
 * @coremail/auth-ldap — LDAP / Active Directory login and directory sync (v6.1).
 *
 * Web/API login:   registerAuthenticator(ldapAuthenticator())        (@coremail/storage/auth)
 * Mail protocols:  registerExternalPasswordVerifier(verifyLdapMailPassword)  (@coremail/storage)
 *                  → resolves `{ userId }` on success, `false` otherwise
 * Sync:            runLdapSyncLocked(domainId) / startLdapSyncScheduler()
 */
export {
  authenticateLdap, ldapAuthDecision, ldapAuthenticator, verifyLdapMailPassword, LDAP_EXTERNAL_ID_PREFIX,
  type LdapAuthDecision, type LdapAuthReason,
} from './authenticate.js';
export {
  syncLdapUsers, runLdapSyncLocked, startLdapSyncScheduler, dueLdapSyncs, LdapSyncBusyError,
  type LdapSyncResult, type SyncLock,
} from './sync.js';
export { testLdapConnection, type LdapTestResult } from './connection-test.js';
export { escapeLdapFilterValue, buildUserFilter, buildSyncFilter } from './filter.js';
export {
  setLdapClientFactory, toLdapSettings, transportSecurityError,
  type LdapClientLike, type LdapEntry, type LdapSettings, type LdapConfigRow, type LdapSearchOptions,
} from './client.js';
