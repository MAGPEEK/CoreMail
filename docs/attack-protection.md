# Attack protection (10.5)

BCP → Schutz → **Angriffsschutz** (`/bcp/attack-protection`) administers the
brute-force protection that every login front door shares, the permanent IP
block list, the exceptions, admin notifications and the escalation of repeat
offenders.

Code: `packages/storage/src/mail-auth-core.ts` (lockout core), `mail-auth.ts`
(wiring), `ip-access.ts` (block list / exceptions), `connect-guard.ts`
(connect-time checks), `security-events.ts` (attack dashboard),
`attack-protection.ts` (settings, notifications, repeat offenders, lock admin);
api-gateway `lib/ip-blocklist-guard.ts`, `lib/attack-protection-worker.ts`,
`routes/admin/security-protection.ts`; BCP `pages/AttackProtectionPage.tsx`.

## The shared lockout

Unchanged since v8.1 (see [mail-protocol-limits.md](mail-protocol-limits.md)):
Redis failure counters per client IP (50 failures / 15 min → 15 min lock,
doubling to 24 h) and per account (10 / 15 min → 5 min, doubling to 1 h),
checked on every attempt of SMTP AUTH, IMAP, POP3, ActiveSync, CalDAV/CardDAV,
JMAP, MAPI, Autodiscover, the web/API login (incl. the MFA step) and the admin
MCP interface. A success resets the **account** counter only. Without Redis the
lockout fails open (mail keeps working).

Redis keys (`LOCKOUT_KEYS`): `mailauth:{ip|acct}:{fail|lock|strikes}:<id>`; an
account id is `sha256(normalised e-mail)[:32]`. The IP id (`ipLockIdOf`) is the
IPv4 address, or the **IPv6 /64** (`2001:db8:1:2::/64`) — one subscriber owns a
whole /64, counting per address would give an attacker 2^64 fresh budgets
(10.5 review). New in 10.5:

| Key | TTL | Content |
|---|---|---|
| `mailauth:{ip\|acct}:info:<id>` | = the lock | JSON: protocol, failures, strikes, lock duration, time, the account label (accounts: the hash → e-mail mapping for the admin view; IPs: the last login tried), the IP |
| `mailauth:ip:locks:<ip>` | 7 days from the first lock | number of IP locks in the window (repeat offenders) |
| `mailauth:acct:known:<acct>:n:<hash>` | `MAIL_AUTH_KNOWN_CLIENT_DAYS` | a known client network of the account |
| `mailauth:acct:known:<acct>:d:<hash>` | `MAIL_AUTH_KNOWN_CLIENT_DAYS` | a known device id of the account |
| `mailauth:acct:knownfail:<acct>:<hash>` | `MAIL_AUTH_ACCOUNT_WINDOW_SEC` | 10.5 review: failures from that known network (its own budget) |
| `mailauth:ip:ok:<ip>:<acct>` | 30 days | 10.5 review: a successful login of the account from that IP id (`a` = admin, `u` = user) — read by the repeat-offender escalation |

**Account labels** (10.5 review): the account text in lock records, security
events (`attack_events.target`) and admin notices is the normalised login only
when it looks like a mail address; anything else (URLs, markup, quotes, control
characters …) becomes `(ungültige Eingabe, N Zeichen)` — raw login text is never
stored or mailed (`safeAccountLabel`).

## Known clients — no lockout of victims by strangers

Anybody who knows an address can lock its account with ten wrong passwords. To
keep the owner working:

1. Every **successful** login stores, for that account, the client **network**
   (IPv4 `/24`, IPv6 `/56`) and — when the front door has one — the **device id**
   (ActiveSync `DeviceId`, plain or base64 request line). Both are stored as
   account-bound SHA-256 hashes, valid for `MAIL_AUTH_KNOWN_CLIENT_DAYS` (30) and
   refreshed by every further success. The web login remembers the network on a
   completed login (password, or password + MFA) — not after the password step of
   an MFA login.
