# Webmail policies

Since 9.4 an administrator decides which modules the webmail offers and how it treats attachments
and external images — on the server, per domain and per mailbox. Nothing changes for existing
installations: every module is on, nothing is blocked, external images are loaded on request.

## Levels and resolution

The same three levels and the same resolution as the [protocol switches](protocol-access.md)
(shared code: `packages/storage/src/policy-levels.ts`):

```
server  →  domain  →  mailbox (user)
```

- **Module switches** are `inherit`, `on` or `off` on the domain and mailbox level; the most
  specific value that is not `inherit` wins. The server level is two-state (`on` / `off`); a
  never-written switch is the built-in default (`on`).
- **Values** (lists, size, mode) are either set or inherited (`null` in the API) on the domain and
  mailbox level; the most specific set value wins. The server level always has a value — a
  never-written value is the built-in default.
- **Upload limit**: a domain or mailbox value is capped by the server value (the server decides
  then). The global maximum message size still caps every message.

Every effective value comes with its **source** — `default`, `global`, `domain` or `user` — which
the BCP shows as "Grund".

Storage: table `webmail_policies` (one row per level — id `global`, or `domainId` / `userId`;
deleted with the domain or user) and `trusted_image_senders`. The schema change is additive.

## Modules

| Switch            | Webmail (hidden)                                    | Enforced on the server                                                |
|-------------------|-----------------------------------------------------|-----------------------------------------------------------------------|
| `calendar`        | rail entry, page, calendar settings                 | `/api/v1/calendar/*`; CalDAV calendars `/dav/calendars/<id>/<calendar>/` (403; the calendar home stays open while tasks are on and then lists only the task list); ActiveSync MeetingResponse (Status 2, nothing written) |
| `contacts`        | rail entry, page                                    | `/api/v1/contacts/*` (the compose autocomplete `GET /contacts?q=` stays and returns address-list entries only); CardDAV `/dav/addressbooks/*` (403); ActiveSync ResolveRecipients without personal contacts |
| `tasks`           | rail entry, page, task reminders                    | `/api/v1/tasks/*`; CalDAV task list `/dav/calendars/<id>/tasks/` (403, not listed in the calendar home; 9.5) |
| `notes`           | rail entry, page                                    | `/api/v1/notes/*`                                                     |
| `rules`           | settings section, "Regeln" in the message menu      | `/api/v1/user/rules/*`                                                |
| `signatures`      | settings section, signatures in compose             | `/api/v1/user/signature(s)`, signature defaults in `/user/preferences` |
| `categories`      | settings section, "Kategorisieren" menus            | `/api/v1/categories/*`                                                |
| `recoverItems`    | settings section, "Gelöschte Elemente wiederherstellen" menus | `/api/v1/mail/recoverable/*` and the shared / delegated variants |
| `changePassword`  | settings section (also hidden for LDAP / SSO accounts) | `/api/v1/user/change-password`                                     |
| `themes`          | settings section; the default design applies        | the `theme` section of `PUT/PATCH /api/v1/user/preferences`; `GET` returns the default design |
| `externalClients` | settings section                                    | `/api/v1/user/client-config`, `/api/v1/user/apple-profile`            |
| `appPasswords`    | settings section                                    | `GET`/`POST /auth/app-passwords` (revoking stays possible); **existing app passwords stop working on every mail protocol** — see below |
| `sharedMailboxes` | shared / delegated mailboxes in the folder pane     | `/api/v1/user/shared-mailboxes/*`, `/api/v1/mail/shared-mailboxes/*`, `/api/v1/mail/delegated-mailboxes/*`, `/api/v1/user/accessible-mailboxes/*` |
| `profilePhoto`    | "Foto hochladen…" / "Foto ändern…" in Settings → E-Mail-Konto (9.5) | `PUT /api/v1/user/photo` only — an existing photo stays visible and its owner can still remove it (`DELETE`) |

A request to a module that is off answers **403** `{ "code": "FEATURE_DISABLED", "feature": "<switch>" }`
(checked in `requireAuth` after the webmail protocol switch; a policy that cannot be read is a 503,
never "allowed"). The admin API and the event stream are never affected (its calendar / task /
contact events carry ids only, no content). The path is compared case-insensitively — Express
routes `/api/v1/Calendar/…` to the calendar router, so the gate treats it as `/api/v1/calendar/…`
(the same for the DAV collections).

**App passwords off**: `verifyMailCredentials()` (storage `mail-auth.ts`) refuses a login with an
app password of such an account on every mail protocol (IMAP, POP3, SMTP submission, ActiveSync,
JMAP, CalDAV / CardDAV, MAPI). The answer is the one of a wrong password (`invalid`) — checked
before the protocol switch, so the reply never reveals that the app password itself is right; a
policy that cannot be read is a temporary failure. The primary password (accounts without MFA) and
web sessions keep working; accounts with MFA have no mail-protocol access while the module is off.
Every account whose module goes from on to off gets the auth event `app-password-revoked` (without
an app-password id): live mail connections that logged in with an app password end at once,
credential caches drop the account. Switching the module on again makes the stored app passwords
work again (they are not deleted).

Mail data only: ActiveSync and JMAP serve the Email class only (FolderSync announces mail folders,
JMAP has no calendar / contact capabilities), so there is nothing else to filter there. Sending as a
Shared Mailbox from compose is a permission of the mailbox, not part of `sharedMailboxes`.

## Attachments and content

