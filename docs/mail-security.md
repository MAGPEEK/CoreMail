# Inbound / outbound mail security

This page describes how CoreMail authenticates inbound mail (port 25), what it
does with the result, and the hardening switches of the SMTP transport.

Set the environment variables below in `.env`; the shipped Compose files pass them through to the `coremail` container (Helm: `app.*` values or `app.extraEnv`).

Transport TLS certificates for SMTP/IMAP/POP3 (assignment, served-certificate check, startup
repair): see [certificates.md](certificates.md).

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

Decisions (unauthenticated sessions only — SMTP submission with AUTH is never
affected):

1. **Exactly one From mailbox** (9.0) — a message whose header has no `From`
   field, several `From` fields, or a `From` with more than one mailbox
   (`From: ceo@ourdomain, x@evil.test`) is refused with
   `550 5.7.1 multiple or missing From`. DMARC cannot evaluate such a message
   (it would otherwise pass as `dmarc=none` and bypass the anti-spoofing check).
   RFC 5322 allows several mailboxes only together with a `Sender` field; like
   most MTAs, CoreMail refuses this for unauthenticated inbound mail.
2. **Local-domain anti-spoofing** — when `MAIL FROM` or the header `From` uses
   one of our own (active) domains, the message must be authenticated for that
   domain: DMARC pass, or SPF/DKIM pass for an aligned domain (equal, or parent /
   subdomain). What happens otherwise is set by `LOCAL_SPOOF_ACTION` (below).
3. **DMARC policy** — on `dmarc=fail` the published policy applies:
   `p=reject` → `550 5.7.1`, `p=quarantine` → delivered to Junk, `p=none` →
   only recorded. `dmarc=none` (no record) and `temperror` never reject.
   `pct` is honoured (RFC 7489 §6.6.4, 9.0): with `pct=N` only N % of the
   failing messages (random sample) get the policy, the rest the next weaker one
   (`reject` → Junk, `quarantine` → only recorded). Mailing lists that break
   DKIM are rejected when the original domain publishes `p=reject`, unless they
   are ARC-trusted (below).

### Local-domain anti-spoofing settings (9.0, BCP since 9.4)

Since 9.4 the three settings are edited in **BCP → Schutzfilter → Spoofing**
(`GET/PUT /api/v1/admin/security/spoofing`, stored in `SecuritySettings.localSpoofAction`,
`localSpoofAllow`, `arcTrustedSealers`; every change is audited as
`settings.spoofing.update` and the security filter applies it at once through the
settings-reload channel). The 9.0 environment variables stay: a variable that is
**set** (non-empty) overrides its BCP field, which the BCP then shows read-only with
the variable name — deployments that configured them keep their behaviour. The
values and their meaning:

| Variable / BCP field | Default | Effect |
|----------|---------|--------|
| `LOCAL_SPOOF_ACTION` | `policy` | `policy`: follow the local domain's **own** published policy. Header `From` of a local domain: our DMARC `p=reject` → `550 5.7.1 Unauthenticated mail claiming local domain …`; `p=quarantine`, `p=none` or no DMARC record → delivered to **Junk** with an extra `Authentication-Results: <host>; x-local-spoof=fail … header.from=<domain>` field. `MAIL FROM` of a local domain only: SPF hard fail (our `-all`) → 550, otherwise Junk + tag. `junk`: always Junk + tag, never reject. `reject`: always `550 5.7.1` (the pre-9.0 behaviour). |
| `LOCAL_SPOOF_ALLOW` | *(empty)* | Comma-separated trusted third-party senders that may use a local domain without alignment: IPs / CIDRs (matched against the client IP) and domains (matched against the domains the message is **authenticated** for — SPF pass or DKIM `d=`; subdomains included), e.g. `LOCAL_SPOOF_ALLOW=203.0.113.25,198.51.100.0/24,sendgrid.net,mcsv.net`. Such mail is also exempt from our own DMARC reject. Invalid entries are logged and ignored. |
| `ARC_TRUSTED_SEALERS` | *(empty)* | Comma-separated ARC sealer domains (e.g. `google.com,microsoft.com,lists.example.org`). A **passing** ARC chain whose newest seal comes from such a sealer (or a subdomain) overrides the local-domain check and any DMARC reject/quarantine — unless that sealer's own ARC-Authentication-Results recorded `dmarc=fail`. |

