# SMTP server — protocol extensions

CoreMail's SMTP server (`packages/smtp-server`) listens on port 25 (inbound MTA
traffic), 587 (submission, STARTTLS) and 465 (submission, implicit TLS). Since
v9.0 the EHLO response matches Exchange 2019:

```
250-mail.example.com
250-SIZE 26214400
250-PIPELINING
250-DSN
250-ENHANCEDSTATUSCODES
250-STARTTLS
250-8BITMIME
250-BINARYMIME
250-CHUNKING
250 SMTPUTF8
```

`AUTH PLAIN LOGIN` follows on encrypted submission connections. `STARTTLS` is
not repeated after the TLS handshake.

## Configuration

| Setting | Default | Effect |
|---|---|---|
| BCP → SMTP configuration (`SmtpSettings.ext*`) | on | STARTTLS, AUTH PLAIN/LOGIN, PIPELINING, SIZE, 8BITMIME, ENHANCEDSTATUSCODES |
| `SMTP_EXT_DSN` | `true` | DSN (RFC 3461): `RET`, `ENVID`, `NOTIFY`, `ORCPT` |
| `SMTP_EXT_SMTPUTF8` | `true` | SMTPUTF8 (RFC 6531) |
| `SMTP_EXT_CHUNKING` | `true` | CHUNKING + BINARYMIME (RFC 3030, `BDAT`) |
| `SMTP_TARPIT_MAX_DELAY_MS` | `5000` | Port 25 tarpit cap (0 = off) |

`false`, `0`, `off` or `no` switches an extension off. A switched-off
extension is neither advertised nor accepted: its MAIL/RCPT parameters get
`555 5.5.4`, `BDAT` gets `500 5.5.1`. The old database columns
`extDsn`/`extSmtputf8`/`extChunking` are not read (the BCP no longer shows
them). CRAM-MD5 is never offered.

The extensions apply to all three ports. DSN parameters given on submission
(587/465) travel with the outbound queue job; on port 25 they are honoured for
local delivery and for alias forwarding to external addresses.

## CHUNKING / BINARYMIME (RFC 3030)

`BDAT <size> [LAST]` transfers exactly `<size>` octets that follow the command
line. There is no dot-stuffing and no line parsing, so any octet value works
(including NUL), and a chunk may end anywhere, even between CR and LF.

- The octets are read straight from the connection (also when pipelined and
  over TLS). Each chunk gets one reply: `250 2.0.0 <n> octets received`.
  `BDAT … LAST` delivers the message and answers like DATA (`250 2.0.0 OK`, or
  the filter/delivery error).
- The assembled message takes the same path as DATA: Received header, content
  filter, quarantine, delivery, tarpit.
- `SIZE` is enforced across all chunks. A chunk that goes over the limit is
  still read (never run as commands) but dropped, the reply is
  `552 5.3.4`, and the transaction is closed.
- `503 5.5.1` for: BDAT before MAIL/RCPT, BDAT after `BDAT … LAST`, DATA after
  a BDAT chunk of the same transaction, and DATA after `MAIL … BODY=BINARYMIME`
  (binary content can only be sent with BDAT).
- A BDAT without a valid size gets `501 5.5.4` and consumes nothing.
- `BDAT 0 LAST` ends a message without adding data.
- Memory bounds: chunk octets are only kept for a transaction with an accepted
  (or pipelined, still pending) recipient. Chunks before MAIL, after a rejected
  RCPT or after `LAST` are read and dropped, and answered `503`. The server
  stops reading while more than one chunk, or more than 100 commands, wait in
  the command queue (pipelining backpressure).

Limitation: a `BODY=BINARYMIME` message is stored as is. When it is relayed,
it is sent unchanged with DATA (there is no conversion to 7bit/8bit).

## DSN (RFC 3461 / RFC 3464)

### Parameters

| Command | Parameter | Validation |
|---|---|---|
| MAIL | `RET=FULL\|HDRS` | case-insensitive |
| MAIL | `ENVID=<xtext>` | at most 100 characters; the decoded value must be printable ASCII |
| RCPT | `NOTIFY=NEVER` or `SUCCESS,FAILURE,DELAY` (any subset) | NEVER cannot be combined with others; no duplicates |
| RCPT | `ORCPT=<addr-type>;<xtext>` | at most 500 characters; `utf-8` type (RFC 6533) only with SMTPUTF8 |

