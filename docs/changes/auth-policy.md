# Authentication policy (target 10.6.0, MINOR)

Changelog fragment for the `[10.6.0]` section (Keep a Changelog). Details: docs/mfa-policy.md.

### Added

- **BCP sidebar group "Authentifizierung"** with the new page **"Mehrstufige Anmeldung (MFA)"**
  (`/bcp/mfa`); *SSO* and *LDAP / Active Dir.* moved into the group from "Infrastruktur" (URLs
  unchanged). Room for a later "Passkeys" entry.
- **MFA policy model**: policy for all users *Pflicht / Optional (Benutzer entscheidet) / Aus*
  (with the existing grace period and the mail-protocol sub-option under *Pflicht*), an admin
  rule *Pflicht / Wie alle Benutzer*, and **per-user exceptions** *Erbt / Pflicht / Optional /
  Aus* (precedence: exception > admin rule > all users). *Aus* = enrolment not offered
  (`403 MFA_NOT_OFFERED` on the enrolment endpoints, a note in the webmail); factors enrolled
  earlier keep working and can be removed. Exceptions: list with search on the new page and one
  field in BCP → Postfächer → Bearbeiten.
- **Admin MFA grace period** (`mfaAdminGraceDays`, 0–14, default 14): admins without a second
  factor keep the admin API until the deadline (`X-CoreMail-Mfa-Grace-Until`), the BCP and the
  webmail show a dismissible prompt ("Jetzt einrichten" / "Später" — hides it for the day, never
  moves the deadline); afterwards `403 MFA_REQUIRED` as before. `GET /api/v1/admin/mfa-status`.
- **"Gerät merken"**: after a successful MFA step "Auf diesem Gerät für N Tage nicht mehr
  fragen" (`rememberDevice` on `POST /auth/mfa/verify`; offered as `rememberDevice: { days }` in
  the login answer). HttpOnly / SameSite=Strict / Secure-on-HTTPS cookie per surface
  (`cm_mfa_dev`, `cm_mfa_dev_bcp`, `Path=/auth`), hashed in the new table `MfaTrustedDevice`.
  Durations off / 30 / 60 / 90 / custom 1–365 days (users default 30, admins separately, default
  off, never longer than users). Password sign-ins of browsers only — never mail protocols, app
  passwords, the admin CLI, MCP tokens or SSO. Revoked on password change / reset, MFA change,
  revoke-all-sessions, role / scope change, deactivation, deletion.
- Webmail Settings → Sicherheit → **Gemerkte Geräte** (`GET/DELETE /api/v1/user/trusted-devices`);
  admins revoke an account's devices in the mailbox panel.
- API: `GET/PUT /api/v1/admin/settings/mfa-policy` (organisation), `GET/PUT /api/v1/admin/user-mfa[/:id]`,
  `DELETE /api/v1/admin/user-mfa/:id/trusted-devices` (recipients, scoped; only Organization
  Management may weaken an admin account's policy — `403 MFA_POLICY_WEAKEN_ADMIN`).
  `GET /api/v1/user/mfa-enforcement` adds `policy`, `enrolmentOffered`, `admin`.
- Audit: `settings.mfa-policy.update`, `mfa.policy.override`, `mfa.trusted-devices.revoke`,
  `user.mfa.trusted-device.revoke`.
- Schema (additive): enums `MfaPolicy`, `AdminMfaPolicy`; `User.mfaPolicy`;
  `ServerSettings.mfaUserPolicy`, `mfaAdminPolicy`, `mfaAdminGraceDays`,
  `mfaAdminEnforcementSince`, `mfaRememberDays`, `mfaRememberDaysAdmins`; table
  `mfa_trusted_devices`.

### Changed

- The MFA switches moved from BCP → Einstellungen → Sicherheit to the new page (the settings
  page links there). `requireMfaForAdmins` / `requireMfaForAllUsers` keep their meaning: they are
  read when the new columns are empty (existing installations unchanged) and every save writes
  both forms; `PUT /api/v1/admin/settings/security` still accepts them.
- **Admin MFA no longer blocks at once** (user decision): with the admin rule on (fresh
  installations included) an admin without MFA has up to 14 days before `403 MFA_REQUIRED`. The
  setup wizard's summary text says so; the e2e `setup` step expects the grace period.
- Admin MCP tokens get no grace period: token use and creation need MFA while the admin rule
  applies (`403 MFA_REQUIRED`).
- SSO: the "admins need CoreMail MFA" rule follows the policy model (admin rule or an admin's own
  "Pflicht" exception).
- The MFA policy is cached 15 s per process (the saving process drops it at once); per-user
  exceptions publish `mfa-policy-change` (new neutral invalidation reason — no session or live
  connection ends).
