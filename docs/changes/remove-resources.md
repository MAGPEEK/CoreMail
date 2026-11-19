# remove-resources — room/equipment resources removed (10.0.0, MAJOR)

**SemVer: MAJOR** — removes REST endpoints, an admin API, schema models/tables and SMTP
behaviour (mail to room addresses is refused).

## Removed

- **Room and equipment mailboxes** completely (like distribution groups in v5.6.1, public
  folders in v3.18.31 and eDiscovery in v3.18.5):
  - Schema: models `ResourceMailbox`, `ResourceCalendar`, `ResourceBooking`, enum `ResourceType`
    and the relations `Domain.resourceMailboxes` / `Mailbox.resourceMailbox` (tables
    `resource_mailboxes`, `resource_calendars`, `resource_bookings`).
  - Storage: `room-booking.ts`, `resource-booking-rules.ts`, `resource-lock.ts`; the
    room-reply-only options (`subject`, `text`, `headers`) of `buildITipReplyMime`.
  - SMTP: resource booking of mailed invitations (`handlers/resource-booking.ts`), the rooms'
    iMIP replies (`handlers/resource-reply.ts`), the recipient lookup of resource addresses and
    the outbound job flag `resourceReply` with its sender-authentication path. A queued 9.5 job
    that still carries the flag is delivered without sender authentication.
  - REST: admin API `/api/v1/admin/resources` (incl. bookings and free/busy), EMS
    `GET /api/v1/admin/ems/resource-mailboxes`, `GET /api/v1/calendar/rooms`, the `rooms` field of
    `POST`/`PUT /api/v1/calendar/events` and the `rooms` / `uid` fields of
    `POST /api/v1/calendar/schedule-suggestions` (ignored when sent). `resources` key of
    `GET /api/v1/admin/organisation/gal`.
  - ActiveSync: room booking of meetings written by a phone (`pim/calendar-rooms.ts`).
  - Webmail: room picker of the event form and the room rows of the scheduling assistant.
  - BCP: remaining room texts (SMTP local delivery hint, role description of
    RECIPIENT_MANAGEMENT).

## Changed

- Calendar meetings: attendees are no longer split into people and rooms — every attendee
  (including one with `CUTYPE=ROOM` / `RESOURCE` from another client) is stored and invited like
  any other. Only the organizer's copy sends invitation updates / cancellations (unchanged;
  `isOrganizerCopy` moved to api-gateway `lib/organizer-copy.ts`).
- schema-sync: a new verdict **retire** — the tables listed in `RETIRED_TABLES`
  (`infra/docker/schema-sync-classify.mjs`: the three room tables) are dropped without
  `COREMAIL_ALLOW_SCHEMA_DATA_LOSS`, but only when every other warning is a safe new unique
  constraint, each table is logged with its row count, and only after the **mandatory**
  pre-migration dump succeeded. Data of a retired table kept in other tables
  (`RETIREMENT_CLEANUP`: the rooms' own owner-less mailbox rows with their folders, messages
  and attachments) is deleted after the dump and before the drop, in one transaction — also on
  the `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` path. Any other data loss stays fail-closed. Without a
  dump location the start stops with the Helm values to set (`app.schemaSync.backupClaim` /
  `skipBackup`).

## Upgrade notes (9.5.x → 10.0.0)

1. **Room data is dropped after a backup.** On the first start, schema-sync writes
   `/data/backups/pre-migrate-<UTC timestamp>.sql.gz` (the `coremail-data` volume) and then drops
   `resource_mailboxes`, `resource_calendars` and `resource_bookings` — the log lists every table
   with its row count. No `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` is needed. If the dump cannot be
   written (no space, PostgreSQL newer than the image's `pg_dump`, directory not writable), the
   start stops and nothing is changed: make your own backup and start once with
   `COREMAIL_SCHEMA_BACKUP=skip`. Helm: set `app.schemaSync.backupClaim` (or
   `app.schemaSync.skipBackup=true` after your own backup) for this rollout.
2. **Mail to room addresses is refused.** A former room or equipment address is an unknown
   recipient: port 25 answers `550 5.1.1` at RCPT, local senders get an NDR. Existing meetings
   still list the room as an attendee — remove it from the meeting, otherwise updates to it bounce.
3. **Recreating rooms**: if you still need a bookable room, create a **shared mailbox** (its
   calendar shared with the people who book it) or a **shared calendar** per room, and let
   attendees check it with the scheduling assistant / free-busy. There is no automatic
   accept/decline any more.
4. **The rooms' own mailboxes are deleted with them.** After the dump and before the tables are
   dropped, schema-sync deletes the mailbox rows that `resource_mailboxes` points at — only
   owner-less ones (no user, no shared mailbox) — together with their folders, messages and
   attachments (one transaction; the log shows the counts; a failure stops the start with
   nothing changed). The raw messages / attachment files of those mailboxes stay in the object
   store without any row pointing at them: no API can serve them, they only take space (they
   are in no backup either). A mailbox row left behind by a room deleted in 9.x (no
   `resource_mailboxes` row any more) is not touched.
5. Clients of the removed APIs (`/api/v1/admin/resources`, `/api/v1/calendar/rooms`, EMS
   `resource-mailboxes`) get 404.

## Tests

- `infra/docker/schema-sync-classify.test.mjs`: retired drop → `retire`; retired + unique →
  `retire`; retired next to any other drop / removed enum value / unexecutable change → `unsafe`;
  look-alike, qualified or prototype table names are not retired; CLI `retired` lines; the
  `cleanup` line of `resource_mailboxes` (one schema-qualified statement deleting only
  owner-less room mailboxes; the FK cascade chain mailbox → folders → messages → attachments is
  checked against schema.prisma); an unusual database schema name is not auto-applied.
- `infra/docker/schema-sync.test.mjs` (`node --test`, stub prisma / psql / pg_dump, needs `sh`):
  dump → room mailbox clean-up → push; a failing clean-up, a missing `psql` or no dump location
  stop the start before anything is deleted; an unrelated data loss next to the room tables is
  refused, its opt-in run cleans up too.
- e2e `schema-upgrade`: a 9.5.x database with room rows is upgraded without opt-in, every table
  logged, dump written first (holds the room rows and the room's mailbox), the room's own
  mailbox with folder / message / attachment deleted while a user's mailbox a room row points at
  and an unrelated owner-less mailbox are kept, tables + enum gone, other data kept; with a
  duplicate unique constraint or a dropped column next to it, nothing is changed (room mailbox
  kept); the opt-in run then removes the room mailbox too.
- api-gateway calendar route: a delegate with WRITE on the organizer's calendar still sends the
  update / cancellation; a meeting with a `CUTYPE=ROOM` attendee is moved without error, the
  attendee keeps its entry and is notified like any other.
- e2e `rest` (`/calendar/rooms` → 404), `smtp` (`/admin/resources` → 404, room address → 550
  5.1.1); room checks removed from `eas-pim` and `smtp`.
- Unit: smtp-server (RCPT 5.1.1 for a former room address, `resourceReply` lends no auth, store
  result `unknown`), api-gateway (`organizer-copy.test.ts`, calendar `rooms` ignored and
  `/calendar/rooms` 404, admin `/resources` + EMS 404), activesync (a room address in a phone
  meeting is an ordinary attendee, no resource model touched).
- Repo hygiene: "the room/equipment resource feature stays removed".
