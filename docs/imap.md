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
| NAMESPACE | 2342 | personal + "Other Users/" + "Shared/" (v9.1), see below |
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
  - lazily — THREAD=REFERENCES indexes at most 200 unindexed messages of the
    selected folder per command and stops after `REFERENCES_LAZY_BUDGET_MS`
    (default 1500 ms, `0` = no lazy step), so a slow object store never blocks
    the session for long; messages whose object failed to read recently are
    skipped. The rest use In-Reply-To until a later command or the background
    job reaches them. The References column is loaded only for the messages
    being threaded (in chunks of 1000 ids);
  - in the background — `REFERENCES_BACKFILL=on` (default) works off all
    mailboxes in batches of 500 with pauses, one instance at a time (Redis lock
    `storage:references-backfill:lock`, refreshed with a token check between
    batches and released with compare-and-delete), every minute while a pass is
    in progress and every 6 hours once a pass is complete. `off` leaves indexing
    to THREAD.
  Indexing never touches mail delivery and does not change MODSEQ (the value is
  derived from the immutable raw message). Messages without a raw object or
  whose object is missing are recorded as having no References. Other read
  errors leave the message unindexed — it is never marked as "no References",
  so it is indexed once the object store is readable again. The background pass
  walks the table with a cursor (newest first), so messages that keep failing
  never block older ones, and failures are counted per message (Redis keys
  `storage:references-backfill:fail:<id>`, 24 h from the first failure): after 3
  failures a message is not read again until its counter expires.
- Work is done in memory on a column projection of the folder. Mailboxes with
  more than `IMAP_SORT_MAX_MESSAGES` messages (default 100000, `<= 0` =
  unlimited) are answered with `NO [LIMIT]`.

## Shared and delegated mailboxes (v9.1, RFC 2342)

Besides the own mailbox, IMAP shows the Shared Mailboxes and delegated mailboxes
a user may open — the same policy as JMAP, REST and the web client
(`@coremail/storage` `listAccessibleMailboxes`):

| Grant | IMAP access |
|---|---|
| Shared Mailbox `FULL_ACCESS` | read-write |
| Shared Mailbox `READ_ONLY` (without FULL_ACCESS) | read-only |
| Shared Mailbox `SEND_AS` / `SEND_ON_BEHALF` only | none (not listed) |
| MailboxDelegate `FULL_ACCESS` (owner active) | read-write |
| MailboxDelegate `READ_ONLY` | read-only |
| inactive Shared Mailbox, deactivated owner | none |

```
* NAMESPACE (("" ".")) (("Other Users/" "/")) (("Shared/" "/"))
```

| Namespace | Prefix | Delimiter | Contents |
|---|---|---|---|
| personal | `""` | `.` | the own folders (unchanged) |
| other users | `Other Users/` | `/` | delegated mailboxes: `Other Users/alice@example.com/INBOX` |
| shared | `Shared/` | `/` | Shared Mailboxes: `Shared/team@example.com/INBOX` |

Naming scheme: `<prefix>/<primary address>/<folder>`; the folder hierarchy of the
target mailbox (stored with `.`) is shown with `/`, e.g. the team mailbox's
`Projects.2026` is `Shared/team@example.com/Projects/2026`. `/` is the delimiter
of these namespaces because addresses contain `.`. The prefix, the address and
`INBOX` are case-insensitive. The address level (`Shared/team@example.com`) and
the prefix (`Shared`) are `\Noselect` parents. Not shown: folders of the target
mailbox whose name contains `/`. A personal folder named exactly like a prefix
(`Shared`) is still listed as the personal folder; new personal folders cannot
be created under `Shared/…` or `Other Users/…` (those names belong to the
namespaces).

- **LIST / LSUB / LIST-EXTENDED / LIST-STATUS** list the foreign folders (every
  folder counts as subscribed). SPECIAL-USE attributes are only set on the own
  folders, so a shared `Sent` never collides with the user's `\Sent`.
- **SELECT / EXAMINE / STATUS / FETCH / STORE / SEARCH / SORT / THREAD / COPY /
  MOVE / EXPUNGE / APPEND / IDLE** work on foreign folders through the same
  message store: UIDs, UIDVALIDITY, modSeq / HIGHESTMODSEQ, QRESYNC and the IDLE
  push come from the target mailbox; sequence numbers are per session as usual.
- **Read-only** permission: SELECT answers `[READ-ONLY]` (EXAMINE semantics,
  `PERMANENTFLAGS ()`, no implicit `\Seen`); STORE, EXPUNGE, UID EXPUNGE, MOVE out
  of it, and COPY / MOVE / APPEND into it are `NO [NOPERM]`. Copying out of it is
  allowed.