Why `policy` is the default: our own domain with `p=none` (or no record yet)
says "do not reject unaligned mail" — contact forms on a web host, SaaS tools
(newsletters, ticket systems, CRM) and mailing lists legitimately send with a
local `From`. They now land in Junk (visible, flagged) instead of being
rejected. Publish `p=reject` for your domains once SPF/DKIM are in place to get
hard rejects back, or choose „Immer ablehnen“ (`reject`) in the BCP.

Devices or applications that send mail "as" a local domain should use SMTP
submission (587/465 with AUTH), be covered by SPF/DKIM, or be listed in
`LOCAL_SPOOF_ALLOW`.

Every delivered message gets `Received-SPF:` and an RFC 8601
`Authentication-Results: <hostname>; …` header. Incoming
`Authentication-Results` fields that carry our own host name as authserv-id are
removed before filtering (they could only be forged). Since 9.0 the same
stripping applies to every **local** delivery path — SMTP submission, the
outbound worker for MWA/REST, JMAP and ActiveSync, and rule forwards — for all
our authserv-ids (`ServerSettings.publicHostname`, `SMTP_HOSTNAME`,
`MAIL_HOSTNAME`), so a local user cannot hand a colleague a forged
`dmarc=pass`. Only a BCP quarantine release keeps the original inbound verdict.

The content filter context lists at most 100 recipients (plus `rcptCount`
with the total) so the `X-Filter-Context` header stays far below the HTTP
header limit for messages with many recipients.

rspamd receives the session as well (`IP`, `Helo`, `From`, `Rcpt` per
recipient, `User` for authenticated sessions, `MTA-Name`).

### Where the verdict is used

* **iTIP REPLY** (`@coremail/storage` `processITipInbound`): an attendee's
  PARTSTAT is only updated when the attendee is authenticated — the message
  passed DMARC/SPF/DKIM for a domain aligned with the attendee's domain, or the
  envelope sender is the authenticated local user (SMTP submission, REST, JMAP,
  ActiveSync). The mail itself is still delivered.
* **Resource mailboxes**: bookings are scoped to the resource's calendar
  (unique per calendar + iCal UID since 9.0, so one meeting can book several
  rooms). The organizer is the iCal `ORGANIZER` (`mailto:`), else the header
  `From` — never the envelope sender, so updates through mailing lists or
  forwarders with SRS/VERP return paths work (9.0). An existing booking is
  updated or cancelled only by its stored organizer, and only when that
  identity is authenticated (domain aligned with a verified domain, or the
  authenticated local sender). A new request from an unauthenticated sender is
  stored as `PENDING` (manual approval) instead of being auto-accepted.
  Invitations from local users (MWA, JMAP, ActiveSync, SMTP submission) reach
  rooms as well (9.0) — they are processed on every delivery path. A local
  recipient that does not exist (anymore) at delivery time is never dropped
  silently: the sender gets an NDR (`5.1.1`).

## Sender lists (block / allow, 9.4)

**BCP → Schutzfilter → Absenderlisten** manages the sender lists (table `blacklist`,
API `/api/v1/admin/security/sender-lists`, hygiene permission: read-only roles may
view and export). Each entry has

- a **list**: `BLOCK` (Sperrliste) or `ALLOW` (Zulassungsliste);
- a **scope**: `GLOBAL` (every recipient), `DOMAIN` (recipients of one local domain)
  or `USER` (one mailbox — its aliases included);
