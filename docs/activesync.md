# ActiveSync (EAS)

`packages/activesync` — ActiveSync protocol versions **12.1, 14.0 and 14.1** on
`/Microsoft-Server-ActiveSync` (port 3005 behind the api-gateway). Everything here follows the
public Microsoft Open Specifications [MS-ASHTTP], [MS-ASCMD], [MS-ASWBXML], [MS-ASPROV],
[MS-ASAIRS], [MS-ASEMAIL], [MS-ASCAL], [MS-ASTASK], [MS-ASNOTE], [MS-ASCNTC] and [MS-ASDTYPE].
Accounts with MFA use app passwords. Classes: Email, and (w3) Calendar, Tasks, Notes and Contacts —
see [Calendar, Tasks and Notes](#calendar-tasks-and-notes-w3) and [Contacts](#contacts-w3).

## Versions and negotiation

`OPTIONS /Microsoft-Server-ActiveSync` answers

| Header | Value |
|---|---|
| `MS-ASProtocolVersions` | `12.1,14.0,14.1` |
| `MS-ASProtocolCommands` | the commands with a real handler (`src/commands.ts`) |
| `MS-Server-ActiveSync` | `14.1` |

Every request is served with one version (`src/protocol-version.ts`):

1. the version the request names — the `MS-ASProtocolVersion` header (plain request line) or the
   version byte of the base64 request line (121 / 140 / 141);
2. without one: the version the device used last (`ActiveSyncDevice.protocolVersion`);
3. without either: 14.1.

A requested version the server did not announce (2.5, 12.0, 16.x, …) is served as **14.1**, as
before 9.4 — a conforming client picks from `MS-ASProtocolVersions`, and refusing a
non-conforming one would lock its device out. The service logs a warning once per device
(`src/device-version.ts`). The negotiated version is stored on the device whenever it changes (a
device that is updated from 12.1 to 14.1 switches on its next request). Commands never compare
numbers: they ask `supports(version, feature)` for the protocol element that differs.

## Request line

Both encodings of [MS-ASHTTP] are accepted (`src/request.ts`):

* **plain**: `?Cmd=Sync&User=…&DeviceId=…&DeviceType=…` plus command parameters
  (`AttachmentName`, `CollectionId`, `ItemId`, `LongId`, `Occurrence`, `SaveInSent=T`); version and
  policy key in the `MS-ASProtocolVersion` / `X-MS-PolicyKey` headers;
* **base64**: the whole query is one base64 value — version byte, command code, locale, DeviceId,
  policy key (4 bytes, little-endian), DeviceType and tag/length/value parameters (Options bit
  0x01 = SaveInSent). A binary DeviceId (GUID) is stored as upper-case hex, an alphanumeric one as
  text. A truncated or malformed value is answered HTTP 400.

## Differences per version

| Area | 12.1 | 14.0 | 14.1 |
|---|---|---|---|
| Refused request (no device, wrong / missing policy key, wipe pending) | HTTP 449; a pending wipe on a request without policy key HTTP 403 ([MS-ASCMD] 2.2.2) | Status 142/144/140 in the command's WBXML | same as 14.0 |
| Blocked / not approved device | HTTP 403 (also for Provision) | Status 129 | Status 129 |
| Provision | same policy document (all its elements exist since 12.1), same RemoteWipe flow | same | + `settings:DeviceInformation` in request/response |
| SendMail / SmartReply / SmartForward | raw MIME body (`message/rfc822`), parameters in the request line, **empty HTTP 200** (errors: 400 / 403 / 413 / 507 / 500) | ComposeMail WBXML; success = **empty response** (9.4), failure = `<Status>` | same as 14.0 |
| Sync / ItemOperations item | Email + AirSyncBase body (Type 1/2/4, MIMESupport) | + Email2 ConversationId / ConversationIndex, + airsyncbase:Preview | same as 14.0 |
| GetItemEstimate request | `Class` and `airsync:FilterType` directly in the Collection; Class echoed | FilterType in `airsync:Options`, no Class | same as 14.0 |
| Settings | Oof, DeviceInformation, UserInformation (EmailAddresses form), DevicePassword | same | + UserInformation Accounts form, RightsManagementInformation |
| ResolveRecipients | no Availability | + Availability (Status 163: no free/busy) | same as 14.0 |
| Classes (w3) | Email, Calendar, Tasks, Contacts | + Notes (code page 23) | same as 14.0 |
| Calendar item (w3) | no ResponseRequested / ResponseType | + ResponseRequested / ResponseType | + Recurrence FirstDayOfWeek (also Tasks) |
| FolderSync, Ping, Search, MoveItems, MeetingResponse, GetAttachment | identical in all three versions (FolderSync / Ping: the Notes folder from 14.0) | | |

MeetingResponse: in every supported version the device sends the meeting reply itself; the
server-side reply path (`SendResponse`) exists for 16.x only. 16.x is not announced, but
MeetingResponse sees the version the client named, so a client that claims 16.x anyway still gets
the reply it asks for (as before 9.4).

### 12.1 SendMail failures

12.1 has no SendMail response body, so a failure is an HTTP status: 400 for a request that cannot
succeed when repeated (malformed MIME, no recipient, unknown source item of SmartReply /
SmartForward), 403 when the From address is not one the user may send as, 507 when the mailbox is
over its send quota, 413 when the message is larger than the maximum message size (9.4), 500 for a
server failure (the device keeps the message and retries).

### Sending: response, size limit, retries (9.4)

- **Success response** (14.x): [MS-ASCMD] 2.2.1.17 SendMail — "If the message was sent
  successfully, the server returns an empty response" (likewise SmartForward 2.2.1.19 and
  SmartReply 2.2.1.20): HTTP 200 with `Content-Length: 0`. A failure keeps the
  `<SendMail|SmartReply|SmartForward><Status>` body. Before 9.4 the success was
  `<Status>1</Status>`.