A malformed value or a repeated parameter gets `501 5.5.4`. The parameters
are stored with the transaction (`MessageMeta.envelope.dsn`) and copied into
the outbound queue job (`OutboundJob.dsn`).

### Generated reports

| NOTIFY | failed | delayed | delivered / relayed |
|---|---|---|---|
| (not given) | yes | yes | no |
| `NEVER` | no | no | no |
| any list | only when it contains FAILURE | only when it contains DELAY | only when it contains SUCCESS |

- **failed**: a permanent remote reply, a permanent DNS result, the queue
  timing out, or a `5.6.7` SMTPUTF8 failure.
- **delayed**: one report after `OUTBOUND_DELAY_DSN_HOURS` (default 4) of
  retrying.
- **delivered**: after local delivery (port 25, submission or the queue). The
  report covers each recipient as it was addressed, aliases included. Mail
  filed as junk on port 25 gets no success report. On port 25 (no SMTP AUTH)
  a success report is only sent when the MAIL FROM domain passed SPF or
  aligned DKIM (`verifiedDomains` of the content filter), and always with
  `RET=HDRS` — a forged MAIL FROM with `NOTIFY=SUCCESS` must not reflect mail
  to a third party (backscatter).
- Local outcomes are reported per address as given: an alias whose target
  mailbox is full gets one NDR under the alias and no success report. When a
  transaction fails after part of it was stored (451, client retry), the
  retry still sends the NDRs of recipients that were over quota or unknown in
  the first attempt (the partial-delivery ledger keeps each outcome). The
  queue worker judges success reports on its persisted delivered/bounced
  sets, so a retry never confirms a recipient that was bounced earlier.
- A transport rule that redirects or adds a local recipient that is full or
  unknown sends the sender an NDR (`5.2.2` / `5.1.1`) instead of dropping the
  copy.
- **relayed**: after an external delivery to a next hop that does not
  advertise DSN. When the next hop does advertise DSN, nodemailer passes
  `RET`/`ENVID`/`NOTIFY`/`ORCPT` on (`dsn` mail option), and that hop is then
  responsible for the reports. nodemailer applies one `dsn` to each SMTP
  transaction, so recipients with different NOTIFY/ORCPT values are sent in
  separate transactions.

Report contents:

- `ENVID` is echoed as `Original-Envelope-Id`, and `ORCPT` as
  `Original-Recipient`.
- `RET=FULL` returns the whole message (`message/rfc822`) in a **failure**
  report, up to 10 MiB. Otherwise only the headers are returned
  (`text/rfc822-headers`). Delay and success reports always return headers
  only (RFC 3461 §4.3).
- Reports are sent with a null sender, never for a message that itself had a
  null sender, and are filtered per recipient by NOTIFY.
- UTF-8 addresses produce `utf-8; …` address fields and
  `message/global-delivery-status`. UTF-8 headers produce
  `message/global-headers` / `message/global` (RFC 6533).

## SMTPUTF8 (RFC 6531)

- `MAIL FROM:<…> SMTPUTF8` allows UTF-8 local-parts and U-label domains in
  MAIL and RCPT. Command arguments are decoded as strict UTF-8 and normalised
  to NFC. Ill-formed UTF-8 gets `501 5.5.4`.
- Without the parameter, a non-ASCII address (or a `utf-8` ORCPT) gets
  `553 5.6.7`.
- Domains are validated and normalised through IDNA/UTS #46: lower case,
  U-label form; an `xn--` domain stays ASCII. C0/C1 control characters and
  U+FFFD in local-parts are rejected.
- Recipient lookups map an IDN domain onto the spelling stored for the local
  domain (A-label or U-label, `canonicalRecipient()` in
  `handlers/expand.ts`). `jörg@bücher.example` therefore matches a domain
  configured as `xn--bcher-kva.example`, and the reverse also works.
- The trace header uses `with UTF8SMTP[S][A]` (RFC 6531 §3.7.3).
- UTF-8 header fields are stored as received, and the parser decodes them
  (RFC 6532). The content-filter context header is ASCII-escaped JSON.
- **Relaying**:
  - IDN domains are looked up and sent as A-labels, so they never need
    SMTPUTF8 on their own.
  - When an envelope still has a UTF-8 local-part, the next hop's EHLO is
    checked first (a separate connect, EHLO and QUIT). If the next hop does not
    advertise SMTPUTF8, the recipients fail permanently with `5.6.7` and are
    bounced (RFC 6531 §3.2).
  - If that probe cannot reach the next hop, the message is sent anyway, and the
    remote server's reply decides.

