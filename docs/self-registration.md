# Self-registration (10.6)

People create their own mailbox from the webmail sign-in page ("Konto
erstellen"). The feature is **off by default** — on fresh and on existing
installations — and is switched on in the BCP under **Authentifizierung →
Selbstregistrierung** (`/bcp/authentication/self-registration`).

Code: api-gateway `routes/self-registration.ts` (public), `routes/admin/self-registration.ts`
(BCP), `lib/self-registration.ts` (address rules, invite codes, form token),
`lib/self-registration-notify.ts` (admin notice); webmail `pages/RegisterPage.tsx`,
`lib/selfRegistration.ts`; BCP `pages/SelfRegistrationPage.tsx`. Schema:
`ServerSettings.allowSelfRegistration` / `selfRegistrationDomainIds` /
`selfRegistrationMode` / `selfRegistrationInviteOnly`, models `SelfRegistration`
and `SelfRegistrationInvite` (additive).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Selbstregistrierung erlauben | off | Shows "Konto erstellen" on the sign-in page. |
| Freigegebene Domains | none | Hosted domains in which accounts may be created. **No allowed (active) domain = registration impossible**, even with the switch on. |
| Freigabe | Admin-Freigabe | `approval`: a new account is created **inactive** and cannot sign in until an admin approves it. `immediate`: the account is active at once. |
| Einladungscode erforderlich | off | Registration needs an admin-generated invite code. |

Only organisation-wide admins with write access to the recipients area
(ORGANIZATION_MANAGEMENT, RECIPIENT_MANAGEMENT without a domain scope) change
these settings and the invite codes. Every change is audited as
`settings.self-registration.update` (`settings.` — always written, even with the
audit log switched off).

## What a registered account gets

- Role **USER**, local password, the default quota of a new mailbox (the same
  default as a mailbox created in the BCP without a quota). The request cannot
  choose a role, quota, state or authentication source — unknown fields are
  ignored.
- The mailbox with the default folders and the default calendar, created by
  the same provisioning as every other mailbox (`ensureMailboxProvisioned`).
- The password must satisfy the server's password policy (minimum length,
  BCP → Global Einstellungen → Sicherheit) and is stored with the usual
  password hash.
