### Added

- **Per-protocol access switches** for IMAP, POP3, SMTP submission, ActiveSync, JMAP, CalDAV/CardDAV,
  Webmail and MAPI over HTTP on the server, domain and mailbox level — each `inherit`, `on` or `off`,
  the most specific value wins; defaults: everything that existed before on, MAPI off (no change for
  existing installations). New table `protocol_policies` (additive). See `docs/protocol-access.md`.
- The switch is checked after a successful authentication in every service, with a protocol-specific
  answer: IMAP `NO [AUTHORIZATIONFAILED]`, POP3 `-ERR [AUTH]`, SMTP `535 5.7.1` (not counted as an AUTH
  failure), ActiveSync/JMAP/CalDAV HTTP 403, web login and webmail API 403 `PROTOCOL_DISABLED`. A wrong
  password keeps getting the normal "invalid credentials" answer.
- Switching a protocol off ends the open connections of the affected accounts at once (new
  invalidation reason `protocol-access-change` with the disabled protocols): IMAP `* BYE` (also during
  IDLE), POP3 `-ERR`, SMTP `421`, ActiveSync Ping 403, JMAP WebSocket close / EventSource end, the
  webmail event stream of non-admin accounts.
- Webmail off never locks admins out of the BCP: accounts with an admin role still log in and keep the
  admin API, the event stream and their account security (MFA, app passwords, sessions).
- Admin API `GET|PUT /api/v1/admin/protocol-access[/domains/:id|/users/:id]` (server/domain: area
  servers, user: area recipients, admin accounts ORGANIZATION_MANAGEMENT only), audited as
  `settings.protocol-access.update` with before/after.
- BCP: *Services → Protokollzugriff* (server), section in *Domain bearbeiten* and in the mailbox edit
  dialog, each with "Erben (an/aus)" and the effective value.
- CLI: `coremail protocol show|set --scope global|domain|user [target] --imap on|off|inherit …`.
- e2e step `protocols` (IMAP off → IDLE session dropped and login refused, Webmail off → web login and
  session refused, inherit → both work).

### Changed

- Autodiscover v1 announces only the account's enabled protocols (IMAP, else POP3; SMTP; MobileSync);
  Autodiscover v2 and Thunderbird autoconfig follow the mail domain's switches (v2: `404 NoSuchProtocol`);
  the Apple profile contains only enabled protocols (POP3 when IMAP is off). Unchanged while no switch
  is set.
- The JMAP switch (`ServerSettings.jmapEnabled`, BCP Server page, `coremail connector … jmap`) is the
  server level of the JMAP protocol switch; the JMAP endpoints answer 404 only while no domain or
  mailbox switches JMAP on. Its API is unchanged.
- The webmail ends its session when a token refresh answers 403 `PROTOCOL_DISABLED` and shows a
  German message at login.

SemVer: MINOR (additive; default behaviour unchanged).