2. While the **account** is locked, a login from a known network is checked
   normally (password / app password / MFA rules unchanged). Every other client
   gets `locked` before any password work, as before. 10.5 review: a device id is
   client-chosen and **never grants the exception on its own** — when the front
   door presents one (ActiveSync), the network AND the device must be known.
3. Failed attempts of a known client still count — per IP and per account (a
   typo from the office extends the account lock; it does not hurt the office).
   10.5 review: they also count against the **own budget of that (account, known
   network)** — `MAIL_AUTH_ACCOUNT_MAX_FAILURES` (10) per
   `MAIL_AUTH_ACCOUNT_WINDOW_SEC` (15 min). When it is used up, the network loses
   the exception until the window ends, so an attacker sharing the victim's
   network (office NAT, a carrier /24) cannot keep guessing while the account is
   locked.
4. The **IP lock is never bypassed**: a known network whose IP is locked stays
   locked.
5. 10.5 review: only an address from the socket or a verified proxy (see
   "Forwarded addresses" below) is learned as a known network or grants the
   exception — an unverified X-Forwarded-For value never does.
6. `MAIL_AUTH_KNOWN_CLIENT_DAYS=0` disables the exception (pre-10.5 behaviour).

Limits: an attacker inside the owner's /24 is treated as known for at most 10
failures per 15 minutes per account (and the per-IP lock, 50 per 15 minutes,
still applies). A phone that roams to a network it never logged in from is
locked like everybody else while the account is locked.

## Forwarded addresses (TRUST_PROXY) — 10.5 review

The api-gateway derives the client IP with `TRUST_PROXY` (`req.ip`; the internal
services read the address the gateway puts into X-Forwarded-For). The address is
**verified** when it is the socket peer, or when it came from a proxy of an
**explicit allow-list** (`TRUST_PROXY=172.18.0.5`, a CIDR, `loopback` …); the
gateway marks it with `X-CoreMail-Ip-Verified: 1` (clients cannot send it — every
`X-CoreMail-*` header of a client is dropped). With a hop count (`TRUST_PROXY=1`)
or `true` any client that reaches port 3000 directly can choose the address:
such an address is still counted and locked, but it is **never escalated** (no
automatic block list entry), **never learned** as a known network and never
grants the known-client exception. SMTP, IMAP and POP3 always use the socket
peer. The api-gateway logs a warning at start when `TRUST_PROXY` is a hop count
or `true`, or covers the Docker bridge gateway (`docs/api-gateway-security.md`).

## Permanent block list and exceptions

Table `ip_access_rules` (Prisma `IpAccessRule`, enum `IpAccessKind`): `kind`
BLOCK / ALLOW, normalised `cidr` (host bits cleared, IPv6 compressed), `note`,
`auto`, `expiresAt` (null = permanent), `createdBy`; unique per kind + CIDR.

- **BLOCK** — refused on every protocol at connect: SMTP (25/587 with
  `554 5.7.1`, 465 dropped before the TLS handshake), IMAP and POP3 on the raw
  TCP socket before the greeting / the TLS handshake, every HTTP surface of the
  api-gateway with `403 {code: IP_BLOCKED}` (webmail, BCP, REST, `/auth`,
  ActiveSync, DAV, JMAP incl. the WebSocket upgrade, MAPI, Autodiscover, MCP —
  the HTTP middleware runs right after the request id; the client IP is `req.ip`,
  i.e. `TRUST_PROXY` aware; 10.5 review: WebSocket upgrades derive it with the
  same trust function). 10.5 review: **automatic** entries (repeat offenders) are
  not applied to inbound mail on **port 25** — other servers delivering mail
  never get a permanent 554 because a shared address tripped the login lockout;
  manual entries apply there as before.
- **ALLOW** ("Ausnahmen — nie sperren") — no per-IP failure counter (merged with
  `MAIL_AUTH_EXEMPT_CIDRS`), therefore never IP-locked, and exempt from the block
  list (an exception wins over a block entry). Account counters still apply.
