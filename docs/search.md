# Mail search and search suggestions

CoreMail's webmail has two search paths on top of PostgreSQL:

| Path | What it matches | Used by |
|------|-----------------|---------|
| `GET /api/v1/mail/search?q=` (+ the same route of a shared / delegated mailbox) | the operator language of `lib/search-query.ts` (`from:`, `subject:`, `is:unread`, `in:`, `"phrase"`, `-word` …); free text as one substring of subject, sender name, sender address **and body** | the message list after typing (300 ms debounce) and the header search (Enter) |
| `GET /api/v1/mail/search/suggest?q=` (10.2, + the same route of a shared / delegated mailbox) | the literal text as one substring of subject, sender name and sender address — never the body | the suggestion dropdown of both search fields |

Both are plain Prisma queries (`contains`, `mode: 'insensitive'` → `ILIKE '%…%'`).
Since 10.2 PostgreSQL maintains a trigram index that serves these conditions.

## The index (10.2)

```prisma
datasource db { extensions = [pg_trgm] }   // previewFeatures += "postgresqlExtensions"

model Message {
  @@index([subject(ops: raw("gin_trgm_ops")), fromName(ops: raw("gin_trgm_ops")), fromAddr(ops: raw("gin_trgm_ops"))],
          type: Gin, map: "messages_search_trgm_idx")
}
```

One multi-column GIN index with the `pg_trgm` operator class on `messages.subject`,
`"fromName"` and `"fromAddr"`. A multi-column GIN index answers a condition on any of
its columns, so the planner combines the three `ILIKE` arms of the `OR` with a
`BitmapOr` over the same index.

**Always current, no indexing job.** PostgreSQL updates the index inside the
transaction that inserts or updates a message (GIN "fast update": new entries go to
a pending list that autovacuum / `gin_pending_list_limit` merges). There is no
application-side indexing, no backfill and no batch job — a message is findable the
moment its row is committed, by every writer (SMTP delivery, IMAP APPEND, JMAP,
ActiveSync, MAPI, restore).

### Why trigrams, not full-text search

- The search language matches **substrings** (`ILIKE '%…%'`) — `anna.k` must find
  `anna.koch@kunde.de`, `rechn` must find "Rechnung". PostgreSQL full-text search
  (`tsvector`) matches words and word prefixes after stemming; it would change what
  the existing search finds and cannot match inside addresses.
- The existing Prisma queries use the index unchanged — no raw SQL, no second query
  language. A `tsvector` column would need a generated column, which Prisma 5 cannot
  declare (`prisma db push` would fight it on every start).
- `pg_trgm` is a contrib module of the stock `postgres:16-alpine` image and a
  *trusted* extension (PostgreSQL 13+); `infra/docker/postgres/init.sql` and the Helm
  chart's `files/postgres-init.sql` create it on every new database since the first
  CoreMail release.

### Why not the body

A trigram index over `bodyText` would be several times the size of the bodies and
make every delivery write thousands of index entries. The full search still matches
bodies — within the folders of one mailbox, so the cost stays bounded by the mailbox
size (the `OR` with the body arm cannot use the index; operator searches such as
`from:` / `subject:` without free text can). The suggestions never search bodies.
A word-based body index (`tsvector`) remains an option for a later release.

## Migration and schema-sync

`schema-sync` (container start / Helm init container, `infra/docker/schema-sync.sh`)
applies the change with `prisma db push`:

```sql
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- only when it is missing
CREATE INDEX "messages_search_trgm_idx" ON "messages"
  USING GIN ("subject" gin_trgm_ops, "fromName" gin_trgm_ops, "fromAddr" gin_trgm_ops);
```

- **No data-loss path.** Prisma reports no warning for a new extension or index (the
  classifier `schema-sync-classify.mjs` is not involved); nothing is dropped or
  rewritten, no pre-migration dump is needed. Prisma never drops extensions the
  schema does not list (`unaccent`, `pgcrypto` of `init.sql` stay). Starting an
  older image again drops only the index (no data).
- **Build time.** `CREATE INDEX` (not `CONCURRENTLY`) blocks writes to `messages`
  while it builds — during the start, before the mail services run. Measured on
  `postgres:16-alpine` (Docker, `maintenance_work_mem` 64 MB): 500 000 messages
  6.8 s, 2 000 000 messages 22 s (≈ 11 µs per message). Size: 217 MB for 2 million
  messages with short subjects (≈ 110 bytes per message); real installations are
  similar per message, a small fraction of the table with its bodies.
- **Database without `pg_trgm` and a role that may not create it** (the
  least-privilege app role `coremail_app` of `02-app-role.sh` has no `CREATE` on the
  database; an external PostgreSQL without the contrib module; the extension in a
  schema outside the search path): the push fails before anything is changed.
  schema-sync recognises the error (`OPTIONAL_EXTENSIONS` in the classifier), pushes
  the schema once more **without** the two lines tagged
  `// schema-sync:optional pg_trgm` (the `extensions` entry and the index) and logs a
  warning. CoreMail starts normally; the search works exactly as before 10.2, only
  without the index. Every start tries the full schema again, so creating the
  extension once is enough:

  ```bash
  # Docker Compose (the superuser of the bundled PostgreSQL)
  docker exec coremail-postgres psql -U coremail -d coremail -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
  # external / managed PostgreSQL: as a superuser or the database owner
  psql "$ADMIN_URL" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
  ```

  then restart CoreMail (`docker compose up -d coremail`, or the pod). Installations
  created with `init.sql` / the Helm chart already have the extension.

