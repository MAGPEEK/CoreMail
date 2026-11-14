/**
 * Mailbox provisioning — moved to @coremail/storage in v6.1 so that the LDAP and
 * OIDC login paths can call it. Re-exported here for existing imports.
 */
export {
  DEFAULT_FOLDERS,
  ensureMailboxProvisioned,
  ensureSharedMailboxProvisioned,
  type ProvisionResult,
} from '@coremail/storage';
