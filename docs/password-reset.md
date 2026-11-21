# Self-service password reset

Since 10.6. Users who forgot their password request a link on the sign-in page
("Passwort vergessen?") and set a new password with it. Administrators decide whether that is
possible and where the link may go: BCP → **Authentifizierung → Passwort-Zurücksetzung**.

## Why not just the own mailbox

Up to 10.5 the link always went to the account's own mailbox. That has two problems:

- a user who forgot the password usually cannot read that mailbox (webmail and mail clients
  need the password), and
- other people may read it — a delegate or a holder of a folder permission would receive the
  link and could take the account over.

10.6 therefore adds an **external recovery address** and skips the own mailbox automatically
while anybody else can read it.

## Policy (server level)

| Setting (ServerSettings column) | Default | Meaning |
|---|---|---|
| Selbstständige Passwort-Zurücksetzung (`selfServicePasswordReset`) | on | Master switch. Off: the sign-in page hides the link, requests do nothing, links already sent stop working. |
| Wiederherstellungsadresse (`ssprRecoveryEmailEnabled`) | on | The link goes to the account's **confirmed** recovery address. |
| Eigenes Postfach (`ssprOwnMailboxEnabled`) | on | The link is written into the account's INBOX (as before 10.6) — **skipped** while the mailbox has any delegate (`MailboxDelegate`, whatever its permission) or a folder permission with the read right for a user or "Default". |
| Auch Konten mit Administratorrolle zulassen (`ssprAllowAdmins`) | off | Accounts with a role other than `USER` take part only when this is on. |

A reset is **available** when the switch is on and at least one method is on. When both methods
apply, the link goes to both (the own mailbox only while nobody else reads it).

> **Note (10.6 review):** "nobody else reads it" covers delegates and folder permissions only. An
> administrator with backup or restore access to the mailbox (system / mailbox backups, the backup
> archive) can read a reset link delivered to the own mailbox. Where that matters, switch the
> method **Eigenes Postfach** off and use confirmed recovery addresses only.

Not covered by self-service reset (always, whatever the settings):

- accounts from an LDAP directory or an SSO provider (`authSource ≠ LOCAL`) — their
  password belongs to the directory;
- inactive accounts;
- accounts whose only second factors are passkeys or security keys (no TOTP, no backup codes):
  the reset page cannot verify them, so such accounts get no link — refused like every other case
  (same answer, refusal `mfa_unprovable`); the user adds TOTP or backup codes, or an administrator
  issues a passkey recovery link ([passkeys.md](passkeys.md));
- passkey-only accounts (`User.passwordLoginDisabled`, docs/passkeys.md): no link
  (`password_login_disabled`), and a link issued earlier is refused at redemption — recovery is the
  admin passkey recovery link.

There is no per-domain override in 10.6; the policy is server-wide.

The policy is checked twice: when a link is requested and again when it is redeemed (switching
the reset off, excluding admins or moving an account to a directory makes outstanding links
useless).

## Recovery address

Webmail → Einstellungen → Sicherheit → **Wiederherstellungsadresse**:

- The user enters an external address and confirms the change with the current password or an
  MFA code (re-authentication, `verifyReauth`, 10 failures per 15 minutes).
- The address must not be in a domain hosted on this server (checked when entered and again when
  confirmed).
- A confirmation link (24 hours, single use, stored as SHA-256) goes to the new address. Until it
  is opened the address is **pending** and never used; a previously confirmed address stays in
  force.
- Every change (requested, confirmed, removed) sends a notice to the own mailbox and to the
  previously confirmed address — the owner learns of a change made with a stolen session.
  Notices mask the other address (`a***@example.net`).
- At most 5 changes per account and hour (each sends a mail to a foreign address).

Model `RecoveryEmail` (`recovery_emails`, one row per user, additive): `address` + `verifiedAt` =
confirmed address; `pendingAddress` / `pendingTokenHash` / `pendingExpiresAt` = requested change.
Single writer: storage `auth/recovery-email.ts`.

## Flow

1. `POST /auth/forgot-password { email }` answers `200 { ok: true }` **before** any lookup — the
   body and the response time are the same for existing, unknown, excluded or rate-limited
   accounts (no enumeration). The work runs after the answer (api-gateway
   `lib/password-reset.ts`):
   - blocked client IPs (attack protection block list) and IPs locked by the shared lockout are
     ignored silently;
   - rate limit: 3 requests per IP and per address per hour (security event
     `PASSWORD_RESET_RATE_LIMIT`);
   - policy + channels (storage `auth/sspr.ts` `planPasswordReset`); refused known accounts are
     audited as `auth.password-reset.refused` with the reason;
   - a reset token (256 bit, stored as SHA-256, 15 minutes, single use; earlier links stay valid
     until they expire) goes to the confirmed recovery address (SMTP submission) and/or the own
     INBOX (written directly — mail rules or forwarding never pass it on); audit
     `auth.password-reset.request` (channels, whether MFA is required).