- **Maximum message size**: the message as it will be sent — for SmartReply / SmartForward
  including the appended original — must not exceed the configured maximum message size (the
  stricter of BCP → SMTP and BCP → Settings → Mail; one storage helper shared with REST and JMAP,
  cached 60 s). Too large: Status 122 (AttachmentIsTooLarge, the size status of [MS-ASCMD] 2.2.2;
  115 SendQuotaExceeded is a quota) in 14.x, HTTP 413 in 12.1. A settings save applies at once (settings reload drops the cache).
- **Request-body cap** (`src/body-limit.ts`): every ActiveSync request body is limited to the
  maximum message size × 4/3 + 1 MB (base64 / WBXML margin, so a message slightly above the
  limit still gets Status 122 / HTTP 413 from the compose handler), at most 150 MB; larger
  bodies end with HTTP 413. Before 9.4 the cap was a fixed 25 MB, so a larger configured size
  could not be used over ActiveSync.
- **Retries**: a 14.x request with a `ClientId` that was already sent gets Status 118
  (MessagePreviouslySent; remembered for 3 days). Without a ClientId (always in 12.1, which has
  none) a request is recognised as a retry by the `Message-ID` header of its MIME together with the
  DeviceId, for 10 minutes — the
  retry is answered as sent (HTTP 200) and not sent again. A request without Message-ID cannot be
  recognised. A failed send releases the key, so the device's retry goes out.

## WBXML

The code pages follow [MS-ASWBXML] (14.1 token tables). `src/wbxml.ts` also records which pages
and tokens a version does not define — taken from the "Protocol versions" column of the
[MS-ASWBXML] 2.1.2.1.x code page tables (ComposeMail and Email2 pages, Preview, Availability,
Accounts form, …): `tagsNewerThan(buffer, version)` lists the tags of an encoded response that the
version does not know. The unit tests and the e2e step assert that every response carries only
tags of the negotiated version.

## Follow-up flags (9.4)

