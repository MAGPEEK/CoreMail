# Multi-factor sign-in policy (10.6)

BCP → **Authentifizierung** → **Mehrstufige Anmeldung (MFA)** (`/bcp/mfa`). The sidebar group
"Authentifizierung" holds *Mehrstufige Anmeldung (MFA)*, *SSO* and *LDAP / Active Dir.* (the
last two moved there from "Infrastruktur"; their URLs `/bcp/sso` and `/bcp/ldap` are unchanged).
A later "Passkeys" entry goes after MFA. The MFA switches that 10.5 kept in Einstellungen →
Sicherheit live on this page now; the settings page links to it.

Code: storage `src/auth/mfa-policy.ts` (model + resolution), `src/auth/mfa-enforcement.ts`
(enforcement, grace periods), `src/auth/trusted-devices.ts` ("Gerät merken"); api-gateway
`routes/admin/global-settings.ts` (`/settings/mfa-policy`), `routes/admin/user-mfa.ts`,
`routes/trusted-devices.ts`, `middleware/auth.ts` (admin rule); BCP `pages/MfaPolicyPage.tsx`,
`components/MfaPolicyField.tsx`, `components/AdminMfaPrompt.tsx`; webmail
`components/AdminMfaPromptBanner.tsx`, `components/settings/SecurityPanels.tsx`
(`TrustedDevicesPanel`).

## Policy model

Three inputs; the most specific one wins:

1. **Per-user exception** — `User.mfaPolicy` (`REQUIRED` / `OPTIONAL` / `OFF`, `null` = inherit).
2. **Admin rule** — `ServerSettings.mfaAdminPolicy` (`REQUIRED` / `AS_USERS`), only for accounts
   with an admin role (every `UserRole` except `USER`).
3. **Policy for all users** — `ServerSettings.mfaUserPolicy` (`REQUIRED` / `OPTIONAL` / `OFF`).

| Level | Meaning |
|---|---|
| Pflicht (`required`) | The account must enrol a second factor (TOTP or a security key) — after a grace period, see below. |
| Optional (`optional`) | The user decides; enrolment is offered in Webmail → Einstellungen → Sicherheit. |
| Aus (`off`) | Enrolment is **not offered**: the webmail shows a note instead of the setup buttons and `POST /auth/mfa/totp/setup` / `POST /auth/mfa/webauthn/register/start` answer `403 MFA_NOT_OFFERED`. Factors enrolled earlier **keep working** — the sign-in still asks for them, the user may remove them and regenerate backup codes. "Aus" never disables an enrolled factor. |

### Two kinds of "Pflicht"