- Loopback is always allowed and cannot be blocked.
- Every service keeps the active rules in memory: SMTP, IMAP, POP3 and the
  api-gateway load them at start (`startAttackProtection()`), refresh every 60 s
  and reload at once on `CHANNEL_SETTINGS_RELOAD {type:'ip-access'}`; services
  that only verify credentials (ActiveSync, DAV, JMAP, MAPI, Autodiscover) refresh
  lazily every 60 s for the exemption. A failed load keeps the last list (fail
  open, like the lockout without Redis).
- IMAP and POP3 additionally refuse IPs that are **currently locked** at connect
  (like SMTP since v7).

Validation (admin API): valid IP/CIDR; at least `/8` (IPv4) / `/16` (IPv6) —
neither list may cover a whole address family; no loopback in BLOCK; at most
1000 entries per list; a BLOCK entry that covers the admin's own IP needs
`confirmOwnIp: true` (409 `BLOCKS_OWN_IP` otherwise — the BCP asks). Expired
entries are ignored at once and purged hourly.

## Repeat offenders

An IP (IPv6: its /64) locked `autoBlockThreshold` (3) times within 7 days
(counted from its first lock in the window) is added to the block list
automatically: note `automatisch: wiederholte Sperre`, `createdBy` empty. An
existing entry (manual or automatic) is left alone; a full list is respected.
Every automatic entry writes the audit row `security.ip.autoblock` (actor
`system`, `changes.step` / `days`), the attack event `IP_AUTO_BLOCKED` and a
notice item. Removing an automatic entry in the BCP also resets the IP's repeat
counter. Switchable on the page.

10.5 review — an automatic entry can hit addresses many clients share (the
Docker userland proxy's bridge gateway for IPv6 clients, a reverse proxy without
`TRUST_PROXY`, an office NAT, carrier-grade NAT). Therefore:

- **Never auto-blocked** (`autoBlockExemption`): private (RFC 1918), CGNAT
  `100.64.0.0/10`, ULA `fc00::/7`, link-local, loopback — this covers the Docker
  bridge networks and gateways (`172.17.0.0/16`, `172.16.0.0/12`); custom Docker
  address pools outside these ranges belong into the exceptions — the
  exceptions and `MAIL_AUTH_EXEMPT_CIDRS`, the proxies `TRUST_PROXY` names
  explicitly, and an IP id with successful logins of **≥ 2 accounts or of any
  admin** within 30 days (`mailauth:ip:ok:*`). The lock itself still applies to
  all of them; only the escalation is skipped (log line "repeat offender NOT
  added to the block list").
- **Only verified addresses** are escalated (socket peer or an explicit
  `TRUST_PROXY` list — see "Forwarded addresses").
- **Escalating lifetime**: the first automatic entry of a range lasts **1 day**,
  the second (within 90 days, counted from the audit log) **7 days**, every
  further one `autoBlockDays` (30; 0 = permanent). A shorter `autoBlockDays`
  caps every step.
- **Client surfaces only**: automatic entries are not applied to inbound port 25
  (see above).

Manual entries keep their behaviour.

## Attack dashboard (all protocols)

`recordSecurityEvent()` writes `attack_events` rows (new additive column
`protocol`; older rows carry the protocol in `service`) and publishes the live
event (`CHANNEL_ADMIN_ATTACK`). Sources: every failure (`AUTH_BRUTE_FORCE`),
lock (`AUTH_LOCKOUT`) and refusal of a locked client (`AUTH_LOCKED`) of the
shared lockout, connect-time block list refusals (`IP_BLOCKLIST`), automatic
blocks (`IP_AUTO_BLOCKED`) and the SMTP connection limiter (`IP_RATE_LIMIT`).
10.6 self-service password reset (docs/password-reset.md, protocol `web`):
`PASSWORD_RESET_RATE_LIMIT`, `PASSWORD_RESET_INVALID_TOKEN`, `PASSWORD_RESET_MFA_FAILED`,
`RECOVERY_EMAIL_INVALID_TOKEN`; reset requests from blocked or locked client IPs are ignored
silently.

Bounded: at most `SECURITY_EVENTS_PER_IP_PER_MIN` (10) events per client IP and
minute (in the process and across processes via Redis `secevt:<ip>:<minute>`),
at most `SECURITY_EVENTS_PER_MIN` (300) per process and minute; locks and
automatic blocks ("important") skip the per-IP budget and — 10.5 review — the
global one too (a flood of failures must never hide a lock); they have their own
ceiling `SECURITY_EVENTS_IMPORTANT_PER_MIN` (10 × the global value). Loopback is not recorded. Rows older
than `ATTACK_EVENT_RETENTION_DAYS` (90) are purged hourly. The dashboard widget
and the page show the counts per protocol of the last 24 hours
(`GET /admin/security/attacks/summary` → `byProtocol`).

## Notifications

When an IP or an account is locked, an IP is put on the block list
automatically, or the failed logins of all protocols reach
`failureAlertThreshold` (200; 0 = off) within a 15-minute window, an item is
queued in Redis (`attackprot:notify:pending`, at most 500). The api-gateway
flushes the queue every minute into **one** aggregated mail — locked IPs and
accounts with count, protocols, level and duration, automatic entries, threshold
alerts — and then waits at least 15 minutes before the next one (items keep
aggregating; Redis-locked across instances).

Recipient: the address set on the page, else `ServerSettings.adminEmail`, else
the active Organization Management admins. A local recipient gets the mail
straight into the INBOX (internal path — works while the MX is under load), any
other address through the `smtp-outbound` queue. Switchable on the page (queued
items are dropped while it is off).

## Admin API

Area `hygiene` (write HYGIENE_MANAGEMENT, read VIEW_ONLY_ORG,
ORGANIZATION_MANAGEMENT both), **organisation-wide only** (`requireUnscoped`) —
see [rbac.md](rbac.md).

| Method + path (`/api/v1/admin/security/protection`) | Purpose | Audit |
|---|---|---|
| `GET /locks` | locked IPs and accounts (scope, id, e-mail, protocol, failures, strikes, remaining time, locks in 7 days); 503 without Redis | — |
| `POST /locks/release` `{scope: ip\|account, id, resetStrikes?}` | deletes lock + failure counter + info (+ backoff level and repeat counter with `resetStrikes`); `id` = IP (an IPv6 address or its `/64`), account hash or e-mail | `security.lock.release` |
| `GET /rules` | block list + exceptions, the caller's IP, the env exemptions | — |
| `POST /rules` `{kind, cidr, note?, expiresInDays?, confirmOwnIp?}` | add an entry (validation above) | `security.ip-rule.create` |
| `DELETE /rules/:id` | remove an entry | `security.ip-rule.delete` |
| `GET /settings`, `PUT /settings` | notifications + repeat offenders (+ the effective recipient) | `security.protection.settings.update` |

The `security.lock|ip|ip-rule|protection.*` actions are always audited, even
with the audit log switched off (`ALWAYS_AUDIT`).

## Testing the known-client rule by hand

The rule is unit-tested (`storage/src/mail-auth-protection.test.ts`,
`activesync/src/auth.test.ts`). On a running stack: log in once successfully
from network A (e.g. IMAP from the host), lock the account with ten wrong
passwords from network B (another host, a VPN, or a second Docker network whose
peer address is in a different /24), then log in from A again — it succeeds
while B still gets `locked`. Loopback cannot stand in for B: it is exempt from
the per-IP counter but not from the account lock, so it behaves like any other
unknown network unless it logged in successfully before. Ten more failures from
A within 15 minutes use up A's own budget — A is then locked too until the
window ends.