Every `Add` and `Change` of the Email class carries `email:Flag` (empty when the mail is not
flagged; Tasks code page 9 for the `tasks:*` dates), and a client `Change` with `email:Flag`
flags, completes or clears the mail through the message store — invalid flags get `Status 6` in
`airsync:Responses`. Rules and mapping: [tasks.md](tasks.md#activesync-emailflag),
`src/commands/flag.ts`.

## Calendar, Tasks and Notes (w3)

`src/pim/` — the PIM classes. A class module (`src/pim/types.ts` `PimClassModule`: folders,
collection lookup, item states, render, create / update / remove, fingerprint, optional move) owns
everything class-specific; Sync, FolderSync, Ping, GetItemEstimate, MoveItems and ItemOperations
dispatch on the collection id (`moduleFor`, `src/pim/registry.ts`). Contacts is one more module
of `CLASS_MODULES` (see [Contacts](#contacts-w3)).

| Class | Collection ids (FolderSync Type) | Items | Writer |
|---|---|---|---|
| Calendar ([MS-ASCAL], page 4) | `cal:<calendarId>` — the user's **own** calendars: the default one Type 8, the others 13; no shared calendars | `CalendarEvent` (ServerId = event id, the MeetingResponse `CalendarId`) | calendar object built / patched with `@coremail/core/calendar` (`src/pim/calendar-ical.ts`), rooms booked through storage `room-booking.ts` (`src/pim/calendar-rooms.ts`), row columns derived from it, `announceCalendarChange` |
| Tasks ([MS-ASTASK], page 9) | `tasks:default` (Type 7) | `Task` | storage `task-store.ts` `createTaskWithRules` / `updateTaskWithRules` — the one task writer of REST, CalDAV and ActiveSync (status rules, the next task of a completed recurring task exactly once, no revived rule on a completed task), `announceUserEvent` `tasks` |
| Notes ([MS-ASNOTE], page 23, 14.0+) | `notes:default` (Type 10) | `Note` (subject, plain-text body, categories ↔ notes:Categories — normalised and capped like the REST API; the colour stays untouched) | row writes, `announceUserEvent` `notes` |
| Contacts ([MS-ASCNTC], pages 1 and 12) | `contacts:default` (Type 9) | the user's own `Contact` rows; contact groups are not synced | storage `contact-store.ts` (the contact writer of REST, CardDAV and ActiveSync), `announceUserEvent` `contacts` |

**Availability**: a class exists for a user only while its webmail module is on (9.4 policies
`calendar` / `tasks` / `notes` / `contacts`) and the protocol version knows it (Notes from 14.0). Switched off:
the folders leave FolderSync, a Sync of such a collection answers Status 12 (hierarchy changed), a
Ping on it Status 7; an unreadable policy → FolderSync Status 6, Sync Status 16, Ping Status 8
(never 7 — the FolderSync it asks for would fail as well). Protocol access (`activesync` switch)
applies at authentication as for mail.

**Change detection**: PIM items have no mailbox modSeq. The item version is `updatedAt` (ms); the
per-device item state (`ActiveSyncItem`, committed / pending rows, `ack:` keys — the same rules as
mail, `src/commands/item-state.ts`) holds the version the device has. A Sync sends Change for held
items at another version, Delete for held items that are gone (deleted, moved, purged) and Add for
items inside the FilterType window (calendar 4–7 = two weeks … six months back, series always;
tasks 8 = incomplete only), at most WindowSize per response (MoreAvailable). SyncKeys are counters
per collection (priming → 1, then the presented key + 1); a collection never primed, or a key that
is neither the issued nor the acknowledged one, is Status 3. A Change carries the complete item.
A calendar Sync reads only the FilterType window plus the events the device holds (`states(…,
held)`), not the whole calendar history.

**Client commands**: Add answers `ClientId` + `ServerId` in airsync:Responses; a retried request
(the same SyncKey presented again) gets for a ClientId of its first attempt the ServerId it got then
(nothing is created twice). The ClientId map (`cid:<collectionId>`) is bound to that SyncKey —
ClientIds of earlier requests are never matched, devices reuse them. A priming Sync without
`Supported` drops the stored list. Change and Delete are applied through the writers; an unknown
ServerId gets Status 8. The device's
own writes are recorded as held at their new version (no echo); an item the server normalised (a
completed recurring task, an Add whose UID the calendar already has — the existing event is updated,
a meeting whose rooms answered, an event moved into another zone than the device's TimeZone) is
recorded at version 0 and comes back as a Change. Change semantics ([MS-ASCMD]
airsync:Supported): an element missing from a Change is cleared, unless the client listed a
Supported set in its priming Sync and the element is not in it (ghosted). A body the device got
truncated and sends back unchanged does not cut the stored one.

**Calendar mapping** (`src/pim/calendar-codec.ts`): times are UTC instants; calendar:TimeZone
([MS-ASDTYPE] 2.7.4, `src/pim/timezone.ts`) carries the master's TZID, else UTC for a timed series
(the server expands a UTC series in UTC) and the user's Settings → Region zone for single timed
events and for all-day events, whose StartTime / EndTime are local midnights. A device TimeZone is
mapped back to the IANA zone with the same rules (names, the user's zone first, then every zone of
the runtime); a timed event added on a device is stored with that TZID (an unknown one → the Region
zone), so a series keeps its wall-clock time across DST changes. A timed event stored in UTC that a
device turns into a series moves to the device's zone — or, when the device sends UTC (the zone it
got) or an unknown one, the Region zone — and the device gets it back with that zone. Recurrence ↔ RRULE
(`src/pim/recurrence.ts`: daily, weekly, monthly on day / nth weekday, yearly on day / nth weekday,
Interval, Occurrences, Until, FirstDayOfWeek); an RRULE without an ActiveSync form is not sent and is
kept on device changes. Exceptions: EXDATEs and cancelled overrides are deleted exceptions, other
RECURRENCE-ID overrides changed ones; a device's exception list is applied with
`excludeOccurrence` / `upsertOccurrence` / `restoreOccurrence` (`@coremail/core/calendar-exceptions`).
Attendees (AttendeeStatus / AttendeeType, rooms as type 3), reminder (VALARM minutes), BusyStatus ↔
show-as, Sensitivity ↔ CLASS, MeetingStatus (own / received / cancelled), ResponseType (14.0+).
Invitations are sent by the device itself (SendMail with text/calendar) — the server does not send
iMIP for device writes.

**Rooms** (`src/pim/calendar-rooms.ts`, the booking path of the REST event form — storage
`room-booking.ts` with the resource policy, every occurrence checked, the room's booking lock): an
attendee whose address is a room / resource mailbox of the user's domain is a room, whatever
AttendeeType the device gave it. Only the user's own meetings (organizer = an own address, or none)
book; a copy of another organizer's meeting never touches a room. Rooms are (re)booked when the room
list or the timing (start, end, all-day, rule, exceptions) changed, a removed room and the rooms of
a deleted meeting are released; the rooms' answers replace whatever the device sent for them
(PARTSTAT, CUTYPE ROOM / RESOURCE, NON-PARTICIPANT — a phone cannot mark a declined room accepted)
and the device gets the meeting back. A booking of the same UID by another organizer is never
changed or released (answer: declined) — device UIDs are client-chosen.

**Tasks mapping** (`src/pim/tasks-codec.ts`): Importance ↔ priority, UtcStartDate / UtcDueDate (the
local StartDate / DueDate in the user's zone), Complete + DateCompleted ↔ status COMPLETED (the
progress rules keep % complete in step), ReminderSet / ReminderTime ↔ reminder, Sensitivity ↔
private, Recurrence ↔ RRULE (Start = start or due date). % complete, effort, mileage, billing and
companies have no ActiveSync form and stay untouched.

**Other commands**: GetItemEstimate counts the next Sync's commands; MoveItems moves an event into
another own calendar (ServerId kept, item state follows) and answers Status 2 for a move between
classes or between mail and a PIM class; ItemOperations Fetch returns the item with its Class;
Ping watches PIM collections against the device's issued SyncKey (fingerprint = count + newest
change, the difference only when it moved) and answers Status 7 when the hierarchy differs from the
device's last FolderSync snapshot (a new calendar, a class switched on or off) — so devices that
synced before discover the new folders. A FolderSync with the previous key (a retry) always answers
a new key with the snapshot the device then holds, so a hierarchy that went back meanwhile cannot
leave Ping answering Status 7 forever. MeetingResponse writes the accepted meeting into the default
calendar; the next calendar Sync delivers it with the returned `CalendarId` as ServerId.

## Contacts (w3)

`src/pim/contacts.ts` (module), `src/pim/contacts-view.ts` (slots, pure),
`src/pim/contacts-codec.ts` (WBXML, pure). Code pages 1 Contacts ([MS-ASWBXML] 2.1.2.1.2) and 12
Contacts2 (2.1.2.1.13); every element exists in 12.1, so the class is the same in all three
versions. The folder is `contacts:default` (FolderSync Type 9, "Kontakte"); the ServerId is the
contact id, the one REST and CardDAV use. Sync, GetItemEstimate, ItemOperations Fetch (`Class`
Contacts) and Ping work as for the other classes; MoveItems answers Status 2 (one folder, no move
between classes). Search does not cover contacts.

**Writes**: the vCard stays the source of truth (see [contacts.md](contacts.md)). A device Add or
Change becomes a structured contact (storage `applyContactPatch`), is written into the stored vCard
with `applyContactCard` (only the properties whose field changed; PHOTO, `X-…`, labels, further
ORG units — everything a CardDAV client stored — survive) and stored through
`createContactRow` / `updateContactRow` (columns derived by `contactColumnsFromVcard`). A device
Delete goes through `deleteContactRow`: the contact leaves every contact group. A Change that
alters nothing writes nothing. Contact groups (`contact_groups`) are not synced: ActiveSync has no
group item.

**Mapping**

| ActiveSync | Contact |
|---|---|
| FirstName, MiddleName, LastName, Title, Suffix, contacts2:NickName | name parts, nickname |
| FileAs | "file as"; the derived value ("Family, Given", …) is sent when none is set, and a device sending back the derived value keeps it derived |
| CompanyName, Department, JobTitle | company, department, job title |
| OfficeLocation | vCard `X-OFFICE-LOCATION` (no standard property) |
| Email1–3Address | the first three e-mail addresses (`"Name" <address>` from a device is read as the address) |
| BusinessPhoneNumber, Business2PhoneNumber / HomePhoneNumber, Home2PhoneNumber / MobilePhoneNumber / BusinessFaxNumber, HomeFaxNumber / PagerNumber | the first two `work`, two `home`, one `mobile`, two `fax`, one `pager` phones |
| contacts2:CompanyMainPhone, CarPhoneNumber, RadioPhoneNumber, AssistantPhoneNumber | the first four `other` phones (CoreMail has no type for these kinds: a number a device enters there is stored as `other`) |
| Business / Home / OtherAddress Street, City, State, PostalCode, Country | the first `work` / `home` / `other` address (PO box and extended part have no element and are kept) |
| WebPage | the first web page |
| contacts2:IMAddress, IMAddress2, IMAddress3 | the first three chat addresses (the IMPP URI as it is) |
| Birthday, Anniversary | dates: sent as the local midnight in the user's Settings → Region zone (UTC midnight without one), a date without year with year 1604; read as the UTC date of a UTC midnight, the date in the user's zone of a local midnight there, else the date of the nearest midnight |
| Categories / Category | categories (trimmed, unique, capped like the REST API) |
| airsyncbase:Body | notes (plain text; an HTML body from a device is converted; a truncated copy sent back unchanged keeps the full note) |
| Picture | an inline JPEG / PNG / GIF PHOTO of at most 48 KiB; a larger photo or one by URL is not sent and never touched by device changes; a device picture over the bound or not an image is refused (the stored one stays and is sent back) |

Not stored (a device value is dropped): AssistantName, Spouse, Children, the Yomi names,
contacts2:CustomerId, GovernmentId, ManagerName, AccountName, MMS.

**Fixed slots, more values** (`src/pim/contacts-view.ts`): a contact can hold more e-mail
addresses, phones, addresses, web pages and chat addresses than ActiveSync has slots. Each slot
shows one list entry (the first unassigned entry of its type, in the order of the table); a device
Change is applied slot by slot to that entry — its value changes, its type, group and parameters
stay; an emptied slot removes its entry; a value in an empty slot appends an entry of the slot's
type. Entries no slot showed (a fourth e-mail address, a third work phone, a second mobile number,
a second work address) are never changed or removed by a device. When the stored contact then
shows something else than the device sent (an entry moved up into an emptied slot, a number
entered as car phone shown as company main phone, the derived "file as" after a name change, a
refused picture), the device gets the contact back as a Change in the same response. Absent
elements follow the Supported rules of the other classes (cleared unless ghosted); the display
name follows the name parts unless it was set apart from them (e.g. by a CardDAV client).

## Device policy

Every command except Provision needs a provisioned device whose final policy key matches the
request ([MS-ASPROV] two-phase handshake, `src/device-policy.ts`).

**Ping without policy key (9.4)**: [MS-ASPROV] "Provision Command" — the current policy key is
received "for all protocol command requests except the Autodiscover command, the Ping command,
and the HTTP OPTIONS command". A Ping **without** `X-MS-PolicyKey` (header absent, or no policy
key in the base64 request line) is therefore served when the device is known, in status OK and has
a committed final policy key. Every other case is unchanged: an empty, `0` or wrong key, an
unknown or not provisioned device (142), a blocked / pending device (129) and a pending wipe (140). The remote wipe flow
(`<RemoteWipe/>` in Provision, acknowledgement stored in `remoteWipeAckAt`) is identical in all
versions.

## Tests

* `src/protocol-version.test.ts` — negotiation (unannounced versions served as 14.1, warning once
  per device, version stored on change), feature table;
* `src/request.test.ts` — plain and base64 request lines (byte fixtures, truncation);
* `src/version-matrix.test.ts` — every command for 12.1 / 14.0 / 14.1 against the in-memory
  Prisma fake: only the version's tags, version-specific content, byte fixtures for the 12.1
  GetItemEstimate and UserInformation responses and the RemoteWipe answer;
* `src/commands/send-mail.test.ts` — the 12.1 compose form and its HTTP statuses, the empty 14.x
  success response, the size limits (122 / 413) and the Message-ID retry detection;
* `src/device-policy.test.ts` — HTTP 449/403 for 12.1 (403 also for a pending wipe without policy
  key), WBXML status for 14.x, Ping without policy key;
* `src/pim/timezone.test.ts`, `src/pim/recurrence.test.ts` — the TimeZone structure byte by byte,
  IANA zone ↔ rules, Recurrence ↔ RRULE;
* `src/pim/calendar-codec.test.ts`, `src/pim/tasks-notes-codec.test.ts` — byte fixtures of the
  calendar / tasks / notes code pages, client items with the [MS-ASWBXML] tokens, the round trip
  of a recurring meeting with exceptions across a DST change, Change / ghosting rules;
* `src/pim/pim-sync.test.ts` — FolderSync, Sync both ways with the item state, policies, Notes
  from 14.0, GetItemEstimate, MoveItems, ItemOperations, Ping, MeetingResponse (in-memory Prisma);
* `src/pim/pim-review.test.ts` — ClientIds of earlier requests, re-priming without Supported,
  rooms of phone meetings (booked / declined / released, copies and foreign UIDs untouched), a UTC
  event turned into a series across DST, the calendar FilterType window, a completed task sent
  again with its rule, FolderSync retried with the previous key, Ping with an unreadable policy;
* `src/pim/contacts-codec.test.ts` — the Contacts / Contacts2 token tables, a byte fixture, the
  mapping round trip (contact → Sync item → device echo → unchanged contact), values the device
  could not see surviving its edits (overflow), ghosting, dates, pictures, "file as" / display name;
* `src/pim/contacts-sync.test.ts` — FolderSync (type 9, module policy), Sync both ways through the
  storage contact writer (CardDAV properties, hidden photo and groups kept, a deleted contact leaves
  its groups), ClientId retries, normalised items, GetItemEstimate, Fetch, MoveItems, Ping;
* e2e steps `eas-legacy` and `eas-pim` (`scripts/e2e/steps/`, see [e2e.md](e2e.md)).
