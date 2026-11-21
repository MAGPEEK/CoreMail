# Passkeys (10.6.0) — implementation plan

Status: approved by the user 2026-11-21. Target release 10.6.0 (MINOR). Specs: W3C Web Authentication
Level 3 (https://www.w3.org/TR/webauthn-3/), CTAP 2.2, RFC 8812 (COSE algorithms for WebAuthn),
RFC 9052/9053 (COSE), RFC 8809 (IANA registrations), RFC 9864 (Ed25519 COSE id).

## User decisions
- Passkeys ship in 10.6.0 together with the MFA policy work.
- Default **off everywhere** (fresh and existing installs); admins enable in BCP → Authentifizierung → Passkeys.
- An **account lock** (password-guessing protection) does **not** block a passkey login; an **IP lock / block list** does.
- The existing security-key second factor bugs (G1, G3, G6, G7 below) are fixed in the same release.
- Legacy security keys stay second-factor only (no passwordless use); the UI offers "register again as a passkey".
- No conditional create / automatic upgrade nudging in this release.

## Current state and bugs of the existing WebAuthn second factor
Code: `packages/auth-service/src/mfa/webauthn.ts`, `src/router/mfa.ts`, verification via
`completeMfaLogin()` in `packages/storage/src/auth/login-service.ts`; library `@simplewebauthn/server` 10.0.1
with mixed `@simplewebauthn/types` 12/10; browser glue `web-client/src/lib/webauthn.ts`,
`admin-panel/src/lib/webauthn.ts`; RP from `getRpConfig()` (`publicHostname`, env `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN`).
Data: `UserMfa.webAuthnCredentials` JSON array, read directly in six places (`getMfaState`,
`mfa-enforcement.ts`, `hasMfa` in `mail-auth-core.ts`, `adminMfaRefusal` in api-gateway `middleware/auth.ts`,
`/auth/mfa/status`, auth-sso `oidc.ts`).
- G1: options send `userVerification:'preferred'` but verify requires UV (library default) → keys without PIN fail. Fix: second factor = `'discouraged'` + `requireUserVerification:false`.
- G2: random user handle never stored.
- G3: credential IDs not unique across users; length ≤1023 bytes not checked (§7.1 steps 25/26).
- G4: no list/rename/delete; no admin MFA reset.
- G5: no transports/BE/BS/AAGUID/lastUsed; JSON read-modify-write races.
- G6: origin ignores the HTTPS port (8443 setups broken) — use `publicBaseUrl()` logic from `routes/sso.ts`.
- G7: challenge deleted only after success → must be single-use (GETDEL); key prefix `auth:*`.
- G8: no usernameless sign-in, no conditional UI, no WebAuthn re-auth (`reauth.ts`).

## Decisions
1. **RP ID** = host name (`publicHostname`), frozen at first registration in `ServerSettings.passkeyRpId`; BCP warns on host-name change. Allowed origins only from configuration (`publicBaseUrl()` incl. port + optional list), never from the Host header. Optional Related Origin Requests (§5.11) via `/.well-known/webauthn`. Readiness check in BCP: HTTPS + DNS name required (IP / plain HTTP cannot work).
2. **Library** `@simplewebauthn/server` **14.1.0 pinned exactly** (Node ≥22); drop `@simplewebauthn/types`. `supportedAlgorithmIDs: [-8, -7, -257]` (EdDSA, ES256, RS256). Ceremony core moves to `@coremail/storage/auth/webauthn` (own subpath; mail servers must not load it). Browser: `@simplewebauthn/browser` same version pinned, or own glue with `PublicKeyCredential.parse*FromJSON` + fallback.
3. **Attestation** `'none'`, no metadata service; store `fmt` + AAGUID for display only.
4. **User verification**: passkey login, passkey registration, passkey re-auth: `required`. Second factor after password: `discouraged`.
5. **Discoverable**: passkeys `residentKey:'required'` + `credProps`; second-factor keys `'discouraged'`. User handle: stable random 64 bytes per user (`User.webauthnUserId`), never personal data; `user.name` = e-mail.
6. **Session**: UV passkey login = MFA (§6.2.3): `issueSession(…, { mfaVerified: true })`, new `Session.authMethod = 'passkey'`; satisfies admin MFA rules, MFA enforcement, MCP-token creation rule.
7. **Policy**: a passkey counts as an enrolled factor everywhere — one central helper `getAuthFactors(userId)` replaces the six JSON readers. Passkey switch `inherit|on|off` at server, domain, user (coordinate with the MFA policy model from branch `auth-policy`; if not merged yet, implement passkey fields on their own and leave a TODO to unify). A passkey login never asks for a second factor and never uses or issues a "remember device" token.
8. **Admin**: global `passkeysEnabled` (default false), `passkeyPasswordlessEnabled`; per domain/user switch; passkey-only accounts `User.passwordLoginDisabled` (checked only after a correct password — no oracle; precondition ≥2 passkeys or 1 synced (BS=1) + backup codes; refused for the last organisation admin unless ≥2 passkeys).
9. **Recovery**: second passkey or backup codes; passkey-only accounts get no mail reset; admin issues a one-time recovery link (hashed token, 24 h, single use, shown once) → user registers a new passkey, all sessions revoked, security notice, audit. Admin can remove a user's passkeys / all MFA.
10. **Mail protocols** cannot use passkeys; a passkey counts in `hasMfa` → app passwords required (warn at registration, offer app password). CLI uses `COREMAIL_TOKEN`.
11. **MCP**: token from a passkey session counts as MFA-verified; re-auth accepts passkeys; add `publickey` to MCP result redaction.
12. **SSO/LDAP**: no passkeys for OIDC-only accounts; LDAP accounts allowed (login checks `active`).
13. **Lockout**: account lock does not block passkey login; IP lock/block list does.

## Data model (additive)
```
model WebAuthnCredential  // @@map("webauthn_credentials")
  id, userId (cascade, index), credentialId @unique (base64url, ≤1023 raw bytes), publicKey Bytes,
  algorithm Int, signCount BigInt @default(0), transports String[], rpId, userHandle String? (null = legacy),
  kind "passkey"|"security_key", discoverable Boolean?, uvInitialized Boolean, backupEligible, backupState,
  aaguid String?, attestationFmt, name, createdAt, lastUsedAt?, lastUsedIp?
User.webauthnUserId String? @unique; User.passwordLoginDisabled Boolean @default(false)
Session.authMethod String @default("password")
ServerSettings.passkeysEnabled / passkeyPasswordlessEnabled / passkeyRpId String? / passkeyRelatedOrigins String[]
PasskeyRecoveryToken { id, userId, tokenHash @unique, createdById, expiresAt, usedAt }
```
Migration: idempotent startup backfill (Redis lock) copies the JSON into `kind='security_key'`, `userHandle=null`;
duplicate credential IDs across users → skip both + alert. The JSON column stays (deprecated) until the next MAJOR.
Never serialise `signCount` BigInt raw.

## Endpoints (auth-service, proxied by the gateway as `/auth/passkey*`, rate-limited)
- Public: `POST /auth/passkey/login/options` → `{flowId, publicKey}` (empty allowCredentials, UV required), flow bound to HttpOnly SameSite=Strict cookie `cm_pk`; ~20/min/IP. `POST /auth/passkey/login/verify` → session (`cm_rt`/`cm_rt_bcp`) or `PASSKEY_UNKNOWN` / `PASSKEY_NOT_ELIGIBLE` / `PASSKEYS_DISABLED` / `PROTOCOL_DISABLED` / maintenance / `PASSKEY_CHALLENGE_EXPIRED`. No e-mail-first variant (§14.6.2).
- User (Bearer): `GET /auth/passkeys`; `POST /auth/passkeys/registration/options` (re-auth) + `/registration/verify`; `PATCH /auth/passkeys/:id`; `DELETE /auth/passkeys/:id` (re-auth; `409 LAST_PASSKEY`); `POST /auth/passkeys/reauth/options` and `verifyReauth()` accepts `webauthnResponse`; `GET /auth/passkeys/signal`; `/auth/mfa/status` gains `passkeyCount`. Old `/auth/mfa/webauthn/*` stay (deprecated) and write the new table.
- Admin (api-gateway): `GET/PUT /admin/authentication/passkeys` (organisation area, `requireUnscoped`, audit `settings.passkey-policy.update`); `GET/DELETE /admin/mailboxes/:id/passkeys[/:pid]`, `POST …/passkey-recovery`, `PUT …/auth-policy` (`requireInScope('user')`, equal/higher roles only by ORGANIZATION_MANAGEMENT, MFA-verified acting admin, audited). Every route in `docs/rbac.md`.

Login verify order: IP block → GETDEL challenge → credential by id → `kind=passkey` and `userHandle` = stored = `User.webauthnUserId` (§7.2) → `verifyAuthenticationResponse` (configured origins, rpId, UV required; reject `crossOrigin`) → BE must equal stored (§6.1.3), update BS → counter regression fail-closed + audit `passkey.counter_regression` + notice (0 = synced, skip) → conditional update → active / maintenance / `webLoginBlocked(surface)` / policy → `issueSession(mfaVerified, authMethod 'passkey')` → `lockout.success`.
Registration: own uniqueness + length check, `publishUserAuthChange('mfa-change')`, security notice, audit.
Challenges: Redis `auth:passkey:chal:<sha256(flowId)>` `{challenge, purpose, userId?, sessionId?, surface, rpId}`, TTL 300 s, single use; frontend renews conditional options before TTL.
Signal API (§5.1.10; feature-detect, fire-and-forget): `signalUnknownCredential` only on `PASSKEY_UNKNOWN`; `signalAllAcceptedCredentials` after sign-in and deletion with the complete list; `signalCurrentUserDetails` after sign-in / name change.

## Frontend
- Webmail + BCP login: e-mail field `autocomplete="username webauthn"`, conditional mediation with AbortController (aborted on password submit/button), explicit "Mit Passkey anmelden" button (incl. QR / other device). Existing MFA challenge form unchanged.
- Webmail Settings → Sicherheit: passkey list (name, synced vs device-bound from BE/BS, provider, created, last used), add (re-auth + app-password warning), rename, delete; hint to add a second passkey; legacy keys marked; passkeys allowed on the MFA enrolment page.
- BCP → Authentifizierung → Passkeys: policy switches, read-only RP ID / origins / HTTPS readiness, related origins, adoption numbers; mailbox dialog: list/remove passkeys, recovery link, per-user policy.
- Accessibility (WCAG 2.2 SC 3.3.8): labelled buttons, role=status/alert, no modal WebAuthn prompt on page load, keyboard/focus, DOMException mapping; texts DE/EN/ES/IT.

## Tests
Software authenticator (node:crypto ES256/Ed25519/RS256 + small CBOR encoder) for exact authData flags: UV=0, BE/BS combos, BE changed, counter regression, wrong rpIdHash/origin/port, crossOrigin, reused/expired challenge, unknown/legacy/duplicate credential, >1023-byte id, userHandle mismatch, inactive user, webmail switched off, maintenance, policy off at server/domain/user, account lock vs IP lock. Recorded fixtures (packed/apple/android-key/tpm/none). Route tests (fake Prisma/Redis), migration idempotence, repo-hygiene guard (no `webAuthnCredentials` readers outside migration). e2e step `passkeys` at API level with the software authenticator.

## Work packages
WP0 bug fixes G1/G3/G6/G7 · WP1 library + core move + model + migration + central factor helper · WP2 login options/verify, session authMethod, policy/lockout, passkey re-auth · WP3 user management API · WP4 admin policy, passkey-only, recovery tokens, admin removal, RBAC docs · WP5 webmail UI · WP6 BCP UI · WP7 `.well-known/webauthn` + readiness · WP8 tests + e2e · WP9 docs (`docs/passkeys.md`, rbac, user-settings, sso-ldap, env/Helm).
