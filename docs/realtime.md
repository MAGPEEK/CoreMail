# Realtime updates (9.4)

Every change a user can see — new mail, flags, moves, deletes, folder lists,
calendar, tasks, contacts, notes, settings, quota, branding — reaches the open
clients within about a second, whichever protocol made it. Polling is only a
safety net.

## Event vocabulary

Two Redis pub/sub channels, defined in `packages/core/src/realtime/` (typed,
validated with `parseMailboxChange` / `parseUserEvent`):

| Channel | Payload | Published by |
|---|---|---|
| `mailbox:changes` | `{ mailboxId, kinds: ('messages'\|'flags'\|'folders')[], folderIds?, modSeq? }` | the message store (every message write) and every folder writer |
| `user:<userId>:events` | `{ type: 'calendar'\|'tasks'\|'contacts'\|'notes'\|'settings'\|'quota', action?, ids?, calendarIds?, scope?: 'shares', section? }` | REST, CalDAV/CardDAV, ActiveSync MeetingResponse, iTIP replies (SMTP delivery), admin quota changes |

`mail:new` stays the "new mail arrived" notification (sender/subject for the
webmail hint and Web Push, published by SMTP delivery). The branding broadcast
uses the existing `settings:reload` message `{ "type": "branding" }`. The former
`mail:update` and `calendar:shares` channels are gone.

### Publishing

- **Messages** — nothing to do in the writers. `packages/storage/src/message-store.ts`
  records every create/move/copy/restore/flag/touch/expunge
  (`realtime/change-scope.ts`). The storage Prisma client wraps interactive
  `$transaction(fn)` calls: changes are merged per mailbox and published **after
  the commit**, dropped on rollback. A `$transaction` started inside another is a
  database transaction of its own and publishes on its own commit. Writers that
  finish related rows after the message transaction wrap the whole unit in
  `deferMailboxChanges(fn)` — SMTP delivery (attachments, rule copies, folder
  counters), the ActiveSync Sent copy and the Shared Mailbox Sent copy of a send as /
  on behalf (storage `storeRawInSentFolder`) — so the event goes out once the clients
  can re-read the finished state (also when a later step fails: committed stays
  committed). Changes recorded outside any scope are published 100 ms later. This covers SMTP delivery, IMAP, POP3, JMAP,
  ActiveSync, the REST API, restore, retention and mail rules alike.
- **Folder lists** — `announceFolderListChange(mailboxId)` (storage) after a
  folder create / rename / move / delete (REST incl. shared/delegated mailboxes,
  IMAP CREATE/RENAME, JMAP Mailbox/set, restore; `deleteFolderMovingMail` does it
  itself).
- **Calendar** — `announceCalendarChange(calendarIds, { action, ids, scope })`
  reaches the calendar owners and every share grantee; event ids go to the owners
  only (a grantee must not learn about confidential events).
- **Message categories** — assigning categories touches the messages
  (`touchMessages`: new modSeq, `mailbox:changes`); editing the category list is a
  `settings` event.
- **Everything else** — `announceUserEvent(userIds, event)`. REST routers use the
  `announceOnWrite` middleware (`packages/api-gateway/src/lib/realtime.ts`): after a
  successful POST/PUT/PATCH/DELETE the acting user's other tabs and devices hear
  about it (tasks, notes, contacts, categories, `/user` settings by area).

All helpers are fire-and-forget: a Redis failure is logged, never fails the write.
Tests: `globalThis.__realtimeRedis` (transport seam, `null` = publish nothing;
the storage test preload `src/test-support/realtime-off.ts` sets it) and
`setMailboxChangePublisher()`.

## Consumers

### Webmail (SSE)

`GET /api/v1/events` (single-use ticket, 25 s heartbeat, reconnect with backoff).
The gateway hub (`lib/sse-hub.ts`) has one Redis subscriber per process:

- `mailbox:changes` → SSE `mailbox` to everyone who sees the mailbox
  (`mailboxAudience`: owner, Shared Mailbox members and delegates with
  FULL_ACCESS/READ_ONLY), tagged with that user's mailbox key
  (`own` / `shared:<id>` / `delegated:<mailboxId>`). Lookups are cached 30 s and
  dropped on permission changes.
- `user:<id>:events` → SSE event named after the type (`calendar`, `tasks`, …).
- `settings:reload` `{type:"branding"}` → `branding` to every connection.
- Every user-routed event only while Webmail is switched on for the user (an
  unreadable switch withholds it); admin streams keep `security:attack`.

The webmail (`hooks/useRealtime.ts`, pure logic in `lib/realtimeEvents.ts`)
invalidates exactly the affected TanStack queries (folder list and message lists
of the changed folders, quota, calendar, …), coalesced for 250 ms. Remaining
`refetchInterval`s are a 15-minute safety net (`SAFETY_REFETCH_MS`).

**One connection per browser.** Open tabs elect a leader over a
`BroadcastChannel` (`lib/tabLeader.ts`: hello / heartbeat every 2 s / takeover
after 5 s without heartbeat / lower id wins a tie / resign on close). Only the
leader holds the SSE stream and forwards each event to the other tabs. Without
`BroadcastChannel` every tab connects itself. A logout in one tab — or
`session-ended` from the server — logs out every tab.

