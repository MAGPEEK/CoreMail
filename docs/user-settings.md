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
| Profile photo (9.5) | `User.photoKey` + object store `profile-photos/` | webmail avatars of the organisation (see [Profile photo](#profile-photo)) |
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
disposition "displayed") through the normal outbound queue with a null envelope sender (an
undeliverable receipt is not reported back) and sets the `$MDNSent` keyword; `ignore` only sets
the keyword, so the user is asked once per message. Policy "Immer senden" answers automatically
only when the receipt goes back to the sender's domain, and the route accepts `mode: 'automatic'`
only with that policy. Never answered: requests in Junk, in shared or delegated mailboxes, and
mailing-list, bulk or automatic mail (`List-Id`, `List-Post`, `Precedence: bulk|list|junk`,
`Auto-Submitted` other than `no`, `multipart/report`) — those requests are not even stored.

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
ActiveSync clients alert too. Invitations show times in the organizer's time zone (all-day events
as dates, the exclusive end shown as the last day).

The calendar grid and the event dialog use the configured time zone (FullCalendar with the luxon
time-zone plugin; empty setting = the browser's zone): times are shown and entered as wall-clock
times of that zone and stored as UTC instants.

### Compose signatures

The inserted signature is a block of its own in the compose body (`<div data-cm-signature>`).
Changing the sender ("Von") replaces it with the new identity's default while it is still exactly
as inserted — never after the user edited or removed it, and not in reopened drafts. The signature
picker (compose ribbon **Einfügen → Signatur** and the "…" menu) inserts any named signature (or
removes it), also in plain-text format. The compose area itself: [compose.md](compose.md).

### Logout

With "Gelöschte Elemente beim Abmelden leeren" a webmail logout (`POST /auth/logout` from the
webmail) moves the content of Deleted Items to the recoverable items — they can still be restored
for the retention period.

## Profile photo

Settings → E-Mail-Konto shows the own avatar (96 px) with "Foto hochladen…" / "Foto ändern…" and
"Foto entfernen". A picked JPEG, PNG or WebP file (max. 5 MB) opens a crop dialog: the image lies
behind a round mask, is moved by dragging (mouse, touch) or the arrow keys (Shift: larger steps)
and zoomed with the "Zoom" slider, the mouse wheel or + / −; it always covers the circle. Previews
show the result at 96, 40 and 28 px. "Übernehmen" renders the circle's square as a 512×512 PNG in
the browser (the circle is only the display mask) and uploads it.

```
PUT    /api/v1/user/photo               raw PNG / JPEG body, or multipart field `photo` (max. 5 MB)
                                        → { photo: { userId, version, updatedAt } }
DELETE /api/v1/user/photo               → { removed }
POST   /api/v1/users/photos/lookup      { addresses: [...] } (max. 100) → { photos: { <address>: { userId, version } } }
GET    /api/v1/users/:id/photo          image/jpeg, ETag (If-None-Match → 304), Cache-Control: private, no-cache
GET    /api/v1/user/profile             … photo: { userId, version, updatedAt } | null
```

**Processing.** The server never stores the uploaded bytes: it checks the type by magic bytes (PNG
or JPEG — WebP and everything else → 415 `UNSUPPORTED` / `TYPE`), reads the dimensions from the
header before decoding (more than 2048 × 2048 pixels or a side under 32 px → 422 `DIMENSIONS`;
more than 5 MB → 413 `SIZE`; undecodable data → 422 `CORRUPT`), decodes it (pure JavaScript, PNG
8-bit non-interlaced, JPEG with resolution and memory caps), crops the centre square, scales it to
512×512, flattens transparency onto white and encodes a new baseline JPEG — no EXIF, GPS, ICC or
comment segments survive. The EXIF orientation of a JPEG sent by an API client is not applied (the
webmail always uploads its own rendering). Uploads are limited per user
(`PROFILE_PHOTO_UPLOAD_LIMIT`, default 20 per `PROFILE_PHOTO_UPLOAD_WINDOW_SEC` = 600 s; 0 disables).

**Storage.** `getObjectStore()` under the content-addressed key `profile-photos/<aa>/<sha256>.jpg`
(never a file name); `User.photoKey` / `photoUpdatedAt` point to it (storage `profile-photo.ts`). A
replaced or removed photo is deleted once no account references it; deleting the account removes
it too.

**Who sees it.** Every signed-in user of the same domain — the boundary of the address list — sees
the photos of the active accounts listed there, and everyone sees the own photo; other requests are
404 (no hint whether an account or photo exists). The webmail shows photos for internal senders in
the message list and the reading pane, on the contact card, in the contact list and on meeting
attendees: the addresses on screen are resolved in one batched lookup (aliases included), each
photo is loaded once per version as a `blob:` URL (Authorization header, never a token in a URL).
External senders keep their initials. Photos are not served over CardDAV, ActiveSync or MAPI.

**Initials** (no photo): first letter of the first and of the last word of the display name ("Erika
Mustermann" → "EM", "Mustermann, Erika" → "EM", parenthesised parts ignored); one word → one letter;
no name → the first letter of the address' local part (`lib/initials.ts`). The colour still comes from
the address.

**Changes.** The own change announces the user event `settings` / `profile` (the top bar and own
messages update at once); other users get the new version with their next lookup (cached for five
minutes) and revalidate the image by ETag.

**Webmail policy.** The module `profilePhoto` (server → domain → user, docs/webmail-policies.md)
switches upload and change: off → the buttons are hidden and `PUT /user/photo` answers 403
`FEATURE_DISABLED`. An existing photo stays visible, and the owner can still remove it.

**Admin.** The BCP mailbox detail shows the photo with "Foto entfernen" (area `recipients`, write;
management scope of the admin): `GET` / `DELETE /api/v1/admin/mailboxes/:id/photo`. Removing the
photo of an admin account needs a role that may manage it. The removal is audited as
`mailbox.photo.remove`. Directory synchronisation (LDAP / OIDC) does not set photos.

## Deep links

The address bar reflects what the webmail shows, so back/forward work and links can be shared with
people who have access to the same mailbox:

- `/mail/<mailbox>/<folderId>/<messageId>` — `<mailbox>` is `own`, `shared:<id>` or
  `delegated:<id>` (URL-encoded); `/mail` opens the inbox of the own mailbox.
- `/calendar/event/<id>` opens an event, `/contacts/<id>` a contact.

The pre-9.4 form `/mail?mailbox=shared:<id>` is still understood and rewritten.

## Not covered

- Sorting by sender, subject or size uses the folder index and sorts the folder's rows in the
  database (no per-column index: subjects can exceed the B-tree entry size).
