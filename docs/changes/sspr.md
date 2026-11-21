# Self-service password reset: recovery address, MFA step, BCP page (target 10.6.0)

Changelog fragment for the `[10.6.0]` section (Keep a Changelog). MINOR: new settings, a new
model, new endpoints and pages; nothing removed or renamed. One deliberate behaviour change for
security (admins excluded by default, own mailbox skipped while others read it) — see "Upgrade
notes".

### Added

- **Recovery address** (webmail → Einstellungen → Sicherheit → „Wiederherstellungsadresse“): an
  external e-mail address (never a domain hosted on this server) that can receive a reset link.
  Saving needs the current password or an MFA code and sends a confirmation link (24 h, single
  use) to the new address — unconfirmed addresses are never used, the previous address stays in
  force until then. Every change notifies the own mailbox and the previously confirmed address;
  at most 5 changes per hour. Confirmation page `/recovery-email/confirm`. New model
  `RecoveryEmail` (`recovery_emails`, additive).
- **BCP → Authentifizierung → Passwort-Zurücksetzung** (`/password-reset`): master
  switch, methods „Wiederherstellungsadresse“ and „Eigenes Postfach“, „Auch Konten mit
  Administratorrolle zulassen“ (default off), number of accounts with a confirmed recovery
  address. API `GET/PUT /api/v1/admin/settings/password-reset` (area organisation, audited as
  `settings.password-reset.update`).
- **Second proof on the reset page**: accounts with any second factor must enter a TOTP or backup
  code; a wrong code keeps the link usable (burnt after 5 wrong codes). The reset never removes
  MFA. Security-key-only accounts get no link (TOTP / backup codes only in 10.6).
- Public `GET /auth/password-reset/available` (`{ enabled }`) and
  `POST /auth/recovery-email/confirm`; `POST /auth/reset-password/verify` also returns
  `mfaRequired` / `methods`; `POST /auth/reset-password` takes `mfaCode`.
- Notices after a reset to the own mailbox and the recovery address; audit
  `auth.password-reset.*` / `auth.recovery-email.*` (always logged); security events
  `PASSWORD_RESET_RATE_LIMIT`, `PASSWORD_RESET_INVALID_TOKEN`, `PASSWORD_RESET_MFA_FAILED`,
  `RECOVERY_EMAIL_INVALID_TOKEN`. Docs: docs/password-reset.md.

### Changed

- The forgot-password answer is sent before any lookup (identical body and timing for every
  address); blocked or locked client IPs are ignored silently.
- The own-mailbox link is written straight into the INBOX (mail rules and forwarding cannot pass
  it on) and is skipped while the mailbox has a delegate or a folder read grant.
- The sign-in page shows „Passwort vergessen?“ only when a reset is possible (switch on and at
  least one method). The forgot / reset pages are translated (DE/EN/ES/IT).
- BCP → Globale Einstellungen → Sicherheit links to the new page instead of its own switch.

### Upgrade notes

- Additive schema: `recovery_emails`, ServerSettings `ssprRecoveryEmailEnabled` /
  `ssprOwnMailboxEnabled` (default on — previous behaviour) and `ssprAllowAdmins` (default off).
- Accounts with an administrator role no longer get reset links until „Auch Konten mit
  Administratorrolle zulassen“ is on. Users whose mailbox others can read need a recovery
  address. Accounts with MFA enter a code when resetting.