| Value                    | Meaning                                                                                       |
|--------------------------|-----------------------------------------------------------------------------------------------|
| `blockedExtensions`      | File types that cannot be downloaded in the webmail: `GET /api/v1/mail/attachments/:id` → 403 `ATTACHMENT_BLOCKED`. |
| `downloadOnlyExtensions` | "Nur speichern": always `Content-Disposition: attachment`, never shown inline — `?inline=1` → 403 `INLINE_PREVIEW_DISABLED`, the webmail shows no inline image of that type. |
| `maxUploadMb`            | Max. size of one uploaded attachment (compose, drafts): 413 `ATTACHMENT_TOO_LARGE`. Server level `null` = no own limit. |
| `externalImages`         | `ask` (default): banner, the reader decides · `contacts`: loaded for senders in the reader's contacts (with the contacts module on) and trusted senders · `block`: never loaded, the image proxy answers 403 `EXTERNAL_IMAGES_BLOCKED`. |

**File type matching** uses the semantics of the inbound attachment filter
(`SecuritySettings.attachmentBlockedExt`): extensions without dot, case-insensitive, trailing dots
and spaces ignored. In addition, the declared MIME type and the content (magic bytes: Windows
executables, ELF, Mach-O, scripts, ZIP / OLE containers, shortcuts, archives, PDF, images, HTML,
SVG, ISO) are checked: a file matches every extension it may really be. A name that fits the
detected container keeps its own extension (`report.docx` with ZIP bytes is a `.docx`); a name
that does not fit gets every extension of the format (`photo.jpg` with ZIP bytes may be a `.jar`).
Before the extension is taken, the name is NFKC-folded (full-width `ｅｘｅ` → `exe`) and invisible
format / control characters (bidi overrides, zero-width spaces, NUL) are removed. The contents of
archives are **not** inspected (block `zip`, `7z`, `rar`, … themselves to keep them out). The block
list is a webmail rule: it applies to the attachment download of the webmail
(`/api/v1/mail/attachments/:id`, own / shared / delegated mailboxes), not to the mail protocols
(IMAP, POP3, ActiveSync, JMAP) nor to the message source (`…/raw`); inbound filtering of file types
is `SecuritySettings.attachmentBlockedExt`.
Shared code: `packages/storage/src/file-types.ts`.

**External images per mail**: the message API (own, shared and delegated mailboxes) returns
`externalImages: 'load' | 'ask' | 'block'` for the reader. **Trusted senders** (an address or
`@domain`, at most 500 per user, stored server-side) load without asking unless the mode is
`block`: banner button "Immer von diesem Absender" or Settings → Lesen → Externe Bilder.
Matching (trusted senders and the `contacts` mode) uses the stored `From` address of the message,
which a sender can forge; inbound DMARC / local-spoof enforcement limits that, but a forged mail
that passes can make the reader's webmail load its images. The effect is limited to what loading
images does: the images are fetched through the image proxy (the reader's IP address is not
revealed), the sender learns that the mail was opened. Entries are per user, read and changed only
by their owner.

```
GET    /api/v1/user/trusted-senders            → { senders, max }
POST   /api/v1/user/trusted-senders            { sender }
DELETE /api/v1/user/trusted-senders/:sender
```

## Webmail

`GET /api/v1/user/features` → `{ features, content: { blockedExtensions, downloadOnlyExtensions,
maxUploadBytes, externalImages } }` is read once (`hooks/useWebmailFeatures.ts`) and again on the
live event `settings` / `policies`, which every change sends to the accounts in scope. Until it is
loaded the webmail behaves as before; the server has the last word in every case. Pages of a module
that is off lead to the mail view.

## Changes take effect immediately

A change writes the row, drops the policy cache in every service (`CHANNEL_SETTINGS_RELOAD`
`{"type":"webmail-policy"}`; otherwise a 30 s cache applies) and sends the user event
`settings` / `policies` to every account in scope, so open webmail tabs update their rail, menus and
settings at once.

## Administration

**BCP**: *Infrastruktur → Webmail-Richtlinien* (server level), and a section in *Domain bearbeiten*
and in the mailbox edit dialog — built like the protocol editor: Erben / An / Aus per module, the
values with an "Erben" option, each row with the effective value and its source ("Grund").

**Admin API**:

```
GET|PUT /api/v1/admin/webmail-policies                 server level
GET|PUT /api/v1/admin/webmail-policies/domains/:id     domain level
GET|PUT /api/v1/admin/webmail-policies/users/:id       user level
PUT body: { "features": { "calendar": "off", … }, "content": { "blockedExtensions": ["exe"], "maxUploadMb": 20, … } }
Answer:   { level, id?, features, settings, inherited, effective, sources, users? }
```

RBAC like the protocol switches: server and domain level need write access to the area *servers*
(readers of *domains* may read the domain level), the user level the area *recipients* — policies
of an admin account only ORGANIZATION_MANAGEMENT. Every change is in the audit log as
`settings.webmail-policy.update` with the changed values (before/after) and the number of accounts
in scope; `settings.*` actions are logged even with the audit toggle off.

**CLI**:

```bash
coremail policy show                                          # server level
coremail policy show --scope domain example.com
coremail policy set --scope user alice@example.com --calendar off --external-images block
coremail policy set --blocked-extensions exe,js,bat --save-only-extensions pdf --max-upload-mb 20
coremail policy set --scope domain example.com --blocked-extensions inherit
```

Modules: `--calendar --contacts --tasks --notes --rules --signatures --categories --recover-items
--change-password --themes --external-clients --app-passwords --shared-mailboxes` with `on`, `off`,
`inherit` (`inherit` only with `--scope domain|user`). `--max-upload-mb none` = no own limit (server
level). `--json` prints the API answer.
