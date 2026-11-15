# SSO (OpenID Connect) and LDAP / Active Directory

CoreMail can authenticate users against an external OpenID Connect provider
(single sign-on in MWA and BCP) and against an LDAP directory / Active Directory
(password login for web, API and — once wired — mail protocols). SAML is **not**
supported.

Packages: `packages/auth-sso` (OIDC flow), `packages/auth-ldap` (LDAP login, sync,
connection test). HTTP routes live in the api-gateway.

## OIDC single sign-on

### Setup (BCP → SSO)

1. Create an app/client at the IdP (confidential client, authorization code flow).
2. In the BCP add a provider: domain, display name, discovery URL, client ID and
   secret. Presets: Microsoft Entra ID, Keycloak, Authentik, Google Workspace, Okta.
3. Register the **redirect URI** shown in the provider list at the IdP:
   `https://<host>/auth/sso/<providerId>/callback`. The base URL comes from
   `COREMAIL_PUBLIC_URL` or ServerSettings (`publicHostname`, `useHttps`, `httpPort`).
4. "Discovery testen" fetches the discovery document server-side and shows issuer,
   endpoints, JWKS, PKCE S256 support and ID-token algorithms.

Provider settings (`OidcProvider`):

| Field | Default | Meaning |
|---|---|---|
| `active` | true | Shown on the login pages |
| `scopes` | `openid email profile` | Must contain `openid` |
| `claimMap.email` / `claimMap.name` | `email` / `name` | Claims for address and display name |
| `forcedDomains` | `[]` | Allowed e-mail domains; empty = only the provider's own domain. Every domain must also exist (active) in CoreMail |
| `requireEmailVerified` | true | `email_verified` must be `true`. Switch off only for IdPs that never send it (Entra ID) and then restrict `forcedDomains` and use a single-tenant discovery URL |
| `autoProvision` | true | Unknown users are created (authSource OIDC) and their mailbox is provisioned |
| `allowLinking` | false | Existing LOCAL/LDAP accounts with the same verified address may log in via SSO (the account is not converted). Since v8.1 the account is bound to the IdP subject of its first SSO login; another subject with the same address gets `account_mismatch` |
| `requireMfa` | false | Users with CoreMail MFA enrolled must enter their code after the IdP |

### Flow and security properties

```
GET  /auth/sso/providers                 public: [{ id, name }] of active providers
GET  /auth/sso/:id/start?target=mwa|bcp  302 → IdP; sets cookie cm_sso
GET  /auth/sso/:id/callback              302 → /sso/callback?code=…  (BCP: /bcp/sso/callback)
                                         errors → /login?sso_error=<reason> (/bcp/login)
POST /auth/sso/exchange { code }         → same body as POST /auth/login
```

- Authorization code flow with **PKCE S256**, random `state` and `nonce` (256 bit).
  State, nonce, verifier and redirect URI are stored in Redis for 10 minutes under
  `sha256(state)`; the record is **bound to the browser** via the `cm_sso` cookie
  (HttpOnly, SameSite=Lax, Path=/auth/sso, Secure on https — only its SHA-256 is stored).
- The state is consumed exactly once (also when the callback fails), so replays fail.
- The ID token is validated by openid-client: signature via the discovery JWKS,
  `iss`, `aud`, `exp`/`iat`, `nonce`; the code exchange sends the PKCE verifier.
- Account policy: verified e-mail, allowed + configured domain, OIDC accounts are
  bound to `oidc:<providerId>:<sub>` on first use (another subject is refused),
  LOCAL/LDAP accounts only with `allowLinking`, inactive accounts refused,
  maintenance mode respected.
- Linked accounts (v8.1) are bound like OIDC accounts: a LOCAL account stores
  `oidc:<providerId>:<sub>` in `User.externalId`; an LDAP account keeps its
  directory id there and its binding lives in Redis (`auth:sso:link:<userId>`,
  persisted by `appendonly`). To re-link an account to another IdP identity, clear
  `externalId` (LOCAL) or delete the Redis key (LDAP). A LOCAL account bound to an
  IdP is no longer taken over by the LDAP login (`allowLocalTakeover`): the stored
  id does not match the directory id.
- The callback never puts tokens into a URL: it issues a one-time code (60 s, Redis,
  single use, bound to the same cookie). The SPA posts it to `/auth/sso/exchange` and
  receives a normal CoreMail session (rotating refresh token) or an MFA challenge.
- Rate limit: start/callback/exchange 60 per 15 min per IP (`ssoRateLimit`); the
  provider list is exempt.

### MFA

Default: the IdP is trusted as the second factor — users are not asked for their
CoreMail MFA code. The session counts as *MFA verified* (relevant for
`requireMfaForAdmins`) only if the ID token's `amr` claim names an MFA method
(`mfa`, `otp`, `hwk`, `swk`, `sc`, `fpt`, `face`, …). With `requireMfa` on the
provider, users with CoreMail MFA enrolled get the normal MFA challenge
(`/auth/mfa/verify`) and the session is MFA verified afterwards.

Admins (v8.1): when `requireMfaForAdmins` is on, an account with an admin role
(anything but `USER`) is **not** MFA verified through `amr` — the claim is the
IdP's own statement. Such admins get the CoreMail MFA challenge when enrolled (even
if the provider has `requireMfa` off); without CoreMail MFA the session stays
unverified and the admin API answers `MFA_REQUIRED` / `MFA_NOT_VERIFIED`. Set
`OIDC_TRUST_IDP_MFA_FOR_ADMINS=true` (default `false`) to trust `amr` for admins
again — only effective for providers with `requireMfa` off.

