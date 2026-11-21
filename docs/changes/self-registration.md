# Self-registration (target 10.6.0)

Changelog fragment for the `[10.6.0]` section (Keep a Changelog). MINOR: new optional feature,
new endpoints and settings, off by default; nothing removed or renamed; the schema change is
additive (three `ServerSettings` columns, tables `self_registrations` and
`self_registration_invites`).

### Added

- **Self-registration** (docs/self-registration.md): people create their own mailbox from the
  webmail sign-in page („Konto erstellen“, page `/register`, DE/EN/ES/IT). **Off by default** on
  fresh and existing installations. BCP → **Authentifizierung → Selbstregistrierung**: switch,
  allowed domains (none = registration impossible), approval mode („Admin-Freigabe“, default:
  the account stays inactive until an admin approves it; or „Sofort aktiv“), optional invite
  codes (created in the BCP, shown once, stored hashed, expiry and number of uses, revocable) and
  the list of registrations waiting for approval (approve → active, reject → account deleted;
  domain-scoped admins see their domains). Accounts get the role USER, the default quota and
  the default folders through the regular mailbox provisioning; the password policy applies.
- **Public endpoints** `GET /auth/register/config` and `POST /auth/register` (404 while off):
  reserved names (postmaster, abuse, admin, …) and taken addresses get one uniform answer
  (`409 ADDRESS_UNAVAILABLE`); budget of 10 attempts per client IP and hour and 200 per hour
  server-wide (`SELF_REGISTRATION_PER_IP_PER_HOUR`, `SELF_REGISTRATION_PER_HOUR`); honeypot field
  and a signed form token with a minimum fill time of 3 seconds (no third-party captcha); abuse
  signals count against the client IP in the shared lockout of the attack protection; every
  refusal is a `REGISTRATION_ABUSE` security event.
- **Admin endpoints** `/api/v1/admin/self-registration` (`/settings`, `/invites`, `/pending`,
  `/pending/:id/approve|reject`; area recipients — settings and invite codes organisation-wide
  only, approvals scoped per domain, docs/rbac.md).
- **Admin notice** for a pending registration through the admin-notice mail path of the attack
  protection (same recipients and delivery), at most one per 15 minutes.
- **Audit**: `auth.register.pending` / `.active` / `.approve` / `.reject`,
  `settings.self-registration.update`, `settings.self-registration.invite.create` / `.revoke` —
  always written (`auth.register.` joins `ALWAYS_AUDIT`).