- a **pattern** matched against the envelope sender (`MAIL FROM`): `EXACT` (a complete
  address, case-insensitive), `WILDCARD` (`*` = any run, e.g. `*@werbung.example`) or
  `REGEX` (linear-time matcher, the same limits as mail rules — refused when saved).

Evaluation, per recipient: the **most specific scope** with a matching entry decides
(USER before DOMAIN before GLOBAL), and inside that scope an ALLOW entry wins over a
BLOCK entry. So a user can allow a sender the organisation blocks, and a user's block
beats an organisation-wide allow. The null sender (`<>`, bounces) is never listed.

- **RCPT TO** (port 25, unauthenticated sessions): a BLOCK verdict refuses that
  recipient with `550 5.7.1 Sender blocked` before greylisting; other recipients of the
  same transaction are unaffected.
- **After DATA**: the message is refused when every recipient blocks the sender (a
  fallback for an unreachable filter at RCPT time). When every recipient **allows** the
  sender, the spam verdict (Junk / reject by score) is skipped — but only when the
  envelope sender's domain is authenticated (SPF or DKIM pass, aligned). An allow entry
  never bypasses SPF/DKIM/DMARC, the local-domain check, the attachment filter or the
  virus scan.
- Webmail "Junk" actions keep their own per-user entries (`USER-JUNK`, delivered to
  Junk); they are not shown in the BCP.

**CSV import/export**: `GET …/sender-lists/export.csv` and `POST …/sender-lists/import`
(`{ "csv": "…" }`, at most 5000 rows / 1 MB). Columns:
`listType,scope,target,patternType,pattern,comment,active` — `target` is empty for
GLOBAL, the domain name for DOMAIN and the mailbox address for USER. Cells starting
with `= + - @` are exported with a leading `'` (spreadsheet formula injection) and
read back without it. An import is validated completely first: one invalid row
(unknown domain or mailbox, invalid pattern) refuses the whole file with the line
numbers; existing entries are skipped. Every create, change, delete and import is
audited (`security.sender-list.*` with the entry data).

## DNSBL zone actions

| Action | Effect |
|--------|--------|
| `REJECT` (Ablehnen) | The connection is refused at connect time. |
| `SCORE_ONLY` (Score, 9.4) | The zone's weight is added to the rspamd spam score of the message; the sum is compared with the Junk / reject thresholds (the reason names the zones, e.g. `DNSBL +3: psbl.surriel.com`). Needs rspamd: when rspamd is not deployed (`RSPAMD_ENABLED=false`) the BCP disables the option. The cached connect-time lookup is reused, hits are counted once in the statistics. |
| `TAG` (Markieren) | Only recorded in the DNSBL statistics. |

A DNSWL hit (whitelist zone) skips the other connection checks and adds no score. Sessions
authenticated with SMTP AUTH get no DNSBL score (their client address is often a listed dial-up
address). rspamd runs its own RBL checks: do not set a zone to `SCORE_ONLY` that the rspamd RBL
module already queries (e.g. Spamhaus ZEN) — that listing would count twice; check the RBL
configuration of the deployed rspamd before choosing „Score“ for a zone.

## Mail rules (`regex` conditions)

User rule patterns are executed by a linear-time matcher
(`@coremail/storage` `matchRulePattern`), never by the backtracking JS engine:
at most 200 characters, input capped at 64 KB, no backreferences, lookarounds
or named groups; bounded repetitions up to `{100}`. Since 9.0 the API refuses
such patterns when a rule is saved (`POST/PUT /api/v1/user/rules` →
`400 INVALID_RULE_PATTERN` with a readable message, shown in the MWA rule
editor); invalid patterns stored earlier never match.

Matching is case-insensitive exactly like JavaScript's `/i` flag (9.0: a
negated class such as `[^a-z]` is folded before it is negated, so it no longer
matches `HELLO`). Limits since 9.0:

