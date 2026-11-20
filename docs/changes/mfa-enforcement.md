# MFA enforcement (target 10.5.0)

Changelog fragment for the `[10.5.0]` section (Keep a Changelog).

### Added

- **"MFA für alle Benutzer erzwingen"** (BCP → Einstellungen → Sicherheit, default off):
  accounts without a second factor get a grace period (`mfaEnforcementGraceDays`, default 7,
  0–90, counted per user from the first check after activation — `User.mfaGraceStartedAt`;
  switching the enforcement on again starts new grace periods). During the grace period the
  webmail shows a banner; afterwards a web/API session may only enrol: every API call answers
  `403 MFA_ENROLMENT_REQUIRED` except `GET /api/v1/user/mfa-enforcement` and
  `GET /api/v1/user/profile`; `/auth/mfa/*`, `/auth/sessions`, `/auth/logout` and revoking app
  passwords stay reachable. The webmail shows the mandatory page `/mfa-enrolment` (TOTP /
  security key setup, sign-out), the BCP its MFA page. Docs: docs/user-settings.md.
- Sub-option **"Hauptpasswort in Mailprogrammen nach der Frist sperren"**
  (`mfaEnforcementBlocksPrimaryPassword`, default off): after the grace period the primary
  password of an account without MFA is refused on mail protocols
  (`mfa_app_password_required`); app passwords keep working.
- `GET /api/v1/user/mfa-enforcement` → `{ state, deadline?, canEnrol }`.
- Audit action `settings.mfa-policy.update` (from/to diff of `requireMfaForAdmins`,
  `requireMfaForAllUsers`, `mfaEnforcementGraceDays`, `mfaEnforcementBlocksPrimaryPassword`;
  always written, `ALWAYS_AUDIT`).
- Schema (additive): `ServerSettings.requireMfaForAllUsers`, `mfaEnforcementGraceDays`,
  `mfaEnforcementSince`, `mfaEnforcementBlocksPrimaryPassword`; `User.mfaGraceStartedAt`.

### Changed

- **Fresh installations start with `requireMfaForAdmins` on**: `POST /api/v1/setup/complete`
  sets it. After the wizard the first admin enrols TOTP or a security key in the webmail
  (Einstellungen → Sicherheit); until then the BCP shows its MFA page, then asks for a sign-in
  with the second factor. The wizard explains this in the admin step and on the summary.
- The setup wizard's `GET /api/v1/setup/secrets-download` and `POST /api/v1/setup/finish` use
  `requireRoleInSetupWindow()` — `requireRole()` without the admin-MFA rule (only inside the setup
  window), so the wizard's password-only session still reaches them.
- BCP MFA page: links to the webmail's security settings and says the webmail stays usable for the
  enrolment; it also handles `MFA_ENROLMENT_REQUIRED`.
- SSO/OIDC: the existing trust rules decide — an MFA-verified SSO session (IdP `amr`; for admins
  under `requireMfaForAdmins` only with `OIDC_TRUST_IDP_MFA_FOR_ADMINS=true`) satisfies the
  enforcement. SSO-only accounts cannot confirm a CoreMail enrolment; the enrolment page tells them
  to sign in through the provider with MFA.

### Security

- Enforcement checks fail closed (`503` when the state cannot be read). JMAP and CalDAV/CardDAV
  refuse Bearer tokens of accounts that must enrol first.
- Listing and creating app passwords is refused while enrolment is required, so the grace period
  cannot be bypassed by minting a new long-lived credential.

### Upgrade note

Existing installations keep their stored `requireMfaForAdmins` value (schema default `false` —
no silent lock-out) and get `requireMfaForAllUsers = false`. Nothing changes until an
administrator switches the new options on. Before turning on "MFA für alle Benutzer erzwingen",
announce it: users who only use mail programs never see the webmail banner, and with the
primary-password sub-option on they need an app password (after enrolling MFA) once their grace
period is over.