## HELP

`HELP [topic]` answers with a multi-line `214 2.0.0` reply: the commands, the
extensions, and a link to RFC 5321. It works in any state and does not change
the state.

## Enhanced status codes and pipelining

Every 2yz/4yz/5yz reply carries an RFC 3463 code; the greeting and the EHLO
lines are the exceptions (RFC 2034). All commands, including BDAT chunks, are
processed strictly in order, so they can be pipelined (RFC 2920). Chunk
octets are read from the connection immediately, but each chunk is processed
in order behind the commands before it.

## Tarpit (port 25)

After 3 permanent (5yz) replies in an unauthenticated session, each further
reply waits 1 s, 2 s, … up to `SMTP_TARPIT_MAX_DELAY_MS`.

- A multi-line reply counts once.
- The counter resets after a message is accepted (DATA or BDAT), so an MTA
  that reuses a connection is not slowed down by the unknown recipients of
  earlier messages.
- RSET and QUIT are never delayed.

## Message trace (MAIL_FLOW, 10.2)

Every accepted, delivered, rejected, quarantined or deferred message writes a
`SystemLog` row with `category: 'MAIL_FLOW'` (BCP "Nachrichtenablaufverfolgung",
admin API `/api/v1/admin/message-trace`). Since 10.2 the rows of the SMTP server
also carry `metadata.trace = { v: 1, stages: [{ stage, at, ms?, result, detail }] }`
— what CoreMail did with the message, built with `createTraceRecorder()` from
`@coremail/storage` (`message-trace.ts`; pure stage builders in smtp-server
`handlers/trace-stages.ts`). Only facts the path computes anyway are recorded
(no extra lookups, never message content); at most 48 stages, 16 detail keys,
300 characters per string and 12 list entries per value.

| Path | Stages |
|---|---|
| Port 25 (inbound) | `connection` (client IP, HELO, port, protocol, TLS version + cipher or none), `connection-check` (DNSBL/DNSWL, GeoIP verdict at connect), `recipient-check` (sender lists + greylisting per RCPT), `authentication` (SPF/DKIM/DMARC/ARC with domains), `sender-list`, `attachments`, `virus-scan`, `spam` (rspamd score + verdict, DNSBL zones), `content-filter` (verdict + round trip), `aliases`, `transport-rules` (rule ids + actions), `inbox-rules` (count + effects), `admin-forward`, `delivery` (mailbox + folder, rejected with the reply, quarantine) |
| Submission (587/465) | `connection` (incl. AUTH user), `submission`, `aliases`, `queued` (tracking id + job id), then the local `delivery` rows |
| Queue worker (one row per attempt) | `queued` (job id, attempt, hold), `smime`, `local-delivery`, `dkim` (domain + selector), `mx` (records as resolved, implicit MX, NXDOMAIN / null MX), `remote` (host, IP connected, port, STARTTLS / TLS / none, reply code + text, duration), `dsn`, `queue-result` (deferred / final) |

The security-filter answers `/check/content` with a `checks` summary (auth,
sender lists, attachments, ClamAV, rspamd, per-stage ms); older security-filter
builds without it are covered by our own `Authentication-Results` header and the
score. Correlation keys: inbound rows carry `storedMessageId` (the stored copy)
and the Message-ID; queue rows `jobId`, `attempt` and `headerMessageId`; SMTP
submission rows `queueTrackingIds`. Rows written before 10.2 have no trace — the
detail view says that fewer details are stored.

`GET /api/v1/admin/message-trace/:id` (area `compliance`) returns the row, its
validated trace (`sanitizeTrace()`), the related rows of the same message
(queue tracking id / Message-ID, −2 / +8 days, scope-filtered) and the delivery
path: for inbound / internal mail the `Received:` chain of the stored original
(first 64 KB only, `lib/received-hops.ts`: oldest hop first, delays, TLS, raw
text when a field cannot be parsed) plus an Authentication-Results / ARC
summary; for outbound mail CoreMail → each host the queue connected to. Scope
and redaction: see `docs/rbac.md`.

Not recorded: the client's reverse DNS at connect time (CoreMail does no PTR
lookup in the SMTP path), the TLS version / cipher of outbound connections
(nodemailer reports only that STARTTLS was used), and rows for local recipients
refused at delivery (unknown, over quota, mailbox policy — they get an NDR).
