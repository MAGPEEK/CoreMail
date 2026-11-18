# Tasks and follow-up flags

## Follow-up flags of mails

A mail can be flagged for follow-up ("Kennzeichnen"). The flag is a property of the mail itself
(`Message.flagStatus` `none` | `flagged` | `complete`, `flagStartAt`, `flagDueAt`,
`flagReminderAt`, `flagCompletedAt`), not a copy in the task list.

### Keyword mapping

The IMAP keyword `\Flagged` (JMAP `$flagged`) stays the boolean view of the flag:

| Change | Result |
|--------|--------|
| flag set (any protocol, any date) | `flagged`, `\Flagged` set |
| marked complete | `complete`, `\Flagged` cleared, completion time stored, dates kept |
| flag cleared | `none`, `\Flagged` cleared, dates cleared |
| IMAP `STORE +FLAGS \Flagged` / JMAP `$flagged: true` | `flagged` (dates kept, completion cleared) |
| IMAP `STORE -FLAGS \Flagged` / JMAP `$flagged: false` on a flagged mail | `none` |
| IMAP / JMAP clearing `\Flagged` on a completed mail | stays `complete` |

The rules live in `storage/src/follow-up.ts`; `message-store.ts` applies them on every keyword
write (`setFlags`, `modifyFlags`, create, copy) and `setFollowUp` writes the flag itself — each
change gets the mailbox's next modSeq, so IMAP CONDSTORE/IDLE, JMAP, EAS and the other webmail
tabs see it. Mails flagged before 9.4 carry only `\Flagged`; they count as flagged without dates.
JMAP has no standard property for the dates, so JMAP clients see the keyword only.

### ActiveSync (`email:Flag`)

Sync carries the flag in every `Add` and `Change` ([MS-ASEMAIL] 2.2.2.34):

* not flagged → empty `<Flag/>`
* flagged → `Status 2`, `FlagType` "Flag for follow up", `tasks:StartDate`/`UtcStartDate`,
  `tasks:DueDate`/`UtcDueDate` (when set), `tasks:ReminderSet` (+ `ReminderTime`)
* complete → `Status 1`, `tasks:DateCompleted`, `CompleteTime`

A device change (`Change` with `email:Flag`) is applied through the message store: empty `Flag` or
`Status 0` clears, `Status 1` (needs `CompleteTime` and `tasks:DateCompleted`) completes, `Status 2`
(needs `FlagType`; the four start/due dates all set or all absent, due not before start) flags.
An invalid flag is answered with `Status 6` for that item in `airsync:Responses` and nothing is
changed. CoreMail keeps one instant per date; the local `StartDate`/`DueDate` are written with the
UTC value. The Tasks code page (9) is part of the WBXML codec for these elements.

### Webmail

* Command bar *Kennzeichnen* (split button): click toggles; the menu offers **Heute**, **Morgen**,
  **Diese Woche** (today until the last work day of the week), **Nächste Woche** (first to last
  work day of next week), **Kein Datum**, **Benutzerdefiniert …** (start, due, reminder),
  **Erinnerung hinzufügen …**, **Als erledigt markieren** and **Kennzeichnung löschen**. Dates are
  the start of the day in the user's time zone; work days come from Settings → Kalender.
* The message list shows the flag (due date in the tooltip) or a check mark for completed flags;
  the context menu has the same *Kennzeichnen* submenu.
* Flag reminders pop up (leading tab) like task reminders.
* Shared and delegated mailboxes keep the plain flag toggle (the follow-up routes act on the own
  mailbox).

REST: `PUT /api/v1/mail/follow-up` `{ ids, status, startAt?, dueAt?, reminderAt? }` (dates left out
keep their value, `null` clears) and `GET /api/v1/mail/follow-up?status=flagged|complete|all`.

## Tasks

### "Gekennzeichnete Elemente und Aufgaben"

The tasks page lists tasks and flagged mails together, filtered by **Aktiv**, **Überfällig** or
**Abgeschlossen** and sorted by due date (items without one last). Completing a flagged mail there
completes the flag of that mail; opening it goes to the mail. Deleting a mail entry clears its flag
(the mail stays).

### Task form

Betreff, Startdatum, Fälligkeitsdatum, Abschlussdatum, Status (*Nicht begonnen*, *In
Bearbeitung*, *Abgeschlossen*, *Wartet auf jemanden*, *Zurückgestellt*), % erledigt, Priorität,
Erinnerung (+ per E-Mail), Privat, Serie (same recurrence editor as events), Gesamtaufwand /
Ist-Aufwand (hours, stored as minutes), Reisekilometer, Abrechnungsinformationen, Firmen and a
rich-text Notiz (`bodyHtml`, shown sanitised; `body` keeps the plain text).

### Status rules (`storage/src/task-rules.ts`)

| Change | Result |
|--------|--------|
| status *Abgeschlossen*, 100 % or a completion date | completed, 100 %, completion date (today unless given) |
| status *Nicht begonnen* | 0 % |
| 1–99 % on a not-started or completed task | *In Bearbeitung* |
| 0 % on a task in progress | *Nicht begonnen* |
| leaving *Abgeschlossen* | completion date removed, 100 % becomes 0 % |

Completing a recurring task closes this occurrence (its rule is removed) and creates the next
task: the next date of the rule after the current due date, start date and reminder keep their
distance, `COUNT` is reduced by one; when the series is over no task follows. `PUT /tasks/:id`
returns the new task as `next`. The completion is a conditional update (only while the task is
still open) in one transaction with the creation, so two concurrent or repeated completions
create the next task once. A task rule repeats at most daily (`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`
with `NAME=value` parts); anything else is refused with 400.

### Not covered

CoreMail has no CalDAV task list (`VTODO`) and no ActiveSync Tasks folder; tasks are reachable in
the webmail only. Flags of mails are visible over IMAP, JMAP (keyword) and ActiveSync.

Tests: `storage/src/follow-up.test.ts`, `task-rules.test.ts`, `message-store.test.ts`,
`activesync/src/commands/flag.test.ts`, `api-gateway/src/routes/tasks-followup.test.ts`,
`web-client/src/lib/followUp.test.ts`; e2e `scripts/e2e/steps/imap.mjs` (IMAP flag visible in
REST), `eas.mjs` (EAS flag both directions), `rest.mjs`.