Tests: `infra/docker/schema-sync-classify.test.mjs` (the captured Prisma output of
this change, the failure detection, the stripped schema), `infra/docker/schema-sync.test.mjs`
(the degraded push). Verified against `postgres:16-alpine` as `coremail_app` with and
without `pg_trgm`: degraded start, then `CREATE EXTENSION`, then the full schema on
the next start; a second start reports "already in sync".

## Search suggestions (`/search/suggest`)

`GET /api/v1/mail/search/suggest?q=` (own mailbox) and
`GET /api/v1/mail/{shared,delegated}-mailboxes/:id/search/suggest?q=`
(`lib/search-suggest.ts`):

```json
{ "people":   [{ "name": "Anna Koch", "address": "anna@kunde.de" }],
  "messages": [{ "id": "…", "folderId": "…", "folderName": "Posteingang", "subject": "Angebot",
                 "fromName": "Anna Koch", "fromAddr": "anna@kunde.de", "date": "2026-03-01T10:00:00.000Z" }] }
```

- `q`: 2–100 characters (control characters dropped, whitespace collapsed), matched
  literally — `%`, `_` and `\` are escaped (Prisma does not escape `contains`).
  Shorter → `{ people: [], messages: [] }` without a database query.
- **Scope**: own mailbox — every folder (as `/search`, Trash and Junk included);
  shared / delegated mailbox — exactly the folders `/search` covers
  (`canReadFolder`, folder permissions included), never more. No access → 403
  `NO_ACCESS` before the query is looked at.
- **messages** (≤ 6): live messages whose subject / sender name / sender address
  contain `q`, newest first.
- **people** (≤ 4): senders of the newest 40 matching messages; recipients (To/Cc)
  of the newest 2 000 messages of the readable Sent folder (one bounded backward scan
  of the `(folderId, date)` index); the caller's own contacts (name / e-mail, only
  while the contacts module of the webmail policy is on — also in a foreign mailbox
  they are the caller's contacts, never the owner's). De-duplicated by address;
  entries matching at a word start come first.
- **Rate limit**: per user, 120 requests / 60 s (`MAIL_SUGGEST_RATE_LIMIT`,
  `MAIL_SUGGEST_RATE_WINDOW_SEC`; 0 disables), shared by all mailboxes, below the
  global per-user API limit (3 000 / 15 min). Over the limit: 429 `RATE_LIMITED`.

### Measured cost

`postgres:16-alpine` in Docker on a desktop machine, `shared_buffers` 128 MB, one
mailbox of **100 000 messages** in a `messages` table of 2 000 000 (50 mailboxes),
warm cache; one suggestion request = 4 queries in parallel (times per query /
request through the real Prisma client):

| Query term | Without index (500 k table) | With `messages_search_trgm_idx` |
|------------|-----------------------------|---------------------------------|
| rare (a number, a unique word, `xyzzy`) | 60–100 ms | 0.2–1 ms (request 2–6 ms) |
| common subject word ("Rechnung", ≈ 7 % of all messages) | 70–100 ms | 60–80 ms |
| common sender prefix (`anna.k`, ≈ 25 000 candidate rows install-wide) | 70–85 ms | 110–120 ms (request 120–190 ms) |
| two characters (`ab` — too short for a trigram) | 60–85 ms | 130–150 ms (scan of the mailbox's folders) |
| recipients (Sent window of 2 000) | — | 3–7 ms |

Rare and typical terms — what typing usually produces after a few characters —
are answered in a few milliseconds instead of scanning the mailbox. Very common
terms still read every matching row of the mailbox to find the newest ones (a GIN
index cannot return rows in date order), so they cost about as much as before; the
debounce (150 ms), the abort of stale requests and the rate limit bound the load.
The first query after a database restart reads from disk and can take seconds.

## Webmail

The search field of the message list and the header search share one combobox
(`hooks/useSearchSuggest.ts`, `components/SearchSuggestList.tsx`, rules in
`lib/searchSuggest.ts`):

- 2+ characters without operator syntax: after 150 ms the server suggestions for
  the mailbox shown in the mail view (TanStack Query; a newer term aborts the stale
  request, the previous suggestions stay visible while the next load).
  **Personen** (avatar, name, address) → runs the search `from:<address>` over the
  whole mailbox (the message list's scope switch changes to "Alle"; the header search
  always searches the whole mailbox);
  **Nachrichten** (subject, sender, folder, short date) → opens the message through
  its deep link (`lib/mailLinks.ts`).
- Field focused and empty: **Letzte Suchen** — the last 5 search terms of the user in
  this browser (`localStorage` `coremail:recent-searches:<userId>`, every access in
  try/catch; `lib/recentSearches.ts`); "×" (or Delete on the highlighted entry)
  removes one. A search counts as run on Enter, a picked person or a picked recent
  search.
- Keyboard: ↑/↓ move (`role="combobox"` + `aria-activedescendant`, options in
  `role="listbox"` groups), Enter picks the highlighted entry, Enter without one runs
  the full search as before, Escape closes (a second Escape clears the list field).
- Operator syntax (`from:`, `is:`, quotes, `-word`) shows no suggestions — the full
  search handles it as before.
