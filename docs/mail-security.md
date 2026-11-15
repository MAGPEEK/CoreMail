# Inbound / outbound mail security

This page describes how CoreMail authenticates inbound mail (port 25), what it
does with the result, and the hardening switches of the SMTP transport.

## Sender authentication (SPF, DKIM, DMARC)

The security-filter (`POST /check/content`) evaluates every message received on
port 25 with the data of the real SMTP session:

| Check | Input |
|-------|-------|
| SPF   | client IP + envelope `MAIL FROM` (null sender: `postmaster@<HELO>`) + HELO name |
| DKIM  | signatures in the message |
| DMARC | header `From` domain, aligned SPF/DKIM pass, published policy (`p`, `sp` for subdomains) |

smtp-server passes `mailFrom`, `helo`, `hostname` (our authserv-id), `rcpts`
and, for an authenticated session, `authUser` in `X-Filter-Context`.

Decisions (unauthenticated sessions only):

1. **Local-domain anti-spoofing** — when `MAIL FROM` or the header `From` uses
   one of our own (active) domains, the message must be authenticated for that
   domain: DMARC pass, or SPF/DKIM pass for an aligned domain (equal, or parent /
   subdomain). Otherwise `550 5.7.1 Unauthenticated mail claiming local domain …`.
   Devices or applications that send mail "as" a local domain through port 25
   must use SMTP submission (587/465 with AUTH) or be covered by SPF.
2. **DMARC policy** — on `dmarc=fail` the published policy applies:
   `p=reject` → `550 5.7.1`, `p=quarantine` → delivered to Junk, `p=none` →
   only recorded. `dmarc=none` (no record) and `temperror` never reject.
   Mailing lists that break DKIM and are not ARC-trusted are rejected when the
   original domain publishes `p=reject` (same as other strict receivers).

Every delivered message gets `Received-SPF:` and an RFC 8601
`Authentication-Results: <hostname>; …` header. Incoming
`Authentication-Results` fields that carry our own host name as authserv-id are
removed before filtering (they could only be forged).

rspamd receives the session as well (`IP`, `Helo`, `From`, `Rcpt` per
recipient, `User` for authenticated sessions, `MTA-Name`).

### Where the verdict is used

* **iTIP REPLY** (`@coremail/storage` `processITipInbound`): an attendee's
  PARTSTAT is only updated when the attendee is authenticated — the message
  passed DMARC/SPF/DKIM for a domain aligned with the attendee's domain, or the
  envelope sender is the authenticated local user (SMTP submission, REST, JMAP,
  ActiveSync). The mail itself is still delivered.
* **Resource mailboxes**: bookings are scoped to the resource's calendar. An
  existing booking is updated or cancelled only by its stored organizer, and
  only when that sender is authenticated. A new request from an unauthenticated
  sender is stored as `PENDING` (manual approval) instead of being auto-accepted.

## Mail rules (`regex` conditions)

User rule patterns are executed by a linear-time matcher
(`@coremail/storage` `matchRulePattern`), never by the backtracking JS engine:
at most 200 characters, input capped at 64 KB, no backreferences, lookarounds
or named groups; bounded repetitions up to `{100}`. API routes should validate
patterns with `validateRulePattern()` when a rule is saved; invalid patterns
never match.

## Failure policy

| Variable | Default | Effect |
|----------|---------|--------|
| `SECURITY_FILTER_FAIL_OPEN` | `false` | An unexpected exception in the content pipeline answers `defer` (smtp-server: `451 4.7.1`, the sender retries). `true` restores the old accept-unscanned behaviour. |

## Outbound

| Variable | Default | Effect |
|----------|---------|--------|
| `OUTBOUND_ALLOW_PRIVATE_MX` | `false` | MX / implicit-MX hosts that resolve to loopback, private, link-local, CGNAT or reserved addresses are refused with a permanent `5.4.4` (no connection to internal port 25). The connection goes to the checked address (no DNS rebinding). `true` only for lab setups with internal MX hosts. The admin-configured smarthost is not affected. |
| `OUTBOUND_DELAY_DSN_HOURS` | `4` | When a message is still being retried after this many hours, the sender gets one delay notification (RFC 3464 `Action: delayed`, `Status: 4.4.7`, `Will-Retry-Until`). `0` disables it. |

Message expiry stays time-based through BCP → Queues →
`outboundRetentionHours` (default 48 h): after that the job ends with a final
DSN. Loop detection rejects messages with more than 100 `Received:` fields
(`554 5.4.6`).

## Tarpit (port 25)

| Variable | Default | Effect |
|----------|---------|--------|
| `SMTP_TARPIT_MAX_DELAY_MS` | `5000` | After 3 permanent (5yz) replies in an unauthenticated port-25 session (unknown recipients, protocol errors, rejects), each further command is answered after 1 s, 2 s, … up to this maximum. `0` disables the tarpit. Submission ports are never tarpitted. |
