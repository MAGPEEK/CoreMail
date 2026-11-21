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
| Background (10.1): none / built-in / own picture | `preferences.appearance.background`; the picture in `User.backgroundKey` + object store `backgrounds/` | webmail canvas behind the panes (see [Background](#background)) |
| Ribbon (10.1): collapsed (10.2: only the simplified ribbon exists; the former `layout` field was removed) | `preferences.ribbon` | webmail mail, calendar and contacts views (one shared ribbon) |
| Favourite folders (10.1) | `preferences.folders.favorites` | webmail folder pane ("Favoriten") |
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
10.6: the recovery address for self-service password reset
(`GET/PUT/DELETE /api/v1/user/recovery-email`, re-authentication required) is the first panel
there — docs/password-reset.md.

10.6: "Gemerkte Geräte" — browsers that skip the MFA step ("Auf diesem Gerät für N Tage nicht
mehr fragen", [mfa-policy.md](mfa-policy.md#gerät-merken)):

```
GET    /api/v1/user/trusted-devices        → { devices: [{ id, surface, userAgent, ipPrefix, createdAt, lastUsedAt, expiresAt }] }
DELETE /api/v1/user/trusted-devices/:id    revokes one own device (404 for any other id)
DELETE /api/v1/user/trusted-devices        revokes all → { revoked }
```

"Alle anderen Sitzungen beenden" and a password or MFA change revoke them too. While the MFA
policy of the account is "Aus", Settings → Sicherheit shows a note instead of the TOTP /
security-key setup (enrolled factors stay and can be removed).

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
more than 5 MB → 413 `SIZE`; undecodable data → 422 `CORRUPT`), walks the JPEG markers before
decoding (exactly one baseline / progressive frame, at most 32 scans and 512 segments, else 415
`UNSUPPORTED` — every scan makes the decoder walk the whole frame again, so thousands of tiny scans
would block the gateway for minutes), decodes it (pure JavaScript, PNG 8-bit non-interlaced, JPEG
with resolution and 128 MB memory caps), crops the centre square, scales it to
512×512, flattens transparency onto white and encodes a new baseline JPEG — no EXIF, GPS, ICC or
comment segments survive. The EXIF orientation of a JPEG sent by an API client is not applied (the
webmail always uploads its own rendering). Uploads are limited per user
(`PROFILE_PHOTO_UPLOAD_LIMIT`, default 20 per `PROFILE_PHOTO_UPLOAD_WINDOW_SEC` = 600 s; 0 disables).

**Storage.** `getObjectStore()` under the content-addressed key `profile-photos/<aa>/<sha256>.jpg`
(never a file name); `User.photoKey` / `photoUpdatedAt` point to it (storage `profile-photo.ts`). A
replaced or removed photo is deleted once no account references it; deleting the account removes
it too. Accounts with byte-identical photos share one object: the release reads the bytes, deletes
and puts them back if a reference appeared meanwhile, and a save writes the object again after
switching the key, so a concurrent save of the same photo never points at a deleted object.

**Who sees it.** Every signed-in user of the same domain — the boundary of the address list — sees
the photos of the active accounts listed there, and everyone sees the own photo; other requests are
404 (no hint whether an account or photo exists). The webmail shows photos for internal senders in
the message list and the reading pane, on the contact card, in the contact list and on meeting
attendees: the addresses on screen are resolved in one batched lookup (aliases included), each
photo is loaded once per version as a `blob:` URL (Authorization header, never a token in a URL),
revoked only when its cached image query is dropped.
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

## Background

Einstellungen → Darstellung → Hintergrund (10.1): a picture behind the floating panes of the webmail.
The roaming preference `appearance.background` is

| Value | Shows |
|---|---|
| `null` (default) | the organisation default — BCP → Branding → "Standard-Hintergrund" (`Branding.defaultBackground`: `none` or `builtin:<id>`) |
| `none` | the plain canvas |
| `builtin:<id>` | one of CoreMail's own drawings (`lake` Bergsee bei Nacht, `dawn` Morgendämmerung, `forest` Wald, `coast` Küste, `dunes` Dünen, `waves` Wellen, `aurora` Polarlicht, `neutral` Neutral), a light and a dark variant each (`/backgrounds/<id>-light.svg` / `-dark.svg`, web client `public/`, generated by `scripts/backgrounds.mjs`) |
| `custom` | the picture the user uploaded (nothing while none is stored) |

Panes over a picture use the surface at 92 % opacity with a light blur; every text token keeps
4.5:1 on that surface whatever the picture is (`web-client/src/lib/paneSurface.test.ts`).

```
GET    /api/v1/user/background/info   → { background: { version, updatedAt } | null }
GET    /api/v1/user/background        image/jpeg, strong ETag (If-None-Match → 304),
                                      Cache-Control private, no-cache; 404 without a picture
PUT    /api/v1/user/background        raw PNG/JPEG body, or multipart field `background` (max. 5 MB)
                                      → { background: { version, updatedAt } }
DELETE /api/v1/user/background        → { removed }
```

Only the signed-in user reads or changes the own picture — there is no route with a user id. An
upload goes through the profile-photo pipeline (`api-gateway/src/lib/profile-photo/image.ts`
`processBackgroundImage`): type by magic bytes, size and pixel limits from the header before
decoding (at most 12 megapixels, at least 320 px on the shorter side, JPEG scan / segment limits),
decoded, scaled to fit 2560 × 2560 (never enlarged) and re-encoded as JPEG without any metadata.
A JPEG is decoded as RGB under a decoder memory cap of 160 MB: a 12-megapixel camera picture (4:2:0
chroma subsampling) fits, a 12-megapixel JPEG without subsampling or in CMYK is refused with 422
`DIMENSIONS`. Photo and background uploads are decoded in worker threads, at most two at a time per
api-gateway process (`lib/profile-photo/decode-pool.ts`; further uploads wait), so the event loop
stays free and the decoders stay below 2 × their memory cap.
Storage like the profile photo (`storage/src/user-image-store.ts`): content-addressed key
`backgrounds/<aa>/<sha256>.jpg`, compare-and-set on `User.backgroundKey`, an object nobody
references any more is deleted (also when the account is deleted). Upload errors: 413 `SIZE`,
415 `TYPE` / `UNSUPPORTED`, 422 `DIMENSIONS` / `CORRUPT`; per-user limit 10 uploads / 10 min
(`USER_BACKGROUND_UPLOAD_LIMIT` / `USER_BACKGROUND_UPLOAD_WINDOW_SEC`, 0 disables). A change
announces the user event `settings` / `preferences`, so other tabs pick it up.

## Mail templates (10.1)

Personal templates ("Vorlagen") for mails written often: a name, subject, body and optional
An / Cc / Bcc lists. No attachments. Model `MailTemplate` (table `mail_templates`, cascade with the
user), at most 200 per user, body (HTML and text each) at most 256 KB.

    GET    /api/v1/mail/templates       → { templates: [{ id, name, subject, preview, updatedAt }], max }
    GET    /api/v1/mail/templates/:id   → { id, name, subject, bodyHtml, bodyText, to, cc, bcc, createdAt, updatedAt }
    POST   /api/v1/mail/templates       { name, subject?, bodyHtml?, bodyText?, to?, cc?, bcc? } → 201
    PUT    /api/v1/mail/templates/:id   the given fields replace the stored ones
    DELETE /api/v1/mail/templates/:id

Own templates only — another user's id answers 404 like an unknown one. Validation errors answer
400 `TEMPLATE_INVALID` with `details: [{ field, message }]` (name 1–100 characters, no line breaks in
the subject, every recipient a valid address, at most 100 per list, unknown fields refused); the
201st template 409 `TEMPLATE_LIMIT`. The Webmail protocol switch applies like for drafts; there is no
own webmail module. Every write announces `settings` / `templates` to the user's other tabs.

The body is untrusted HTML: the webmail sanitises it with the mail sanitiser (`lib/mailHtml.ts`)
before saving, again when it is loaded into an editor or inserted into a draft, and shows previews
through `sanitizeMailHtml` (external images blocked). The server only bounds the sizes.

Webmail (`components/templates/`, rules in `lib/mailTemplates.ts`):

- **Neue E-Mail aus Vorlage** (`TemplatePickerDialog`): search, list, preview; "Verwenden" opens a
  new compose tab with subject, recipients and body (the default signature follows the body).
  The mail view wires it with `useTemplatePicker()` → `{ open, element }`
  (`<MailRibbon onNewFromTemplate={templates.open} />` + `{templates.element}`): "E-Mail aus Vorlage"
  in the menu of the ribbon's split button "Neue E-Mail" (E-Mail, E-Mail aus Vorlage, Ereignis; while a
  shared or delegated mailbox is open a fourth entry "E-Mail aus dem eigenen Postfach").
- **Vorlagen verwalten** (`TemplateManagerDialog`): list + editor (name, subject, recipient fields,
  body with a small formatting bar), new / save / delete; asks before unsaved changes are lost.
  Reached from the picker and from Settings → Vorlagen.
- Compose "…" menu: **Vorlage einfügen …** inserts the body at the cursor and fills subject and
  recipient fields only while they are empty; **Als Vorlage speichern …** saves subject, recipients
  and the body without signature block and quoted original. While the ribbon shows the draft's
  contextual tabs (the card then hides its "…" menu) the same two commands are in the ribbon:
  **Einfügen → Vorlage einfügen …** and **Nachricht → Als Vorlage speichern …**.

## Deep links

The address bar reflects what the webmail shows, so back/forward work and links can be shared with
people who have access to the same mailbox:

- `/mail/<mailbox>/<folderId>/<messageId>` — `<mailbox>` is `own`, `shared:<id>` or
  `delegated:<id>` (URL-encoded); `/mail` opens the inbox of the own mailbox.
- `/calendar/event/<id>` opens an event, `/contacts/<id>` a contact.

The pre-9.4 form `/mail?mailbox=shared:<id>` is still understood and rewritten.

## MFA enforcement (10.5)

> 10.6: these switches became the MFA policy model on BCP → Authentifizierung → Mehrstufige
> Anmeldung (MFA) — policy for all users (Pflicht / Optional / Aus), admin rule (Pflicht with an
> admin grace period of at most 14 days / Wie alle Benutzer), per-user exceptions and "Gerät
> merken". The rules below are the "Pflicht" enforcement for users; see
> [mfa-policy.md](mfa-policy.md) for the model, the admin rule and remembered devices. The
> fields below are still written (in step with the new columns).

Two server-wide switches in BCP → Einstellungen → Sicherheit (organisation area: only
ORGANIZATION_MANAGEMENT may change them; every change is audited as
`settings.mfa-policy.update` with a from/to diff, also with the audit log switched off):

| Field (`ServerSettings`) | Default | Meaning |
|---|---|---|
| `requireMfaForAdmins` | `false`; `true` for fresh installations (setup wizard, docs/setup-wizard.md) | Admin API only with an enrolled second factor (`403 MFA_REQUIRED`) and an MFA-verified session (`403 MFA_NOT_VERIFIED`). Existing installations keep their stored value on upgrade. |
| `requireMfaForAllUsers` | `false` | "MFA für alle Benutzer erzwingen" — below. |
| `mfaEnforcementGraceDays` | `7` | Grace period in days (0–90, 0 = at once). |
| `mfaEnforcementBlocksPrimaryPassword` | `false` | Sub-option: after the grace period the primary password no longer works on mail protocols for accounts without MFA. |
| `mfaEnforcementSince` | – | Written when `requireMfaForAllUsers` is switched on (activation time). |

Per user: `User.mfaGraceStartedAt` (additive column).

### "MFA für alle Benutzer erzwingen"

Rules (storage `src/auth/mfa-enforcement.ts`):

- **Satisfied** by an enrolled second factor (TOTP or a security key) or by a session that was
  established with MFA. SSO: a session the IdP's MFA (`amr`) made MFA-verified counts — with
  the existing trust rules (docs/sso-ldap.md: always for plain users unless the provider demands
  CoreMail MFA; for admin roles under `requireMfaForAdmins` only with
  `OIDC_TRUST_IDP_MFA_FOR_ADMINS=true`).
- **Grace period per user**: it starts at the account's first check after the switch was turned
  on (first web request, the status call after the sign-in, or a mail-protocol login) and lasts
  `mfaEnforcementGraceDays`. A stored start from before `mfaEnforcementSince` is stale: switching
  the enforcement off and on again gives everybody a new grace period. Changing the number of
  days applies to running grace periods.
- **During the grace period** everything works; the webmail shows a banner with the days left
  and a link to Einstellungen → Sicherheit.
- **After the grace period** a web/API session of such an account may only enrol: every API call
  answers `403 { code: "MFA_ENROLMENT_REQUIRED", deadline }` except `GET
  /api/v1/user/mfa-enforcement` and `GET /api/v1/user/profile` (the webmail sign-in loads it);
  `/auth/mfa/*` (enrolment), `/auth/sessions` and `/auth/logout` stay reachable, revoking an app
  password too, listing / creating app passwords does not. Bearer tokens on JMAP and
  CalDAV/CardDAV are refused as well (JMAP `401`, DAV `403`). The password sign-in itself keeps
  working (otherwise nobody could enrol). The webmail shows the mandatory page `/mfa-enrolment`
  (TOTP and security-key setup of Einstellungen → Sicherheit, sign-out; "Weiter zum Webmail" once
  a factor is set up — the backup codes stay visible until then). The BCP shows its MFA page.
- Enrolling publishes `mfa-change` (auth invalidation bus): the cached state is dropped at once in
  every service; otherwise the per-process caches (policy 15 s, per user 15 s) expire.
- A missing or unreadable state is a temporary failure (`503`), never "allowed".
- **SSO-only accounts** (OIDC, no password) cannot confirm an enrolment (re-authentication needs
  the password or an MFA code): the enrolment page tells them to sign in through the provider
  with MFA (`canEnrol: false` in the status) or to contact the administrator.

`GET /api/v1/user/mfa-enforcement` → `{ state: "off" | "satisfied" | "grace" | "required",
deadline?, canEnrol }` (`Cache-Control: no-store`).

**Mail protocols.** Accounts with MFA need app passwords on IMAP, POP3, SMTP, ActiveSync, JMAP,
CalDAV/CardDAV and MAPI anyway (unchanged). Accounts **without** MFA keep their primary password
on mail protocols until they enrol — unless the sub-option `mfaEnforcementBlocksPrimaryPassword`
is on: then, after the account's grace period, the primary (or directory) password is answered
like the MFA case (`mfa_app_password_required` — each protocol's "app password required"
refusal; a wrong password stays `invalid`). App
passwords keep working in every case — the enforcement never breaks an existing app password.
A mail-protocol login also starts the account's grace period, but such users never see the
webmail banner: announce the change.

## Passkeys (10.6)

Einstellungen → Sicherheit → **Passkeys** (`components/settings/PasskeysPanel.tsx`, API
`/auth/passkeys`, details in [passkeys.md](passkeys.md)):

- list of the account's passkeys and security keys — name, synced or device-bound (from the
  BE / BS flags), provider (known AAGUIDs only), added, last used; pre-10.6 security keys are
  marked "Sicherheitsschlüssel (nur zweiter Faktor)" and offer "Als Passkey neu registrieren";
- **add**: re-authentication with the current password or an existing passkey, then the
  browser's passkey dialog; after the first second factor the panel says that mail programs now
  need an app password (link to App-Passwörter);
- **rename**, **remove** (re-authentication; the last passkey of a passkey-only account cannot be
  removed — `409 LAST_PASSKEY`); a hint suggests a second passkey while there is only one;
- only when passkeys are allowed for the account (server / domain / user switch); OIDC-only
  accounts see a hint instead; a configuration without HTTPS / DNS name is reported.

A passkey is a second factor: it satisfies "MFA für alle Benutzer erzwingen" (the panel is also
on the mandatory enrolment page) and the admin MFA rule. The login page offers "Mit Passkey
anmelden" and the passkeys in the e-mail autofill when the server allows the sign-in without a
password. `GET /auth/mfa/status` reports `passkeyCount` and `securityKeyCount` besides
`webauthnCount` (both).

## Not covered

- Sorting by sender, subject or size uses the folder index and sorts the folder's rows in the
  database (no per-column index: subjects can exceed the B-tree entry size).