- The MFA policies apply as for any other account ("MFA für alle Benutzer
  erzwingen" starts the grace period at the first sign-in).

## Address rules

The local part (name before the @) uses lower-case letters, digits, `.`, `-`
and `_`, starts and ends with a letter or digit, has no doubled separators and
is at most 64 characters long. Refused with **one and the same answer**
("Diese Adresse ist nicht verfügbar", `409 ADDRESS_UNAVAILABLE`):

- reserved names: postmaster, abuse, admin, administrator, root, hostmaster,
  webmaster, noreply, no-reply, mailer-daemon, security, support, info — also
  with `.`, `-` or `_` inside (`post.master`, `no_reply`);
- every address already used by a mailbox, a shared mailbox or an alias.

A reserved name and a taken address are indistinguishable to the visitor; the
answer is rate limited (below). With "Einladungscode erforderlich" the invite
code is checked **before** the address, so nobody without a valid code can
probe addresses at all.

## Approval

In approval mode the BCP page lists the accounts waiting for approval
(name, address, time, client IP, whether an invite code was used). Admins with
write access to the recipients area approve (the account becomes active,
`auth.register.approve`) or reject (the account is deleted,
`auth.register.reject`). A domain-scoped admin sees and decides only the
registrations of its domains. Read-only roles (HELP_DESK, VIEW_ONLY_ORG) see
the list.

A pending account answers a sign-in like a wrong password (no account state is
revealed at the sign-in); the registration page tells the visitor "Konto wartet
auf Freigabe".

**Admin notice:** a new pending registration sends a notice to the recipient
of the attack-protection notifications (BCP → Schutz → Angriffsschutz →
Benachrichtigung; else `ServerSettings.adminEmail`; else the Organization
Management admins) through the same delivery path (local recipient → straight
into the INBOX, other addresses → outbound queue). At most **one notice per
15 minutes**; further registrations of that window are not mailed one by one —
the BCP list always shows all of them.

## Invite codes

Codes are created on the BCP page with an optional label, a validity (1–365
days, default 14) and a number of uses (1–1000, default 1). The code (16
characters, e.g. `7KQ2-M9XA-…`, 80 bits) is shown **once** — only its sha256 and
the last four characters are stored. A code is valid while it is not revoked,
not expired and not used up; spaces, dashes and case do not matter when it is
typed. Two registrations can never share the last use of a code (the use
counter is updated with a compare-and-set). Creating and revoking a code is
audited (`settings.self-registration.invite.create` / `.revoke`). At most 500
codes may be valid at the same time.

## Abuse protection

- **Off → 404.** With the switch off, or without an allowed active domain,
  `GET /auth/register/config` and `POST /auth/register` answer 404 like an
  unknown path.
- **IP block list** of the attack protection applies (every gateway path).
- **Shared lockout:** a client IP locked by the shared web/mail lockout gets
  `429` before any work. Abuse signals count as failed attempts for the client
  IP (default 50 per 15 minutes lock it, escalating like every lock, repeat
  offenders reach the automatic block list): a filled honeypot, a form sent
  faster than 3 seconds after it was loaded, a forged or expired form token, a
  domain that is not allowed and a wrong invite code.
- **Budget:** 10 registration attempts per client IP and hour, 200 per hour
  server-wide (`SELF_REGISTRATION_PER_IP_PER_HOUR`,
  `SELF_REGISTRATION_PER_HOUR`); beyond that `429 RATE_LIMITED`.
- **Honeypot:** the hidden field `website` must stay empty.
- **Minimum fill time:** `GET /auth/register/config` hands out a form token
  (issue time signed with an HMAC derived from `JWT_SECRET`); `POST` refuses a
  token younger than 3 seconds or older than 2 hours. No third-party captcha.
- **Security events:** every refusal is recorded as `REGISTRATION_ABUSE`
  (protocol web, reason in the detail) on the attack dashboard.
- Maintenance mode answers `503`.

## API

Public (mounted before the `/auth` login limiter):

| Route | Answer |
|---|---|
| `GET /auth/register/config` | `{ enabled: true, domains: [{id, name}], inviteRequired, mode, minPasswordLength, formToken }`; 404 when off |
| `POST /auth/register` `{ domainId, displayName, localPart, password, inviteCode?, website, formToken }` | `201 { status: 'pending' \| 'active', email }`; 400 `INVALID_INPUT` / `INVALID_FORM` / `INVALID_NAME` / `INVALID_LOCAL_PART` / `PASSWORD_POLICY` / `DOMAIN_NOT_ALLOWED` / `INVITE_INVALID`; 409 `ADDRESS_UNAVAILABLE`; 429 `RATE_LIMITED`; 503 maintenance; 404 when off |

Admin (`/api/v1/admin/self-registration`, area recipients; decisions in
[rbac.md](rbac.md)):

| Route | |
|---|---|
| `GET/PUT /settings` | settings (org-wide admins) |
| `GET /invites`, `POST /invites` `{ label?, expiresInDays, maxUses }`, `DELETE /invites/:inviteId` | invite codes (org-wide admins); `POST` answers `{ code, invite }` once |
| `GET /pending` | accounts waiting for approval (filtered by the admin's scope) |
| `POST /pending/:id/approve`, `POST /pending/:id/reject` | `:id` = user id; outside the scope → 404 |

Audit actions: `auth.register.pending` / `auth.register.active` (account
created, actor = the new account, with the client IP), `auth.register.approve`,
`auth.register.reject`, `settings.self-registration.update`,
`settings.self-registration.invite.create` / `.revoke`. All of them are always
written (`ALWAYS_AUDIT`).

## Tests

`packages/api-gateway/src/routes/self-registration.test.ts` (public and admin
routes), `packages/web-client/src/lib/selfRegistration.test.ts`,
`packages/admin-panel/src/lib/selfRegistration.test.ts`.
