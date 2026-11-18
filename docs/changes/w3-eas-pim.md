# w3-eas-pim — ActiveSync Calendar, Tasks and Notes

SemVer: MINOR (compatible feature). No schema change, no removed or changed endpoint; existing
ActiveSync mail behaviour is unchanged (see "Changed" for the two protocol-visible additions).

### Added

- ActiveSync: the Calendar ([MS-ASCAL], code page 4), Tasks ([MS-ASTASK], code page 9) and Notes
  ([MS-ASNOTE], code page 23, EAS 14.0+) classes sync both ways. FolderSync announces the user's own
  calendars (default calendar type 8, others 13), the tasks folder (type 7) and the notes folder
  (type 10); shared calendars are not offered over ActiveSync.
- Sync for these classes with the per-device item state of the mail sync (committed / pending
  rows, acknowledged keys, retries resend the same changes): server Add / Change (complete item) /
  Delete detected from the item versions (`updatedAt`), FilterType windows (calendar 2 weeks …
  6 months back with series always included, tasks "incomplete only"), WindowSize + MoreAvailable;
  client Add with ClientId → ServerId responses (a retried Add is not created twice), Change and
  Delete through the existing writers, no echo of the device's own writes, airsync:Supported
  ghosting, truncated bodies sent back unchanged do not cut the stored text.
- Calendar mapping: TimeZone structure ([MS-ASDTYPE] 2.7.4) ↔ IANA zones (a timed series created
  on a device keeps its local time across DST changes), Recurrence ↔ RRULE (daily, weekly,
  monthly / yearly on a day or the nth weekday, interval, occurrences, until, first day of the
  week), exceptions ↔ EXDATE / RECURRENCE-ID overrides (deleted, changed and restored occurrences),
  attendees with status and type, reminder, busy status, sensitivity, all-day events, meeting
  status and response type.
- Tasks mapping: importance, start / due dates (UTC and local), completion (the task status rules
  apply; completing a recurring task on the phone creates the next one), reminder, privacy,
  recurrence. Notes: subject and body.
- GetItemEstimate, ItemOperations Fetch and Ping for the new collections; MoveItems moves an event
  between the user's own calendars. MeetingResponse keeps working: the accepted meeting reaches
  the phone's calendar with the returned CalendarId as its ServerId.
- Webmail module policies apply: with the calendar, tasks or notes module switched off the folders
  disappear from FolderSync and their Sync / Ping ask the device to refresh its folder list.
- Storage: `createTask` / `updateTask` (task-writer.ts), the task writer shared by the REST API and
  ActiveSync. Core: `restoreOccurrence` (calendar exceptions) and an optional `tzid` for
  `buildVCalendar`.
- Tests: TimeZone and Recurrence mapping, WBXML byte fixtures for the three classes, the round trip
  of a recurring meeting with exceptions, PIM sync-state tests on the in-memory Prisma fake; e2e
  step `eas-pim`.

### Changed

- ActiveSync Ping answers Status 7 (folder hierarchy changed) when the folder hierarchy differs from
  the device's last FolderSync, so existing devices discover the new calendar / tasks / notes
  folders and later hierarchy changes without being set up again.
- ActiveSync MoveItems answers Status 2 (invalid destination) for a move between a mail folder and a
  calendar / tasks / notes folder, or between different PIM classes.
- REST `POST/PUT /api/v1/tasks` use the shared storage task writer (same behaviour).

### Known limits

- Device writes do not send meeting invitations (the device sends them itself, as before for
  MeetingResponse) and do not (re)book rooms of a meeting; rooms stay attendees.
- Recurrence rules without an ActiveSync form (e.g. several month days, hourly) are not sent to the
  device and are kept unchanged on device edits.
- An event made recurring on the device after it was stored as a single timed event keeps a UTC
  start (the series follows UTC across DST changes).
- Contacts are a separate package (the class registry takes one more module).
