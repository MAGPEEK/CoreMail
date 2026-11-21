# Passkeys (10.6)

Passkeys let users sign in without a password — with a fingerprint, face recognition or the
device PIN (user verification). CoreMail implements them with WebAuthn Level 3
(<https://www.w3.org/TR/webauthn-3/>), CTAP 2.2, RFC 8812 / 9052 / 9053 (COSE), RFC 8809 and
RFC 9864 (Ed25519). The same code serves the existing security keys as a second factor after the
password.

Passkeys are **off by default** on fresh and existing installations. Admins switch them on in
BCP → Authentifizierung → Passkeys.

## Concepts

| | Passkey | Security key (second factor) |
|---|---|---|
| Registered through | Settings → Sicherheit → Passkeys (`/auth/passkeys`) | the deprecated `/auth/mfa/webauthn/register/*`, or migrated from before 10.6 |
| `WebAuthnCredential.kind` | `passkey` | `security_key` |
| Discoverable (resident key) | required (`credProps` recorded) | discouraged |
| User verification | required | not required (G1: keys without PIN work) |
| Usernameless sign-in | yes (when allowed) | no — `403 PASSKEY_NOT_ELIGIBLE` |
| Second factor after the password | yes | yes |
| Re-authentication (`verifyReauth`) | yes (UV required) | no (use the password / an MFA code) |

Both kinds are an **enrolled factor** everywhere (`getAuthFactors()`): the admin MFA rule, "MFA
für alle Benutzer erzwingen", the MFA challenge after a password and the mail protocols — an
account with a passkey needs **app passwords** for IMAP, POP3, SMTP, ActiveSync, JMAP,
CalDAV/CardDAV and MAPI. The webmail tells the user so after the first factor.

A usernameless passkey sign-in with user verification is multi-factor (WebAuthn §6.2.3): the
session is `mfaVerified` and has `Session.authMethod = "passkey"`. It satisfies the admin MFA rule,
MFA enforcement and the MCP-token creation rule. It never asks for a second factor and never uses
or issues a "remember this device" token.

Pre-10.6 security keys (`UserMfa.webAuthnCredentials` JSON) are copied once into the table as
`security_key` with `userHandle = null` (startup backfill of the api-gateway, Redis lock,
idempotent; each account once — `UserMfa.webAuthnMigratedAt` — so a key removed later is never
re-imported). They stay second factor only; the webmail marks them and offers "Als Passkey neu
registrieren". A credential id that more than one user had is skipped for **all** of them and
alerted (error log + audit `passkey.migration_duplicate`). The JSON column itself is deprecated
and stays until the next MAJOR release; nothing else reads it (repo-hygiene guard).

## Relying Party

- **RP ID**: `WEBAUTHN_RP_ID`, else `ServerSettings.passkeyRpId`, else the public host name. The RP
  ID is **frozen** at the first registration (`passkeyRpId`), so a later host-name change does not
  silently invalidate every passkey; the BCP page warns when the host name no longer matches.
- **Allowed origins** come from the configuration only, never from the `Host` header:
  `WEBAUTHN_ORIGIN` (comma-separated) or the public base URL — `COREMAIL_PUBLIC_URL`, else scheme,
  public host name and the **external port** (`useHttps` / `httpPort`; 8443 setups work, G6) —
  plus the related origins of the BCP page.
- **Related Origin Requests** (§5.11): `GET /.well-known/webauthn` answers
  `{ "origins": [primary, …related] }` while passkeys are on somewhere and at least one related
  origin is set (else 404).
- **Readiness** (BCP page): browsers allow WebAuthn only in a secure context — HTTPS (plain HTTP
  only on `localhost`) and a DNS name as RP ID (an IP address cannot be one), and the RP ID must be
  the origin's host or a registrable suffix of it.
- Attestation `none`, no metadata service: `fmt` and the AAGUID are stored for display only (a few
  well-known provider names are mapped for the list). Algorithms: EdDSA (-8), ES256 (-7), RS256
  (-257). Library: `@simplewebauthn/server` **14.1.0**, pinned exactly, in the subpath
  `@coremail/storage/auth/webauthn` — the mail services never load it.

## Interaction with the MFA policy, "Gerät merken" and password reset

- The MFA policy (docs/mfa-policy.md) does **not** govern passkeys: MFA "Aus" neither blocks
  passkey registration nor the passkey sign-in — only the passkey policy below does. A passkey is
  an enrolled factor for every MFA rule ("Pflicht", the admin rule — no admin grace prompt).
- A passkey sign-in never checks or issues a remembered-device ("Gerät merken") token
  (storage `auth/trusted-devices.ts` is not involved).
- Self-service password reset (docs/password-reset.md): passkeys count as factors, so the reset
  needs a TOTP code or a backup code; an account with only passkeys / security keys is refused
  uniformly (`mfa_unprovable`); passkey-only accounts never get a reset link.

## Policy

| Level | Where | Values |
|---|---|---|
| Server | `ServerSettings.passkeysEnabled` (BCP page) | on / off (default off) |
| Domain | `PasskeyPolicy.domainId` (`PUT /admin/authentication/passkeys/domains/:id`) | inherit / on / off |
| User | `PasskeyPolicy.userId` (mailbox dialog → Passkeys) | inherit / on / off |

The most specific non-inherit switch wins. `passkeyPasswordlessEnabled` (server, default on)
decides whether passkeys may be used for the usernameless sign-in; off = second factor and
re-authentication only. The switch governs **registering** passkeys, the **usernameless sign-in**
and **recovery links**; existing credentials keep counting as a factor and keep working as a
second factor and for re-authentication — switching passkeys off never locks anybody out of MFA.

OIDC-only accounts get no passkeys (they sign in at their identity provider); LDAP accounts may
register passkeys (the sign-in checks `active` like every login).

Changes publish `CHANNEL_SETTINGS_RELOAD {type:'passkeys'}`; services drop their 15 s caches.

TODO (auth-policy branch): the domain / user passkey switch is a model of its own
(`PasskeyPolicy`); it is meant to be unified with the per-user MFA policy model once that is merged.

## Sign-in

`POST /auth/passkey/login/options` → `{ flowId, publicKey }` (empty `allowCredentials`, UV
required). The flow is bound to the HttpOnly `SameSite=Strict` cookie `cm_pk`
(`Path=/auth/passkey`, 300 s); browser clients must present it with the same flow id.

`POST /auth/passkey/login/verify { flowId?, response }` — the order of the checks:

1. client IP on the block list (`403 IP_BLOCKED`) or IP-locked by the shared lockout
   (`429 IP_LOCKED`, `Retry-After`) — **an account lock does not apply** (it protects passwords);
2. the challenge is read and deleted in one step (GETDEL, single use, 300 s) —
   `401 PASSKEY_CHALLENGE_EXPIRED`;
3. the credential by id — `401 PASSKEY_UNKNOWN`; `kind = passkey` with a user handle, else
   `403 PASSKEY_NOT_ELIGIBLE`;
4. the response's user handle = the stored one = `User.webauthnUserId` (§7.2);
5. signature, configured origins, RP ID, UV required; `clientData.crossOrigin` is refused;
6. BE (backup eligibility) must equal the stored value (§6.1.3; a migrated key adopts it), BS is
   updated; a signature counter that does not grow (unless both are 0 — synced passkeys) fails
   closed with audit `passkey.counter_regression` and a security notice;
7. conditional counter update (a concurrent use of the same counter fails);
8. account active, maintenance mode, the Webmail switch of the requesting surface
   (`PROTOCOL_DISABLED`), the passkey policy (`403 PASSKEYS_DISABLED`);
9. session (`mfaVerified`, `authMethod = passkey`; `cm_rt` / `cm_rt_bcp` like `/auth/login`), the
   account's failure counter is reset.

Every failed verification (not the policy answers) counts against the client IP of the shared
lockout. The gateway limits the public endpoints to 20 requests per minute per IP
(`GET /auth/passkey/status` exempt).

There is no "e-mail first" variant (§14.6.2): the server never tells whether an address has
passkeys.

## User API (`/auth/passkeys`, Bearer)

| Route | |
|---|---|
| `GET /auth/passkeys` | list (`id, name, kind, legacy, backupEligible, synced, discoverable, aaguid, provider, transports, createdAt, lastUsedAt, signCount`) + `allowed`, `passwordless`, `passwordLoginDisabled`, `eligible`, `rpId`, `ready` |
| `POST /auth/passkeys/registration/options` | re-authentication (`currentPassword`, `mfaCode` or a passkey) → `{ flowId, publicKey }` |
| `POST /auth/passkeys/registration/verify` | `{ flowId, response, name }` → `201 { credential }`; `PASSKEY_DUPLICATE` (any user, G3), `PASSKEY_ID_TOO_LONG` (> 1023 bytes) |
| `PATCH /auth/passkeys/:id` | `{ name }` |
| `DELETE /auth/passkeys/:id` | re-authentication; `409 LAST_PASSKEY` for the last passkey of a passkey-only account |
| `POST /auth/passkeys/reauth/options` | `{ flowId, publicKey }` for re-authentication (UV required); `404 NO_PASSKEY` |
| `GET /auth/passkeys/signal` | data for the Signal API (`rpId`, `userId` = user handle, `allAcceptedCredentialIds`, `name`, `displayName`) |

Re-authentication with a passkey: send `webauthnFlowId` + `webauthnResponse` instead of
`currentPassword` / `mfaCode` — accepted by every route that uses `verifyReauth()` (MFA changes,
app passwords, passkeys). `GET /auth/mfa/status` additionally reports `passkeyCount` and
`securityKeyCount` (`webauthnCount` = both).

Registration, removal and recovery publish `mfa-change` (credential caches of the mail
protocols, MFA enforcement), write an audit row and a security notice into the user's INBOX.

The deprecated `/auth/mfa/webauthn/register/start|finish` (removed with the next MAJOR) register
a second-factor security key into the same table; `/auth/mfa/webauthn/auth/start` gives the
options of the second factor of a pending MFA challenge (UV discouraged, single-use challenge
under `auth:passkey:chal:*` — G7).

## Passkey-only accounts and recovery

`User.passwordLoginDisabled` (admin: mailbox dialog → Passkeys → "Nur mit Passkey anmelden"):

- the web login answers `403 PASSWORD_LOGIN_DISABLED` — only **after** the password was verified
  (a wrong password stays `401`, no oracle); password re-authentication is refused; no password
  reset by mail (the request is silently ignored, an existing link is refused);
- precondition: two passkeys, or one synced passkey (BS) plus backup codes (`409 NEEDS_PASSKEYS`);
  the last active ORGANIZATION_MANAGEMENT account needs two passkeys (`409 LAST_ORG_ADMIN`);
- mail programs keep using app passwords.

Recovery: a second passkey, backup codes as second factor, or an admin **recovery link**
(`POST /admin/mailboxes/:id/passkey-recovery`): one-time token (only its SHA-256 is stored,
24 h, single use, shown once, delivered in the URL fragment `…/passkey-recovery#<token>`). The
user registers a new passkey on that page (`/auth/passkey/recovery/options|verify`, no session);
every session of the account is revoked, the user gets a security notice, both the issue and the
redemption are audited. Admins can also remove one or every passkey of a mailbox, or reset every
factor (passkeys, security keys, TOTP, backup codes).

## Admin API

| Route | Area / scope |
|---|---|
| `GET/PUT /admin/authentication/passkeys` | organisation (write ORGANIZATION_MANAGEMENT; read SERVER_MANAGEMENT, VIEW_ONLY_ORG), organisation-wide admins only; audit `settings.passkey-policy.update` |
| `GET/PUT /admin/authentication/passkeys/domains/:id` | same |
| `GET /admin/mailboxes/:id/passkeys` | recipients read, the user's domain in scope (else 404) |
| `DELETE /admin/mailboxes/:id/passkeys[/:pid]`, `POST /:id/mfa-reset`, `POST /:id/passkey-recovery`, `PUT /:id/passkey-policy` | recipients write, in scope, admin accounts only by ORGANIZATION_MANAGEMENT (`FORBIDDEN_ROLE`), the acting session MFA-verified (`403 MFA_NOT_VERIFIED`); audited (`passkey.admin_*`, `mailbox.passkey-policy.update`, `mailbox.mfa.reset`) |

`PUT /admin/mailboxes/:id/passkey-policy { passkeys?: inherit|on|off, passwordLoginDisabled? }`.
The route is named `passkey-policy` (not `auth-policy`) so it cannot collide with the per-user
MFA policy of the auth-policy work. See [rbac.md](rbac.md).

The admin MCP interface redacts `publicKey`, user handles and recovery tokens/URLs from tool
results.

## Frontends

- **Login (webmail, BCP)**: e-mail field `autocomplete="username webauthn"`, conditional
  mediation (the passkeys appear in the autofill; renewed before the challenge expires, aborted by
  the password submit and the button), button "Mit Passkey anmelden" (this device, a security key
  or another device by QR code). After a `PASSKEY_UNKNOWN` the browser is told
  (`signalUnknownCredential`); after a sign-in and a deletion the complete list and the user
  details are signalled (Signal API, feature-detected, fire-and-forget). No WebAuthn prompt opens
  on page load (WCAG 2.2 SC 3.3.8). The existing MFA challenge form is unchanged.
- **Webmail → Einstellungen → Sicherheit → Passkeys**: list (name, synced / device-bound from
  BE/BS, provider, added, last used), add (re-authentication with the password or an existing
  passkey; hint that mail programs need app passwords), rename, remove, hint to add a second
  passkey, legacy keys marked. Also on the mandatory MFA enrolment page. Texts DE/EN/ES/IT.
- **`/passkey-recovery#<token>`**: redeems a recovery link.
- **BCP → Authentifizierung → Passkeys**: switches, RP ID / origins / readiness (read-only),
  host-name warning, related origins, adoption numbers. Mailbox dialog → Passkeys: list / remove,
  reset all factors, recovery link, per-user switch, passkey-only.

## Data model (additive)

`WebAuthnCredential` (`webauthn_credentials`): `credentialId` (unique, base64url, ≤ 1023 raw
bytes), `publicKey` (COSE bytes), `algorithm`, `signCount` (BigInt — never serialised raw),
`transports`, `rpId`, `userHandle` (null = migrated), `kind`, `discoverable`, `uvInitialized`,
`backupEligible` (null = unknown), `backupState`, `aaguid`, `attestationFmt`, `name`, `createdAt`,
`lastUsedAt`, `lastUsedIp`. `PasskeyRecoveryToken`, `PasskeyPolicy`; `User.webauthnUserId` (random
64 bytes, never personal data; `user.name` in the options is the e-mail address),
`User.passwordLoginDisabled`, `Session.authMethod`, `UserMfa.webAuthnMigratedAt` (backfill marker),
`ServerSettings.passkeysEnabled /
passkeyPasswordlessEnabled / passkeyRpId / passkeyRelatedOrigins`.

## Environment

| Variable | |
|---|---|
| `WEBAUTHN_RP_ID` | pins the RP ID (overrides the frozen value) |
| `WEBAUTHN_ORIGIN` | allowed origins, comma-separated (replaces the derived base URL) |
| `WEBAUTHN_RP_NAME` | RP name shown by authenticators (default `CoreMail`) |
| `COREMAIL_PUBLIC_URL` | public base URL (also the SSO redirect base) |

## Tests

- `packages/storage/src/auth/webauthn/passkeys.test.ts` — software authenticator (ES256, Ed25519,
  RS256; attestation none and packed self attestation) with exact authData flags: UV=0, BE/BS,
  BE changed, counter regression, wrong rpIdHash / origin / port, cross-origin, reused / expired
  challenge, unknown / legacy / duplicate / > 1023-byte credential, user-handle mismatch, inactive
  user, Webmail off, maintenance, policy off at server / domain / user, account lock vs IP lock
  vs block list, second factor without UV, re-authentication, recovery, passkey-only, migration
  idempotence and duplicates.
- `packages/auth-service/src/router/passkeys.test.ts`, `packages/api-gateway/src/routes/admin/passkeys.test.ts` — the routes.
- `scripts/e2e/steps/passkeys.mjs` — e2e at API level with `scripts/e2e/soft-authenticator.mjs`.
- Not included: recorded attestation fixtures of real authenticators (`packed` with certificates,
  `apple`, `android-key`, `tpm`) — attestation is `none` and no metadata service is used, so the
  library verifies these formats but CoreMail does not depend on them.