| Limit | Value | Effect |
|-------|-------|--------|
| `RULE_PATTERN_STEP_BUDGET` | `5000000` | Matcher steps for the regex conditions of **one rule** (transport rule or inbox rule) for one delivered message. Every rule starts with its own budget, so a padded message cannot use up the steps of the rules that follow. |
| `RULE_PATTERN_MESSAGE_STEP_BUDGET` | 4 × `RULE_PATTERN_STEP_BUDGET` (`20000000`) | Upper bound for all rules of one message together; each rule gets at most what is left of it. Never lower than the per-rule budget. |
| regex conditions per user | 20 | Conditions + exceptions with operator `regex`, over all of a user's inbox rules. Saving more → `400 TOO_MANY_REGEX_CONDITIONS`. |

When a budget runs out before a regex condition is decided (for example because
the sender padded the message), the result depends on what the rule does — an
exhausted budget must never switch off a blocking rule:

| Rule | Exhausted condition | Exhausted exception |
|------|---------------------|---------------------|
| Transport rule with a `reject`, `quarantine` or `redirect` action | counts as **match** (fail-closed) | — (transport rules have no exceptions) |
| Other transport rules (headers, subject, disclaimer, add/remove recipient) | no match | — |
| Inbox rules (user mail rules) | no match | counts as matched → the rule is skipped |

Every exhausted evaluation is logged as a warning with the rule id (and, for
transport rules, whether it failed closed).

## rspamd controller authentication

| Variable | Default | Effect |
|----------|---------|--------|
| `RSPAMD_CONTROLLER_PASSWORD` | unset | When set, every rspamd controller call (security-filter `/learnspam` + `/learnham`; api-gateway Bayes learning from "mark as junk/not junk" and the BCP threshold/stat calls) sends it as the `Password` header (9.0). Set the same value as the controller `password` / `enable_password` in rspamd, so the controller no longer needs to trust the app's IP via `secure_ip`. Values with CR/LF are ignored. |

## Antivirus (ClamAV)

Policy (action on a virus, scanner failure, timeout, size limit, Heuristics/PUA/encrypted
findings), the `X-CoreMail-Virus-Scan` header, the status card, the EICAR test and the
recommended `clamd.conf` limits: [antivirus.md](antivirus.md).

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
`outboundRetentionHours` (default 48 h). Since 9.0 a transient failure is
retried for the whole window (Exchange-like): first after
`retryBackoffDelaySec` (default 60 s), then after 5 min, 15 min and then every
30 min; the last retry is pulled forward to the expiry moment, where the job
ends with ONE final NDR (RFC 3464 `Action: failed`, `Status: 5.4.7`, the last
remote reply as diagnostic). Time-based expiry wins: `maxRetryAttempts` is a
minimum — each job gets at least enough attempts to cover the window. The delay
DSN above is unchanged. Loop detection rejects messages with more than 100
`Received:` fields (`554 5.4.6`).

**Retry of a dead letter** (BCP → Queues → Retry, 9.0): the retry window starts
again at the moment of the retry (job field `expiryBaseMs`) and the attempt
counter is reset — an expired message is really delivered again instead of
failing at once. Recipients already delivered are skipped; recipients that
already got the final NDR are tried again but never get a second NDR.

Regex patterns of transport rules (`regex` condition) and sender blacklist
entries (`patternType: REGEX`) run on the same linear-time matcher as inbox
rules; wildcard blacklist entries use a non-backtracking glob matcher. Rule
patterns are validated when saved (`400 INVALID_RULE_PATTERN`). Existing REGEX
blacklist entries with unsupported syntax (backreferences, lookarounds, > 200
characters) are skipped and logged.

## Tarpit (port 25)

| Variable | Default | Effect |
|----------|---------|--------|
| `SMTP_TARPIT_MAX_DELAY_MS` | `5000` | After 3 permanent (5yz) replies in an unauthenticated port-25 session (unknown recipients, protocol errors, rejects), each further command is answered after 1 s, 2 s, … up to this maximum. `0` disables the tarpit. Submission ports are never tarpitted. |
