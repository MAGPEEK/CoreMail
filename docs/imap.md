# IMAP server

`packages/imap-server` — IMAP4rev1 / IMAP4rev2 (RFC 3501 / RFC 9051) on ports 143
(STARTTLS) and 993 (implicit TLS). Authentication requires TLS; accounts with MFA
use app passwords. Resource limits are described in
[mail-protocol-limits.md](mail-protocol-limits.md).

## Capabilities

| Capability | RFC | Notes |
|---|---|---|
| IMAP4rev1, IMAP4rev2 | 3501, 9051 | `ENABLE IMAP4rev2` switches to rev2 semantics |
| LITERAL+, SASL-IR, ID, ENABLE, IDLE, NAMESPACE, UNSELECT, UIDPLUS, MOVE, CHILDREN | 7888, 4959, 2971, 5161, 2177, 2342, 3691, 4315, 6851, 3348 | |
| CONDSTORE | 7162 §3.1 | |
| **QRESYNC** | 7162 §3.2 | after `ENABLE QRESYNC` (implies CONDSTORE) |
| ESEARCH, SEARCHRES | 4731, 5182 | |
| **SORT** | 5256 | keys ARRIVAL CC DATE FROM REVERSE SIZE SUBJECT TO |
| **THREAD=ORDEREDSUBJECT, THREAD=REFERENCES** | 5256 | |
| **ACL, RIGHTS=texk** | 4314 | read-only, see below |
| **COMPRESS=DEFLATE** | 4978 | advertised only after authentication, and no longer once active |
| SPECIAL-USE, LIST-EXTENDED, LIST-STATUS, STATUS=SIZE | 6154, 5258, 5819, 8438 | |
| BINARY | 3516 | |
| QUOTA, QUOTA=RES-STORAGE | 9208 | read-only |

Not implemented: NOTIFY (RFC 5465), ESORT/CONTEXT (RFC 5267), SORT=DISPLAY
(RFC 5957 — the To display name is not stored, so DISPLAYTO would need the raw
header of every message), UTF8=ACCEPT, METADATA.

## QRESYNC (RFC 7162 §3.2)

- `ENABLE QRESYNC` → `* ENABLED QRESYNC`; CONDSTORE is enabled too (MODSEQ in
  every FETCH).
- `SELECT|EXAMINE mbox (QRESYNC (uidvalidity modseq [known-uids [(seqs uids)]]))`
  — BAD without a prior `ENABLE QRESYNC`. When the UIDVALIDITY matches, the
  standard SELECT responses are followed by `* VANISHED (EARLIER) …` and a
  `FETCH (UID … FLAGS … MODSEQ …)` for every message whose modSeq is greater than
  the client's. The sequence match data is validated but not needed.
- `UID FETCH set items (CHANGEDSINCE m VANISHED)` — `VANISHED (EARLIER)` for the
  UID set before the FETCH responses. VANISHED without QRESYNC, without
  CHANGEDSINCE or on a non-UID FETCH is BAD.
- Unsolicited `* VANISHED uid-set` replaces `EXPUNGE` once QRESYNC is enabled
  (EXPUNGE, UID EXPUNGE, MOVE, updates from other clients during NOOP/IDLE/…).
  The same RFC 9051 §7.5.1 rule applies: none during FETCH, STORE, SEARCH, SORT,
  THREAD (their UID variants may send them).
- The tagged OK of EXPUNGE, UID EXPUNGE and MOVE carries `[HIGHESTMODSEQ n]`.
- `* OK [CLOSED]` is sent whenever SELECT/EXAMINE implicitly closes the selected
  mailbox (for every client, since the server advertises QRESYNC).

### Deletion history (safe behaviour)

Expunged messages stay as tombstones (soft-deleted rows with the modSeq of the
expunge, see the storage message store). The history is still incomplete:
moving a message to another folder and hard deletes (empty trash, retention)
leave no tombstone in the source folder, and tombstones are purged after the
recovery window. The server therefore reports

```
VANISHED (EARLIER) = candidates − live UIDs of the folder
                     − UIDs whose tombstone has modSeq ≤ the client's modseq
```

- candidates = the client's `known-uids`, else `1:(UIDNEXT-1)` for SELECT; the
  requested UID set for `UID FETCH … VANISHED` (`*` = UIDNEXT-1).
- For an explicit `known-uids` list the tombstone exclusion is not applied: a UID
  the client claims to know but which is gone is always reported.

RFC 7162 allows reporting UIDs the client never had, so this is always correct;
a client is never left with a message that no longer exists. The price is a
larger response: UIDs come from one counter per account (all folders), so the
gaps between a folder's UIDs show up in the result. The result is computed and
sent as ranges (O(live messages)), split into several `VANISHED (EARLIER)`
lines of at most ~4 KB. Clients that send `known-uids` (iOS Mail, Thunderbird)
get compact answers.

## SORT and THREAD (RFC 5256)

- `SORT (keys) charset criteria`, `UID SORT …`, `THREAD algorithm charset criteria`,
  `UID THREAD …`. Charsets: UTF-8 and US-ASCII (others → `NO [BADCHARSET (UTF-8 US-ASCII)]`).
- The search criteria use the SEARCH engine (same keys incl. MODSEQ and `$`);
  `SORT … MODSEQ n` ends with `(MODSEQ highest)`.
- Base subject extraction follows RFC 5256 §2.1 (Re:/Fw:/Fwd:, `[blob]`
  prefixes, `(fwd)` trailers, `[fwd: …]` wrappers). Strings compare with
  i;ascii-casemap; FROM/TO/CC use the mailbox (local) part of the first address;
  DATE is the sent date, ARRIVAL the internal date; ties end in sequence order.