2. `POST /auth/reset-password/verify { token }` → `{ valid, mfaRequired, methods }` — the page
   asks for a second factor when `mfaRequired` (`methods`: `totp`, `backup_code`).
3. `POST /auth/reset-password { token, newPassword, mfaCode? }`:
   - password policy first (a policy failure never burns the link or a backup code);
   - accounts with any second factor (TOTP, backup codes, passkeys, security keys — storage
     `getAuthFactors()`) must send a TOTP code or a
     backup code. Missing → `400 MFA_REQUIRED`, wrong → `400 MFA_INVALID` (security event
     `PASSWORD_RESET_MFA_FAILED`, audit `auth.password-reset.mfa-failed`); **the link is not
     consumed**. After 5 wrong codes the link is burnt (`429 MFA_LOCKED`); wrong codes also count
     towards the per-IP MFA failure limit (20 per 15 minutes; above it `429 RATE_LIMITED`, the
     link is kept);
   - the token is claimed atomically; the password is set; other reset links are deleted; all
     sessions, app passwords and MCP tokens are revoked (`password-reset-by-mail`). **MFA is
     never removed.**
   - notice to the own mailbox and to the confirmed recovery address; audit
     `auth.password-reset.complete`.
   - invalid / expired / used links → `400 INVALID_TOKEN` (security event
     `PASSWORD_RESET_INVALID_TOKEN`).
4. `GET /auth/password-reset/available` → `{ enabled }` — the sign-in page shows
   "Passwort vergessen?" only when this is `true`. (`GET /api/v1/admin/settings/public` keeps its
   `selfServicePasswordReset` field with the same meaning.)
5. `POST /auth/recovery-email/confirm { token }` — confirms a recovery address (public: the link
   is opened wherever that mailbox is read); audit `auth.recovery-email.confirm`.

Security keys / passkeys as the second proof on the reset page are not supported in 10.6 (only
TOTP and backup codes); see "Not covered" above.

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /auth/forgot-password` | public | request a link (always `{ ok: true }`) |
| `GET /auth/password-reset/available` | public | `{ enabled }` |
| `POST /auth/reset-password/verify` | public (token) | `{ valid, mfaRequired, methods }` |
| `POST /auth/reset-password` | public (token) | set the password |
| `POST /auth/recovery-email/confirm` | public (token) | confirm a recovery address |
| `GET /api/v1/user/recovery-email` | session | state + what the policy means for the account |
| `PUT /api/v1/user/recovery-email` | session + re-auth | `{ address, currentPassword \| mfaCode }` → `202` |
| `DELETE /api/v1/user/recovery-email` | session + re-auth | remove (also a pending change) |
| `GET/PUT /api/v1/admin/settings/password-reset` | admin, area organisation | policy + counts (docs/rbac.md) |

The admin answer: `{ enabled, recoveryEmail, ownMailbox, allowAdmins, available, stats: {
usersWithRecoveryEmail, localUsers, adminAccounts } }`; `PUT` takes any subset of the four
booleans.

## Audit and events

Always logged (`ALWAYS_AUDIT`): `auth.password-reset.request|refused|mfa-failed|complete`,
`auth.recovery-email.request|confirm|remove`, `settings.password-reset.update` (from/to diff).
Recovery addresses appear masked in audit rows.

Security events (attack dashboard, protocol `web`): `PASSWORD_RESET_RATE_LIMIT`,
`PASSWORD_RESET_INVALID_TOKEN`, `PASSWORD_RESET_MFA_FAILED`, `RECOVERY_EMAIL_INVALID_TOKEN`.

## Upgrade notes (10.6)

- Additive schema: table `recovery_emails`, ServerSettings columns `ssprRecoveryEmailEnabled`,
  `ssprOwnMailboxEnabled` (both default on — the previous behaviour) and `ssprAllowAdmins`
  (default **off**).
- **Behaviour change:** accounts with an administrator role no longer get reset links unless
  "Auch Konten mit Administratorrolle zulassen" is switched on. Mailboxes with delegates or
  folder read grants no longer receive their own reset link; those users need a recovery
  address. Accounts with MFA must enter a code on the reset page.
- The switch moved from BCP → Globale Einstellungen → Sicherheit to the new page; the
  `selfServicePasswordReset` field of `PUT /api/v1/admin/settings/security` keeps working.

## Code

- storage `auth/sspr.ts` (policy, factors, own-mailbox check, `planPasswordReset`),
  `auth/recovery-email.ts`, `auth/password-reset.ts` (tokens, second proof)
- api-gateway `lib/password-reset.ts` (request work, mails, notices), `routes/auth.ts`,
  `routes/recovery-email.ts`, `routes/admin/global-settings.ts`
- webmail `pages/ForgotPasswordPage.tsx`, `pages/ResetPasswordPage.tsx`,
  `pages/RecoveryEmailConfirmPage.tsx`, `components/settings/RecoveryEmailPanel.tsx`
- BCP `pages/SsprPage.tsx`
- tests: storage `auth/sspr.test.ts`, api-gateway `routes/password-reset.test.ts`
