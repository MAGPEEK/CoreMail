# Windows desktop mail programs: mail, calendar, contacts

CoreMail does not speak MAPI/RPC or EWS. A Windows desktop mail program without CalDAV/CardDAV
support is connected as an **IMAP + SMTP** account for mail (or with MAPI over HTTP, see
[mapi.md](mapi.md)); calendar and contacts are
synchronised over **CalDAV / CardDAV** with a sync add-in. Webmail (MWA) offers everything in the
browser without additional software.

## 1. Mail: IMAP + SMTP account

1. Add an account in the mail program (in Outlook: *File → Add Account*), enter the e-mail address. The client asks Autodiscover
   ([autodiscover.md](autodiscover.md)) and creates an IMAP account with these settings:

   | | Server | Port | Encryption |
   |---|---|---|---|
   | Incoming (IMAP) | `mail.<domain>` | 993 | SSL/TLS |
   | Outgoing (SMTP) | `mail.<domain>` | 587 | STARTTLS (or 465, SSL/TLS) |

   User name: the full e-mail address (primary address, not an alias).
2. If automatic setup is not possible: *Advanced options → Let me set up my account manually →
   IMAP* and enter the values above. The current values are shown in the MWA under
   **Einstellungen → Externe Clients**.
3. **Password:** users with two-factor authentication (MFA) must use an **app password**
   (MWA → Einstellungen → Sicherheit → App-Passwörter). The normal password and MFA codes are not
   accepted by IMAP/SMTP/CalDAV/CardDAV.

Old mail program versions on old Windows releases that cannot use TLS 1.2 need the opt-in
[TLS 1.0/1.1 switch](legacy-tls.md) — preferably on a dedicated listener and only temporarily.

## 2. Calendar and contacts: CalDAV / CardDAV

Such a mail program has no built-in CalDAV/CardDAV support; a sync add-in creates local calendar,
contacts and task folders and keeps them in sync with CoreMail. A commonly used open-source option
is **Outlook CalDav Synchronizer** (free, GPL); commercial add-ins work the same way with the
same URLs.

URLs (copy buttons in the MWA under **Einstellungen → Externe Clients**):

| | URL |
|---|---|
| CalDAV account (all calendars) | `https://mail.<domain>/dav/calendars/<user id>/` |
| One calendar | `https://mail.<domain>/dav/calendars/<user id>/<calendar id>/` (shown per calendar in the MWA) |
| CardDAV account | `https://mail.<domain>/dav/addressbooks/<user id>/` |
| Default address book | `https://mail.<domain>/dav/addressbooks/<user id>/default/` |

The `<user id>` and `<calendar id>` parts are internal identifiers — copy the URLs from the MWA
instead of typing them.

Steps with a CalDAV/CardDAV sync add-in:

1. Install the add-in, restart the mail program.
2. Create a new sync profile of type *CalDAV/CardDAV* (generic server, not a hosted provider
   preset).
3. Enter the CalDAV URL of the calendar (or the account URL and let the add-in discover the
   calendars), the e-mail address as user name and the password — with MFA an **app password**.
4. Pick or create the local folder to sync with, choose two-way sync and an interval
   (e.g. 5 minutes).
5. Repeat with the CardDAV address book URL for contacts (local contacts folder).
6. Shared calendars (MWA → Kalender → Freigeben) appear in the discovery list of the account
   URL; read-only shares are synced one-way.

Notes:

* Invitations: the mail program sends and receives meeting invitations as normal mail (iCalendar
  attachments); replies update the CoreMail calendar when they arrive.
* Private/confidential appointments keep their classification; delegates see them masked.
* Free/busy lookups of other users are available in the MWA; the sync add-ins do not use them.

## 3. Alternatives without add-ins

* **MWA in the browser** — mail, calendar, contacts, tasks, notes.
* **Thunderbird** — IMAP/SMTP via autoconfig, calendar and contacts with the built-in
  CalDAV/CardDAV support.
* **Mobile devices** — ActiveSync (iOS Mail, Android) for mail, calendar and contacts, or
  CalDAV/CardDAV (iOS, DAVx⁵ on Android).