- THREAD=REFERENCES runs the full RFC 5256 algorithm (Zawinski): the parent
  chain comes from the stored `References` header (`Message.references`,
  since 9.1), falling back to the first `In-Reply-To` msg-id when a message has
  none. Missing ancestors become dummy containers, existing links are kept and
  links that would form a loop (reference cycles, self references) are not
  added; duplicate or missing Message-IDs get a container of their own. Dummies
  are pruned (children promoted; to the root set only for a single child),
  roots with the same base subject are merged (step 5) and siblings/threads are
  sorted by sent date (dummies by their earliest child, ties by sequence
  number). The implementation is iterative (no recursion limit for long reply
  chains) and uses maps for the subject merge, so a mailbox at the
  `IMAP_SORT_MAX_MESSAGES` limit threads in well under a second of CPU.
- `References` storage: every message written since 9.1 stores the msg-ids of
  its `References` header (RFC 5322 §3.6.4) in header order — comments, quoted
  strings, ids with whitespace/control characters or over 998 characters are
  ignored, duplicates removed, at most 100 ids (the first and the last 99).
  Messages written before 9.1 have no value yet (`null`) and are indexed from
  their stored raw message (header section only):
  - lazily — THREAD=REFERENCES indexes up to 2,000 unindexed messages of the
    selected folder per command before threading (the rest use In-Reply-To
    until a later command or the background job reaches them);
  - in the background — `REFERENCES_BACKFILL=on` (default) works off all
    mailboxes in batches of 500 with pauses, one instance at a time (Redis lock
    `storage:references-backfill:lock`), every minute while rows are left and
    every 6 hours once done. `off` leaves indexing to THREAD.
  Indexing never touches mail delivery and does not change MODSEQ (the value is
  derived from the immutable raw message). Messages without a raw object or
  whose object is missing are recorded as having no References.
- Work is done in memory on a column projection of the folder. Mailboxes with
  more than `IMAP_SORT_MAX_MESSAGES` messages (default 100000, `<= 0` =
  unlimited) are answered with `NO [LIMIT]`.

## ACL (RFC 4314) — read-only

IMAP exposes only the user's own mailbox (personal namespace; NAMESPACE returns
no other-users or shared namespace). Shared mailboxes and delegated mailboxes
(`SharedMailbox` permissions FULL_ACCESS / SEND_AS, `MailboxDelegate`) are not
reachable over IMAP, so ACL only describes the own folders:

| Command | Answer |
|---|---|
| `MYRIGHTS mbox` | `* MYRIGHTS mbox lrswipkxteacd` (owner: all rights) |
| `GETACL mbox` | one entry: the login address with all rights |
| `LISTRIGHTS mbox id` | the owner: all rights always granted; anyone else: `""` |
| `SETACL`, `DELETEACL` | `NO [NOPERM]` — permissions are managed by administrators in the BCP |

Unknown mailboxes → `NO [NONEXISTENT]`. If shared/delegated mailboxes are added
to the IMAP namespace later, the mapping would be FULL_ACCESS / delegate →
`lrswipkxteacd`, read-only access → `lr`.

## COMPRESS=DEFLATE (RFC 4978)

- Only in the authenticated/selected state (`BAD` before login), only `DEFLATE`
  (`BAD` otherwise), once per connection (`NO [COMPRESSIONACTIVE]`).
- `tag OK DEFLATE active` is the last uncompressed response; from then on both
  directions use raw deflate (RFC 1951) on top of TCP or TLS. Octets the client
  pipelined after `COMPRESS DEFLATE` are treated as compressed.
- Output is sync-flushed once per event-loop turn. Input is inflated and fed to
  the same command reader, so line (64 KiB) and literal limits apply to the
  inflated data; while a command runs, both the transport and the inflate
  stream are paused, so a decompression bomb is throttled by TCP and cut off by
  the line limit (`* BYE Line too long`). A corrupt deflate stream closes the
  connection. Idle timeouts, the per-IP / per-user connection limits and all
  pre-authentication limits are unchanged (they act on the transport or before
  COMPRESS is possible).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IMAP_SORT_MAX_MESSAGES` | 100000 | largest mailbox SORT/THREAD work on (`<= 0` unlimited) |
| `REFERENCES_BACKFILL` | on | background indexing of the References of messages written before 9.1 (`off`: only lazily by THREAD=REFERENCES) |

Connection limits (`IMAP_MAX_CONNS*`, `MAIL_CONN_EXEMPT_CIDRS`) are documented
in [mail-protocol-limits.md](mail-protocol-limits.md).

## Tests

- `src/commands/sort-thread.test.ts` — base subject, sort order, both thread
  algorithms (REFERENCES: References chains, In-Reply-To fallback, missing
  parents, cycles, duplicate Message-IDs, subject merging, 20,000-deep chains,
  100,000 roots), UID range helpers.
- `packages/storage/src/references.test.ts` — References parsing, population
  on message creation, lazy and background backfill (batching, Redis lock).
- `src/server/imap-protocol.test.ts` (loopback server, `node src/run-protocol-tests.mjs`)
  — QRESYNC (Thunderbird CONDSTORE/QRESYNC flows), SORT/THREAD, ACL, and
  COMPRESS with an iOS Mail sequence (LOGIN, ID, COMPRESS, ENABLE QRESYNC,
  SELECT (QRESYNC …), FETCH), pipelined compressed input, decompression bomb and
  corrupt stream.
