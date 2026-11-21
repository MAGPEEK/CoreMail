# Passkeys — changelog entry (target 10.6.0, MINOR)

Keep-a-Changelog fragment for `CHANGELOG.md` `[Unreleased]` / `[10.6.0]`; the release lead merges
it. Details: [docs/passkeys.md](../passkeys.md).

### Added
- **Passkeys** (WebAuthn Level 3): usernameless sign-in with user verification in the webmail
  and the BCP — passkeys in the e-mail autofill (conditional mediation) and a "Mit Passkey
  anmelden" button (this device, a security key or another device by QR code). A passkey sign-in
  is multi-factor: the session is MFA-verified (`Session.authMethod = "passkey"`) and satisfies the
  admin MFA rule, "MFA für alle Benutzer erzwingen" and the MCP-token rule.
- Webmail → Einstellungen → Sicherheit → **Passkeys**: list (synced / device-bound, provider,
  added, last used), add with re-authentication by password or an existing passkey, rename,
  remove; hint to add a second passkey and that mail programs need app passwords; also on the
  mandatory MFA enrolment page. Texts DE/EN/ES/IT.
- BCP → **Authentifizierung → Passkeys** (new sidebar group): server switch (default off),
  sign-in without a password, read-only RP ID / origins, HTTPS readiness, warning after a
  host-name change, related origins (`/.well-known/webauthn`, Related Origin Requests), adoption
  numbers. Domain and mailbox switches (inherit | on | off).
- Mailbox dialog → **Passkeys**: list and remove passkeys, reset every factor, one-time
  **recovery link** (24 h, shown once, token in the URL fragment; redeeming it registers a new
  passkey and signs every session out), **passkey-only** accounts (`passwordLoginDisabled`:
  the password is refused only after it was verified, no password reset by mail; precondition two
  passkeys or one synced passkey plus backup codes; the last Organization Management account needs
  two).
- Re-authentication with a passkey (`webauthnFlowId` + `webauthnResponse`) wherever the password
  or an MFA code is accepted; `/auth/mfa/status` reports `passkeyCount` / `securityKeyCount`;
  `/auth/passkeys/signal` feeds the WebAuthn Signal API.
- API: `/auth/passkey/login/options|verify`, `/auth/passkey/recovery/options|verify`,
  `/auth/passkey/status` (public, 20 requests/min per IP), `/auth/passkeys/*` (signed in),
  `/api/v1/admin/authentication/passkeys[/domains/:id]`,
  `/api/v1/admin/mailboxes/:id/passkeys[/:pid]`, `…/mfa-reset`, `…/passkey-recovery`,
  `…/passkey-policy` (RBAC decisions in docs/rbac.md).
- Schema (additive): `WebAuthnCredential`, `PasskeyRecoveryToken`, `PasskeyPolicy`,
  `User.webauthnUserId`, `User.passwordLoginDisabled`, `Session.authMethod`,
  `ServerSettings.passkeysEnabled / passkeyPasswordlessEnabled / passkeyRpId /
  passkeyRelatedOrigins`. One-time startup backfill of the pre-10.6 security keys.
- Dependency: `@simplewebauthn/server` **14.1.0** (pinned exactly; Node ≥ 22), in the new subpath
  `@coremail/storage/auth/webauthn` — the mail services never load it. `@simplewebauthn/types`
  dropped.
- e2e step `passkeys` (API level, software authenticator).

### Changed
- One central factor helper (`getAuthFactors()` / `authFactorsOf()`) decides "has MFA" for the
  web login, the admin MFA rule, MFA enforcement, the mail protocols (`hasMfa`), client-config
  and the Apple profile; passkeys and security keys count as an enrolled factor everywhere (an
  account with a passkey needs app passwords on the mail protocols).
- An **account lock** (password guessing) does not block a passkey sign-in; an **IP lock** and
  the BCP **block list** do. Failed passkey assertions count against the client IP.
- The RP ID is frozen at the first passkey registration; allowed origins come only from the
  configuration (`WEBAUTHN_ORIGIN` now takes a comma-separated list).

### Fixed
- **G1** — a security key as second factor no longer requires user verification (options said
  `preferred`, verification required it: keys without PIN failed).
- **G3** — credential ids are unique across all users and at most 1023 bytes (WebAuthn §7.1
  steps 25/26).
- **G6** — the expected origin includes the external HTTPS port (setups on 8443 failed).
- **G7** — every WebAuthn challenge is single use (Redis GETDEL under `auth:passkey:chal:*`); a
  failed second-factor attempt no longer leaves the challenge reusable.

### Deprecated
- `UserMfa.webAuthnCredentials` (JSON) — copied once into `WebAuthnCredential`, read by nothing
  else; removed with the next MAJOR release.
- `/auth/mfa/webauthn/register/start|finish` — still register a second-factor security key (into
  the new table, `Deprecation: true` header); use `/auth/passkeys/registration/*`. Removed with
  the next MAJOR release.

### Security
- Usernameless sign-in checks the user handle against the stored credential and the account,
  refuses cross-origin responses, enforces BE consistency and fails closed on a signature
  counter regression (audit `passkey.counter_regression`, security notice); flows are bound to
  the HttpOnly `SameSite=Strict` cookie `cm_pk`; every credential change publishes `mfa-change`,
  writes an audit row and a security notice. MCP results redact public keys, user handles and
  recovery links.
