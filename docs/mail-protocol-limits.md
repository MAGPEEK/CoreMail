# Mail protocol limits (IMAP, POP3, shared login lockout, send rate)

Resource limits and brute-force protection of the TCP mail protocols (v9.0).
All values are environment variables of the `coremail` app container; a limit of
`0` (or a negative value) disables that check.

Set them in `.env`; the shipped Compose files pass them through to the `coremail` container (Helm: `app.mailAuth.*` or `app.extraEnv`).

## Connection limits

Checked on the raw TCP connection, before the greeting and — on the implicit-TLS
ports 993/995 — before the TLS handshake.

| Variable | Default | Meaning |
|----------|---------|---------|
| `IMAP_MAX_CONNS_PER_IP` | `50` | Concurrent IMAP connections per client IP. Above it: `* BYE [UNAVAILABLE] Too many connections` (port 143) or the connection is dropped (port 993). |
| `IMAP_MAX_CONNS` | `2000` | Concurrent IMAP connections per process (all clients). |
| `IMAP_MAX_CONNS_PER_USER` | `20` | Concurrent authenticated IMAP sessions per user. A login above it is answered with `NO [LIMIT]`. |
| `POP3_MAX_CONNS_PER_IP` | `50` | Concurrent POP3 connections per client IP (`-ERR [SYS/TEMP] too many connections`). |
| `POP3_MAX_CONNS` | `1000` | Concurrent POP3 connections per process. |
| `MAIL_CONN_EXEMPT_CIDRS` | *(empty)* | Comma-separated IPs/CIDRs without the per-IP cap (the global cap still applies). Loopback is always exempt. |

POP3 allows one session per maildrop anyway (RFC 1939 §4 lock, `-ERR [IN-USE]`).

### Offices behind NAT

Behind a NAT gateway or a proxy that does not preserve the client address, every
client shares one IP. A desktop IMAP client keeps 3–10 connections open (one
per watched folder plus IDLE), phones 1–3 — so 10 users behind one office
router can already need 50+ connections. The per-IP default is 50 since 9.0
(was 20). For larger offices:

* list the office's public address in `MAIL_CONN_EXEMPT_CIDRS` (e.g.
  `MAIL_CONN_EXEMPT_CIDRS=203.0.113.10,198.51.100.0/28`) — no per-IP connection
  cap for it, the global cap still applies;
* list it in `MAIL_AUTH_EXEMPT_CIDRS` as well when many users log in from there,
  so one user's typos cannot trip the **per-IP** login-failure counter for the
  whole office (the per-account counter still applies, see below);
* or raise `IMAP_MAX_CONNS_PER_IP` / `POP3_MAX_CONNS_PER_IP`.

## Timeouts and size caps (fixed)

| Protocol | Rule |
|----------|------|
| IMAP | Before authentication a command line and the literals of one command are capped at 8 KiB (`LOGIN`/`AUTHENTICATE` included); larger literals get `NO [TOOBIG]` (synchronizing) or `BYE` + close (non-synchronizing). After login the message-size limit (`maxMessageSizeMb`) applies. |
| IMAP | Idle timeout 60 s before authentication, 30 min afterwards (RFC 9051 §5.4). |
| IMAP / POP3 | A STARTTLS/STLS handshake must complete within 30 s; implicit TLS handshakes likewise. |
| POP3 | Command lines ≤ 512 octets (RFC 2449), autologout after 10 min idle (RFC 1939 §3). |

## Shared login lockout (all mail protocols)

`verifyMailCredentials` (`packages/storage/src/mail-auth-core.ts`) counts failed
logins per client IP and per account in Redis and locks with exponential backoff
(`MAIL_AUTH_IP_*`, `MAIL_AUTH_ACCOUNT_*`, see `mail-auth.ts`).