SSO accounts have no CoreMail password; mail clients use app passwords. Creating
an app password (v8.1) needs re-authentication — SSO users confirm with a
CoreMail TOTP or backup code (`mfaCode`).

## Web login hardening (v8.1)

### Shared lockout

`POST /auth/login` and `/auth/mfa/verify` use the same Redis failure counters as
the mail protocols (`MAIL_AUTH_*` variables, see `packages/storage/src/mail-auth.ts`):
per account (default 10 failures / 15 min → 5 min lock, doubling per strike) and per
client IP (50 / 15 min; only loopback and `MAIL_AUTH_EXEMPT_CIDRS` are exempt). Wrong passwords and wrong MFA codes count alike;
only a completed login resets the account counter. A locked account or IP gets
`429 { code: 'ACCOUNT_LOCKED', retryAfter }` with `Retry-After` before any password
check — also for unknown accounts, and `mfaRequired` is never revealed while locked.
Failures on IMAP/SMTP/… and on the web count against the same budget.

### Refresh-token cookie

Browser frontends send `X-CoreMail-Client: web` (the BCP also `X-CoreMail-App: bcp`).
For them every token-issuing answer (`/auth/login`, `/auth/mfa/verify`,
`/auth/refresh`) carries only `{ accessToken, expiresIn }`; the refresh token is set
as cookie `cm_rt` (BCP: `cm_rt_bcp`) — `HttpOnly; SameSite=Strict; Path=/auth`,
`Secure` when the request is HTTPS (TLS proxy, trusted `X-Forwarded-Proto`) or the
page origin is `https://`. The access token is kept in memory; after a reload the
frontends call `/auth/refresh` with the cookie.

`/auth/refresh` and `/auth/logout` use the cookie when the JSON body has no
`refreshToken`. Cookie use requires a same-origin `Origin` (or `Referer`) — the
request's `Host`, `req.hostname` (`X-Forwarded-Host` with `TRUST_PROXY`), the
configured public hostname or an entry of `COREMAIL_ALLOWED_ORIGINS`
(comma-separated origins like `https://mail.example.com` or host names) — else
`403 ORIGIN_MISMATCH`. Logout always deletes the cookie; a failed cookie refresh
deletes it too.

Compatibility: clients that send the refresh token in the body (admin CLI, API
scripts) keep the old contract. A browser that still has a pre-8.1 token in
localStorage sends it once in the body; the answer moves it into the cookie and the
frontend deletes the stored copy. The SSO exchange (`/auth/sso/exchange`) still
returns the refresh token in its body; the frontends hand it over the same way.

## LDAP / Active Directory

### Login (`authenticateLdap`)

Registered as the `ldap` step of the shared login service
(`registerAuthenticator(ldapAuthenticator())` in api-gateway and auth-service). Steps:

1. Empty password → refused (would be an unauthenticated simple bind).
2. The login domain must be an active CoreMail domain with an enabled `LdapConfig`.
3. Existing CoreMail account: must have authSource LDAP. A LOCAL account is only
   taken over with the explicit opt-in `allowLocalTakeover` (authSource → LDAP, local
   password removed, sessions revoked); OIDC accounts never. Inactive → refused.
4. Bind with the service account, search `userDN` with `userFilter` —
   placeholders `{{username}}` (local part), `{{email}}`, `{{domain}}`, escaped
   per RFC 4515 (not stripped). Exactly one entry is required.
5. The entry's mail attribute (`attributeMap.email`, default `mail`) must equal the
   login address.
6. Bind as the found DN with the password (separate connection).
7. A stored directory id (`externalId = ldap:<objectGUID|entryUUID>`) must match.
8. First login creates the user (authSource LDAP) **and provisions the mailbox**.

Transport: `ssl` (ldaps) or `startTls`; certificate verification `tlsVerify`
(default on), optional PEM CA `tlsCaCert`. Plain LDAP is refused unless the host is
loopback or `LDAP_ALLOW_INSECURE=true`.

Mail protocols: `verifyLdapMailPassword(email, password)` resolves to
`{ userId }` on success and `false` otherwise (never throws); register it with
`registerExternalPasswordVerifier(verifyLdapMailPassword)` from `@coremail/storage`.

### Sync (`syncLdapUsers`)

BCP → LDAP → Synchronisation ("Jetzt synchronisieren", `POST /api/v1/admin/ldap/:domainId/sync`)
and a scheduler in the api-gateway (`syncEnabled`, interval `syncIntervalMinutes`,
default daily; Redis lock `ldap:sync:lock:<domainId>`, one run per domain).

- Searches `(&(objectClass=person)(<mail>=*)<groupFilter>)` (paged). Only entries
  with an address in the domain are used.
- Creates missing users (+ mailbox), updates display name / directory id, deactivates
  LDAP users that are missing in the result or disabled in AD
  (`userAccountControl` 0x2) — `active=false`, `deactivatedBySync=true`, sessions
  revoked. Nothing is deleted.
- Re-activates only accounts the sync itself deactivated.
- LOCAL accounts with a directory address are reported as conflicts (unless
  `allowLocalTakeover`).
- If the directory returns no users at all, nobody is deactivated.
- The result is stored in `LdapConfig.lastSyncResult`.

### Connection test

`POST /api/v1/admin/ldap/:domainId/test { email? }` connects with the configured
TLS settings, binds with the service account, runs the sync search (up to 25
entries) and optionally looks up one login address (DN, mail match, ambiguity).

The bind password is never returned by the admin API (`hasBindPassword` instead);
an empty `bindPassword` on update keeps the stored one.
