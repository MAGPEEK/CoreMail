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
- THREAD=REFERENCES runs the RFC 5256 algorithm with the stored `In-Reply-To`
  and `Message-ID` columns. The full `References` header is not stored, so a
  reply whose direct parent is not in the mailbox is attached by base subject
  (step 5) instead of to an older ancestor.
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

Connection limits (`IMAP_MAX_CONNS*`, `MAIL_CONN_EXEMPT_CIDRS`) are documented
in [mail-protocol-limits.md](mail-protocol-limits.md).

## Tests

- `src/commands/sort-thread.test.ts` — base subject, sort order, both thread
  algorithms, UID range helpers.
- `src/server/imap-protocol.test.ts` (loopback server, `node src/run-protocol-tests.mjs`)
  — QRESYNC (Thunderbird CONDSTORE/QRESYNC flows), SORT/THREAD, ACL, and
  COMPRESS with an iOS Mail sequence (LOGIN, ID, COMPRESS, ENABLE QRESYNC,
  SELECT (QRESYNC …), FETCH), pipelined compressed input, decompression bomb and
  corrupt stream.
