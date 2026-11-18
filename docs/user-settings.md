# Personal settings (webmail)

Since 9.4 the webmail settings follow the user from device to device: they are stored on the
server, the browser keeps only an offline copy. This page describes what is stored where, the API,
and how each setting takes effect.

## Where settings live

| Setting | Stored in | Applied by |
|---|---|---|
| View: reading pane, density, conversations, sort order, conversation order, shortcuts, undo-send delay, new-mail notification | `UserSettings.preferences.view` | webmail |
| Theme (light/dark/system) and accent colour | `preferences.theme` | webmail (the accent only while the branding allows user accents) |
| Language, time zone, date format, 12/24 h | `preferences.regional` | webmail formatting; the time zone also for invitation texts (iMIP) |
| Mark as read, read receipts, empty Deleted Items on logout | `preferences.reading` | webmail; read receipts and the logout cleanup on the server |
| Compose format, default font and size, forgotten-attachment check | `preferences.compose` | webmail |
| Calendar: work days and hours, week start, time grid, default reminder, default duration, week numbers, hidden calendars | `preferences.calendar` | webmail calendar; default reminder on the server (`POST /calendar/events`) |
| Signatures (several, named) | table `user_signatures` | webmail compose |
| Default signature per identity (own address, shared mailboxes) and kind (new / reply) | `preferences.signatures.defaults` | webmail compose |
| Out of office, rules, categories, inactivity timeout, hidden shared mailboxes | unchanged (own columns / tables) | server / webmail |
| Panel widths, collapsed folder sections, expanded shared mailboxes | browser only | webmail (they depend on the screen) |

`UserSettings.preferences` is one JSON column with a version. The api-gateway
(`packages/api-gateway/src/lib/user-preferences.ts`) defines every field once, with its validation
and default:

- **Reading** a stored value is tolerant — a missing or invalid field gets its default, unknown
  keys are dropped. A login never fails because of a stored preference.
- **Writing** (`PATCH`) is strict — an unknown section or field, or an invalid value, is refused
  with 400.

The webmail has the same shape and defaults in `packages/web-client/src/lib/preferences.ts`.

## API

All routes need a session (Bearer access token).

```
GET   /api/v1/user/preferences
      → { inactivityTimeoutMinutes, inactivityTimeoutMinutesGlobal, preferences }
PATCH /api/v1/user/preferences   (PUT is the same handler)
      { inactivityTimeoutMinutes?, preferences?: { <section>: { <field>: value } }, migrateFromLocal? }
      → { ok, applied, inactivityTimeoutMinutes, inactivityTimeoutMinutesGlobal, preferences }
```

A `PATCH` replaces the given fields and leaves everything else alone; signature defaults merge per
identity (`{ "shared:<id>": { "newId": null, "replyId": null } }` removes an entry). Concurrent
writes (two tabs, two devices) are serialised, no field update is lost.

`preferences.migratedAt` is set by the first write. `migrateFromLocal: true` applies the patch only
while it is still empty — this is how the webmail imports the values a pre-9.4 browser kept in
`localStorage` (`coremail-ui-prefs`, `coremail-theme`, `coremail-owa-lang`) exactly once. After
that, the server copy wins on every login. Values of another account in the same browser are never
imported.

```
GET    /api/v1/user/signatures          → { signatures: [{ id, name, html, sortOrder }], defaults }
POST   /api/v1/user/signatures          { name, html }             → 201 signature (max. 20)
PUT    /api/v1/user/signatures/:id      { name?, html?, sortOrder? }
DELETE /api/v1/user/signatures/:id      (defaults pointing at it are cleared)
```

The pre-9.4 single signature (`GET/PUT /api/v1/user/signature`) keeps working: on first use it is
imported as the signature "Standard", and the old columns always mirror the own default
(new mails, else replies, else the first signature) — JMAP `Identity` reads them.

```
GET    /auth/sessions                   → [{ id, ipAddress, userAgent, createdAt, lastUsedAt, expiresAt, mfaVerified, current }]
DELETE /auth/sessions/:id               ends one session (access tokens refused at once)
POST   /auth/sessions/revoke-others     ends every session except the calling one → { revoked }
```

Mobile devices (`GET/DELETE /api/v1/smime/devices`) and S/MIME processing
(`GET/PUT /api/v1/smime/settings`) are shown in Settings → Sicherheit with their existing routes.

### Read state and read receipts

```
GET  /api/v1/mail/messages/:id?markRead=false     (also on shared/delegated mailboxes)
POST /api/v1/mail/messages/:id/receipt            { action: 'send' | 'ignore', mode?: 'manual' | 'automatic' }
```

Opening a message marks it read as before; `?markRead=false` leaves the read state alone. The
webmail always passes it and marks the message read itself — immediately, after the chosen number of
seconds in the reading pane, or only manually.

Incoming mail with a `Disposition-Notification-To` header gets the address stored in
`Message.dispositionNotificationTo` at delivery (messages delivered before 9.4 have none). The
receipt route re-reads the header from the raw original, sends the receipt (`multipart/report`,
disposition "displayed") through the normal outbound queue and sets the `$MDNSent` keyword;
`ignore` only sets the keyword, so the user is asked once per message. Policy "Immer senden"
answers automatically only when the receipt goes back to the sender's domain; requests in Junk and
in shared or delegated mailboxes are never answered.

Sending: `POST /mail/send` and `POST /mail/drafts/:id/send` accept `requestReceipt: true`, which
adds `Disposition-Notification-To: <From address>`.

### Message list order

`GET /mail/folders/:id/messages` (own, shared and delegated mailboxes) accepts
`sort=date|from|subject|size` and `dir=desc|asc`. Pinned messages stay on top; the default is the
pre-9.4 order (date, newest first). With "group by conversation" the webmail lists the messages of a
conversation together, newest or oldest first.

### Calendar defaults

`POST /api/v1/calendar/events` accepts `reminderMinutes` (number, or `null` for none). Without it
the user's default reminder is written as a display alarm (`VALARM`) into the event, so CalDAV and
ActiveSync clients alert too. Invitations show times in the organizer's time zone.

### Logout

With "Gelöschte Elemente beim Abmelden leeren" a webmail logout (`POST /auth/logout` from the
webmail) moves the content of Deleted Items to the recoverable items — they can still be restored
for the retention period.

## Deep links

The address bar reflects what the webmail shows, so back/forward work and links can be shared with
people who have access to the same mailbox:

- `/mail/<mailbox>/<folderId>/<messageId>` — `<mailbox>` is `own`, `shared:<id>` or
  `delegated:<id>` (URL-encoded); `/mail` opens the inbox of the own mailbox.
- `/calendar/event/<id>` opens an event, `/contacts/<id>` a contact.

The pre-9.4 form `/mail?mailbox=shared:<id>` is still understood and rewritten.

## Not covered

- The calendar grid itself uses the browser's time zone; the configured time zone applies to the
  mail list, the reading pane, the sessions list and invitation texts.
- A compose window picks its signature once when it opens; changing the sender afterwards does not
  swap the signature.
