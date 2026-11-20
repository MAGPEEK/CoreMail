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
account id is `sha256(normalised e-mail)[:32]`. New in 10.5:

| Key | TTL | Content |
|---|---|---|
| `mailauth:{ip\|acct}:info:<id>` | = the lock | JSON: protocol, failures, strikes, lock duration, time, the e-mail (accounts: the hash → e-mail mapping for the admin view; IPs: the last login tried), the IP |
| `mailauth:ip:locks:<ip>` | 7 days from the first lock | number of IP locks in the window (repeat offenders) |
| `mailauth:acct:known:<acct>:n:<hash>` | `MAIL_AUTH_KNOWN_CLIENT_DAYS` | a known client network of the account |
| `mailauth:acct:known:<acct>:d:<hash>` | `MAIL_AUTH_KNOWN_CLIENT_DAYS` | a known device id of the account |

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
2. While the **account** is locked, a login from a known network or with a known
   device id is checked normally (password / app password / MFA rules unchanged).
   Every other client gets `locked` before any password work, as before.
3. Failed attempts of a known client still count — per IP and per account (a
   typo from the office extends the account lock; it does not hurt the office).
4. The **IP lock is never bypassed**: a known network whose IP is locked stays
   locked.
5. A successful login through a known device from a new network makes that
   network known as well.
6. `MAIL_AUTH_KNOWN_CLIENT_DAYS=0` disables the exception (pre-10.5 behaviour).

Limits: an attacker inside the owner's /24 (or using a leaked DeviceId) is
treated as known — such attempts are still bounded by the per-IP lock (50 per
15 minutes). Device ids are not secret; they only ever widen access for a client
that also presents the right password.

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
  i.e. `TRUST_PROXY` aware).
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

An IP locked `autoBlockThreshold` (3) times within 7 days (counted from its first
lock in the window) is added to the block list automatically: note
`automatisch: wiederholte Sperre`, lifetime `autoBlockDays` (30; 0 = permanent),
`createdBy` empty. Exceptions are never escalated; an existing entry (manual or
automatic) is left alone; a full list is respected. Every automatic entry writes
the audit row `security.ip.autoblock` (actor `system`), the attack event
`IP_AUTO_BLOCKED` and a notice item. Removing an automatic entry in the BCP also
resets the IP's repeat counter. Switchable on the page.

## Attack dashboard (all protocols)

`recordSecurityEvent()` writes `attack_events` rows (new additive column
`protocol`; older rows carry the protocol in `service`) and publishes the live
event (`CHANNEL_ADMIN_ATTACK`). Sources: every failure (`AUTH_BRUTE_FORCE`),
lock (`AUTH_LOCKOUT`) and refusal of a locked client (`AUTH_LOCKED`) of the
shared lockout, connect-time block list refusals (`IP_BLOCKLIST`), automatic
blocks (`IP_AUTO_BLOCKED`) and the SMTP connection limiter (`IP_RATE_LIMIT`).

Bounded: at most `SECURITY_EVENTS_PER_IP_PER_MIN` (10) events per client IP and
minute (in the process and across processes via Redis `secevt:<ip>:<minute>`),
at most `SECURITY_EVENTS_PER_MIN` (300) per process and minute; locks and
automatic blocks skip the per-IP budget. Loopback is not recorded. Rows older
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
| `POST /locks/release` `{scope: ip\|account, id, resetStrikes?}` | deletes lock + failure counter + info (+ backoff level and repeat counter with `resetStrikes`); `id` = IP, account hash or e-mail | `security.lock.release` |
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
unknown network unless it logged in successfully before.
