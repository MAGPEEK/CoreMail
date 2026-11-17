### Added

- **Per-protocol access switches** for IMAP, POP3, SMTP submission, ActiveSync, JMAP, CalDAV/CardDAV,
  Webmail and MAPI over HTTP on the server, domain and mailbox level. Domain and mailbox: `inherit`,
  `on` or `off`, the most specific value wins; the server level is `on` / `off` (a never-set server
  switch is the default: everything that existed before on, MAPI off — no change for existing
  installations). New table `protocol_policies` (additive). See `docs/protocol-access.md`.
- The switch is checked after a successful authentication in every service, with a protocol-specific
  answer: IMAP `NO [AUTHORIZATIONFAILED]`, POP3 `-ERR [AUTH]`, SMTP `535 5.7.1` (submission on 587/465
  only, not counted as an AUTH failure), ActiveSync/JMAP/CalDAV HTTP 403, web login and webmail API
  403 `PROTOCOL_DISABLED`. A wrong password keeps getting the normal "invalid credentials" answer; a
  switch that cannot be read is a temporary failure, never "allowed".
- Switching a protocol off ends the open connections of the affected accounts at once (new
  invalidation reason `protocol-access-change` with the disabled protocols): IMAP `* BYE` (also during
  IDLE), POP3 `-ERR`, SMTP `421`, ActiveSync Ping 403, JMAP WebSocket close / EventSource end, the
  webmail event stream of non-admin accounts. JMAP push subscriptions and Web Push stop as well.
- Webmail off never locks admins out of the BCP: accounts with an admin role still log in to the BCP
  and the admin CLI and keep the admin API, the event stream (without mailbox events) and their
  account security (MFA, app passwords, sessions). The webmail itself is refused for them too.
- Admin API `GET|PUT /api/v1/admin/protocol-access[/domains/:id|/users/:id]` (server/domain: area
  servers, user: area recipients, admin accounts ORGANIZATION_MANAGEMENT only), audited as
  `settings.protocol-access.update` with before/after.
- BCP: *Services → Protokollzugriff* (server, An/Aus), section in *Domain bearbeiten* and in the
  mailbox edit dialog (Erben/An/Aus, "Erben" shows what it resolves to), each with the effective value.
- CLI: `coremail protocol show|set --scope global|domain|user [target] --imap on|off|inherit …`
  (`inherit` only for domain and user).
- e2e step `protocols` (server level refuses inherit, IMAP off → IDLE session dropped, login refused
  and no IMAP server on the external clients page, Webmail off → web login and session refused,
  inherit → both work).

### Changed

- Autodiscover v1 announces only the account's enabled protocols (IMAP, else POP3; SMTP; MobileSync);
  Autodiscover v2 and Thunderbird autoconfig follow the mail domain's switches (v2: `404 NoSuchProtocol`)
  from an in-memory index — an anonymous request never causes a database query of its own; the Apple
  profile contains only enabled protocols (POP3 when IMAP is off). Unchanged while no switch is set.
- Webmail → Settings → External clients and `GET /api/v1/user/client-config` show only protocols
  switched on for the account (`protocols`; the setup data of a disabled protocol is `null`).
- The JMAP switch (`ServerSettings.jmapEnabled`, BCP Server page, `coremail connector … jmap`) is the
  server level of the JMAP protocol switch; the JMAP endpoints answer 404 only while no domain or
  mailbox switches JMAP on. Its API is unchanged.
- The webmail ends its session when an API call or a token refresh answers 403 `PROTOCOL_DISABLED`
  and shows a German message at login.

SemVer: MINOR (additive; default behaviour unchanged). `GET /api/v1/user/client-config` gained
`protocols` and nullable sections — only the webmail consumes it.