| Applies to | Enforcement |
|---|---|
| Admin accounts required by the admin rule or by their own exception | **Admin rule**: admin grace period (`mfaAdminGraceDays`, 0–14, default 14) per admin from the first check after the rule applies; during it the admin API works and every admin answer carries `X-CoreMail-Mfa-Grace-Until: <ISO>`; the BCP and the webmail show a dismissible prompt ("Jetzt einrichten" / "Später"). After the deadline `403 MFA_REQUIRED` (with `deadline`) — enrolment (`/auth/mfa`, webmail) stays reachable. An enrolled admin needs an MFA-verified session (`403 MFA_NOT_VERIFIED`, unchanged). The webmail is never blocked by the admin rule. |
| Every other required account (users; admins under "Wie alle Benutzer") | The 10.5 rules of "MFA für alle Benutzer erzwingen" ([user-settings.md](user-settings.md#mfa-enforcement-105)): grace `mfaEnforcementGraceDays` (0–90), then only enrolment; the sub-option `mfaEnforcementBlocksPrimaryPassword` blocks the primary password on mail protocols afterwards. |

"Später" hides the prompt for the rest of the day in that browser (local storage); it never
moves the deadline. Per-user exceptions cannot give an admin more than 14 days. Admin MCP tokens
get no grace: while the admin rule applies, a token of an admin without MFA answers
`403 MFA_REQUIRED`, and creating a token needs an MFA-verified session.

Grace starts: `User.mfaGraceStartedAt` (shared by both kinds — an account is under one kind at a
time). A start older than the activation time is stale (new grace): `mfaEnforcementSince` (policy
for all users switched to Pflicht), `mfaAdminEnforcementSince` (admin rule switched to Pflicht).
Setting or changing a per-user exception clears the start (new grace period).

### Backward compatibility

The new columns are `null` on existing installations; then the 10.5 switches decide on read:
`requireMfaForAllUsers` → Pflicht / Optional, `requireMfaForAdmins` → Pflicht / Wie alle
Benutzer. Every save (the new page and the old `PUT /settings/security`) writes both forms, so
readers of the legacy switches keep working. Changed behaviour on purpose (user decision): the
admin rule no longer blocks the admin API at once — admins without MFA get up to 14 days (fresh
installations included; the setup wizard says so).

## "Gerät merken"

After a successful MFA step the browser may be remembered: the login answer offers
`rememberDevice: { days }` and the MFA form shows "Auf diesem Gerät für N Tage nicht mehr fragen";
`POST /auth/mfa/verify { …, rememberDevice: true }` then sets an HttpOnly cookie per surface —
`cm_mfa_dev` (webmail) / `cm_mfa_dev_bcp` (BCP), `Path=/auth`, `SameSite=Strict`, `Secure` on
HTTPS, `Max-Age` = the allowed days. The server stores only `sha256(token)` in `MfaTrustedDevice`
(user, surface, created / expires / last used, a "browser · OS" summary, the network — IPv4 /24,
IPv6 /48 — revocation time and reason). At most 20 active devices per user.

A later **password** sign-in skips the MFA challenge only if the cookie's hash matches a row of
the account whose password was just verified, for the same surface, not revoked, not expired and
younger than the number of days the policy allows **now**. The session then counts as
MFA-verified. Never for mail protocols / app passwords, the admin CLI (no browser surface), MCP
tokens or SSO sign-ins.

Durations (`mfaRememberDays` for users, default 30; `mfaRememberDaysAdmins` for admin accounts,
default 30): off / 30 / 60 / 90 days / custom 1–365; the admin value never exceeds the users
value. Lowering a value shortens existing devices, 0 switches remembering off.

Revoked by: `revokeAllSessions()` — password change or reset, "Alle anderen Sitzungen beenden" /
sign out everywhere, role or scope change, deactivation, deletion, admin "Sitzungen beenden", LDAP
sync — and by every `mfa-change` event (factor added or removed, backup codes regenerated). Users
see and revoke their devices in Webmail → Einstellungen → Sicherheit → Gemerkte Geräte; admins
revoke an account's devices in BCP → Postfächer → Bearbeiten.

## API

| Route | Access | Notes |
|---|---|---|
| `GET /api/v1/admin/settings/mfa-policy` | organisation read | `{ policy, bounds, admins: [{ id, email, role, mfaPolicy, enrolled, effective }] }` — the admin list feeds the "admin without MFA" warning |
| `PUT /api/v1/admin/settings/mfa-policy` | organisation write (ORGANIZATION_MANAGEMENT) | partial `{ users, admins, graceDays, blocksPrimaryPassword, adminGraceDays, rememberDays, rememberDaysAdmins }` (strict; `adminGraceDays` ≤ 14, `rememberDaysAdmins` ≤ `rememberDays`); audit `settings.mfa-policy.update` (always written) |
| `GET /api/v1/admin/user-mfa?q=&overrides=1` | recipients read, scoped | accounts in scope with exception, enrolment, effective level + source |
| `GET /api/v1/admin/user-mfa/:id` | recipients read, scoped | + inherited level, remembered devices, `canWeaken`, `canRevokeDevices` |
| `PUT /api/v1/admin/user-mfa/:id` | recipients write, scoped | `{ mfaPolicy: 'inherit' \| 'required' \| 'optional' \| 'off' }`; only ORGANIZATION_MANAGEMENT may weaken an admin account's effective level (`403 MFA_POLICY_WEAKEN_ADMIN`); audit `mfa.policy.override`; publishes `mfa-policy-change` (caches only) |
| `DELETE /api/v1/admin/user-mfa/:id/trusted-devices` | recipients write, scoped; admin accounts ORGANIZATION_MANAGEMENT only | audit `mfa.trusted-devices.revoke` |
| `GET /api/v1/admin/mfa-status` | every admin role, own account | `{ state: off \| satisfied \| grace \| required, deadline?, canEnrol }` — the BCP prompt |
| `GET /api/v1/user/mfa-enforcement` | own account | 10.6 adds `policy`, `enrolmentOffered`, `admin: { state, deadline? }` |
| `GET / DELETE /api/v1/user/trusted-devices[/:id]` | own account | audit `user.mfa.trusted-device.revoke` |

Out-of-scope ids answer `404` like unknown ids (docs/rbac.md).

## Tests

- storage `src/auth/mfa-policy.test.ts` — resolution matrix (global × admin rule × exception ×
  role), legacy read/write, admin grace (14-day cap, 0 days, override), exceptions, device
  lifecycle (issue, skip, wrong surface, other account, CLI, expiry, lowered / off setting, admin
  default off, revocation by every revoke-all reason and `mfa-change`, list / single revoke),
  cookie helpers.
- api-gateway `src/routes/admin/mfa-policy.test.ts` — policy API (roles, validation, audit,
  legacy columns), exceptions (scope 404, help desk read-only, weakening admins), device
  revocation (admin + own), admin grace status / prompt flag / MFA_REQUIRED after the deadline,
  policy "off"; `src/routes/auth.test.ts` — admin grace on the admin API (200 + header within,
  403 after, 0 days, override cap) and the device cookie on `POST /auth/login`;
  `src/routes/mcp.test.ts` — no grace for MCP tokens.
- BCP `src/lib/mfaPolicy.test.ts`, webmail `src/lib/mfaEnforcement.test.ts` — warning data,
  remember choices, prompt visibility ("Später" only for the day).
