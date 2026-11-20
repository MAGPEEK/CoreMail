# Security review fixes for the 10.5 attack protection

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead (target 10.5.0 — fixes of unreleased 10.5 features; additive settings, no schema
change).

### Security

- **Repeat-offender auto-block no longer hits shared addresses** (`storage/attack-protection.ts`
  `autoBlockExemption`). Never auto-blocked: private (RFC 1918), CGNAT `100.64.0.0/10`, ULA
  `fc00::/7`, link-local and loopback ranges (Docker bridge networks and gateways, office NAT),
  the exceptions / `MAIL_AUTH_EXEMPT_CIDRS`, the proxies `TRUST_PROXY` names explicitly, and an
  IP with successful logins of ≥ 2 accounts or of an admin within 30 days (new Redis key
  `mailauth:ip:ok:<ip>:<acct>`). Automatic entries are **not applied to inbound port 25**
  (`ipAccessVerdict(ip, 'mx')`, SMTP factory) — only to client surfaces; manual entries keep
  their behaviour. Escalating lifetime **1 day → 7 days → `autoBlockDays`** (counted from the
  audit log, 90 days) instead of a flat 30 days.
- **Known-client exception can no longer defeat the account lock** (`storage/mail-auth-core.ts`).
  Each (account, known network) has its own failure budget (`MAIL_AUTH_ACCOUNT_MAX_FAILURES` per
  `MAIL_AUTH_ACCOUNT_WINDOW_SEC`); when used up the network loses the exception. An ActiveSync
  DeviceId (client-chosen) never grants the exception on its own — with a device id the network
  AND the device must be known. The per-IP counter counts **IPv6 per /64** (`ipLockIdOf`; IP
  locks, the lock view / release and automatic entries use the /64).
- **Server-generated mail counts against the account's send rate** (`consumeSendRate`, new
  protocol labels `calendar`, `rule`, `autoreply`, `receipt`): calendar invitations, updates and
  cancellations (REST — refused with `429 SEND_RATE_LIMITED` before anything is stored; every
  attendee is a recipient), read receipts (`429`), the ActiveSync `MeetingResponse` REPLY
  (Status 4), inbox-rule forwards / redirects (skipped over the limit, the inbound delivery is
  never refused, a "forward and delete" rule keeps the local copy) and out-of-office replies
  (counted, skipped over the limit, never blocking the delivery).
- **Global HTTP connection cap is no longer a cheap DoS lever** (`api-gateway/lib/http-hardening.ts`):
  IPv6 aggregate caps per /56 and /48 (`HTTP_MAX_CONNS_PER_V6_56` 600, `HTTP_MAX_CONNS_PER_V6_48`
  1200); a reserve near the global cap (`HTTP_CONN_RESERVE_PERCENT` 20, `HTTP_CONN_HEAVY_THRESHOLD`
  16) refuses the heaviest sources first and keeps room for light clients; a write-stall timeout
  (`HTTP_WRITE_STALL_TIMEOUT_MS` 60000) closes connections whose client stopped reading queued
  response bytes — SSE, ActiveSync Ping, MAPI NotificationWait and slow-but-reading clients are
  not affected.
- **X-Forwarded-For no longer feeds the escalation**: only an address from the socket or from an
  explicit `TRUST_PROXY` allow-list is auto-blocked or learned as a known network (gateway mark
  `X-CoreMail-Ip-Verified`, `lib/client-ip-trust.ts`; services read it with
  `clientIpInfoFromRequest`, the web login with `clientInfoOf().ipTrusted`). Addresses from a hop
  count / `TRUST_PROXY=true` are still counted and locked, never escalated. Startup warning when
  `TRUST_PROXY` is a hop count / `true` or covers the Docker bridge gateway.
- **WebSocket upgrades** (`/jmap/ws`) check the block list with the client IP derived by the same
  trust function as normal requests (`upgradeBlocked(req, guard, trustFn)`).
- **MCP tokens honour "MFA für alle Benutzer erzwingen"**: after the owner's grace deadline a
  token of an account without MFA is refused (`403 MFA_ENROLMENT_REQUIRED`; unreadable state →
  503).
- **No raw login text in admin notices or `attack_events`**: accounts are shown / stored only as
  normalised mail addresses; anything else becomes `(ungültige Eingabe, N Zeichen)`
  (`safeAccountLabel`, also applied by the security-event recorder).
- **Important security events are never sampled away**: locks and automatic blocks skip the
  global per-minute budget (own ceiling `SECURITY_EVENTS_IMPORTANT_PER_MIN`, default 10 × the
  global value).
- **Domain-scoped admins can no longer raise a mailbox's hourly send rate above the global
  value** (`PUT /api/v1/admin/mailboxes/:id/mail-flow` → `400 SEND_RATE_ABOVE_GLOBAL`);
  organisation-wide admins may.

Docs: `docs/attack-protection.md`, `docs/api-gateway-security.md`,
`docs/mail-protocol-limits.md`.