- **Quota**: APPEND / COPY / MOVE into a foreign mailbox are checked against that
  mailbox's own quota (`NO [OVERQUOTA]`). `GETQUOTAROOT` on a foreign folder
  returns no quota root (the user's root `""` is the own mailbox).
- **Folder management**: with FULL_ACCESS, CREATE / DELETE / RENAME work inside
  the foreign mailbox (RENAME across mailboxes → `NO [CANNOT]`); read-only or no
  access → `NO [NOPERM]`.
- **No oracle**: a foreign name without a current permission (no grant, SEND_AS
  only, unknown address) is answered exactly like a missing mailbox
  (`[NONEXISTENT]`, `[TRYCREATE]` for APPEND/COPY/MOVE, `[NOPERM]` for CREATE /
  RENAME into it) and never appears in LIST/LSUB.

### Permission changes on live sessions

Permission changes made in the BCP / admin API are published at once: setting or
removing a Shared Mailbox permission, (de)activating or deleting a shared
mailbox (all its grantees) and granting or revoking a delegation publish a
`permission-change` event for each affected user on the auth invalidation bus
(`CHANNEL_AUTH_INVALIDATE`; it never ends a connection). On any such event — and
on every other auth invalidation event, e.g. a deactivated owner — the IMAP
server clears the permission caches and re-checks the selected foreign mailbox
of that user's IDLE sessions right away; other sessions re-check it before their
next command. Permissions are also re-read:

- on SELECT / EXAMINE and before every write (STORE, EXPUNGE, CLOSE's expunge,
  implicit `\Seen`, COPY / MOVE / APPEND target, CREATE / DELETE / RENAME) —
  without the cache;
- before every other command on a selected foreign mailbox, for LIST / STATUS and
  during IDLE — from a per-session cache that lives at most
  `IMAP_SHARED_ACCESS_CACHE_MS` (≤ 30 s), the fallback when Redis (and thus the
  event) is unavailable.

A revoked permission closes the selected mailbox with `* OK [CLOSED] Access to
the selected mailbox was revoked`; the command that needed it gets
`NO [NOPERM]`. A downgrade to READ_ONLY turns the selected mailbox read-only.

### Reserved folder names (migration note)

Names that start with a namespace prefix and `/` — `Shared/…` and
`Other Users/…` in any letter case, or the configured `IMAP_NAMESPACE_*`
prefixes — belong to the namespaces. Since 9.1:

- IMAP LIST / LSUB / STATUS-listing no longer show a personal folder with such a
  name (it could never be selected, because the name resolves into the
  namespace, and it would shadow the real shared entry). The server logs a
  warning once per user.
- New folders with such names are refused: IMAP CREATE / RENAME answer
  `NO [NOPERM] … names under "Shared/" are reserved …`, the REST folder routes
  `400 RESERVED_FOLDER_NAME`, JMAP Mailbox/set `invalidProperties` on `name`.

**Migration:** personal folders created before 9.1 with such a name (e.g. a
folder `Shared/Projects` made by an IMAP client while the namespace did not
exist) keep their messages but are invisible over IMAP. Rename them in the
webmail (or via JMAP) to a name without the prefix — renaming *away* from a
reserved prefix is always allowed — and they reappear in IMAP clients.

### Client setup

- **Thunderbird**: nothing to configure — it reads NAMESPACE and shows
  "Other Users" and "Shared" as folder trees under the account (Account
  Settings → Server Settings → Advanced → "Allow server to override these
  namespaces" stays on). If "Show only subscribed folders" is enabled the folders
  appear as well (LSUB includes them). Thunderbird keeps a delimiter per
  namespace, so the `.` / `/` mix is supported.
- **Apple Mail** (macOS / iOS): lists the folders from `LIST "" "*"`; shared and
  delegated folders appear under "Shared" / "Other Users". Leave the "IMAP Path
  Prefix" empty. Apple Mail may show the address level as a plain folder. If a
  client handles only one hierarchy delimiter, it shows the full name
  (`Shared/team@example.com/INBOX`) as one folder — still usable.
- Other clients that ignore other namespaces: use the web client, JMAP or
  ActiveSync for shared mailboxes.

These client notes follow RFC 2342 / RFC 5258; they were not verified against
live client builds in this release.

## ACL (RFC 4314) — read-only

Rights reflect the real permissions:

| Folder | `MYRIGHTS` |
|---|---|
| own folder | `lrswipkxteacd` (all rights) |
| foreign, FULL_ACCESS | `lrswipkxtecd` (everything except `a` — the ACL is administered in the BCP) |
| foreign, READ_ONLY | `lr` (no `s`: `\Seen` cannot be changed either) |

| Command | Answer |
|---|---|
| `MYRIGHTS mbox` | the caller's rights (table above) |
| `GETACL mbox` | own folder: one entry, the login address with all rights; foreign folder: `NO [NOPERM]` (RFC 4314 §4 requires `a`; other grantees are not disclosed) |
| `LISTRIGHTS mbox id` | own folder: the owner all rights, anyone else `""`; foreign folder: the caller's own identifier → its rights, anyone else `NO [NOPERM]` |
| `SETACL`, `DELETEACL` | `NO [NOPERM]` — permissions are managed by administrators in the BCP |

Unknown or inaccessible mailboxes → `NO [NONEXISTENT]`.

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
| `IMAP_NAMESPACE_OTHER_USERS` | `Other Users` | prefix of the delegated-mailbox namespace; `off` / empty disables it. Printable ASCII without `. / % * " \`, not `INBOX`; an invalid value falls back to the default |
| `IMAP_NAMESPACE_SHARED` | `Shared` | prefix of the Shared Mailbox namespace; same rules; must differ from the other prefix (else this namespace is disabled) |
| `IMAP_SHARED_ACCESS_CACHE_MS` | 30000 | lifetime of the per-session permission cache (0–30000) |
| `REFERENCES_BACKFILL` | on | background indexing of the References of messages written before 9.1 (`off`: only lazily by THREAD=REFERENCES) |
| `REFERENCES_LAZY_BUDGET_MS` | 1500 | time budget of the lazy References indexing in one THREAD=REFERENCES command (at most 200 messages; `0` = no lazy step; max 30000) |

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
- `src/server/imap-shared.test.ts` (same runner, multi-mailbox fake) — NAMESPACE
  configuration, LIST/LSUB/LIST-STATUS of foreign folders, every message command
  on Shared / Other Users folders, read-only NOPERM, target quota, IDLE push,
  ACL rights, IDOR checks on every command (incl. UID addressing and COPY in both
  directions), live revocation and downgrade.
- `packages/storage/src/mailbox-access.test.ts` — the access policy.