Since v9.0 **private addresses are counted like public ones**: behind a reverse
proxy or the Docker userland proxy every attacker would otherwise appear as an
exempt private peer. Only loopback is exempt by default. 10.5 review: IPv6
clients are counted per **/64** (one subscriber owns the whole /64), IPv4
clients per address.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAIL_AUTH_EXEMPT_CIDRS` | *(empty)* | Comma-separated IPs/CIDRs exempt from the **per-IP** failure counter (e.g. an internal webmail or monitoring host). The per-account counter always applies. Invalid entries are ignored and logged. |

`MAIL_AUTH_LIMIT_PRIVATE_IPS` (pre-9.0) is obsolete and ignored — counting private
addresses is now the default.

## Outgoing send rate per account (all submission paths, 10.5)

A compromised account must not be able to spam: every client submission path
counts the **messages** and the **recipients** an account sends per sliding
hour and refuses a submission that would exceed either limit. One limiter for
all paths — `packages/storage/src/submission-rate.ts` (`consumeSendRate` /
`peekSendRate`).

| Setting | Default | Where |
|---|---|---|
| on / off | on | BCP → SMTP & Routing → Sendelimit (`ServerSettings.sendRateLimitEnabled`) |
| messages per hour and account | `200` | same (`sendRateMessagesPerHour`, 1–100000) |
| recipients per hour and account | `1000` | same (`sendRateRecipientsPerHour`, 1–1000000) |
| block the account for one hour when the limit is exceeded | off | same (`sendRateBlockOnExceed`) |
| per account | global value | BCP → edit mailbox → Nachrichtenfluss (`MailFlowPolicy.maxMessagesPerHour` / `maxRecipientsPerHour`, user mailboxes only), admin API `PUT /api/v1/admin/mailboxes/:id/mail-flow`. 10.5 review: a **domain-scoped** admin may not set a value above the global one (`400 {code: SEND_RATE_ABOVE_GLOBAL}`); organisation-wide admins may. |

Admin API: `GET/PUT /api/v1/admin/smtp-config/send-rate` (`{enabled, messagesPerHour,
recipientsPerHour, blockOnExceed}`, partial PUT; area *servers*, organisation-wide like
every `/smtp-config` route; audited as `settings.send-rate.updated`). Services read the
settings with a 60 s cache; a save clears it at once in every service that listens on
`CHANNEL_SETTINGS_RELOAD` for the submission limits (REST, JMAP, ActiveSync), otherwise
after at most 60 s (SMTP, MAPI).

**Counting.** Key = the authenticated account; mail sent as / on behalf of a
Shared Mailbox counts against the user who sends it. A message counts once with
its envelope recipients (de-duplicated where the path does so), right before it
is accepted / queued and after every other check — a message refused for another
reason (size, sender, quota) is not counted, nor is a refused one. Sliding-window
counter: two fixed hour windows in Redis (`sendrate:<userId>:<window>`), the
previous one weighted by the part still inside the last hour; check and increment
are one Lua script (no race between processes). A single message with more
recipients than the hourly recipient limit is never accepted — keep the hourly
recipient limit at or above the per-message recipient limit (BCP SMTP *max. recipients*).

**Redis down.** Not ready, slower than 500 ms or failing → the same counter in
the process memory, one warning per minute. Each process then counts on its own
(fail-open across processes until Redis is back, never "unlimited" in one
process). An unexpected limiter error lets the submission through with an error
log line — the limiter never blocks mail on its own failure.

**Answers per protocol** (all temporary — the client keeps the message):

| Path | Answer |
|---|---|
| SMTP submission 587/465 | `451 4.7.1 Sending rate limit exceeded (max N messages\|recipients per hour), try again in S seconds` at the end of DATA; once the account is at its message limit (or blocked) already at `MAIL FROM` (no data transfer). Blocked: `451 4.7.1 Sending temporarily suspended for this account …` |
| Webmail / REST (`POST /mail/send`, `POST /mail/drafts/:id/send`, undo hold) | `429` + `Retry-After`, body `{code: 'SEND_RATE_LIMITED', reason, limit, retryAfter}`; a draft stays in Drafts |
| ActiveSync SendMail / SmartReply / SmartForward | 14.x: Status `111` ServerErrorRetryLater ([MS-ASCMD] common status); 12.1: HTTP `503`. The ClientId / Message-ID retry key is released, so the device's retry is sent later; a retry of an already sent message is not counted |
| JMAP `EmailSubmission/set` | SetError `rateLimit` (RFC 8620 §5.3, inherited by RFC 8621 §7.5) |
| MAPI `RopSubmitMessage` | `ecQuotaExceeded` (the submission-quota error of the existing mapping) |

**Mail the server sends for an account (10.5 review)** counts against the same
budget of the account that causes it (protocol label in the audit / attack event):

| Path | Counted | Over the limit |
|---|---|---|
| Calendar invitations, updates, cancellations (REST `POST/PUT/DELETE /api/v1/calendar/events…`, also single occurrences) | the acting user, 1 message with every attendee as a recipient (`calendar`) | `429` + `Retry-After`, `{code: 'SEND_RATE_LIMITED', reason, limit, retryAfter}` **before anything is stored** — the event is not created / changed / deleted; a change that mails nobody is never refused |
| Read receipts (`POST /api/v1/mail/messages/:id/receipt`) | the user, 1 recipient (`receipt`) | `429` like above, no receipt sent |
| ActiveSync `MeetingResponse` REPLY (EAS 16 + SendResponse) | the user, 1 recipient (`activesync`) | Status `4` (server error, the device retries later), no REPLY |
| Inbox-rule forwards / redirects | the rule's owner, 1 recipient each (`rule`) | the forward is skipped; the inbound delivery is never refused and a "forward and delete" rule keeps the local copy (trace `inbox-rules: forwardsSkippedSendRate`) |
| Out-of-office replies | the user, 1 recipient (`autoreply`) | the reply is skipped (checked before the sender is marked as answered); the inbound delivery is never affected |

Not counted: the admin forwarding of a mailbox (`MailFlowPolicy.forwardTo`, an
admin setting), transport rules, DSNs / bounces and system notices.

The REST burst limiter in front of the webmail routes (`MAIL_SEND_RATE_LIMIT`,
30 requests / 60 s, docs/api-gateway-security.md) stays: it counts *requests*
per minute (including invalid ones); the hourly limiter counts *sent messages*.
They do not count the same thing twice.

**When an account hits the limit** (first refusal per account and hour, claimed
across processes): audit entry `mail.send.rate-limited` (actor = the account,
protocol, reason, limits, client IP where known; respects the global audit
switch), an `AttackEvent` row of type `SEND_RATE_LIMIT` (service = protocol;
published live on the BCP dashboard channel), and a notice into the inbox of the
organisation's administrator address (BCP → Einstellungen → Organisation
`adminEmail`, when it is a local user, Shared Mailbox or alias; otherwise every
active ORGANIZATION_MANAGEMENT admin): *„Konto X hat das Sendelimit erreicht —
möglicherweise kompromittiert"*. Further refusals within the hour are only
logged. With *block on exceed* the account may not send at all for one hour
after the first refusal (`retryAfter` = the remaining block time); the block
ends by itself — reset the password / revoke app passwords and sessions of a
compromised account in the meantime.

### Attack protection (10.5)

The lockout is administered in BCP → Schutz → **Angriffsschutz** — see
[attack-protection.md](attack-protection.md) for the full model. In short:

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAIL_AUTH_KNOWN_CLIENT_DAYS` | `30` | How long a successful login keeps its client network (IPv4 /24, IPv6 /56) and — for ActiveSync — its DeviceId "known" for the account. A locked **account** still accepts logins from a known network (failures keep counting); `0` switches this off. The IP lock is never bypassed. 10.5 review: a DeviceId alone never grants this (with a DeviceId, network AND device must be known); each known network has its own budget of `MAIL_AUTH_ACCOUNT_MAX_FAILURES` failures per `MAIL_AUTH_ACCOUNT_WINDOW_SEC`, after which it is locked like a stranger; only verified client addresses (socket / explicit `TRUST_PROXY` list) are learned. |
| `SECURITY_EVENTS_PER_IP_PER_MIN` | `10` | Attack dashboard events per client IP and minute (sampling; the counters are not affected). |
| `SECURITY_EVENTS_PER_MIN` | `300` | Attack dashboard events per process and minute in total (locks and automatic blocks are never dropped for it — 10.5 review). |
| `SECURITY_EVENTS_IMPORTANT_PER_MIN` | `3000` (10 × the above) | 10.5 review: ceiling of lock / automatic-block events per process and minute. |
| `ATTACK_EVENT_RETENTION_DAYS` | `90` | Attack events older than this are purged hourly (`0` = keep). |

- **Connect-time refusal:** SMTP (all listeners), IMAP and POP3 refuse IPs that are
  currently locked by the shared lockout **and** IPs on the permanent block list —
  on the raw TCP socket, before the greeting and before the TLS handshake on
  465/993/995 (IMAP `* BYE [UNAVAILABLE]`, POP3 `-ERR [SYS/TEMP]` / `[SYS/PERM]`,
  SMTP `421 4.7.1` / `554 5.7.1`).
- **Exceptions** of the BCP list ("nie sperren") are merged with
  `MAIL_AUTH_EXEMPT_CIDRS`: no per-IP counter, never on the block list.
- 10.5 review: **automatic** block list entries (repeat offenders) never apply
  to inbound mail on port 25 (only manual ones do), are never created for
  private / CGNAT / ULA / link-local addresses, `TRUST_PROXY` proxies or IPs
  with successful logins of ≥ 2 accounts or an admin, and last 1 day → 7 days →
  `autoBlockDays` (attack-protection.md).
- Every failure, lock and refusal of every protocol (SMTP, IMAP, POP3, web/API,
  ActiveSync, CalDAV/CardDAV, JMAP, MAPI, Autodiscover, MCP) is recorded in the
  attack dashboard with its protocol.
