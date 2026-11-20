# Attack protection ("Angriffsschutz")

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead (target 10.5.0 — additive schema, new settings and page, compatible behaviour).
Details: [docs/attack-protection.md](../attack-protection.md).

### Added

- **BCP → Schutz → Angriffsschutz** (`/bcp/attack-protection`): currently locked IP addresses
  and accounts of every protocol (accounts shown by e-mail, with protocol, failures, level,
  remaining time and the IP's locks within 7 days) with **Entsperren** (optionally also
  resetting the backoff level); events per protocol of the last 24 hours; the permanent IP
  block list; the exceptions ("nie sperren"); notifications; repeat offenders. Area hygiene,
  organisation-wide admins only.
- **Permanent IP block list and exceptions** (new table `ip_access_rules`, enum
  `IpAccessKind`): IPv4/IPv6 addresses and CIDR ranges, optional note and lifetime. Block list
  entries are refused on every protocol at connect — SMTP (all listeners, 465 before the TLS
  handshake), IMAP and POP3 on the raw socket before the greeting / TLS, every HTTP surface of
  the api-gateway (webmail, BCP, API, ActiveSync, CalDAV/CardDAV, JMAP incl. WebSocket, MAPI,
  Autodiscover, MCP: `403 IP_BLOCKED`). Exceptions are exempt from the per-IP lockout counter
  (merged with `MAIL_AUTH_EXEMPT_CIDRS`) and from the block list. Every service caches the
  rules (60 s refresh, immediate reload on change).
- **IMAP and POP3 refuse IPs that are currently locked** at connect, like SMTP.
- **All protocols in the attack dashboard**: failures, locks and refusals of the shared
  lockout (IMAP, POP3, SMTP, web/API, ActiveSync, CalDAV/CardDAV, JMAP, MAPI, Autodiscover,
  MCP) and block list refusals are recorded with their protocol (new additive column
  `attack_events.protocol`); sampled to at most 10 events per IP and minute
  (`SECURITY_EVENTS_PER_IP_PER_MIN`) and 300 per process and minute (`SECURITY_EVENTS_PER_MIN`);
  events older than 90 days are purged (`ATTACK_EVENT_RETENTION_DAYS`). The dashboard widget
  shows the counts per protocol (`/admin/security/attacks/summary` → `byProtocol`).
- **Admin notifications**: locks, automatic block list entries and a failure threshold
  (200 failed logins in 15 minutes, configurable, 0 = off) produce one aggregated mail at most
  every 15 minutes, listing IPs, accounts and protocols — to the address set on the page, else
  `ServerSettings.adminEmail`, else the Organization Management admins. Switchable (new
  singleton table `attack_protection_settings`).
- **Repeat offenders**: an IP locked 3 times within 7 days is added to the block list
  automatically ("automatisch: wiederholte Sperre", 30 days by default, 0 = permanent;
  threshold, lifetime and the switch on the page); audit `security.ip.autoblock`.
- Admin API `/api/v1/admin/security/protection` (`/locks`, `/locks/release`, `/rules`,
  `/rules/:id`, `/settings`) — audited as `security.lock.release`, `security.ip-rule.create`,
  `security.ip-rule.delete`, `security.protection.settings.update` (always logged).

### Security

- **No lockout of victims by strangers**: while an account is locked, logins from a network
  (IPv4 /24, IPv6 /56) or an ActiveSync device that logged in successfully for this account
  within the last 30 days (`MAIL_AUTH_KNOWN_CLIENT_DAYS`, 0 = off) are still checked; failures
  keep counting per IP and per account, the IP lock is never bypassed. Everybody else still
  gets the lock. Remembered as account-bound hashes in Redis.
- Every lock stores an info record next to it (same TTL) so locked accounts can be shown by
  e-mail although the lock keys are hashed.
- Block list entries cannot cover loopback or more than an IPv4 /8 / IPv6 /16; blocking the
  admin's own IP needs an explicit confirmation.

### Changed

- The SMTP server no longer publishes its own `AUTH_BRUTE_FORCE` events (the shared lockout
  records them for every protocol); its connection-limit events go through the shared,
  sampled recorder.
- `sharedLoginLockout(protocol)` takes the login surface (`web` default, `mcp` for the admin
  MCP interface); `LoginLockout.check/success` accept the client IP (and device id) for the
  known-client rule.