Task reminders run in the leading tab only (`lib/tabRole.ts`,
`lib/taskReminders.ts`): it shows the toast, sends the reminder mail and
announces the reminder to the other tabs, which show the same toast and remember
it (a later leader does not fire it again). Without `BroadcastChannel` every tab
leads itself.

### IMAP IDLE

`imap-server` subscribes to `mailbox:changes` (`server/idle-push.ts`): an idling
session whose selected folder belongs to the mailbox (and, when the event names
folders, is one of them) re-reads its view and reports EXISTS / EXPUNGE / FETCH
FLAGS. Folder-list changes do not wake IDLE. Wake-ups coalesce: while a re-read
waits for the session lock, further changes join it (`queueIdleSync`), so a burst
costs at most one running and one waiting re-read per session. The per-session
timer is a fallback (120 s, `setIdlePollInterval`). Sessions ended by a credential change or the
protocol switch are already gone and are never woken.

### JMAP push

`jmap-server` (`push/bus.ts`) maps `mailbox:changes` to the JMAP account
(user id or `shared-<id>`) and wakes EventSource/WebSocket listeners (StateChange
built 300 ms later from the current states) and JMAP Web Push subscriptions
(batched 1 s, only users with JMAP switched on).

## Web Push in the webmail

Settings → **Benachrichtigungen**: opt-in per browser. The webmail registers
`/sw.js` (with `/sw-logic.js`, no fetch handler, no offline caching), asks for
notification permission, subscribes with the server's VAPID key
(`GET /api/v1/push/vapid-public-key`; 503 without `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY`) and registers the subscription (`POST /api/v1/push/subscribe`,
topic `mail.new`). Turning it off unsubscribes the browser and calls
`POST /api/v1/push/unsubscribe`.

- **Preview** (`PushSubscription.showPreview`, default off): with it the
  notification shows sender and subject, without it the product name and
  "Neue Nachricht".
- **Click** focuses an open webmail window and routes it to
  `/mail?folder=<id>&message=<id>` (plus `mailbox=shared:<id>` for a Shared
  Mailbox); without an open window a new one opens there.
- Sent once per (user, message) across gateway instances; never for junk; never
  while Webmail is switched off for the user; never to deactivated Shared Mailbox
  members.
- **Logout ends it**: when the session of the browser ends (logout in any tab,
  expiry, revocation) the webmail cancels the browser's push subscription; the
  gateway drops the row on the push service's next 410. Turning push on again
  after the next login is up to the user.
- Notification clicks only follow same-origin paths without whitespace, control
  characters or backslashes (`sw-logic.js`); anything else opens `/mail`.

## Installable webmail (PWA)

`GET /manifest.webmanifest` is built from the branding: product name, header or
primary colour as theme colour, `start_url: /mail`, `display: standalone`, PNG
icons 192×192 and 512×512:

- **Default** — rendered from the default logo when the web client is built
  (`scripts/app-icons.mjs` → `/icons/app-{192,512}.png` and
  `/icons/app-maskable-{192,512}.png`, purpose `any` / `maskable`).
- **Custom** — a square PNG branding favicon of at least 512 px (8-bit,
  non-interlaced) is scaled by the gateway in pure JavaScript
  (`lib/branding/png.ts`, `lib/branding/app-icons.ts`) and served as
  `/branding/app-icons/<sha256>-{192,512}.png` (immutable, only for the current
  favicon, cached). Purpose `any` only — a logo of unknown shape is not declared
  maskable. WebP, SVG and smaller favicons keep the default icons (scaling them
  would need a native image library).
`/sw.js` and `/sw-logic.js` are served with `Cache-Control: no-cache`.

## Tests

- core `src/realtime/realtime.test.ts` — vocabulary, validation, merge, publish.
- storage `src/message-store.test.ts` — post-commit publish, rollback, cross-mailbox move;
  `src/realtime/change-scope.test.ts` — deferred units of work, nested transactions;
  `src/realtime/audience.test.ts` — mailbox audience, calendar ids for owners only.
- api-gateway `src/lib/sse-hub.test.ts` (routing, audience cache, notification payload),
  `src/lib/realtime.test.ts` (middleware, settings areas, manifest),
  `src/routes/categories.test.ts` (category assignment = message change),
  `src/lib/branding/app-icons.test.ts` (PNG codec, scaling, custom icons).
- imap-server `src/server/idle-push.test.ts` + protocol suite (IDLE woken by a
  message-store write, folder changes do not wake).
- jmap-server `src/push/bus.test.ts`.
- web-client `src/lib/realtimeEvents.test.ts`, `tabLeader.test.ts`, `tabRole.test.ts`,
  `taskReminders.test.ts`, `webPush.test.ts`, `swLogic.test.ts`, `appIcons.test.ts`.
- e2e: `webmail` (SSE receives contacts, calendar and shared-folder events;
  manifest with its PNG icons + `sw.js`), `live` (IMAP IDLE reports EXISTS within 2 s of a delivery).
