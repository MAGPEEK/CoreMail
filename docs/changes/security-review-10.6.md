# 10.6 security review fixes (target 10.6.0)

Keep-a-Changelog fragment for `CHANGELOG.md` `[10.6.0]`; the release lead merges it.

### Security
- **Admin MFA grace can no longer be restarted**: an override change never clears the grace start
  of an admin account (a plain USER account gets a fresh grace only when it moves from "not
  required" to "required"); a run-out admin grace is not restarted within 30 days of its end, not
  even when the admin rule is switched off and on. `PUT /api/v1/admin/user-mfa/:id` refuses the
  caller's own account (`403 MFA_POLICY_OWN_ACCOUNT`), needs an MFA-verified acting session
  (`403 MFA_NOT_VERIFIED`) and, for admin accounts, ORGANIZATION_MANAGEMENT (`403 FORBIDDEN_ROLE`,
  also when strengthening).
- **Pre-10.6 security keys fail closed**: until the backfill copied them, keys in the deprecated
  `UserMfa.webAuthnCredentials` JSON count as a second factor everywhere (web login, MFA
  enforcement, mail protocols → app passwords, admin lists). The start-up backfill retries with
  backoff while its lock is busy or a run fails, and a second-factor login migrates on read.
  Unreadable or duplicate legacy keys are no longer dropped: the account stays un-migrated with
  exactly those entries, keeps counting as MFA-enrolled and is alerted (audit
  `passkey.migration_pending`, security event `PASSKEY_MIGRATION_PENDING`) until an admin resets
  its MFA or resolves the duplicate.
- **Account pre-takeover protection**: an account created by self-registration is never linked to
  an OIDC subject (`account_not_linked`) nor taken over by LDAP (login and sync); refused attempts
  are audited (`auth.account-link.refused`) and recorded (`ACCOUNT_LINK_REFUSED`). The first OIDC
  link and every LDAP takeover of a LOCAL account end all its sessions, app passwords, MCP tokens
  and remembered devices. Passkey sign-in follows the account rules of the password sign-in
  (OIDC-only accounts: no passkey sign-in, `PASSKEYS_DISABLED`).
- **Sessions after factor removal**: the admin "remove all passkeys" and "MFA reset" end every
  session of the user; a user removing one of their own passkeys / security keys ends their other
  sessions.
- **Account-recovery actions** (`POST /admin/mailboxes/:id/mfa-reset`, `…/passkey-recovery`):
  ORGANIZATION_MANAGEMENT only, MFA-verified acting session, never the own account
  (`403 OWN_ACCOUNT`); the security notice goes to the user's mailbox and its confirmed recovery
  address.
- Audit: `mfa.*` and `user.mfa.*` actions are always logged (also with the audit log switched off).
- Recovery addresses are normalised (trimmed, lower case, trailing dot stripped, IDN as A-label)
  before the "not hosted here" check and storage; the hosted check matches both IDN spellings.
- Docs: an admin with backup access can read a reset link delivered to the own mailbox
  (docs/password-reset.md).
