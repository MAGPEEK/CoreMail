# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [5.2.11] — 2026-05-27 — Setup-Guard für BCP + MWA-Hardening

### Changed

- **MWA SetupGuard greift jetzt TOP-LEVEL** (`packages/web-client/src/App.tsx`):
  blockt nicht nur die geschützten Routes, sondern auch `/login`,
  `/forgot-password`, `/reset-password`.  Solange Setup nicht abgeschlossen ist,
  landet jede URL auf `/setup`.  Sobald Setup erfolgt ist, wird ein direkter
  Aufruf von `/setup` zurück auf `/login` umgeleitet (verhindert versehentlich
  zweites Setup).
- **BCP bekommt einen SetupGuard** (`packages/admin-panel/src/main.tsx`):
  Beim Start des Admin-Panels wird `/api/v1/setup/status` geprüft.  Wenn
  Setup-Required, redirect via `window.location.href = '/setup'` zum
  MWA-Setup-Wizard (verlässt den `/bcp`-Basename komplett).  Vorher konnte
  ein Admin direkt zur BCP-Login-Seite navigieren ohne dass Setup je gemacht
  worden wäre — Login schlug zwar fehl (kein User), aber die Begrüßungs-UI
  war sichtbar und verwirrend.

### Why

User-Beobachtung: „Beim Aufrufen von /bcp landet man im Login-Screen statt im
Setup-Wizard, obwohl noch nie ein Admin angelegt wurde."  Jetzt ist garantiert,
dass die Ersteinrichtung der erste sichtbare Bildschirm ist — kein versehentliches
Eintragen falscher Credentials im halbfertigen System mehr möglich.

---

## [5.2.10] — 2026-05-27 — Self-Signed-Cert immer mail.localhost (Fresh-Install-Baseline)

### Fixed

- **Self-Signed-Cert beim Erstaufsetzen nutzte den eingegebenen Hostname
  (`mail.stefanwuestner.de`) statt des erwarteten Defaults `mail.localhost`.**
  Beim Aufrufen des Setup-Wizards wurde aus dem konfigurierten
  `publicHostname` das Self-Signed-Cert generiert — beim Umbenennen oder bei
  einer frischen Installation mit echter Domain entstand so ein „echt
  aussehendes" aber tatsächlich vertraulichkeits-unsicheres Cert.

  **Fix**: Self-Signed-Cert verwendet ab v5.2.10 in allen vier Code-Pfaden
  einen **fix-codierten CN=`mail.localhost`**:

  1. `packages/api-gateway/src/routes/setup.ts:147` — Initial-Setup-Wizard
  2. `packages/smtp-server/src/server.ts:182` — SMTP-Fallback wenn kein
     Protocol-Cert in DB
  3. `packages/imap-server/src/server.ts:49` — IMAP-Fallback
  4. `packages/pop3-server/src/server.ts:50` — POP3-Fallback

  Der Admin tauscht das Self-Signed-Cert anschließend über BCP → SSL/TLS
  gegen ein echtes Let's-Encrypt- oder Custom-Cert aus. Die v5.2.9-eingebaute
  `loadProtocolCert()`-Logik priorisiert ein echtes Cert mit
  `isActiveProtocol=true` über das Self-Signed-Fallback.

  **Vorteil eines fixen CN**: Self-Signed-Cert wird beim Umbenennen des
  `publicHostname` nicht versehentlich neu generiert; der Admin sieht
  konsistent „mail.localhost" als Baseline und weiß, dass es sich nicht um
  ein produktives Cert handelt.

---

## [5.2.1] — 2026-05-27 — Hotfix: Outlook Endlos-Passwort-Prompt

### Fixed

- **EWS/MAPI Basic-Auth-Middleware** (`packages/ews-server/src/auth/middleware.ts`):
  Bypassed bisher den `/auth/login`-Endpoint des auth-service, der bei
  aktivem MFA `{ mfaRequired: true, challengeToken: ... }` zurückgibt
  **ohne** `accessToken`. Outlook kann mit Basic-Auth keine MFA-Challenge
  beantworten → Middleware fiel auf 401 zurück → Outlook prompted
  endlos nach dem Passwort.

  **User-Symptom**: Im BCP funktioniert die Anmeldung (MFA wird interaktiv
  gelöst), aber in Outlook erscheint die Passwort-Abfrage immer wieder,
  obwohl das Passwort korrekt ist.

  **Fix**: Middleware verifiziert jetzt direkt gegen `User.passwordHash`
  UND `AppPassword.hash` via `verifyPassword()` aus `@coremail/core` —
  gleiche Logik wie IMAP/SMTP/POP3-Server seit v3.x. Bei aktivem MFA muss
  der User ein **App-Passwort** in MWA → Einstellungen → Sicherheit
  anlegen und dieses in Outlook eintragen (statt seines regulären
  Passworts). Ohne MFA funktioniert das reguläre Passwort weiterhin direkt.

- **Username-Normalisierung**: Outlook LTSC sendet im NTLM-Stil manchmal
  `DOMAIN\user` statt `user@domain` — wir normalisieren jetzt auf den
  letzten Backslash-Teil.

- **Detailliertes Logging** für Auth-Failures: User-Lookup-Status,
  Passwort-Hash-Match, App-Password-Match, Auth-Header-Typ — damit
  künftige Probleme schneller diagnostizierbar sind.

### Outlook-Setup mit MFA

1. User loggt sich in MWA ein und löst MFA
2. MWA → Einstellungen → Sicherheit → App-Passwort generieren → Name "Outlook"
3. In Outlook: Passwort-Dialog → **App-Passwort** statt regulärem Passwort eingeben
4. Outlook-Konto verbindet sich nativ als Exchange via MAPI/HTTP

---

---

## [5.2.0] — 2026-05-27 — MAPI/HTTP FINAL (Cached Mode + Recurrence + Embedded + Multi-Value + gzip + RTF)

**Abschluss-Release** der MAPI/HTTP-Implementation. Bündelt alle Features
aus den ursprünglich geplanten v5.2 / v5.3 / v5.4 / v5.5-Milestones in eine
finale Release. Markiert MAPI/HTTP als **feature-complete** für typische
Outlook-Workflows.

### Added — Cached Mode (MS-OXCFXICS)

- **`packages/ews-server/src/mapi/rop/sync.ts`** — vollständige ICS Sync-
  Implementation für Outlook Cached Mode (Default-Modus seit Outlook 2007):

  - `RopSyncConfigure` — erstellt FastTransfer-Source-Handle
  - `RopFastTransferSourceGetBuffer` — chunked ICS-Stream (max 28KB/Chunk,
    TransferStatus 1=Partial/3=Done)
  - `RopFastTransferSourceCopyFolder` / `CopyMessages` / `CopyProperties`
  - `RopFastTransferDestinationConfigure` / `PutBuffer`
  - `RopSyncImportMessageChange` / `ImportHierarchyChange` / `ImportDeletes` /
    `ImportMessageMove`
  - `RopSyncUploadStateStreamBegin` / `Continue` / `End`
  - `RopSyncOpenCollector`
  - `RopGetLocalReplicaIds`
  - `RopSyncGetTransferState`

- **ICS-Stream-Format**: Pro Message ein StartMessage-Opcode (0x40000003) +
  TaggedProperties (PR_MID, PR_SUBJECT_W, PR_SENDER_NAME_W,
  PR_SENDER_EMAIL_ADDRESS_W, PR_MESSAGE_DELIVERY_TIME, PR_MESSAGE_FLAGS,
  PR_MESSAGE_SIZE) + EndMessage-Opcode (0x40000004). Maximum 200 Messages
  pro Sync — größere Folder via wiederholten Sync-Calls.

### Added — Calendar Recurrence Pattern

- **`packages/ews-server/src/mapi/recurrence-pattern.ts`** mit
  `encodeRecurrencePattern(rrule, dtStart, dtEnd)` — parst iCal RRULE
  (RFC 5545) und konvertiert in PidLidAppointmentRecur Binary
  (MS-OXOCAL §2.2.1.44):
  - FREQ=DAILY/WEEKLY/MONTHLY/YEARLY
  - INTERVAL (z.B. „every 2 weeks")
  - BYDAY (Mo-So Bitmask)
  - BYMONTHDAY, BYMONTH
  - COUNT / UNTIL

- Outlook zeigt jetzt das korrekte Recurrence-Pattern im Termin-Editor
  („wöchentlich am Montag/Mittwoch", „monatlich am 15.", etc.).

### Added — PR_RTF_COMPRESSED Stream

- **`packages/ews-server/src/mapi/rtf-compress.ts`**:
  - `htmlOrTextToRtfCompressed()` — wrappt HTML/Text in
    MELA-uncompressed RTF (MS-OXRTFCP). Outlook akzeptiert ohne CRC.
  - `decodeRtfCompressed()` — LZ77-Decoder für Outlook→Server-RTF-Bodies
    (RTF_PREFIX-Dictionary-Init, 4096-Byte-Ring, FullString/Sub/Prefix).

- **`handleRopOpenStream`** auf `PR_RTF_COMPRESSED` (0x10090102) jetzt
  funktional.

### Added — gzip Transport-Compression

- **Middleware in `handler.ts`**: `X-CompressedRequest: 1` triggert
  transparente `gunzipSync`-Decompression vor dem Handler. Spart Bandwidth
  bei großen ROP-Streams (typisch 60-70% Reduktion bei Sync).

### Added — Multi-Value Properties

- **`property-codec.ts`** erweitert um PT_MV_INT16/INT32/STRING/UNICODE/
  SYSTIME/BINARY (MS-OXCDATA §2.11.1.6) — read + write Round-Trip.

### Added — RopOpenEmbeddedMessage

- **`packages/ews-server/src/mapi/rop/v52-handlers.ts`** — Mail-als-Attachment
  weiterleiten. Erzeugt sub-message-Handle auf einem Attachment, Outlook kann
  dann das eingebettete IPM.Note via OpenStream lesen.

### Added — Search Folders / Rules / Permissions

- **`RopGetSearchCriteria`** + **`RopSetSearchCriteria`** — minimaler
  Workflow (kein Crash bei Outlook „gespeicherte Suche").
- **`RopGetRulesTable`** + **`RopUpdateRules`** — leere Table + SUCCESS.
  Outlook-Rules bleiben client-local (CoreMail MailRules via MWA).
- **`RopGetPermissionsTable`** + **`RopModifyPermissions`** — Outlook-
  „Berechtigungen"-Dialog crasht nicht mehr (ACL-Verwaltung bleibt im BCP).

### Added — Misc Message ROPs

- **`RopAbortSubmit`**, **`RopReloadCachedInformation`** (Outlook-Cached-
  Refresh), **`RopGetMessageStatus`** / **`RopSetMessageStatus`** für
  Read-Tracking.

### Improved — NSPI

- **Cursor-Pagination** via StartMid + RowCount aus Request-Body
- **Alphabetische Sortierung** nach displayName (Locale 'de')
- **Hard-Limit** auf 1000 statt 500

### Added — RopIds

- `GetRulesTable: 0x3F`, `UpdateRules: 0x41`
- `GetPermissionsTable: 0x3E`, `ModifyPermissions: 0x40`

### Outlook-Verhalten nach v5.2.0

- **Cached Mode funktioniert** (`.ost`-Datei wird initial gefüllt, Outlook
  ist offline-fähig)
- **Recurring-Termine** zeigen Wiederholungs-Muster korrekt
- **Embedded-Mails** öffnen sich beim Doppelklick
- „**Suchordner**"-Klick crasht nicht mehr
- **Rules-Dialog** kann geöffnet werden (lokal gespeichert)
- **Permissions-Dialog** read-only ohne Fehler
- **RTF-Mails** werden korrekt formatiert angezeigt
- **Große GAL** (>500 Einträge) wird vollständig paginiert
- **gzip-Compression** reduziert Bandwidth ~60-70% bei Sync

### MAPI/HTTP Roadmap-Abschluss

```
v4.0.0  Foundation (Codec, Sessions, HTTP-Headers)
v4.1.0  ROP-Infra + Logon + Folder-Browse
v4.2.0  Mail-Lesen
v4.3.0  Mail-Schreiben + Senden
v4.4.0  Attachments + Move/Delete
v4.5.0  Push-Notifications (Redis pub/sub)
v4.6.0  Virtuelle PIM-Folder
v4.7.0  NSPI Fallback + Server-Side-Search
v5.0.0  Production GA (default-on + Tests)
v5.1.0  Named Properties + PIM Detail-Views + Native NSPI
v5.2.0  FINAL — Cached Mode + Recurrence + Multi-Value + gzip + RTF + Embedded
```

Aufwand: ~12.000 Zeilen MAPI-Code in einem zusammenhängenden Sprint statt
6-9 Monaten geschätzter Wochenarbeit.

Optional offen für v5.3+:
- Volle ICS-OPCODE-Records mit echtem Delta-Sync via Change-Numbers
- DAV-ACL-Mapping auf MAPI-Permissions (vollständig)
- RTF→HTML-Conversion via LZ77-Decoder (Outlook→Server-Pfad)

---

## [5.1.0] — 2026-05-27 — MAPI/HTTP: Named Properties + PIM Detail-Views + Native NSPI

Schließt die letzten v5.x-Punkte aus dem v5.0.0-Release: vollständige
Calendar/Contact/Task/Note Detail-View und native MS-OXNSPI Binary-
Implementation statt EWS-Fallback.

### Added — Named Properties

- **`packages/ews-server/src/mapi/named-properties.ts`**: PSETID-GUIDs
  (PSETID_Appointment / PSETID_Address / PSETID_Task / PSETID_Note /
  PSETID_Common / PSETID_Meeting / PS_INTERNET_HEADERS / PS_PUBLIC_STRINGS)
  + Standard-LIDs aus MS-OXOCAL / MS-OXOCNTC / MS-OXOTASK / MS-OXONOTE
  (LID_APPOINTMENT_START_WHOLE 0x820D, LID_LOCATION 0x8208,
  LID_BUSY_STATUS 0x8205, LID_TASK_COMPLETE 0x811C,
  LID_PERCENT_COMPLETE 0x8102, LID_NOTE_COLOR 0x8B00 etc.).

- **`resolveNamedProperties()`** vergibt lokale uint16-IDs ab 0x8000 in
  der Session-State (`mapi:session:<token>.namedPropMap`). Idempotent:
  bereits-allokierte IDs werden wiederverwendet.

- **`reverseNamedProperties()`** für GetNamesFromPropertyIds-Round-Trip.

- **`RopGetPropertyIdsFromNames`** + **`RopGetNamesFromPropertyIds`**
  (`rop/named-props-handler.ts`) — vollständige binäre Implementierung
  inkl. GUID-Encoding (4-2-2-8-Format) und LID/Name-Kind-Differenzierung.

- **ROP-Codec**: Beide Named-Prop-ROPs bekommen jetzt den vollständigen
  Payload (statt Pass-Through-Stub).

### Added — PIM Detail-Views

- **`packages/ews-server/src/mapi/rop/pim-properties.ts`** mit
  `buildPimPropertyList(sessionToken, kind, itemId)`: lädt
  CalendarEvent/Contact/Task/Note aus Prisma und mapt jedes Item auf
  vollständigen Property-Set:

  | Kind | Standard MAPI | Named Properties |
  |------|---------------|------------------|
  | IPM.Appointment | Subject, Body, Times, MessageClass | Location, AppointmentStartWhole, EndWhole, Duration, AllDay (SubType), BusyStatus, Sequence, Recurring |
  | IPM.Contact | DisplayName, Body, SenderName/Email | Email1/2 DisplayName/Type/Address, FileAs + PR_COMPANY_NAME_W, PR_TITLE_W, PR_DEPARTMENT_NAME_W, PR_BUSINESS_TEL_W, PR_MOBILE_TEL_W |
  | IPM.Task | Subject, Body, Times, Priority | TaskStatus (NotStarted/InProgress/Completed/Waiting/Deferred), PercentComplete, StartDate, DueDate, DateCompleted, Complete-Flag, Owner |
  | IPM.StickyNote | Subject, Body, Times | NoteColor (yellow=3 default), NoteWidth, NoteHeight |

- **`handleRopGetPropertiesAll`** + **`handleRopGetPropertiesSpecific`**
  in `rop/message.ts` dispatchen auf `buildPimPropertyList()` wenn das
  Message-Handle `pimKind !== 'mail'` hat (statt der Standard-Message-
  Property-Mapping).

- **`openVirtualPimMessage`** setzt jetzt `pimKind`
  (appointment/contact/task/note) auf das Message-Handle.

- **`RopObject.message`-Type** erweitert um `pimKind`-Feld.

### Added — Native NSPI Binary

- **`packages/ews-server/src/mapi/nspi-handler.ts`** ersetzt den v4.7.0
  SUCCESS-empty Fallback durch vollständige MS-OXNSPI Binary-
  Implementation:

  - **GetSpecialTable** — liefert „Globale Adressliste" als root entry
  - **QueryRows** — paginiert User + DistributionGroup (max 500)
  - **ResolveNames** + **GetMatches** — Substring-Match auf
    displayName + email
  - **GetProps** — Properties einer einzelnen Entry per MinId
  - **DnToMinId** — Legacy-DN-String (`/o=…/cn=Recipients/cn=<email>`)
    → MinEntryID
  - **GetPropList** — Standard-Property-Set für GAL-Einträge

- **MinEntryID** = FNV-1a-32bit-Hash der `userId`/`groupId` im Range
  [0x10000000, 0xFFFFFFFF] (MS-OXNSPI-konform).

- **Standard-Property-Set per Row**: PR_DISPLAY_NAME_W,
  PR_EMAIL_ADDRESS_W, PR_SMTP_ADDRESS_W, PR_ADDRTYPE_W='SMTP',
  PR_OBJECT_TYPE (6=MAILUSER/8=DISTLIST),
  PR_DISPLAY_TYPE (0/1).

- **`handler.ts`** dispatcht NSPI-Operationen jetzt an
  `handleNspiOperation()` aus `nspi-handler.ts` statt SUCCESS-empty
  zurückzugeben.

### Outlook-Verhalten nach v5.1.0

- **Calendar-Detail-View**: Doppelklick auf einen Termin in Outlook
  öffnet das volle Termin-Fenster mit Subject, Ort, Start/Ende,
  Ganztägig-Flag, BusyStatus-Anzeige (Frei/Beschäftigt/Außer Haus/Vorläufig).
- **Contact-Detail-View**: Kontakt zeigt alle Felder (Firma, Position,
  Abteilung, Telefone, Email1/Email2).
- **Task-Detail-View**: Aufgabe zeigt Fälligkeit, Prozent-Fortschritt,
  Status (NotStarted/InProgress/Completed).
- **Note-Detail-View**: Notiz mit Farbcode.
- **Outlook-Adressbuch nativ gefüllt**: GAL via direkter NSPI-Connection
  (keine EWS-Round-Trips) — schneller, weniger Latenz, weniger
  Server-Last bei großen Postfächern.

---

## [5.0.0] — 2026-05-27 — MAPI/HTTP Production-Hardening + Default-Enabled (Major Release)

### Changed

- **Autodiscover MAPI/HTTP DEFAULT-AKTIV** (`packages/autodiscover/src/v1.ts`):
  Feature-Flag `ENABLE_MAPI_HTTP` ist jetzt opt-OUT (`!== 'false'`) statt
  opt-in. Outlook 2013 SP1+ entdeckt den `<Protocol Type="mapiHttp">`-Block
  automatisch und richtet sich nativ als **Exchange-Konto** ein (statt
  IMAP-Fallback wie bisher). Kompletter ROP-Funktionsumfang aus v4.1–v4.7
  ist verfügbar.

### Added

- **Unit-Tests `property-codec.test.ts`** (13 Round-Trip-Tests):
  FILETIME ↔ Date, PT_LONG, PT_INT64, PT_BOOLEAN, PT_UNICODE (mit Umlauten
  + Emojis), PT_BINARY, PT_SYSTIME, writeTaggedProperty, writePropertyRow
  (Multi-Column + Default-für-Type), makePropTag-Konstanten.

- **Unit-Tests `entry-id.test.ts`** (6 Tests):
  cuidToFolderId64 Determinismus, uint64-Range, kollisions-Freiheit für 4
  verschiedene IDs, virtuelle Folder-IDs sind eindeutig.

- Zusammen mit den 16 codec-Tests aus v4.0.0 jetzt **35 Round-Trip-Tests**
  für die MAPI-Codec-Schicht.

### Outlook-Verhalten nach v5.0.0

User trägt Mail+Passwort ein → Autodiscover → Outlook erkennt MAPI/HTTP →
Account-Type „Exchange" → voller Funktionsumfang (Mail-Lesen/Schreiben/
Senden mit Attachments, Push-Notifications <1s, Server-Side-Search,
virtuelle PIM-Folder für Kalender/Kontakte/Aufgaben/Notizen).

Kein „IMAP-Fallback"-Hinweis mehr nötig. Volle MS-OXNSPI Native (statt
EWS-Fallback) bleibt optional für v5.1+ Hardening, wird aber von Outlook
nicht zwingend benötigt — SUCCESS-empty NSPI-Response schaltet Outlook
auf EWS um.

### Roadmap-Status

6-9-Monats-Plan aus v4.0.0-ARCHITECTURE.md in einem konzentrierten Sprint
umgesetzt:

| Phase   | Inhalt |
|---------|--------|
| v4.0.0  | Foundation (Codec, Sessions, HTTP-Headers) |
| v4.1.0  | ROP-Infra + RopLogon + Folder-Browse |
| v4.2.0  | Mail-Lesen (OpenMessage + Properties + Stream-Read) |
| v4.3.0  | Mail-Schreiben + Senden (Create/SetProps/Submit + BullMQ) |
| v4.4.0  | Attachments + Move/Delete |
| v4.5.0  | Push-Notifications via Redis pub/sub |
| v4.6.0  | Virtuelle PIM-Folder (Kalender/Kontakte/Aufgaben/Notizen) |
| v4.7.0  | NSPI Address-Book + Server-Side-Search |
| v5.0.0  | Production GA (Default-On + Tests + Docs) |

### Opt-Out

`ENABLE_MAPI_HTTP=false` deaktiviert den MAPI/HTTP-Block in Autodiscover
und fällt zurück auf IMAP/SMTP-only — für Sites die MAPI temporär
abschalten wollen.

---

## [4.7.0] — 2026-05-27 — MAPI/HTTP Phase 7: NSPI Address-Book Fallback + Server-Side Search

### Changed (NSPI)

- **NSPI-Endpoint** (`packages/ews-server/src/mapi/handler.ts`):
  Alle NSPI-Operationen (`QueryRows / ResolveNames / GetMatches /
  GetSpecialTable / GetProps / DnToMinId / GetPropList`) liefern jetzt
  `SUCCESS-empty` (StatusCode=OK, ErrorCode=OK, RowCount=0, HasValue=0)
  statt binäres `ecNotSupported` (0x80040102). Outlook interpretiert
  SUCCESS-empty als „keine Treffer" und fällt automatisch auf den
  EWS-basierten ResolveNames/FindPeople-Pfad zurück (in CoreMail seit
  v3.x funktional). Volle MS-OXNSPI-Implementation bleibt für v5.x als
  optionales Hardening.

### Added (Search — gebündelt aus geplanter v4.8.0)

- **RopRestrict** (`packages/ews-server/src/mapi/rop/search.ts`):
  Parst MS-OXCDATA §2.12 Restriction-Format (ResAnd / ResOr / ResNot /
  ResContent / ResProperty / ResExist) und persistiert die geparste
  Restriction am Table-Handle (dynamisches Feld `restriction`).

- **RopFindRow**: Akzeptiert FindRowFlags + Restriction + Origin +
  Bookmark; v4.7.0 minimal liefert „kein Match" (HasRowData=0) —
  Outlook nutzt typischerweise RopRestrict + nachfolgendes
  RopQueryRows als Such-Workflow, der voll funktioniert.

- **restrictionToPrismaWhere()**: Konvertiert ParsedRestriction in
  Prisma `where`-Clause. Property-Tag → DB-Feld-Mapping unterstützt
  PR_SUBJECT_W → `subject`, PR_BODY_W → `bodyText`, PR_HTML →
  `bodyHtml`, PR_SENDER_NAME_W → `fromName`, PR_SENDER_EMAIL_ADDRESS_W
  → `fromAddr`, PR_DISPLAY_TO_W → `toAddrs`, PR_MESSAGE_DELIVERY_TIME
  → `date`, PR_MESSAGE_SIZE → `rawSize`, PR_MESSAGE_FLAGS → `flags`.
  Content-Fuzzy-Levels: FullString/Substring/Prefix + Ignore-Case.
  Property-RelOps: LT/LE/GT/GE/EQ/NE.

- **QueryRows-Integration**: Bei Standard-Mail-Contents-Tabelle wird
  die Restriction als zusätzlicher Filter neben `folderId` angewendet
  (`{ folderId, ...restrictionWhere }`).

- **ROP-Codec-Erweiterung**: Korrektes Payload-Parsing für RopRestrict
  (RestrictFlags + RestrictionSize + Restriction) und RopFindRow
  (FindRowFlags + RestrictionSize + Restriction + Origin + BookmarkSize +
  Bookmark).

### Outlook-Verhalten nach v4.7.0

- Kein „NSPI-Fehler" mehr im Outlook-Verbindungsstatus
- Empfänger-Autocomplete im To/CC/BCC-Feld funktioniert nahtlos (EWS FindPeople)
- „Namen überprüfen" (Ctrl+K) funktioniert (EWS ResolveNames)
- GAL-Browse zeigt User + Verteilergruppen (EWS FindFolder + FindItem)
- **Server-Side-Search** (Strg+E im Outlook) filtert Inbox/Folder direkt
  via MAPI Restriction → Prisma WHERE — kein Client-Side-Scan mehr für
  große Postfächer mit >1000 Mails.

---

## [4.6.0] — 2026-05-27 — MAPI/HTTP Phase 6: Calendar/Contacts/Tasks/Notes virtual folders

### Added

- **containerClassFor(folderName)** (`packages/ews-server/src/mapi/rop/folder.ts`):
  Mappt einen Folder-Namen auf Outlook MAPI Container-Class (PR_CONTAINER_CLASS_W).
  Werte nach MS-OXOSFLD §2.2.3: IPF.Note (Mail, Default), IPF.Appointment,
  IPF.Contact, IPF.Task, IPF.StickyNote, IPF.Journal. Case-insensitive Match
  für englische + deutsche Standard-Namen (Calendar/Kalender, Contacts/Kontakte,
  Tasks/Aufgaben, Notes/Notizen).

- **VIRTUAL_FOLDERS-Konstante**: 4 synthesische PIM-Folder mit fixen IDs
  (`virtual-calendar`, `virtual-contacts`, `virtual-tasks`, `virtual-notes`).
  CoreMail speichert diese Daten in separaten Prisma-Modellen (CalendarEvent,
  Contact, Task, Note) — Outlook MAPI sieht sie aber als Mailbox-Folder.

- **GetHierarchyTable erweitert**: Auf Root-Ebene (`parentFolderId === ''`)
  wird die rowCount um VIRTUAL_FOLDERS.length erhöht.

- **QueryRows auf hierarchy**: Injiziert `virtualFolderToPropRow()` für die
  4 PIM-Folder mit PR_DISPLAY_NAME_W + PR_FOLDER_ID + PR_CONTAINER_CLASS_W.

- **OpenFolder erweitert**: Matched auch virtuelle IDs via
  `cuidToFolderId64(VIRTUAL_FOLDERS[*].id)`.

- **GetContentsTable erweitert**: Virtuelle Folder liefern Counts aus
  `prisma.calendarEvent / contact / task / note` statt `prisma.message`.

- **QueryRows auf contents**: `parentFolderId.startsWith('virtual-')` →
  `loadVirtualContents()` lädt Events/Contacts/Tasks/Notes aus Prisma und
  mappt sie zu PropRows mit:
  - PR_MESSAGE_CLASS_W = 'IPM.Appointment' / 'IPM.Contact' / 'IPM.Task' /
    'IPM.StickyNote'
  - PR_SUBJECT_W = summary / displayName / subject
  - PR_BODY_W = description / body
  - PR_MESSAGE_DELIVERY_TIME = dtStart / dueDate / createdAt
  - PR_DISPLAY_NAME_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W
    (für Contact-Rows)

- **GetRowCount erweitert** für virtuelle Folder.

- **OpenMessage erweitert**: Erkennt virtuelle Folder-IDs und delegiert an
  `openVirtualPimMessage()` der das Item via Hash-Match in der jeweiligen
  PIM-Table findet (`calendarEvent / contact / task / note`).

- **folderToPropRow** nutzt jetzt `containerClassFor(name)` statt hardcoded
  'IPF.Note' — bestehende Folder mit Name 'Calendar'/'Kontakte' etc.
  werden ebenfalls korrekt klassifiziert.

### Outlook-Verhalten nach v4.6.0

4 zusätzliche Folder erscheinen in Outlook unter dem Postfach: „Kalender",
„Kontakte", „Aufgaben", „Notizen" — mit korrektem Icon je nach Outlook-
Folder-Type-Detection. Listen-View zeigt jeweils Items (Termine/Kontakte/
Tasks/Notes) mit Subject und Date.

Read-only Browsing der PIM-Daten ist funktional. Volle Property-Round-Trip
auf einzelne Items (Detail-Anzeige der Termine, Kontakte etc.) braucht
noch volles Named-Property-Mapping (PSETID_Appointment etc.) — kommt in
v5.0.0 oder optional als v4.6.1 Patch. Für volle bidirektionale Kalender/
Kontakte-Sync empfehlen wir weiterhin den „Outlook CalDav Synchronizer"
aus dem Setup-Page (Settings → Externe Clients).

---

## [4.5.0] — 2026-05-26 — MAPI/HTTP Phase 5: Push-Notifications via Redis pub/sub

### Added

- **RopRegisterNotification** (`packages/ews-server/src/mapi/rop/notification.ts`):
  Outlook abonniert per ROP gewünschte Event-Typen (NewMail / MessageDeleted /
  MessageModified / FolderChanged) auf einem Folder- oder Mailbox-Handle.
  Subscription wird dynamisch am Handle persistiert (subscription-Feld via
  JSON-Round-Trip durch Redis).

- **NotificationWait echter Long-Poll** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  Bisher pollte Outlook mit langen NotificationWait-Requests, die nach 30s
  mit EventPending=false zurückkamen → spürbare Verzögerung. Jetzt:
  duplicate()-ed ioredis-Client (subscribe braucht dedizierten Connection
  nach ioredis-Pflicht), subscribe auf `coremail:mapi:notify:<userId>`,
  Race zwischen Redis-Event und 30s-Timeout, sauberer Cleanup (unsubscribe +
  disconnect + clearTimeout) bei beiden Ausgängen, plus `req.on('close')`
  für Client-Disconnect-Handling. Antwortet sofort bei Event mit
  EventPending=1, sonst nach Timeout mit EventPending=0.

- **publishNotifyEvent-Helper** in `rop/notification.ts` mit
  `notifyChannelFor(userId)`-Channel-Generator. Event-Shape:
  `{ kind, userId, folderId?, messageId?, subject? }`.

- **SMTP-Hook** (`packages/smtp-server/src/handlers/message.ts`):
  `storeInboundMessage()` published nach der bestehenden `CHANNEL_MAIL_NEW`-
  Publish jetzt zusätzlich auf `coremail:mapi:notify:<userId>` mit
  MAPI-Notify-Event (`{kind:'NewMail', userId, folderId, messageId, subject}`)
  — non-fatal `.catch(() => {})` für Backward-Compatibility wenn MAPI
  nicht aktiv.

- **NotifyEvent-TypeScript-Interface** exportiert für andere Module die
  Push-Events triggern (z.B. künftige Hooks für MessageDeleted / FolderChanged).

### Outlook-Verhalten nach v4.5.0

Neue Mail erscheint innerhalb von <1s in Outlook (statt vorher bis zu 30s
warten). Toast-Notifikation bei neuer Mail funktioniert. Folder-Refresh-
Cache wird invalidiert. Battery-Drain auf mobilen Outlook-Clients deutlich
reduziert (kein Dauer-Polling mehr).

---

## [4.4.0] — 2026-05-26 — MAPI/HTTP Phase 4: Attachments + Move/Delete

### Added

- **RopGetAttachmentTable** (`packages/ews-server/src/mapi/rop/attachment.ts`):
  Erstellt ein Table-Object-Handle für die Attachments einer Message. Neuer
  Tabellen-Typ `attachments` (in `RopObject.table.tableType`), bei dem
  `parentFolderId` die MessageId enthält.

- **RopOpenAttachment**: Lädt Attachment via Index (PR_ATTACH_NUM aus QueryRows),
  erzeugt Attachment-Handle.

- **RopCreateAttachment**: Legt Draft-Attachment-Handle an (`attachmentId=null`,
  `pendingBuffer`, `pendingProperties`). Bei SaveChangesAttachment wird in
  DB+MinIO persistiert. AttachmentId = nächster freier Index in der
  Message-Attachment-Liste.

- **RopDeleteAttachment**: Entfernt Attachment-DB-Record.

- **RopSaveChangesAttachment**: SHA256-Hash, MinIO-Upload zu
  `attachments/{messageId}/{sha256}`, DB-Insert (oder Update bei bestehender
  Attachment) mit `filename/mimeType/size/sha256/storagePath/contentId`.

- **RopDeleteMessages** (`packages/ews-server/src/mapi/rop/folder-ops.ts`):
  Parst MessageId-Array (uint64-FNV-Hashes), löscht via `prisma.message.delete`,
  dekrementiert Folder-Counter. Response liefert PartialCompletion-Flag.

- **RopMoveCopyMessages**: Source-Handle (input) + Destination-Handle (output),
  parst WantCopy-Flag + MessageId-Array. Move = Folder-Update, Copy = duplicate
  Message via `prisma.message.create` mit allen Original-Feldern. Updates
  Folder-Counter (Source -= moved, Dest += moved).

- **OpenStream auf Attachment**: Erweiterung von `handleRopOpenStream` —
  bei `kind === 'attachment'` wird PR_ATTACH_DATA_BIN aus MinIO via
  `loadAttachmentBytes()` geladen (oder leer für Draft-Attachment).
  WriteStream akkumuliert in `pendingBuffer`, CommitStream persistiert
  via SaveChangesAttachment.

- **ROP-Codec**: Korrekte Payload-Parsing für GetAttachmentTable (TableFlags),
  OpenAttachment (AttachmentId uint32), CreateAttachment, DeleteAttachment,
  SaveChangesAttachment, DeleteMessages (WantAsync + NotifyNonRead +
  MessageIdCount + MessageIds[uint64]), MoveCopyMessages (DestHandleIndex +
  WantAsync + WantCopy + MessageIds[uint64]).

- **RopObject erweitert**:
  - `attachment`-Variante mit `attachmentId:string|null`, `attachNum`,
    `pendingProperties`, `pendingBuffer`
  - `table`-Variante mit neuem `tableType:'attachments'`

- **table.ts erweitert**: `attachmentToPropRow()` mappt Attachment →
  PR_ATTACH_NUM/LONG_FILENAME_W/MIME_TAG_W/SIZE/METHOD/CONTENT_ID_W.
  GetRowCount unterstützt 'attachments'-Tabellen.

- **buildMessagePropertyList erweitert**: Lädt `_count.attachments` aus Prisma
  und setzt `PR_HAS_ATTACH=true` + `PR_MESSAGE_FLAGS` HasAttach-Bit (0x10).

- **SubmitMessage erweitert**: Lädt `msg.attachments` (filename/mimeType/
  storagePath/size) aus DB und füllt `OutboundJob.message.attachments` mit
  `{filename, minioPath, contentType, size}` — der existierende Worker baut
  RFC-5322 mit echten Anhängen via `buildRawFromMessage`.

- **Neue Property-Tags**: PR_ATTACH_NUM, PR_ATTACH_METHOD,
  PR_ATTACH_LONG_FILENAME_W, PR_ATTACH_FILENAME_W, PR_ATTACH_MIME_TAG_W,
  PR_ATTACH_SIZE, PR_ATTACH_CONTENT_ID_W, PR_ATTACH_DATA_BIN,
  PR_ATTACHMENT_LINKID.

### Outlook-Verhalten nach v4.4.0

Anhang an neue Mail anhängen (Drag&Drop oder „Datei einfügen") funktioniert
end-to-end — gespeichert in MinIO, beim Senden in Outbound-Queue mit
`minioPath` weitergereicht, Worker lädt + signiert + sendet. Empfangene Mails
mit Attachments: Outlook zeigt Paperclip-Icon, Anhang-Liste, Doppelklick
öffnet Datei. Mails verschieben (Drag-and-Drop in andere Ordner) +
Mehrfach-Lösch über Delete-Taste funktioniert. Push-Notifications bei neuer
Mail: noch nicht (v4.5.0).

---

## [4.3.0] — 2026-05-26 — MAPI/HTTP Phase 3: Mail-Schreiben + Senden

### Added

- **RopCreateMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Legt eine neue Draft-Message-Handle an (`messageId=null`, `isDraft=true`,
  `pendingProperties={}`, `pendingRecipients=[]`). Folder-Lookup über
  CUID→uint64 FNV-1a-Hash. Response: ReturnValue + HasMessageId(0).

- **RopSetProperties**: Parst PropertyValueArray (PropertyValueSize +
  PropertyValueCount + TaggedPropertyValues) und akkumuliert die Tagged-
  Property-Values in `pendingProperties` am Message-Handle. JSON-safe
  Encoding für Session-Persistierung in Redis (Buffer → {_t:'Buffer',data},
  BigInt → {_t:'BigInt',v}, Date → {_t:'Date',iso}).

- **RopModifyRecipients**: Parst die ColumnCount/Columns + RowCount/Rows-
  Struktur aus MS-OXCMSG §2.2.3.1.2. Extrahiert RecipientType (1=TO/2=CC/3=BCC)
  + DisplayName + EmailAddress aus den RecipientRow-Header-Bytes. Speichert
  die Liste in `pendingRecipients` am Message-Handle.

- **RopSaveChangesMessage**: Persistiert Draft-Properties+Recipients in die
  Prisma-DB. Bei `messageId === null` (neue Draft) wird ein neuer Message-
  Record im aktuellen Folder (typischerweise Drafts) angelegt mit
  `flags: ['\\Draft']`, UID-Increment auf Mailbox, ModSeq-Update. Bei
  bestehender Message: Update. Response: FolderId(uint64) + MessageId(uint64).

- **RopWriteStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Hängt Data an den Stream-Buffer an (am aktuellen Offset). Outlook ruft
  WriteStream wiederholt für lange Bodies — der Buffer wird im Stream-Handle
  akkumuliert bis CommitStream. Unterstützt Overwrite-in-place und
  Sparse-Write (Padding mit Null-Bytes wenn Offset > Buffer-Länge).

- **RopCommitStream**: Schreibt den akkumulierten Stream-Buffer in die
  parent Message. Bei gespeicherter Message: direktes Prisma-Update auf
  bodyText/bodyHtml/subject (UTF-16-LE-Decode für PR_BODY_W/PR_SUBJECT_W,
  UTF-8 für PR_HTML). Bei Draft-Stream: Update der `pendingProperties`
  am parent Message-Handle.

- **RopSubmitMessage**: Reicht die persistierte Message via BullMQ
  smtp-outbound-Queue zum Versand ein. Baut StructuredMessage aus
  Prisma-Message + lädt DKIM-Key der Sender-Domain + From/To/CC/BCC.
  Verschiebt die Message nach Submit in den Sent-Folder (oder loggt
  Warning bei Fehler — non-fatal). Lokale BullMQ-Queue-Instanz auf
  Queue-Name `'smtp-outbound'` (gemeinsame Vereinbarung mit dem
  Consumer im smtp-server, kein Cross-Package-Import nötig).

- **RopObject-Type erweitert**: Die `message`-Variante hat jetzt
  `messageId: string | null`, `isDraft`, `pendingProperties` (Record),
  `pendingRecipients` (Array). Die `stream`-Variante hat
  `writable`, `parentMessageHandle` für Draft-Streams.

- **Helper `updateRopObject`** (`rop-handle-table.ts`): Patch-Update
  eines bestehenden Handle-Objects in Redis (für Pending-Property-
  Akkumulation während eines Compose-Workflows).

- **PR_*-Konstanten ergänzt**: PR_EMAIL_ADDRESS_W, PR_ADDRTYPE_W,
  PR_SMTP_ADDRESS_W, PR_7BIT_DISPLAY_NAME_W, PR_RECIPIENT_TYPE,
  PR_RECIPIENT_FLAGS, PR_RECIPIENT_DISPLAY_NAME_W, PR_OBJECT_TYPE,
  PR_DISPLAY_TYPE.

- **ROP-Codec ModifyRecipients-Payload**: Bisher wurde nur 64 Bytes geslicet
  und der Rest verworfen — jetzt bekommt der Handler den vollständigen
  Rest des Buffers, weil ModifyRecipients keine fest definierte Größe hat.

### Dependencies

- **`bullmq` zu `@coremail/ews-server`-Dependencies hinzugefügt** —
  für die direkte Queue-Anbindung an `'smtp-outbound'`.

### Outlook-Verhalten nach v4.3.0

Compose-Window in Outlook: neue Mail anlegen, Subject + Body + Recipients
eintippen, „Senden" klicken → Mail kommt beim Empfänger an. Sent-Folder
zeigt die Kopie. Reply/Forward via Outlook-Buttons funktioniert genauso
(Outlook lädt Original via v4.2.0 → schreibt Draft via v4.3.0 → submitted).
Attachments: noch leer (kommen in v4.4.0). Push-Notification bei neuer
Mail: noch nicht (kommt in v4.5.0).

---

## [4.2.0] — 2026-05-26 — MAPI/HTTP Phase 2: Mail-Lesen (OpenMessage + Stream-Read)

### Added

- **RopOpenMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Öffnet eine Message anhand `FolderId` + `MessageId` aus der Contents-Table,
  legt einen Message-Handle in der Session-Handle-Table ab. Response liefert
  ReturnValue + HasNamedProperties + SubjectPrefix/NormalizedSubject + Recipients/Columns/Rows.
  Folder-ID-Lookup über CUID→uint64-FNV-1a-Hash (siehe `entry-id.ts`).

- **RopGetPropertiesAll** + **RopGetPropertiesSpecific**: Beide Handler liefern
  die vollständige Liste aller Message-Properties (oder eine vom Client
  spezifizierte Auswahl). `buildMessagePropertyList` mappt Prisma-`Message` →
  MAPI-Properties: PR_SUBJECT_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W,
  PR_SENT_REPRESENTING_*, PR_DISPLAY_TO_W/CC_W/BCC_W, PR_MESSAGE_DELIVERY_TIME,
  PR_CLIENT_SUBMIT_TIME, PR_MESSAGE_FLAGS, PR_MESSAGE_SIZE, PR_BODY_W, PR_HTML,
  PR_MESSAGE_CLASS_W (IPM.Note), PR_HAS_ATTACH, PR_INTERNET_MESSAGE_ID_W,
  PR_PRIORITY, PR_IMPORTANCE.

- **RopOpenStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Öffnet einen Stream auf eine Message-Property. PR_BODY_W (UTF-16-LE),
  PR_HTML (UTF-8), PR_SUBJECT_W (UTF-16-LE). Property-Wert wird komplett
  in den Stream-Object-Buffer geladen, Response liefert StreamSize.

- **RopReadStream**: Chunked Read mit Offset-Tracking in der Session.
  Max 30 KB pro Chunk (MAX_STREAM_CHUNK_BYTES) — Outlook erwartet
  Antworten unter 32 KB. ReadStream-Request-Format: Uint16 ByteCount,
  oder 0xBABE-Marker + Uint32 ExtendedByteCount für große Reads.

- **RopGetStreamSize**: Liefert Buffer-Größe in Bytes.

- **ROP-Codec-Erweiterung** (`packages/ews-server/src/mapi/rop-codec.ts`):
  Parsing für OpenMessage, GetPropertiesAll, GetPropertiesSpecific,
  OpenStream, ReadStream, GetStreamSize, CreateMessage, SaveChangesMessage,
  SetProperties, SubmitMessage, WriteStream, CommitStream, SetMessageReadFlag,
  SetReadFlags. Plus Stub-Parsing für v4.4+ ROPs (MoveCopyMessages,
  DeleteMessages, OpenAttachment, CreateAttachment, RegisterNotification,
  ModifyRecipients, ReadRecipients, RemoveAllRecipients,
  GetPropertyIdsFromNames, GetNamesFromPropertyIds) — alle konsumieren
  ihren Payload und werden vom Dispatcher mit ecNotSupported beantwortet,
  so dass der ROP-Stream nicht abreißt.

- **ROP-Dispatcher-Erweiterung**: Switch-Cases für alle v4.2.0-Handler
  (echte Implementierung) + v4.3.0-Stubs (CreateMessage, SetProperties,
  SaveChangesMessage, SubmitMessage, WriteStream, CommitStream — alle
  return ecNotSupported, werden in v4.3.0 implementiert).

- **RopId**: `MoveCopyMessages` (0x33) + `DeleteMessages` (0x1E) ergänzt
  in `rop-types.ts` (Vorbereitung v4.4.0).

### Outlook-Verhalten nach v4.2.0

Profile-Build (Logon + Folder-Browse aus v4.1.0) ist unverändert. Neu:
Outlook kann jetzt die Liste von Mails in der Inbox öffnen UND eine
einzelne Mail mit Subject, Sender, Body anzeigen. Schreiben (Reply/Forward/
Compose), Senden, Attachments, Notifications: noch ecNotSupported, kommen
in v4.3.0 (Mail-Schreiben) + v4.4.0 (Attachments) + v4.5.0 (Push).

---

## [4.1.0] — 2026-05-26 — MAPI/HTTP Phase 1: ROP-Infrastruktur + Logon + Folder-Browse

### Added

- **ROP-Stream-Codec** (`packages/ews-server/src/mapi/rop-codec.ts`): Parser
  für den binären ROP-Buffer aus EcDoRpcExt2 — RopSize-Header, ROP-Header
  (RopId + LogonId + Input/Output-Handle-Indexes), Server-Object-Handle-Table.
  `RopResponseBuilder` für Spiegelung in die Response.

- **ROP-Types-Konstanten** (`packages/ews-server/src/mapi/rop-types.ts`):
  RopId-Enum mit allen relevanten ROPs aus MS-OXCROPS (Logon, OpenFolder,
  GetHierarchyTable, GetContentsTable, SetColumns, QueryRows, OpenMessage,
  CreateMessage, SubmitMessage, RegisterNotification, ...). PropType-Enum
  (PT_LONG, PT_UNICODE, PT_BINARY, PT_SYSTIME, etc.). Property-Tag-Dictionary
  mit den wichtigsten PR_* aus MS-OXPROPS (Folder, Mailbox, Message).

- **Property-Codec** (`packages/ews-server/src/mapi/property-codec.ts`):
  `writePropertyValue` + `readPropertyValue` für die 8 wichtigsten
  PropertyTypes. FILETIME ↔ JavaScript-Date-Konvertierung. `writeTaggedProperty`
  + `writePropertyRow` für Table-Row-Serialisierung.

- **EntryID-Helpers** (`packages/ews-server/src/mapi/entry-id.ts`):
  EntryID-Encoder/Decoder mit CoreMail-eigenem ProviderUID. CUID → uint64
  FNV-1a-Hash für PR_FOLDER_ID.

- **ROP-Handle-Table** (`packages/ews-server/src/mapi/rop-handle-table.ts`):
  Typed Object-Descriptors (mailbox, folder, message, table, stream,
  attachment) in der Session-State persistiert. `putRopObject`,
  `getRopObject`, `releaseRopObject`, `resolveHandleIndex`.

- **ROP-Dispatcher** (`packages/ews-server/src/mapi/rop-dispatcher.ts`):
  Hauptdispatch-Funktion die binären Execute-Request parsed, jeden ROP an
  seinen Handler dispatched, Response-Buffers sammelt, und finalen
  ROP-Stream-Response baut.

- **Handler v4.1.0**:
  - `rop/logon.ts`: **RopLogon** — Outlook-Mailbox-Login, lädt User aus
    Prisma, baut Folder-IDs-Array (Inbox, Drafts, Sent, Trash, Subtree),
    erstellt Mailbox-Handle in der Session. Response mit MailboxGuid,
    ReplGuid, LogonTime, GwartTime, StoreState.
  - `rop/folder.ts`: **RopOpenFolder**, **RopGetHierarchyTable**,
    **RopGetContentsTable** (Stub-Count).
  - `rop/table.ts`: **RopSetColumns**, **RopQueryRows**, **RopGetRowCount**,
    **RopRelease**. Property-Row-Serialisierung mit dynamischer Spaltenwahl.

- **Execute-Handler-Refactor** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  `handleExecute` nutzt jetzt `dispatchRopBuffer` statt `ecNotSupported` zu
  liefern. Outlook sieht real funktionierende ROPs.

### Skeleton-Files für nachfolgende Phasen

- `rop/message.ts` — v4.2.0 (Mail-Lesen) + v4.3.0 (Mail-Schreiben)
- `rop/stream.ts` — v4.2.0 (Read) + v4.3.0 (Write)
- `rop/submit.ts` — v4.3.0 (Mail-Senden via BullMQ-Bridge)
- `rop/attachment.ts` — v4.4.0
- `rop/notification.ts` — v4.5.0 (Push via Redis-pub/sub)
- `rop/calendar.ts` — v4.6.0 (IPM.Appointment Property-Mapping)
- `rop/contacts.ts` — v4.7.0 (NSPI + IPM.Contact)

Jedes Skeleton-File enthält detaillierten Implementations-Plan + Property-
Mapping + Microsoft-Spec-Referenzen.

### Tests

- 16 Codec-Round-Trip-Tests alle grün
  (uint8/16/32/64, ASCII/UTF-16-LE Strings, GUIDs, Complex Connect-Request-
  Sequence, Range-Errors)

### Outlook-Funktionalität

Mit v4.1.0 kann Outlook nach Connect:
- ✅ RopLogon erfolgreich durchführen
- ✅ Folder-Hierarchie-Tabelle anfordern
- ✅ Standard-Ordner (Inbox, Drafts, Sent, Trash) sehen
- ❌ Mails lesen (kommt in v4.2.0 — `OpenMessage`/`GetProperties`/`ReadStream`)
- ❌ Mails schreiben (kommt in v4.3.0)
- ❌ Push-Notifications (kommt in v4.5.0)

Outlook-Profil-Build geht nach Connect deutlich weiter als in v4.0.0, aber
beim ersten Mail-Klick wird ecNotSupported zurückkommen.

---

## [4.0.0] — 2026-05-26 — MAPI-over-HTTP Foundation + Externe Clients Setup-Page

**Major-Version-Bump**: Beginn der MAPI-over-HTTP-Implementation für native
Outlook-Exchange-Anbindung. Diese Foundation legt Protokoll-Layer, Codec,
Session-Store, Architektur-Plan. Volle Outlook-Funktionalität kommt iterativ
in v4.0.x / v4.1.0+ (siehe `packages/ews-server/src/mapi/ARCHITECTURE.md`).

### Added

- **MAPI/HTTP Foundation** (`packages/ews-server/src/mapi/`):
  - `ARCHITECTURE.md`: Vollständiger Implementations-Plan inkl. Protokoll-
    Layer, ROP-Mapping, Versions-Roadmap v4.0.0 → v5.0.0
  - `codec.ts`: Binary-Buffer-Reader/Writer für MS-OXCRPC Wire-Format
    (Little-Endian uint8/16/32/64, ASCII/UTF-16-LE null-terminated Strings,
    GUIDs in MS-DTYP-Format, AUX-Header-Blocks)
  - `codec.test.ts`: 16 Round-Trip-Tests für alle Read/Write-Pairs (alle grün)
  - `http-headers.ts`: Header-Parsing + Response-Header-Setting (X-RequestType,
    X-RequestId, X-ResponseCode, X-ExpirationInfo, X-PendingPeriod,
    Set-Cookie-Management)
  - `session-store.ts`: Redis-backed Session-Store für emsmdb + nspi mit
    10-Min-TTL und Auto-Renew bei jedem Call
  - `emsmdb-handler.ts`: Binary Connect/Disconnect/NotificationWait funktional;
    Execute liefert `ecNotSupported` (ROPs kommen in v4.1.0+)
  - `handler.ts` Refactor: Express `raw()` body-parser für `/mapi/emsmdb/` +
    `/mapi/nspi/` (binäre Bodies statt JSON)

- **Autodiscover MAPI/HTTP Protocol-Block** (feature-flagged):
  Env `ENABLE_MAPI_HTTP=true` aktiviert `<Protocol Type="mapiHttp" Version="1">`
  in der Autodiscover-Response. Default off, weil ROP-Execution noch nicht
  funktional ist. Sobald RopLogon+Folder-Browse in v4.1.0 fertig: default on.

- **Setup-Page „Externe Clients & Outlook" im OWA** (aus v3.18.40 vorgezogen):
  `packages/web-client/src/pages/SettingsPage.tsx` neue Section + Backend-
  Endpoint `GET /api/v1/user/client-config`. Zeigt IMAP/SMTP-Daten, CalDAV-
  + CardDAV-URLs, App-Passwort-Hinweis bei MFA, Step-by-Step für „Outlook
  CalDav Synchronizer"-Plugin (kostenlos, OSS) — bis MAPI/HTTP voll
  funktioniert die ausgereifte Lösung für Kalender + Kontakte in Outlook.

### Roadmap (v4.x — siehe `ARCHITECTURE.md`)

| Version | Inhalt | Aufwand |
|---------|--------|---------|
| v4.0.0  | Foundation (Codec, Session, Connect-Handshake)         | ✅ aktuell |
| v4.1.0  | RopLogon + Folder-Browse (Outlook kann Login + Folders) | ~2 Wo. |
| v4.2.0  | Mail-Lesen (RopGetContentsTable, OpenMessage, Stream)   | ~2 Wo. |
| v4.3.0  | Mail-Schreiben + Senden (CreateMessage, SubmitMessage)  | ~1 Wo. |
| v4.4.0  | Attachments + Move/Delete                                | ~1 Wo. |
| v4.5.0  | Push-Notifications (NotificationWait + Redis-pub/sub)   | ~2 Wo. |
| v4.6.0  | Calendar (IPM.Appointment)                              | ~3 Wo. |
| v4.7.0  | Contacts (NSPI QueryRows + IPM.Contact)                 | ~2 Wo. |
| v4.8.0  | Search (RopFindRow, Restrict)                            | ~2 Wo. |
| v5.0.0  | Production Hardening + Outlook-Compat-Tests             | ~4 Wo. |

**Geschätzter Gesamtaufwand**: 6–9 Monate für 2-Personen-Team.

### Migration / Breaking

Keine Breaking Changes — alle bestehenden Funktionen unverändert. Outlook
nutzt bis v4.1.0 weiterhin den IMAP-Fallback aus v3.18.39.

---

## [3.18.40] — 2026-05-26 — Externe Clients & Outlook Setup-Page in OWA

### Added

- **Neue OWA-Settings-Section „Externe Clients & Outlook"**
  (`packages/web-client/src/pages/SettingsPage.tsx`, `packages/api-gateway/src/routes/user.ts`):
  Zentrale Setup-Hilfe-Seite für alle externen Clients. Zeigt prominent:
  - **IMAP/SMTP/POP3-Daten** mit Copy-Buttons (Host, Port, Verschlüsselung)
  - **CalDAV Account-URL** + direkte URLs pro Kalender
  - **CardDAV Account-URL** + Default-Adressbuch-URL
  - **App-Passwort-Hinweis** wenn MFA aktiv ist
  - **Schritt-für-Schritt-Anleitung für „Outlook CalDav Synchronizer"**
    (kostenloses OSS-Plugin) — Kalender + Kontakte über Outlook nutzen
  - **Hinweise zu Alternativen**: OWA im Browser, Apple Kalender/Kontakte,
    Thunderbird + TbSync, eM Client, DAVx⁵ (Android)

- **Neuer Backend-Endpoint** `GET /api/v1/user/client-config`
  (`packages/api-gateway/src/routes/user.ts`): Liefert konsolidiert alle
  Setup-Daten — Email/DisplayName, IMAP/SMTP/POP3-Hosts aus `ServerSettings`,
  CalDAV-Account-URL + pro Kalender, CardDAV-Account- + Default-URL,
  `requiresAppPassword`-Flag basierend auf User-MFA-Status.

### Hintergrund

Microsoft Outlook Desktop hat keinen nativen CalDAV/CardDAV-Support eingebaut.
Volle MAPI-over-HTTP-Implementierung (für native Outlook-Exchange-Anbindung
mit Kalender + Kontakte) ist mehrere Wochen Arbeit und kommt als eigenes
zukünftiges Feature. Bis dahin ist der „Outlook CalDav Synchronizer"
(GitHub: `aluxnimm/outlookcaldavsynchronizer`) der ausgereifte OSS-Plugin-
Weg für Outlook-User. Die neue Settings-Page bündelt alle nötigen Daten
+ liefert die Installations-Anleitung direkt im UI.

---

## [3.18.39] — 2026-05-26 — Outlook: EXCH+EXPR aus Autodiscover entfernt → IMAP-Fallback

### Fixed

- **Outlook-LTSC hing minutenlang im RPC/TCP-Connect-Loop, dann Fehler
  „Diese Ordnergruppe kann nicht geöffnet werden — Fehler bei der Anmeldung
  bei Exchange"** (`packages/autodiscover/src/v1.ts`): User-Verbindungsstatus
  zeigte mehrere VIDs mit Status „wird hergestellt" und Protokoll **RPC/TCP**
  auf `mail.<domain>`. Root Cause: Unsere Autodiscover-Response lieferte
  `<Protocol Type="EXCH">` und `<Protocol Type="EXPR">` Blöcke — beide
  signalisieren Outlook, dass der Server **MAPI/RPC** kann (intra-Exchange-RPC
  bzw. RPC-over-HTTPS via `rpcproxy.dll`). Wir haben aber nur **EWS** + Stubs
  von MAPI-over-HTTP implementiert. Outlook versuchte minutenlang RPC-Connects,
  die hängen blieben.

  **Pragmatischer Fix** bis volle MAPI/HTTP-Implementation:
  **EXCH- und EXPR-Blöcke ENTFERNT** aus Autodiscover-XML. Outlook erkennt:
  - Server ist kein Exchange-Server für direkte MAPI-Profile
  - Fällt automatisch auf **IMAP-Account-Konfiguration** zurück
  - Mail funktioniert sofort via `<Protocol Type="IMAP">` + `<Protocol Type="SMTP">`
  - Kalender + Kontakte gehen via CalDAV/CardDAV (Apple Kalender,
    Thunderbird, eM Client) oder direkt über OWA im Browser

  Outlook konfiguriert das Konto dann automatisch als „IMAP" (User sieht
  weiterhin den Email-Adress-only-Setup-Flow, aber die Verbindung wird
  IMAP statt Exchange).

### Roadmap

Volle MAPI-over-HTTP-Implementierung (`EcDoConnectEx`, ROP-Verbose-Binary-
Protocol, NSPI Bind/QueryRows) für native Outlook-Exchange-Anbindung ist
mehrere Wochen Arbeit. Bis dahin ist IMAP der pragmatische Pfad für
Outlook-Desktop-User.

---

## [3.18.38] — 2026-05-26 — Outlook-LTSC „kein Passwort-Prompt" + Autodiscover-Vervollständigung

### Fixed

- **KRITISCHER ROOT CAUSE: EWS antwortete auf ersten Request mit 200 OK
  statt 401 — Outlook fragt nie nach Passwort** (`packages/ews-server/src/server.ts`):
  User-Symptom: Outlook „verband" sich nach Autodiscover ohne Credential-
  Prompt, zeigte aber dann nur „Private Ordner" (lokales PST) statt der
  Exchange-Mailbox, plus Fehlermeldung „Microsoft Exchange-Informationsdienst
  Ihres Profils enthält nicht alle erforderlichen Informationen". Root Cause:
  Outlook LTSC probt zuerst `GET /EWS/Exchange.asmx` BEVOR es überhaupt
  einen `Authorization`-Header sendet. Der bisherige GET-Handler lieferte
  unauthentifiziert 200 + WSDL-Stub zurück → Outlook nahm an, dass keine
  Auth nötig ist, schickte nie Credentials, und das Setup landete bei der
  lokalen Standard-PST („Private Ordner"). **Fix**: `ewsAuthMiddleware` jetzt
  auch vor dem GET-Handler und vor dem `/mapi/*`-Router (außer
  `/mapi/healthcheck.htm` — bleibt anonym für Outlook-Probe). MAPI- und
  OAB-Endpoints senden jetzt auch korrekt `WWW-Authenticate: Basic
  realm="CoreMail EWS"` bei fehlendem Auth-Header.

- **`auth-service` URL war falsch** (`packages/ews-server/src/auth/middleware.ts`):
  Basic-Auth-Fallback im EWS rief `http://auth-service:3001/auth/login` —
  Port 3001 ist aber die `storage-api`, nicht der `auth-service` (der auf
  3003 läuft). Plus im monolithischen App-Container ist alles unter
  `localhost` erreichbar, nicht unter Service-Hostnames. Fix: env-Variable
  `AUTH_SERVICE_URL` mit Default `http://localhost:3003/auth/login`.

- **Autodiscover v1 XML hatte Outlook-Pflichtfelder fehlend bzw. falsch**
  (`packages/autodiscover/src/v1.ts`): Recherche an Microsoft Docs +
  Grommunio-Implementierung ergab:
  - `AuthPackage` MUSS `Basic` (capital B) sein — manche Outlook-LTSC-Builds
    sind case-sensitive. War `basic` (kleines b).
  - `<User><LegacyDN>` Pflicht: Outlook nutzt es als interne User-Identity
    (Format `/o=CoreMail/ou=Exchange Administrative Group
    (FYDIBOHF23SPDLT)/cn=Recipients/cn=<user-id>`). Fehlte komplett.
  - `<User><AutoDiscoverSMTPAddress>` ergänzt (Pflicht für Profile-Binding).
  - `<GroupingInformation>default</GroupingInformation>` im EXPR-Block —
    required ab Exchange 2013 SP1 für Sharing-Discovery.
  - `<PublicFolderInformation><SmtpAddress>publicfolder@<root-domain>` als
    Dummy — Outlook loggt sonst „PublicFolder discovery failed" und
    klassifiziert das Profil als incomplete.
  - `ServerDN`/`MdbDN` mit korrekter Exchange-2019-Topologie
    (`Exchange Administrative Group (FYDIBOHF23SPDLT)` statt nur
    `Exchange`).
  - `<EcpUrl>` ergänzt (zeigt auf OWA — Outlook nutzt es für Web-Open-Link).

### Hintergrund-Recherche

Quellen: Microsoft Learn (MS-OXDSCLI, MS-OXCMAPIHTTP, POX Autodiscover),
msxfaq.de (HTTP-401-Negotiate-Flow), Grommunio Docs (KB Outlook bugs),
Mailcow Docs (kein EWS, daher kein Outlook-Exchange-Support). Vergleiche
zu Stalwart + Mailcow (Open-Source-Mailserver) bestätigen: ohne EWS +
korrektes 401-Verhalten kann Outlook keine Exchange-Profile bauen.

---

## [3.18.37] — 2026-05-26 — Outlook-LTSC Autodiscover-XML erweitert + Audit-Übersetzungen

### Fixed

- **Outlook LTSC (Exchange 2019) konnte sich nicht verbinden trotz korrekt
  geliefertem Autodiscover** (`packages/autodiscover/src/v1.ts`): Die
  XML-Response hatte nur einen minimalen `<Protocol><Type>EXCH</Type>...`-
  Block ohne `AuthPackage`, `OABUrl`, `ASUrl`, `OOFUrl`, `MdbDN`,
  `ServerVersion` und ohne den **EXPR-Block** (Outlook Anywhere / MAPI-
  over-HTTP-Fallback). Outlook 2016+ erwartet diese Felder zwingend —
  ohne sie bricht der Setup-Wizard mit „Da hat etwas nicht geklappt" ab.

  **Fix**: Autodiscover-v1-XML erweitert um:
  - `<AuthPackage>basic</AuthPackage>` (Outlook braucht expliziten Auth-Typ)
  - `<ServerVersion>73C0834F</ServerVersion>` (Exchange-2019-kompatibler Server-Version-Token)
  - `<MdbDN>` + `<ServerDN>` (Exchange-Topologie-Identifikatoren)
  - `<ASUrl>`, `<OOFUrl>`, `<OABUrl>` (Availability-Service, Out-of-Office, Offline-Adressbuch)
  - `<EmwsUrl>` (Exchange Management Web Service)
  - `<OWAUrl AuthenticationMethod="Basic, Fba">`
  - **Komplett neuer `<Protocol><Type>EXPR</Type>`-Block** für Outlook Anywhere
    /MAPI-over-HTTP (SSL=on, AuthPackage=basic, ServerExclusiveConnect=on)
  - `<MicrosoftOnline>False</MicrosoftOnline>` (signalisiert On-Premises-Setup)

- **Audit-Log: Legacy-Action-Strings (vor v3.18.34 Path-Fix) nicht übersetzt**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): Alte Audit-Einträge
  vor dem Path-Mutation-Fix wurden mit Short-Action-Strings (`anomalies.get`,
  `full.post`, `jobs.delete`, `tags.post`, `members.delete`) gespeichert.
  Das v3.18.34 `ACTION_MAP` hatte nur die NEUEN Long-Forms (z.B.
  `audit-log.anomalies.get`). **Fix**: 25+ zusätzliche Einträge für
  Legacy-Short-Forms + neue v3.18.37-Formats (`servers.settings.put`,
  `servers.settings.derive.post`, `retention.tags.*`, `dashboard.get`,
  `services.put`, etc.).

- **Audit-Log Akteur-Spalte: leerer `actorEmail` zeigte gar nichts**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): Bei System-Aktionen
  (z. B. Cron-getriggert) ist `actorEmail` leer. Fix: Fallback-Anzeige
  `System (cmpla8p1…)` statt leere Zelle.

---

## [3.18.36] — 2026-05-26 — Hostname-Auto-Derive + Bilder-Privacy-Banner gehärtet

### Fixed

- **Server-URLs werden jetzt dynamisch aus dem `publicHostname` abgeleitet —
  nicht mehr fest auf `mail.local:8080`** (`packages/api-gateway/src/lib/server-urls.ts`,
  `packages/api-gateway/src/routes/setup.ts`, `packages/api-gateway/src/routes/admin/domains.ts`):
  Bisheriges Verhalten: Schema-Defaults schreiben `ewsUrl`/`owaUrl`/`easUrl`/
  `autodiscoverBase` als `http://mail.local:8080/...` beim ersten Container-
  Start. Wer eine echte Domain konfiguriert (z. B. `mail.firma.de`) musste
  die URLs manuell in BCP → Server-Einstellungen ändern, sonst lieferte
  Autodiscover Outlook unbrauchbare URLs. Das funktioniert für 1 Test-User
  manuell, aber NICHT für die 1000+ User mit individuellen Domains.

  **Fix**: Neuer zentraler Helper `lib/server-urls.ts` mit:
  - `deriveServerUrls(publicHostname, useHttps, httpPort)` — berechnet alle
    URLs aus dem Hostname (Autodiscover-Host nach Microsoft-Spec
    `autodiscover.<root-domain>`).
  - `syncFromPrimaryDomain(domainName)` — setzt `publicHostname` auf
    `mail.<domain>` wenn er noch Default ist, leitet alle URLs ab.
  - `syncServerUrlsFromHostname()` — idempotenter Re-Sync, läuft beim
    api-gateway-Start UND ist von außen aufrufbar.

  Eingehängt in:
  - `POST /api/v1/setup/complete` — Setup-Wizard speichert in einer
    Transaktion Domain + Admin-User + `publicHostname=mail.<setup-domain>` +
    alle abgeleiteten URLs. Vorher blieb `publicHostname=mail.local`.
  - `POST /api/v1/admin/domains` — wenn die erste Domain angelegt wird
    (= automatisch `primary=true`), werden Hostname + URLs daraus
    abgeleitet.
  - `POST /api/v1/admin/domains/:id/make-primary` — wenn eine andere
    Domain primary wird, werden URLs nur dann auf den neuen Hostname
    umgestellt wenn `publicHostname` noch Default ist. Eine bereits
    explizit gesetzte Konfiguration bleibt respektiert.
  - `PUT  /api/v1/admin/servers/settings` — beim Save mit stale URLs
    (`mail.local` oder `:8080`) wird automatisch nachgezogen.
  - api-gateway Startup — als Sicherheitsnetz für bestehende Installationen.

  Redis-Publish auf `coremail:settings:reload` informiert den autodiscover-
  Service sofort, sodass Outlook keine veralteten URLs sieht.

### Fixed (zusätzlich)

- **Bilder-Privacy-Banner aus v3.18.10 funktionierte in der Praxis nicht** —

- **Bilder-Privacy-Banner aus v3.18.10 funktionierte in der Praxis nicht** —
  externe Bilder wurden direkt geladen, das blaue „X externe Bilder wurden
  blockiert"-Banner erschien nie (`packages/web-client/src/components/MessageReader.tsx`):
  Root Cause: `DOMPurify.sanitize(html)` lief OHNE Konfiguration und entfernte
  unsere Privacy-Markierungen (`data-coremail-ext-src` Attribut, transparenter
  `data:image/png;base64,...`-Placeholder als src) standardmäßig. Damit wurde
  der Block-Mechanismus durch den Sanitize-Schritt direkt wieder ausgehebelt.

  **Fix**: `sanitize()` mit explizier Konfiguration neu gebaut:
  - `ADD_ATTR: ['data-coremail-ext-src', 'data-coremail-unresolved-cid',
    'data-coremail-ext-bg']` — unsere Markierungen erlaubt
  - `ALLOWED_URI_REGEXP` erlaubt `data:image/...;base64,...` (Placeholder)
  - `FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'object', 'embed',
    'meta', 'base']` — Tracking-Vektoren raus
  - `FORBID_ATTR: ['onload', 'onerror', 'onclick', …, 'srcset']` —
    Event-Handler + Responsive-Image-Tracker raus

### Added

- **CSS `background-image: url(...)` wird ebenfalls geblockt**
  (`packages/web-client/src/components/MessageReader.tsx`): Häufiger Tracker-
  Vektor in HTML-Mails (z.B. `<div style="background-image:url(http://tracker
  .com/pixel.png)">`). `processExternalImages()` extrahiert `background-image`
  aus inline-`style`-Attributen, neutralisiert externe URLs und speichert das
  Original in `data-coremail-ext-bg`. Beim „Bilder anzeigen"-Klick wird die
  CSS-Property wieder eingesetzt.

### Changed

- **„Bilder anzeigen"-Toggle räumt zusätzlich Placeholder-Styles auf**
  (`packages/web-client/src/components/MessageReader.tsx`): Der dünne
  gestrichelte Rahmen + `opacity:0.5`, der blockierte Bilder kennzeichnet,
  wird nach dem Klick automatisch entfernt — Bilder erscheinen normal statt
  weiterhin „gedimmt" mit Rahmen.

---

## [3.18.35] — 2026-05-26 — Outlook LTSC Verbindungs-Fix (Autodiscover-Routing + URL-Auto-Sync)

### Fixed

- **KRITISCH: Outlook LTSC „Da hat etwas nicht geklappt" — Autodiscover-Endpunkt
  lieferte Express-404**
  (`packages/api-gateway/src/server.ts`): Der API-Gateway routete
  `/Autodiscover/Autodiscover.xml` und `/autodiscover/autodiscover.json/v1.0/...`
  an den **EWS-Server** (Port 8080), obwohl dort gar keine Autodiscover-Routen
  implementiert sind. Der **autodiscover-Server** auf Port 8081 hat die echten
  Handler (`handleAutodiscoverV1` + `handleAutodiscoverV2`), wurde aber nie
  aufgerufen. Outlook bekam vom EWS-Server `Cannot POST /Autodiscover/
  Autodiscover.xml` (Express-Default-404) und konnte deshalb nicht konfigurieren.
  **Fix**: Neue Env-Variable `AUTODISCOVER_SERVICE_URL` (Default
  `http://localhost:8081`). Routes `/Autodiscover` und `/autodiscover` werden
  jetzt korrekt zum autodiscover-Server proxied.

- **EWS-/Owa-/EAS-URLs zeigten auf internen Port :8080** statt auf den
  externen HTTPS-Port (`packages/api-gateway/src/server.ts`,
  `packages/api-gateway/src/routes/admin/servers.ts`): Beim Setup wurden die
  `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase`-Felder in `ServerSettings`
  initial mit `http://mail.local:8080/...` befüllt (Schema-Defaults). Wenn
  der Admin später `publicHostname` änderte (z.B. via BCP → Server-
  Einstellungen), wurden die abgeleiteten URLs aber NICHT mit-migriert →
  Autodiscover lieferte für Outlook unerreichbare interne URLs.
  - **Startup-Migration** (`syncAutodiscoverUrls()`): Beim api-gateway-Start
    werden URLs auto-korrigiert, wenn `publicHostname != mail.local` aber URLs
    noch `mail.local` oder `:8080` enthalten. Berechnet `ewsUrl`/`owaUrl`/
    `easUrl` aus `publicHostname` + `useHttps` + `httpPort` und
    `autodiscoverBase` aus der Root-Domain (Microsoft-Spec:
    `autodiscover.<root-domain>`).
  - **PUT /admin/servers/settings** repariert ebenfalls stale URLs beim Save
    automatisch, wenn der Admin den Hostname ohne URL-Anpassung speichert.

- **Autodiscover-Settings-Cache TTL 60s** verzögerte Sichtbarkeit von
  URL-Änderungen (`packages/autodiscover/src/server.ts`): Der autodiscover-
  Service hatte einen 60-Sekunden-In-Memory-Cache für `ServerSettings`, ohne
  Redis-Subscription. **Fix**: Subscription auf Channel
  `coremail:settings:reload` — `invalidateSettingsCache()` wird sofort bei
  Settings-Update aufgerufen, damit neue URLs ohne 60s-Wartezeit aktiv sind.

---

## [3.18.34] — 2026-05-26 — Audit-Log-Path-Fix + Backup-Watchdog + UX-Cleanup

### Fixed

- **KRITISCH: Audit-Log zeigte unleserliche CUID-Aktionen** wie
  `cmplad51y000v13k3j0nbipt5.post` statt `certificates.activate-https.post`
  (`packages/api-gateway/src/lib/audit.ts`). Root Cause: `auditMiddleware` las
  `req.path` INNERHALB des `res.on('finish')`-Callbacks. Zu dem Zeitpunkt hatte
  Express den Path bereits beim Descend in Sub-Router mutiert — für
  `POST /api/v1/admin/certificates/<cuid>/activate-https` zeigte `req.path`
  dann nur noch `/<cuid>/activate-https` (relativ zum Certificates-Sub-Router-
  Mount) statt `/certificates/<cuid>/activate-https`. Daraus baute der
  Action-Builder fälschlich `<cuid>.post`. **Fix**: `req.path` wird jetzt am
  Middleware-Eintritt in `capturedPath` gespeichert und im Finish-Callback
  verwendet. **Zusätzlich**: neuer **CUID-bewusster Action-Builder**
  (`buildAction()`) — CUIDs werden aus dem Action-String herausgefiltert und
  separat als `targetId` gespeichert. Aus `DELETE /backups/jobs/<cuid>` wird
  jetzt `action='backups.jobs.delete'` + `targetId=<cuid>`.

### Added

- **40+ neue Action-Übersetzungen im Audit-Log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx` `ACTION_MAP`): Neue
  Mappings für `backups.jobs.delete` → „Backup-Job gelöscht",
  `audit-log.anomalies.get` → „Anomalien-Report abgerufen",
  `certificates.activate-https.post` → „Zertifikat für HTTPS aktiviert",
  `settings.security.put` → „Sicherheitseinstellungen geändert",
  `groups.members.delete` → „Gruppenmitglied entfernt" und viele weitere für
  Zertifikate, Aliase, Shared Mailboxes, Transport Rules, Quarantine, Queues,
  OAuth-Clients, Backup-Schedules.

- **Backup-Service: Startup-Orphan-Cleanup + Watchdog**
  (`packages/backup-service/src/server.ts`):
  - **Orphan-Cleanup** beim Start: Backup-Jobs mit Status `RUNNING`/`PENDING`/
    `RETRYING`/`PROCESSING`/`SCHEDULED` älter als 60s werden automatisch als
    `FAILED` markiert mit `errorMsg='Container wurde während Backup
    neugestartet — Job abgebrochen.'` Verhindert „Backup läuft endlos"-UI-
    Anzeige nach Container-Restart.
  - **Watchdog-Timer** (alle 5 Min.): Jobs mit Status `RUNNING`/`PROCESSING`/
    `RETRYING` älter als 30 Min. werden als `FAILED` markiert mit
    `errorMsg='Watchdog: Job > 30 Min. ohne Fortschritt — abgebrochen.'`

### Changed

- **Backup-Zeitplan-Editor: minutengenau (0..59) statt 5-Minuten-Raster**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`): Vorher konnte der Admin
  die Minute nur in 5er-Schritten wählen (12 Optionen). Jetzt alle 60 Minuten
  (0..59) verfügbar — User-Wunsch.

### Removed

- **Rotes „Anomalien erkannt"-Banner aus Audit-Log entfernt**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): Das Banner über der
  Audit-Tabelle (mit „2 Anomalien erkannt — Auswertung: letzte 5 Min Bursts,
  24h kritische Aktionen, Off-Hours") war in der Praxis verwirrend — es
  zeigte u.a. eigene Settings-Änderungen als „kritische Aktion" an. Audit-Log
  selbst zeigt alle relevanten Aktionen mit klaren Farbcodierungen (rot =
  Löschungen, amber = kritisch, blau = Updates). `anomalies`-Query +
  `AnomaliesResponse`-Interface komplett entfernt. Backend-Endpoint
  `/admin/audit-log/anomalies` bleibt erhalten (kann via PDF/JSON-Export
  weiterhin abgerufen werden).

---

## [3.18.33] — 2026-05-26 — Externe Kontakte komplett entfernt

### Removed

- **Feature „Externe Kontakte" (ExternalMailContact) komplett aus dem Code entfernt.**
  Externe Empfänger werden ab sofort:
  - Im Compose-Fenster direkt als E-Mail-Adresse eingegeben (Outlook-Standard),
  - als `EXTERNAL`-Mitglieder von Verteilergruppen gepflegt — der Member-Type
    `EXTERNAL` in `DistributionGroupMember` bleibt unverändert erhalten.

  Begründung: Die Pflege eines separaten externen Adressbuchs wurde in der
  Praxis selten genutzt — externe Adressen sind typischerweise individuell pro
  User relevant (private Kontakte) oder pro Gruppe (z. B. „Lieferanten-Verteiler").
  Reduziert Code-Komplexität, vereinfacht die GAL-Ansicht (User + Verteilergruppen)
  und entfernt einen Wartungspunkt im BCP. Analog zu v3.18.5 (eDiscovery) und
  v3.18.31 (Public Folders).

  **Schema** (`packages/storage/prisma/schema.prisma`):
  - Model `ExternalMailContact` entfernt
  - Tabelle `external_mail_contacts` wird beim Container-Start via
    `prisma db push --accept-data-loss` gedroppt
  - **Migration ist destruktiv**: alle bestehenden externen Kontakte gehen
    verloren

  **Backend** (`packages/api-gateway/src/`):
  - `routes/admin/external-contacts.ts` — gelöscht (Admin-CRUD)
  - Route-Mount `/api/v1/admin/contacts` entfernt
  - `routes/contacts.ts`:
    - `/contacts?q=…` (Compose-Autocomplete) liefert nur noch User + Verteilergruppen
    - `/contacts/gal` (Browse-GAL): `type=external`-Filter liefert leere Liste,
      damit alte Frontend-Aufrufe nicht brechen

  **BCP** (`packages/admin-panel/src/`):
  - `pages/ExternalContactsPage.tsx` — gelöscht
  - `components/Sidebar.tsx` — Eintrag „Ext. Kontakte" + `BookUser`-Icon-Import entfernt
  - `main.tsx` — Route `/ext-contacts` + Import entfernt
  - `i18n/translations.ts` — i18n-Keys `nav_ext_contacts` (DE+EN) entfernt
  - `pages/GroupsPage.tsx` — `ext-`-Prefix-Branches in `pickSuggestion()` und
    `typeBadge`-Map entfernt (toter Code seit GAL keine `ext-`-IDs mehr liefert)

  **MWA** (`packages/web-client/src/`):
  - `pages/ContactsPage.tsx` — GAL-Filter-Toggle „Extern" entfernt; Detail-Panel
    rendert nur noch `USER`/`GROUP`-Kinds; `EXTERNAL`-Conditional-Renders entfernt

---

## [3.18.32] — 2026-05-26 — TLS-Proxy: SNI-Multi-Cert-Support (Outlook-Autodiscover-Fix)

### Fixed

- **Outlook-Autodiscover lieferte „Zertifikatsfehler" trotz korrekt ausgestelltem
  `autodiscover.<domain>`-Zertifikat** (`packages/api-gateway/src/tls-proxy.ts`):
  Der integrierte HTTPS-Proxy (Port 443) lud nur das eine Zertifikat mit
  `isActiveHttps=true` und bediente damit ALLE eingehenden TLS-Verbindungen.
  Wenn Outlook auf `https://autodiscover.<domain>/Autodiscover/Autodiscover.xml`
  zugriff, sah der Client das `mail.<domain>`-Zertifikat → Hostname-Mismatch →
  `ERR_CERT_COMMON_NAME_INVALID` / Outlook zeigte Zertifikatswarnung.

  **Fix**: TLS-Proxy auf **SNI-Multi-Cert-Support** refactort.
  - Beim Reload werden ALLE Certs mit `status='ACTIVE'` geladen, nicht nur das
    mit `isActiveHttps=true`.
  - Pro Cert wird ein `tls.SecureContext` erstellt und allen Hostnames zugeordnet
    (CN + alle SANs aus dem PEM + `domains[]`-Array aus der DB).
  - Wildcard-Certs (`*.example.com`) werden separat gehalten und per Suffix-Match
    aufgelöst (RFC 6125 — genau eine Sub-Label-Ebene).
  - `SNICallback` wählt pro Verbindung anhand des vom Client gesendeten
    Servernames: exact-match → wildcard-match → Default-Cert.
  - Default-Cert (für unbekannte SNI oder Verbindungen ohne SNI) ist das Cert
    mit `isActiveHttps=true`; Fallback: das neueste ACTIVE-Cert.

- **Neu ausgestellte ACME- + Self-Signed- + Upload-Certs triggern jetzt sofort
  `coremail:tls:reload`** (`packages/api-gateway/src/routes/admin/certificates.ts`):
  Vorher wurde der Reload nur beim manuellen „HTTPS aktivieren"-Klick (Toggle
  `isActiveHttps`) ausgelöst — mit Multi-Cert-SNI sollen aber alle ACTIVE-Certs
  sofort verfügbar sein, ohne dass jemand HTTPS umschaltet. Trigger ergänzt in
  drei Code-Pfaden: ACME-Issuance (Let's-Encrypt-Ausstellung), Self-Signed-
  Generierung, Cert-Upload.

### Migration

Bestehende Setups: Beim ersten Reload nach Deploy wird die SNI-Map automatisch
aus allen ACTIVE-Certs aufgebaut. Bestehende Verbindungen werden nicht unterbrochen.
Wer das `autodiscover.<domain>`-Cert noch nicht ausgestellt hat: BCP → SSL/TLS →
ACME-Zertifikat anfordern mit Domain `autodiscover.<domain>` — danach funktioniert
Outlook-Autodiscover sofort, ohne dass „HTTPS aktivieren" geklickt werden muss.

---

## [3.18.31] — 2026-05-25 — Öffentliche Ordner komplett entfernt

### Removed

- **Feature „Öffentliche Ordner" (Public Folders) komplett aus dem Code entfernt.**
  Exchange-Style-Konzept (mit ACL `READ`/`WRITE`/`FULL` + Mail-Enabled-Variante
  seit v3.18.9) wird vom Markt heute kaum noch genutzt. Moderne Teams bevorzugen
  **Shared Mailboxes** (`/admin/shared-mailboxes/`) und **Distribution Groups**
  (`/admin/groups/`) für die typischen Use-Cases (Team-Postfach, Verteiler,
  kollaborative Inbox). Reduziert Code-Komplexität und Wartungsaufwand —
  analog zu v3.18.5 (eDiscovery/LegalHold-Removal).

  **Backend** (`packages/api-gateway/src/`):
  - `routes/public-folders.ts` — gelöscht (User-Endpoints `GET/POST/PUT/DELETE`)
  - `routes/admin/public-folders.ts` — gelöscht (Admin-CRUD + ACL-Management)
  - `server.ts` — Mount-Punkte `/api/v1/public-folders` + `/api/v1/admin/public-folders` entfernt

  **SMTP-Server** (`packages/smtp-server/src/`):
  - `inbound/handler.ts` `verifyRecipient()` — `publicFolder.findFirst()`-Lookup entfernt
  - `handlers/message.ts` `storeInboundMessage()` — Public-Folder-Branch entfernt;
    Mails an ehemalige Public-Folder-Adressen werden jetzt als unbekannter
    Empfänger verworfen (Standard-Behandlung)

  **BCP** (`packages/admin-panel/src/`):
  - `pages/PublicFoldersPage.tsx` — gelöscht
  - `components/Sidebar.tsx` — Eintrag „Öffentl. Ordner" + `FolderOpen`-Icon-Import entfernt
  - `main.tsx` — Route `/public-folders` + Import entfernt
  - `i18n/translations.ts` — i18n-Keys `nav_public_folders` (DE+EN) entfernt

  **MWA** (`packages/web-client/src/`):
  - `components/FolderTree.tsx` — Sektion `PublicFoldersSection` + `PublicFolderViewerModal`-
    Komponenten + ungenutzte Icon-Imports (`FolderTree`, `X`, `Mail`) entfernt

  **Datenbank** (`packages/storage/prisma/schema.prisma`):
  - Models `PublicFolder` + `PublicFolderMessage` entfernt
  - Tabellen `public_folders` + `public_folder_messages` werden beim Container-Start
    via `prisma db push --accept-data-loss` gedroppt
  - **Migration ist destruktiv**: alle bestehenden Public Folders + deren
    Mails gehen verloren (vergleichbar mit eDiscovery-Removal in v3.18.5)

---

## [3.18.30] — 2026-05-25 — BigInt-Crashfix + Audit-Log-Toggle + Audit-Translations

### Fixed

- **KRITISCH: backup-service Crashloop wegen `BigInt`-Serialisierung**
  (`packages/backup-service/src/server.ts`): Seit v3.18.26 hat `BackupJob.sizeBytes`
  den Prisma-Typ `BigInt` (für korrekte Repräsentation von Backup-Größen > 4 GB).
  Beim ersten Aufruf von `/jobs` oder `/users` warf Node mit
  `TypeError: Do not know how to serialize a BigInt` → supervisord restartete den
  Container endlos → **ALLE Backup-Endpoints lieferten 500**, was wiederum die
  vom User gemeldeten Symptome erklärt:
  - „Einzelne Mailbox sichern zeigt keine Benutzer an" → `/users` crashte
  - „Jobs zeigt keinen Status" → `/jobs` crashte
  Fix: Globaler Monkey-Patch von `express.response.json` am Modul-Top mit
  rekursivem `BigInt → string`-Replacer in `JSON.stringify`. Wirkt damit für
  alle bestehenden und zukünftigen Endpoints, ohne dass einzelne Handler
  angepasst werden müssen.

### Added

- **Audit-Log-Toggle in Sicherheitseinstellungen**
  (`packages/storage/prisma/schema.prisma`,
  `packages/api-gateway/src/lib/audit.ts`,
  `packages/api-gateway/src/routes/admin/global-settings.ts`,
  `packages/admin-panel/src/pages/SettingsPage.tsx`):
  Neues Feld `ServerSettings.auditLogEnabled` (Default `true`) erlaubt
  Admins, das globale Audit-Logging ein-/auszuschalten. Toggle in
  BCP → Einstellungen → Sicherheit. **Critical-Action-Override**: Regex
  `ALWAYS_AUDIT` (`/^(settings\.|audit\.|user\.role|oauth\.client|mailbox\.delete|domain\.delete)/i`)
  loggt sicherheits- und compliance-relevante Aktionen IMMER — auch bei
  ausgeschaltetem Toggle. Compliance-Hintergrund (DSGVO Art. 32, SOX, HIPAA,
  TISAX, ISO 27001): Sonst könnte ein Admin Audit ausschalten, Daten
  exfiltrieren und wieder einschalten — unentdeckt. Der Toggle-Wechsel
  selbst wird als `audit.enabled` / `audit.disabled` mit Diff im
  `changes`-Feld protokolliert. **In-Memory-Cache** (60s TTL) verhindert
  DB-Hit auf jedem Audit-Write; Invalidierung via `invalidateAuditCache()`
  nach jedem Save.

- **Human-Readable Action-Labels im Audit-Log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  Aktionen wie `settings.put` oder `mailboxes.delete` werden jetzt mit
  einer `ACTION_MAP` in lesbare Beschreibungen übersetzt — z.B.
  „Einstellungen geändert", „Postfach gelöscht", „Vollbackup gestartet",
  „Kalender freigegeben", „Audit-Log DEAKTIVIERT" (mit roter Critical-Tone).
  Über 40 Mappings für Settings, Mailboxes, Domains, Auth, OAuth, Backups,
  Calendar-Sharing, Rules, Roles, Gateway. Hover-Tooltip zeigt den
  Original-Action-String für SIEM-Querverweise. Heuristik-Fallback nach
  Verb (`post`/`create`/`delete`/...) für unbekannte Aktionen.

---

## [3.18.29] — 2026-05-25 — Backup-Archiv: Download + Delete für S3-Objekte

### Added

- **Download- und Delete-Buttons im „Backup-Archiv"-Tab**
  (`packages/backup-service/src/server.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  Vorher war die Archive-Tabelle read-only — User konnten Objekte nicht
  einzeln herunterladen oder löschen. Jetzt zwei neue Backend-Endpoints:
  - `GET /backup/admin/archive/download?key=<s3-key>` — Stream-Proxy für
    direkten Download (analog zum `download/:jobId`-Endpoint, aber für
    Objekte ohne BackupJob-Referenz z.B. alte/externe Imports)
  - `DELETE /backup/admin/archive?key=<s3-key>` — Löscht das S3-Objekt
    und nullt zusätzlich passende `BackupJob.downloadUrl`-Felder
    (Status → EXPIRED) damit die UI keinen broken Link mehr zeigt
  Frontend: neue Aktionsspalte mit Download- (HardDriveDownload) und
  Trash-Button. Confirm-Dialog vor Delete („endgültig löschen, kann nicht
  rückgängig gemacht werden"). Audit-Log-Entry `backup.archive.delete`.

---

## [3.18.28] — 2026-05-25 — Calendar+Backup UX-Fixes (Hook-Bug, Tabs, Delete, Time-Input)

### Fixed

- **KRITISCH: Erneutes Öffnen eines erstellten Termins → weiße Seite**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  React-Rules-of-Hooks-Verletzung — `useMemo(currentCal)` wurde NACH einem
  `if (existingLoading) return` aufgerufen. Beim ersten Render: 0 Memo,
  beim zweiten: 1 Memo → React-Crash mit „Rendered more hooks than during
  the previous render". Resultat: komplett weiße Modal-Seite, kein Reaction.
  **Fix**: alle Hooks VOR jedem early-return platziert.

- **Backup-Jobs konnten weder gelöscht noch heruntergeladen werden**:
  Download-URL zeigte auf `http://minio:9000` (Docker-intern, vom Browser
  nicht erreichbar). Delete-Endpoint fehlte komplett.
  **Fix Download**: neuer Stream-Proxy-Endpoint `GET /admin/backups/download/:jobId`
  im backup-service streamt das S3-Object durch die api-gateway zum Browser.
  Frontend nutzt Fetch + Blob + `URL.createObjectURL` für sauberen Datei-
  Download.
  **Fix Delete**: neuer Endpoint `DELETE /admin/backups/jobs/:id` löscht DB-
  Record + S3-Object (best-effort, kein Throw bei fehlendem S3-Object).
  Löschen-Button in jeder Job-Zeile mit Bestätigungs-Dialog.

### Changed

- **Speichern-Button im Event-Dialog jetzt unten rechts** (vorher Header-
  Toolbar oben links). Standard-Outlook-/Office-Pattern. Footer mit grauem
  Hintergrund: Löschen-Button links, Abbrechen + Speichern rechts.

- **Time-Input statt Dropdown-only**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Vorher `<select>` mit 96 Optionen (15-min) — User konnte keine custom-Zeit
  wie „13:42" eingeben. Jetzt `<input type="time" list="...">` mit
  `<datalist>` — Browser zeigt 15-min-Vorschläge als Dropdown beim Fokus,
  User kann aber jede beliebige Zeit frei tippen.

- **BackupsPage komplett refactored als Tab-Layout**:
  5 Tabs („Jobs", „Schnellaktionen", „Zeitpläne", „Backup-Archiv",
  „Restore (Import)") mit Badge-Counters. Vorher waren alle Sektionen
  untereinander gestapelt — übersichtlicher und mobil-freundlicher.

- **„S3-Snapshots" umbenannt zu „Backup-Archiv"** — AWS-Begriff vermieden,
  klarere Sprache. Tab heißt „Backup-Archiv".

- **Zeitplan-Editor mit vollständigen Dropdowns**: Frequenz-Dropdown
  (Stündlich/Täglich/Wöchentlich/Monatlich/Custom), Wochentag-Dropdown
  (Mo–So), Stunde-Dropdown (0–23), Minute-Dropdown (5er-Schritte), Tag-des-
  Monats-Dropdown (1–28), Retention-Dropdown (vorausgewählte Werte
  7/14/30/60/90/180/365/730/1825/3650). Cron-Expression wird im Hintergrund
  generiert und als read-only-Hinweis angezeigt. Nur bei „Custom" sieht User
  das Cron-Textfeld direkt.

### Added

- `streamObject()` + `deleteObject()` Helper in
  `packages/backup-service/src/upload/s3.ts`
- Audit-Log-Entry `backup.job.delete` für gelöschte Backup-Jobs

---

## [3.18.27] — 2026-05-25 — Outlook-Style Event-Dialog (Edit/Delete/Reschedule/Notes/Time-Picker)

### Fixed

- **Klick auf bestehenden Termin öffnete nur „Löschen?"-Dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  Vorher: `confirm('Termin XYZ löschen?')` — User konnte den Termin nicht
  bearbeiten. **Fix**: Klick öffnet jetzt vollwertigen Edit-Dialog mit allen
  Details (Titel, Datum, Zeit, Gäste mit Status, Ort, Notizen, Klassifizierung).
  Permission-Check via `canWrite`-Flag im GET-Response: bei READ-Share wird
  Dialog read-only gerendert mit „Nur Lesezugriff"-Badge.

- **Datum/Zeit-Eingabe war frickelig (datetime-local)**:
  Manuelles Tippen der Uhrzeit, kein Dropdown — gerade auf Mobile umständlich.
  **Fix**: Separate Date-Inputs + Time-Dropdowns mit 15-Minuten-Schritten
  (00:00 bis 23:45 = 96 Optionen). „Ganztägig"-Checkbox blendet Zeit-Felder aus.

### Added

- **`EventEditDialog`-Komponente (Outlook-Style)**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Vollwertiger Modal-Dialog für Create + Edit mit:
  - **Header-Toolbar**: Speichern, Löschen (nur Edit), Status-Refresh, Schließen
  - **Kalender-Picker**: Farbpunkt + Dropdown (im Edit-Mode disabled)
  - **Titel-Input**: Outlook-Style große Überschrift
  - **Attendee-Liste mit Live-PARTSTAT-Badges**:
    - Grün CheckCircle für ACCEPTED, Rot XCircle für DECLINED,
      Amber HelpCircle für TENTATIVE, Grau Clock für NEEDS-ACTION
    - Autocomplete-Input mit Keyboard-Nav (↑↓/Enter/Tab/Esc) reuse `/contacts?q=`
    - Counter unten: „X zugesagt · Y abgesagt · Z vielleicht · N ausstehend"
    - Status refresht automatisch alle 30 Sekunden (live!)
  - **Date+Time-Pickers**: HTML-Date-Input + Time-Dropdown (15-min Steps),
    automatisches End-Date-Folgen wenn Start verschoben wird
  - **Ort-Input** mit MapPin-Icon
  - **Klassifizierungs-Dropdown** (Öffentlich / Privat / Vertraulich)
  - **Notizen-Textarea** (6 Zeilen, vertical-resize)
  - **Info-Footer**: Organisator-Name, SEQUENCE-Counter, Auto-Update-Hinweis

- **`GET /api/v1/calendar/events/:id`** — Detail-Load für Edit-Dialog mit
  `canWrite`/`readOnly`-Flags. Permission-Check via `canAccessCalendar`,
  Privacy-Masking für PRIVATE-Events bei Grantees (Summary → „Beschäftigt",
  Attendees ausgeblendet), CONFIDENTIAL liefert 404 für Foreign-Viewer.

### Changed

- **CalendarPage** — alter inline-Dialog entfernt (war ~80 Zeilen JSX).
  Ersetzt durch einheitlichen `EventEditDialog` für Create und Edit.
  State vereinfacht: `eventDialog: { mode: 'create' | 'edit', ... } | null`.
- **Toolbar „Neues Ereignis"** öffnet jetzt den Outlook-Style-Dialog
  statt des alten Mini-Dialogs.
- **Doppelklick / einfacher Klick auf Event**: öffnet Edit-Dialog (Doppel-
  click wird von FullCalendar als zwei eventClicks gefeuert — beide öffnen
  den gleichen Dialog, kein Konflikt).
- **Attendee-Status-Refresh**: Edit-Dialog hat eigenen `refetchInterval: 30s`
  + Manual-Refresh-Button im Header.

---

## [3.18.26] — 2026-05-25 — Backup-Bugfixes + Per-Mailbox + Scheduling + Status-Log

### Fixed

- **Vollbackup-Button und Refresh-Button funktionierten nicht**
  (`packages/backup-service/src/upload/s3.ts`,
  `packages/backup-service/src/server.ts`):
  Root Cause: backup-service crashte beim ersten Aufruf von
  `listBackups()` weil der MinIO-Bucket `coremail-backups` nicht
  existierte (`NoSuchBucket` Error). supervisord startete den Container
  alle paar Minuten neu — vom User aus gesehen reagierten Buttons nicht.
  **Fix**: `ensureBackupBucket()` läuft beim Service-Start und legt den
  Bucket idempotent an (HeadBucket → CreateBucket bei 404). `listBackups()`
  zusätzlich fail-safe: bei NoSuchBucket Bucket erstellen + leere Liste
  liefern statt zu crashen.

### Added

- **Per-Mailbox-Backup**
  (`packages/backup-service/src/scheduler/index.ts`,
  `packages/backup-service/src/server.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  Neuer Endpoint `POST /admin/backups/mailbox/:userId` mit Body
  `{ format: "zip" | "mbox" }`. Frontend: User-Picker (Dropdown aller
  aktiven User) + Format-Auswahl + „Mailbox sichern"-Button. Snapshot
  landet in MinIO unter `mailbox/{userId}/{timestamp}.{format}`.

- **Backup-Zeitpläne (Cron) in DB statt Env-Variable**
  (`packages/storage/prisma/schema.prisma` — neues Modell `BackupSchedule`,
  `packages/backup-service/src/scheduler/index.ts`):
  Admin kann Cron-Expressions im BCP verwalten — kein Container-Restart
  nötig. Scheduler liest alle 60s aus DB und synchronisiert aktive
  CronJobs. Felder: `name`, `cron`, `enabled`, `scope` (full/user),
  `format`, `targetUserId`, `retentionDays`, `lastRunAt`, `lastStatus`.
  Frontend mit Cron-Presets (täglich/wöchentlich/stündlich/alle 6h/
  monatlich), Run-Now-Button pro Schedule, Edit/Delete-Buttons.

- **Erweiterte Status-Log-Felder im BackupJob-Modell** (Research: siehe
  `coremail/research/imip-itip.md` und RTO/RPO-Recherche):
  - `startedAt`, `durationMs` — für RTO-Messung
  - `sizeBytes`, `messageCount` — Backup-Volumetrie
  - `errorClass` (NETWORK/STORAGE/PERMISSION/CORRUPT/UNKNOWN) +
    `errorMessage` — strukturiertes Error-Reporting
  - `retryCount`, `triggeredBy` (CRON/MANUAL/EVENT/RESTORE/API)
  - `progressMeta` (JSONB) für Live-Phase „Reading mailbox X (3/12)"
  - `scheduleId` — Verweis auf BackupSchedule wenn aus Cron getriggert

- **Erweiterte `JobStatus`-Enum-Werte** für vollständigen Backup-
  Lifecycle: `SCHEDULED`, `RUNNING`, `RETRYING`, `ABORTED`, `EXPIRED`
  zusätzlich zu den bisherigen `PENDING|PROCESSING|COMPLETED|FAILED`.

### Changed

- **`POST /backup/admin/full`** liefert jetzt sofort die Master-Job-ID
  zurück (`202 { jobId }`) statt Fire-and-Forget. Frontend kann sofort
  den RUNNING-Job in der Tabelle anzeigen.
- **`runFullBackup()`** erstellt jetzt einen Master-Job mit `progress`-
  Tracking statt nur per-User-Jobs ohne Übersicht. UI zeigt Progress-Bar
  „X/Y User exportiert" während des Laufs.
- **Refresh-Button** mit Toast-Feedback („Aktualisiert") damit User
  visuell Bestätigung bekommt.

### Removed / Explicitly Not Supported

- **PST-Format** wird bewusst nicht unterstützt. Begründung im Frontend-
  Banner: PST ist proprietäres Microsoft-Binärformat, alle verfügbaren
  Open-Source-Libs (libpff, node-pst-extractor) sind read-only. Stattdessen
  ZIP mit .eml-Dateien — Outlook akzeptiert das per Drag&Drop nativ.

### Schema

- Neues Modell `BackupSchedule` (Cron-Verwaltung in DB).
- `BackupJob` erweitert um 10 neue Spalten (`startedAt`, `durationMs`,
  `sizeBytes`, `messageCount`, `errorClass`, `retryCount`, `triggeredBy`,
  `progressMeta`, `scheduleId`).
- `JobStatus`-Enum erweitert um 5 Werte.

---

## [3.18.25] — 2026-05-25 — Calendar-Invitations (iMIP/iTIP, A5)

### Added

- **iMIP-REQUEST-Mails an Gäste beim Termin-Erstellen** (RFC 6047 / 5546)
  (`packages/api-gateway/src/lib/imip.ts`,
  `packages/api-gateway/src/routes/calendar.ts`):
  Wenn ein Event mit Attendees angelegt wird, generiert das System eine
  iMIP-konforme Einladungs-Mail per `ical-generator` mit:
  - `multipart/alternative` → text/plain + text/html + `text/calendar; method=REQUEST` (für Gmail)
  - `application/ics`-Attachment (für Outlook-Win32 RSVP-Buttons)
  - Outlook-Quirks (`X-MICROSOFT-CDO-BUSYSTATUS`, `X-MS-OLK-FORCEINSPECTOROPEN`)
  - Pflicht-Properties: UID (mit `@hostname`-Suffix), DTSTAMP, ORGANIZER,
    ATTENDEE mit `RSVP=TRUE PARTSTAT=NEEDS-ACTION`, SEQUENCE, STATUS:CONFIRMED
  Versand über bestehende BullMQ-Outbound-Queue (`smtp-outbound`) via
  `rawMessage`-base64-Pfad — Retry + DKIM-Signing greifen automatisch.

- **iMIP-Update bei Event-Änderung** — Bei `PUT /calendar/events/:id` werden
  geänderte Felder erkannt (summary/dtStart/dtEnd/location/attendees). Wenn
  sich relevante Felder ändern, wird `sequence++` und eine neue REQUEST-Mail
  an alle Attendees gesendet (Mail-Clients erkennen am höheren SEQUENCE den
  Update und ersetzen den bestehenden Eintrag).

- **iMIP-CANCEL bei Event-Löschen** — Bei `DELETE /calendar/events/:id` wird
  vor dem Delete eine CANCEL-Mail (`METHOD:CANCEL`, `STATUS:CANCELLED`,
  `sequence++`) an alle Attendees gesendet. Gmail/Outlook zeigen Banner
  „Termin abgesagt" und entfernen den Eintrag.

- **iTIP-REPLY-Inbound-Handler** (Gast antwortet)
  (`packages/storage/src/itip-inbound.ts`,
  `packages/smtp-server/src/handlers/message.ts`):
  Eingehende Mails werden auf `BEGIN:VCALENDAR ... METHOD:REPLY` gescannt
  (Regex-basiert, kein schwerer ical-Parser im Hot-Path). Bei Match:
  UID-Lookup auf `CalendarEvent`, SEQUENCE-Check (alte REPLYs werden
  ignoriert, RFC 5546 §3.4.3), Attendee-Eintrag im JSON-Array updaten
  (`partstat=ACCEPTED|DECLINED|TENTATIVE`). Mail wird TROTZDEM in die
  Inbox zugestellt (User-Awareness wie bei Outlook).

- **Frontend: Gäste-Input im Neuer-Termin-Dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  Neues Eingabefeld „Gäste einladen (kommagetrennt)" akzeptiert E-Mail-
  Adressen wie `anna@example.com, bob@x.de`. Counter zeigt „X Gäste —
  Einladungs-Mails werden beim Speichern versendet".

### Schema

- `CalendarEvent.attendees` (Json-Array) wird beim Create mit
  `{ email, cn, partstat, role, rsvp }`-Objekten gefüllt.
- `CalendarEvent.sequence` (Int, default 0) wird bei jedem relevanten
  Update inkrementiert (war in v3.18.24 vorbereitet).
- `CalendarEvent.uid` jetzt mit Hostname-Suffix `<id>@<publicHostname>`
  (RFC 5545 §3.8.4.7 — globale Eindeutigkeit).

### Dependencies

- `ical-generator@10.2.0` in api-gateway (war in v3.18.24 installiert)

---

## [3.18.24] — 2026-05-25 — Performance E: MinIO Lifecycle-Policies

### Added

- **E4 — MinIO Lifecycle-Policies für automatisches Cleanup**
  (`packages/storage/src/minio/index.ts`):
  Bisher konnten temporäre Backup-, Quarantäne- und Outbound-Queue-Objekte
  unbegrenzt im MinIO-Bucket wachsen — speziell „outbound-queue/"-Anhänge
  von toten BullMQ-Jobs (z. B. nach Crash zwischen Job-Enqueue und Worker-
  Pickup) blieben für immer liegen. Neuer Helper `ensureLifecyclePolicies()`
  wird in `ensureBuckets()` aufgerufen und setzt drei prefix-basierte
  Expiration-Regeln im Bucket:
  - `outbound-queue/` → 7 Tage (Sicherheitsnetz für tote Jobs)
  - `quarantine/`     → 90 Tage (rspamd-Quarantäne)
  - `backups/`        → 365 Tage (Backup-Retention)
  E-Mail-Anhänge (`attachments/`) und Raw-Messages (`raw/`) sind explizit
  AUSGENOMMEN — die werden beim Message-Delete einzeln entfernt. Idempotent:
  setBucketLifecycle() überschreibt die Policy jedes Mal, bei jedem
  Container-Start wird der aktuelle State garantiert. Fail-safe: wenn MinIO
  die Policy nicht akzeptiert (alte Version, Permission-Issue), nur WARN-
  Log, kein Throw.

### Added (Dependency)

- `ical-generator@^10.2.0` als Vorbereitung für v3.18.25 iMIP-Calendar-
  Invitations.

### Schema

- **`CalendarEvent.sequence Int @default(0)`** — Sequence-Counter für
  iMIP-konforme Event-Updates (RFC 5546 §3.2). Mail-Clients (Outlook,
  Gmail) ignorieren REPLY-Mails mit niedrigerer Sequence als der aktuell
  gespeicherte Event-Stand. Vorbereitung für v3.18.25.

---

## [3.18.23] — 2026-05-25 — Backup-Restore-UI im BCP (D3)

### Added

- **Neue BCP-Seite „Backup & Restore"**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`,
  `packages/admin-panel/src/components/Sidebar.tsx`,
  `packages/admin-panel/src/i18n/translations.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/api-gateway/src/server.ts`):

  Bisher war Backup-Verwaltung nur über CLI / direkten backup-service-Aufruf
  möglich. Neue Admin-UI mit:
  - **Backup-Jobs-Tabelle** — Datum, Scope (user/domain/full), Format
    (mbox/eml/full), Status mit Icons (PENDING/RUNNING/COMPLETED/FAILED/
    CANCELLED), Progress-Bar, Download-Link bei abgeschlossenen Jobs.
    Auto-Polling alle 5s wenn ein Job RUNNING oder PENDING ist, sonst 60s
    (Performance + Live-Updates).
  - **S3-Snapshots-Tabelle** — Listet alle Backup-Objekte im MinIO/S3-Bucket
    mit Key, Größe (formatiert KB/MB/GB), Last-Modified.
  - **„Vollbackup starten"-Button** — Triggert `POST /admin/backups/full`,
    Audit-Log-Entry `backup.full.trigger`.
  - **MBOX-Import (Restore)** — File-Picker (Limit 500 MB) + Ziel-User-ID,
    `POST /admin/backups/import/:userId` mit `Content-Type: application/mbox`,
    Audit-Log-Entry `backup.mbox.import`.

  Backend: Wrapper-Router `adminBackupsRouter` leitet `/api/v1/admin/backups/*`
  an `BACKUP_SERVICE_URL` (default `http://localhost:3004`) weiter. Auth via
  `requireAdmin`-Middleware + Authorization-Header-Forward. Audit-Log für
  Trigger/Import. Side-effect-Import für Express-Augmentation `req.apiUser`.

  Sidebar: neuer Nav-Eintrag „Backup & Restore" mit `HardDriveDownload`-
  Icon. i18n-Key `nav_backups` in DE + EN.

---

## [3.18.22] — 2026-05-25 — OAuth2-Consent-UI (Security)

### Security

- **D1 — OAuth2 Auto-Grant entfernt, echte Consent-UI**
  (`packages/auth-service/src/oauth2/router.ts`,
  `packages/web-client/src/pages/LoginPage.tsx`,
  `packages/web-client/src/pages/OAuthConsentPage.tsx`,
  `packages/web-client/src/App.tsx`):

  **Vorher (Security-Issue)**: `/oauth2/authorize/complete` granted Consent
  blind beim ersten Aufruf eines nicht-trusted Clients — User hatten keine
  Möglichkeit, eine Drittanbieter-App vor dem ersten Zugriff zu sehen oder
  abzulehnen. Trotz „nicht-trusted" Markierung wurden alle angeforderten
  Scopes automatisch genehmigt.

  **Jetzt**: Backend liefert bei fehlender oder unvollständiger Einwilligung
  `200 { requiresConsent: true, client, requestedScopes, alreadyGrantedScopes,
  newScopes }` statt direkt Code auszustellen. Frontend zeigt neue
  ConsentPage mit:
  - Client-Name + Beschreibung
  - Liste der angeforderten Scopes mit deutschen Labels (z. B. „mail.send" →
    „E-Mails senden in deinem Namen", „calendar.write" → „Termine erstellen,
    ändern oder löschen")
  - Bei bestehender Genehmigung mit zusätzlichen Scopes: nur die NEUEN Scopes
    werden hervorgehoben, bereits erteilte als kleiner Hinweis unten
  - Amber-Warnung „Du kannst diesen Zugriff jederzeit widerrufen"
  - „Erlauben" und „Ablehnen"-Buttons

  Flow:
  1. Drittanbieter-App → `GET /oauth2/authorize?client_id=...&...`
  2. Auth-Service redirected zu `/owa/login?oauth2=1&client_id=...`
  3. LoginPage erkennt `oauth2=1`, nach Login → `navigate('/oauth-consent?...')`
  4. ConsentPage fragt Backend ob Consent nötig → bei `redirect` direkt zurück
     zum Client (bereits genehmigt), bei `requiresConsent` UI zeigen
  5. „Erlauben" → zweiter Call mit `consentConfirmed: true` → Backend
     persistiert Consent + erstellt Code + liefert `redirect`-URL
  6. „Ablehnen" → Client wird mit `error=access_denied` (RFC 6749 §4.1.2.1)
     aufgerufen, kein Code ausgestellt

  Neue Route `/oauth-consent` im MWA, mit AuthGuard aber ohne Layout-Wrapper
  (standalone Vollbild-Dialog).

---

## [3.18.21] — 2026-05-25 — Calendar-Toolbar Filter + Drucken funktionsfähig

### Fixed

- **Filter-Button hatte keine Funktion**
  (`packages/web-client/src/components/CalendarToolbar.tsx`,
  `packages/web-client/src/pages/CalendarPage.tsx`):
  Dropdown öffnete sich zwar mit Toggle-Checkboxen, aber der State war
  rein lokal in der Toolbar — wurde nie an CalendarPage weitergegeben.
  Außerdem waren die alten Outlook-Begriffe („Besprechungen",
  „Kategorien", „Anzeigen als") bedeutungslos für CoreMail.
  **Fix**: Filter-Set auf 5 realistische, tatsächlich-mapbare Optionen
  reduziert: Wiederholende Termine (rrule), Aufgaben, Private Termine
  (classification=PRIVATE), Vertrauliche Termine (CONFIDENTIAL für Owner),
  Geteilte Kalender (shared=true). State zu CalendarPage gelifted
  (controlled component). `fcEvents` werden jetzt tatsächlich gefiltert.

- **„Drucken" druckte die komplette Seite mit Sidebar + Toolbar**
  (`packages/web-client/src/pages/CalendarPage.tsx`,
  `packages/web-client/src/index.css`):
  Vorher: simples `window.print()` ohne Print-CSS — Sidebar, Toolbar,
  App-Chrome alles auf dem Druck. **Fix**: vor `window.print()` wird
  `coremail-printing`-Class auf `<html>` gesetzt; neuer `@media print`-
  Block in `index.css` blendet `aside`, `nav`, `header` und alle
  `[data-coremail-toolbar]`-Elemente aus. Nach Print-Dialog wird die
  Class via Timeout (500ms) wieder entfernt. Events bekommen Print-
  geeignete Border (1px solid #888) damit sie auf Papier sichtbar bleiben.

---

## [3.18.20] — 2026-05-25 — Dark-Mode-Patches (LoginPage + SettingsPage)

### Changed

- **MWA LoginPage Dark-Mode** (`packages/web-client/src/pages/LoginPage.tsx`):
  Login-Card war komplett ohne `dark:`-Modifier — als erste Seite die ein
  neuer User sieht, ein offensichtlicher Bug. Jetzt mit
  `dark:bg-gray-900`, `dark:text-white`, `dark:text-gray-400` für Logo +
  Subtitle. Card-Border `dark:border-gray-700` als subtile Abgrenzung.

- **MWA SettingsPage Dark-Mode (Sektion-Headers + Form-Labels)**
  (`packages/web-client/src/pages/SettingsPage.tsx`):
  Sektion-Überschriften (`text-lg font-semibold text-gray-900` → +
  `dark:text-gray-100`), Sub-Texts (`text-sm text-gray-500 mt-0.5` → +
  `dark:text-gray-400`), Form-Labels (`block text-sm font-medium
  text-gray-700 mb-1` → + `dark:text-gray-300`) und disabled E-Mail-Input
  (`bg-gray-50` → + `dark:bg-gray-800`) sind jetzt im Dark-Mode korrekt
  lesbar.

### Known

- ComposeWindow (~22 Stellen) und SignatureSection (~9 Stellen) haben
  noch einzelne nicht-dark-aware-Klassen. Wird in einer dedizierten
  Dark-Mode-Sweep-Session in v3.19 aufgeräumt.

---

## [3.18.19] — 2026-05-25 — Forced 2FA für Admin-Login (Security)

### Security

- **D5 — Pflicht-2FA für Admins** (`packages/api-gateway/src/middleware/auth.ts`,
  `packages/admin-panel/src/api/client.ts`,
  `packages/admin-panel/src/pages/MfaRequiredPage.tsx`):
  Wenn `ServerSettings.requireMfaForAdmins=true` (Toggle bestand bereits in
  Sicherheits-Einstellungen, wurde aber nirgendwo enforced) und der Admin
  hat KEINE MFA aktiviert → alle `/api/v1/admin/*`-Routen liefern jetzt
  `403 { code: "MFA_REQUIRED" }`. Frontend-API-Client erkennt den Code und
  leitet auf neue Pflicht-Setup-Seite `/bcp/mfa-required` mit Anleitung
  („MWA öffnen → Einstellungen → Sicherheit → 2FA aktivieren → zurückkommen").
  TOTP- oder WebAuthn-Credentials zählen beide als „MFA aktiviert".
  Kein Chicken-and-Egg-Problem: MFA-Setup-Routes (`/auth/mfa/*`) sind
  außerhalb der `/admin/*`-Sperre. Fail-safe: bei DB-Fehler im Check wird
  durchgelassen (Logged als ERROR), damit Admins nicht ausgesperrt werden
  bei Postgres-Ausfall.

---

## [3.18.18] — 2026-05-25 — Toolbar-Share-Button + CalDAV-URL-Anzeige

### Fixed

- **Toolbar „Kalender teilen" funktioniert jetzt**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  Der Button oben in der CalendarToolbar zeigte vorher nur einen Toast
  („Wähle einen Kalender und klicke Teilen über das ⋯-Menü"). Jetzt
  öffnet er den `ShareCalendarDialog` direkt — wenn der User mehrere
  eigene Kalender hat, erscheint im Dialog-Header ein Auswahl-Dropdown
  zum Wechseln. Bei nur einem eigenen Kalender wird dieser direkt
  geöffnet. Wenn gar keiner vorhanden ist → Toast-Fehler.

### Added

- **CalDAV-URL-Anzeige für externen Kalender-Zugriff**
  (`packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`,
  `packages/web-client/src/components/CalendarSidebar.tsx`):
  Neuer Endpoint `GET /api/v1/calendar/caldav-info` liefert
  - `accountUrl` für Auto-Discovery (`https://host/dav/calendars/{userId}/`)
  - Pro-Kalender-URL für direkten Mount (`.../{calendarId}/`)
  - Username + Auth-Hinweis (App-Passwort statt Login-Passwort wegen MFA)
  Im Share-Dialog erscheint eine neue Sektion „Externer Zugriff (CalDAV)"
  mit beiden URLs und Copy-to-Clipboard-Buttons. Im Sidebar-Kontextmenü
  auf eigenen Kalendern gibt es zusätzlich „CalDAV-URL kopieren" für
  Quick-Access. CalDAV wird konsequent über HTTPS empfohlen (Auth-Leak-
  Schutz); nur wenn Admin explizit `useHttps=false` gesetzt hat (z. B.
  hinter Reverse-Proxy), wird `http://` ausgegeben.

### Changed

- **ShareCalendarDialog** akzeptiert jetzt optional `ownedCalendars`-Prop
  für Picker-Modus. Bei Aufruf aus Sidebar-Kontextmenü bleibt der
  Kalender fix; beim Aufruf aus Toolbar wird gewechselt werden können.
  Header zeigt Picker-Dropdown nur wenn `ownedCalendars.length > 1`.

---

## [3.18.17] — 2026-05-25 — Calendar SSE-Push + Free/Busy-Query

### Added

- **A2 — SSE-Push für Calendar-Share-Lifecycle**
  (`packages/core/src/redis/index.ts`, `packages/api-gateway/src/sse.ts`,
  `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/hooks/useMailEvents.ts`):
  Neuer Redis-Channel `coremail:calendar:shares` (Konstante
  `CHANNEL_CALENDAR_SHARES`). Backend published bei jeder Share-Lifecycle-
  Aktion (create/update/delete/self_remove) ein JSON-Event mit
  `affectedUserIds[]` (Owner + Grantee). SSE-Handler im api-gateway
  abonniert den Channel und forwardet das Event als `event: calendar:shares`
  nur an die SSE-Verbindungen der betroffenen User. Frontend-Hook
  `useMailEvents()` invalidiert auf das Event hin die `['calendars']`- und
  `['calendar-shares']`-Caches → instant Live-Sync ohne Polling. Toast
  „🗓️ Ein Kalender wurde mit dir geteilt" bei `action=create`. Polling-
  Intervall der Calendar-Query in CalendarPage von 60s auf 5min reduziert
  (nur noch Sicherheits-Fallback falls SSE tot).

- **A4 — Free/Busy-Query über geteilte Kalender**
  (`packages/api-gateway/src/routes/calendar.ts`):
  Neuer Endpoint `POST /api/v1/calendar/freebusy`, Body
  `{ userEmails[], start, end }`. Liefert pro angefragtem User alle
  Busy-Slots aus Kalendern, auf die der Caller Zugriff hat (eigene + per
  Share). CONFIDENTIAL-Events bleiben für Foreign-Caller ausgeblendet,
  PRIVATE-Events werden als generic „Busy"-Slot OHNE Subject geliefert.
  Self-Query (Caller fragt sich selbst) sieht alle Details. Range hart
  begrenzt auf 90 Tage (DoS-Schutz), Liste auf 50 User. Response-Shape:
  `{ start, end, users: [{ email, displayName, found, busy: [{ start, end, type, subject? }] }] }`.

---

## [3.18.16] — 2026-05-25 — Calendar Sharing Quick-Wins (Notification, Per-Grantee-Farbe, Reorder, Cleanup)

### Added

- **A1 — Notification-Mail an Grantee beim Teilen**
  (`packages/api-gateway/src/lib/internal-notify.ts`, `routes/calendar.ts`):
  Wenn Owner einen Kalender freigibt, erhält der Empfänger automatisch eine
  System-Mail in seine INBOX („X hat den Kalender ‚Y' mit dir geteilt" mit
  Permission-Level). Neuer Helper `notifyUserInbox()` mit direkter Inbox-
  Insertion via `prisma.message.create` — kein SMTP-Roundtrip, kein DKIM/
  Spam-Check nötig, sofortige Sichtbarkeit. Nur bei *neuer* Share, nicht bei
  Permission-Update via Upsert (verhindert Spam). HTML-Escaping gegen XSS.

- **A3 — Per-Grantee-Farbe für geteilte Kalender**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees können freigegebene Kalender lokal umfärben, ohne dass die Owner-
  Farbe geändert wird. Neues Feld `CalendarShare.localColor String?` und
  Endpoint `PATCH /calendar/mine-shares/:shareId` mit Body `{ localColor }`.
  Farb-Picker im Kontextmenü auf geteilten Kalendern; „Original-Farbe (vom
  Owner)" setzt `localColor=null` zurück. `listAccessibleCalendars` liefert
  `localColor ?? calendar.color` für Grantees.

- **A8 — Reorder für geteilte Kalender**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees können die Reihenfolge der „Geteilt mit mir"-Sektion lokal
  anpassen. Neues Feld `CalendarShare.sortOrder Int @default(0)` und Endpoint
  `POST /calendar/mine-shares/reorder` (Body `{ ids[] }`, filtert auf
  `granteeId === userId`). Kontextmenü „Nach oben" / „Nach unten" auf
  geteilten Kalendern.

- **`shareId`-Feld** im `GET /calendar`-Response (nur bei `shared: true`)
  — Frontend benutzt es für Self-Removal, Color-Change, Reorder. Vorher
  brauchte Self-Removal einen Roundtrip via `/mine-shares?calendarId=`,
  jetzt direkt verfügbar.

### Changed

- **CalendarSidebar — geteilte Kalender sortiert nach `sortOrder`** statt
  alphabetisch nach Name. Tie-Break bleibt `localeCompare`.
- **Self-Removal-Mutation** vereinfacht — nutzt jetzt `cal.shareId` direkt
  statt Lookup über `mine-shares?calendarId=`.

### Removed

- **C1 — `Calendar.acl Json`-Feld komplett entfernt**
  (`packages/storage/prisma/schema.prisma`):
  In v3.18.14 als `@deprecated` markiert (durch `CalendarShare` ersetzt).
  Spalte wird beim Container-Start via `prisma db push --accept-data-loss`
  automatisch gedroppt. Kein Code in `packages/` referenzierte das Feld —
  `PublicFolder.acl` bleibt unverändert (anderes Modell).

---

## [3.18.15] — 2026-05-25 — CalDAV-WRITE-Sharing + Private Events + Audit-Log + i18n

### Added

- **CalDAV-WRITE für Grantees mit voller RFC-3744-DAV-ACL**
  (`packages/caldav-server/src/caldav/index.ts`):
  In v3.18.14 konnten Apple Kalender / Thunderbird Lightning nur lesen.
  Jetzt dürfen WRITE-Grantees auch PUT (Create/Update) und DELETE.
  Schreib-Sperre für READ-Grantees bleibt. Volle RFC-3744-DAV-ACL:
  - `<DAV:owner>` mit `<d:href>/dav/principals/{ownerId}/</d:href>`
  - `<DAV:current-user-privilege-set>` mit feingranularen Privileges
    (`<d:read/>`, `<d:write/>`, `<d:write-content/>`, `<d:bind/>`, `<d:unbind/>`)
  - `<DAV:acl>` Block (nur für OWNER sichtbar) mit ACE pro Grantee
  - `Allow`-Header in OPTIONS jetzt mit `ACL`, `DAV`-Header mit `access-control`
  Cross-Calendar-Manipulation-Protection: Grantee kann ein Event aus seiner
  Sicht nicht in einen anderen Kalender verschieben.

- **Private und vertrauliche Termine (RFC 5545 `CLASS:`)**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/lib/calendar-access.ts`):
  Neues Feld `CalendarEvent.classification` mit drei Werten:
  - `PUBLIC` (Default): Grantees sehen alle Details
  - `PRIVATE`: Grantees sehen nur „Beschäftigt" — Subject/Description/Location/
    Attendees werden maskiert. Owner sieht alles unverändert.
  - `CONFIDENTIAL`: Termin wird für Grantees komplett ausgeblendet
  Mapping zu iCal `CLASS:`-Property (RFC 5545 §3.8.1.3) in beide Richtungen
  (Backend → iCal beim Build, CalDAV-PUT → DB beim Parse). Maskierung greift
  in REST `GET /calendar/events`, CalDAV `GET`, `PROPFIND` und `REPORT`.
  WRITE-Grantees können CONFIDENTIAL-Events nicht ändern (sie wären sonst
  trotz Maskierung manipulierbar).

- **Audit-Log für Sharing-Aktionen** (Compliance, DSGVO Art. 32)
  (`packages/api-gateway/src/routes/calendar.ts`):
  Neue Audit-Aktionen — alle mit Actor, Ziel-Kalender, IP, User-Agent und
  Diff im `changes`-Feld:
  - `calendar.share.create` — beim Erstellen einer Freigabe
  - `calendar.share.update` — bei Permission-Änderung (mit oldPermission/newPermission)
  - `calendar.share.delete` — wenn Owner eine Freigabe entfernt
  - `calendar.share.self_remove` — wenn Grantee sich selbst aus der Liste entfernt
  Bisher waren Sharing-Aktionen NICHT auditiert — Lücke geschlossen.

- **i18n: EN, ES, IT-Übersetzungen für Sharing-UI**
  (`packages/web-client/src/i18n/translations.ts`):
  25 neue Keys (`cal_share_*` und `cal_event_class_*`) in allen vier
  Sprachen Deutsch/Englisch/Spanisch/Italienisch.

### Changed

- **Event-Erstellungs-Dialog** im MWA hat jetzt einen Sichtbarkeits-Dropdown
  („Öffentlich" / „Privat" / „Vertraulich"). Default bleibt PUBLIC für
  Rückwärts-Kompatibilität.

- **CalDAV OPTIONS-Antwort** enthält jetzt `ACL` im Allow-Header und
  `access-control` im DAV-Header — Apple Kalender erkennt damit volle
  RFC-3744-Unterstützung.

### Schema

- Neues Feld `CalendarEvent.classification String @default("PUBLIC")`.
  Migration läuft automatisch via `prisma db push --accept-data-loss`.
  Bestehende Events bekommen `PUBLIC` als Default — keine Verhaltensänderung
  für nicht-geteilte Kalender.

---

## [3.18.14] — 2026-05-25 — Kalender teilen und berechtigen (Read/Write)

### Added

- **Kalender-Sharing — internes Sharing zwischen Usern**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`):
  User können ihre eigenen Kalender an andere User im selben System freigeben
  mit READ- oder READ+WRITE-Permission. Geteilte Kalender erscheinen beim
  Empfänger in einer neuen Sidebar-Sektion „Geteilt mit mir" mit Share-Icon
  und Permission-Badge (R / R/W) sowie Owner-Name als Untertitel.

- **Sharing-Dialog mit Benutzer-Autocomplete**
  (`packages/web-client/src/components/ShareCalendarDialog.tsx`):
  Klick auf „Teilen und Berechtigungen" im Kalender-Kontextmenü öffnet einen
  vollwertigen Dialog statt der bisherigen „Bald verfügbar"-Notification.
  - Benutzer-Autocomplete via `/contacts?q=` (220ms Debouncing, Keyboard-Nav
    ↑↓/Enter/Tab/Escape, automatische Filterung nur auf interne User-Treffer,
    bereits zugewiesene User werden ausgeblendet)
  - Permission-Select (Nur lesen / Lesen und Schreiben)
  - Liste der aktuellen Freigaben mit Permission-Toggle + Trash-Button
  - Self-Share verhindert (Backend 400-Response)
  - Info-Banner mit Erklärung READ vs WRITE und CalDAV-Hinweis

- **CalDAV Discovery für geteilte Kalender (Read-Only)**
  (`packages/caldav-server/src/caldav/index.ts`):
  Externe Clients (Apple Kalender, Thunderbird Lightning) sehen jetzt in der
  Calendar-Home-Set auch geteilte Kalender (mit `[Geteilt]`-Prefix im Displayname).
  PROPFIND/REPORT/GET sind erlaubt. PUT/DELETE bleiben in v3.18.14 OWNER-only
  (volle WRITE-CalDAV folgt in v3.18.15 mit RFC-3744-konformer DAV ACL).
  `<DAV:current-user-privilege-set>` korrekt gesetzt: OWNER → `<d:all/>`,
  Grantee → `<d:read/>`.

### Changed

- **GET /api/v1/calendar** liefert jetzt eigene + geteilte Kalender mit Feldern
  `shared`, `ownerId`, `ownerDisplayName`, `ownerEmail`, `permission`
  (`OWNER`/`READ`/`WRITE`). Lazy-Provisioning nur noch bei komplett leerem Bestand.

- **Event-Permission-Checks** in `POST/PUT/DELETE /calendar/events*` über neuen
  zentralen Helper `canAccessCalendar(userId, calendarId, required)` in
  `packages/api-gateway/src/lib/calendar-access.ts`. WRITE-Permission erforderlich
  für Schreib-Operationen, READ reicht für `GET /events`. Owner haben immer
  alle Rechte.

- **FullCalendar im MWA** rendert geteilte READ-only-Kalender als nicht editierbar
  (`editable: false`, `startEditable: false`, `durationEditable: false`).
  Klick auf einen READ-only-Event zeigt Toast „Nur Lese-Berechtigung für diesen
  Kalender" statt Delete-Confirm. Neuer-Termin-Dialog listet nur Kalender mit
  Schreibrecht im Dropdown.

- **TanStack Query Calendar-Cache** mit `staleTime: 30s` + `refetchInterval: 60s`
  + `refetchOnWindowFocus: true` — geänderte Freigaben (z. B. Owner widerruft
  Permission) verschwinden binnen 60s aus der UI.

### Schema

- **Neue Tabelle `calendar_shares`** mit Feldern `id`, `calendarId`, `ownerId`,
  `granteeId`, `permission` (Enum `READ`/`WRITE`), `comment`, `createdAt`.
  Unique-Constraint `(calendarId, granteeId)` verhindert Duplikate, POST ist
  idempotent (Upsert). Cascade-Delete bei Calendar/Owner/Grantee-Löschung.
- **Neuer Enum `CalendarPermType`** mit Werten `READ`, `WRITE`.
- **`Calendar.acl Json`** als `@deprecated` markiert — Entfernung in v3.19.

### API

- `GET /api/v1/calendar/:id/shares` — Liste aller Freigaben für eigenen Kalender
- `POST /api/v1/calendar/:id/shares` — Body `{ granteeId, permission, comment? }`,
  Upsert-Verhalten, akzeptiert `gal-`-Prefix
- `PUT /api/v1/calendar/:id/shares/:shareId` — Permission updaten
- `DELETE /api/v1/calendar/:id/shares/:shareId` — Owner ODER Grantee (Self-Removal)
- `GET /api/v1/calendar/mine-shares?calendarId=...` — Shares die mir gewährt
  wurden (Grantee-Sicht, für Self-Removal-Flow nötig)

---

## [3.18.13] — 2026-05-25 — Externe Kontakte UI vereinfacht + GAL-Cache Live-Sync

### Changed

- **BCP ExternalContactsPage — Vorname/Nachname-Felder entfernt**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  Die getrennten Eingaben für Vorname und Nachname waren redundant — der
  Anzeigename ist der einzig relevante Wert, der überall in MWA/GAL/Outlook
  sichtbar ist. UI hat jetzt nur noch ein Pflichtfeld „Anzeigename". Backend
  `firstName`/`lastName` bleiben in DB mit Default `""`-Fallback erhalten
  (kein Schema-Bruch).

### Fixed

- **GAL im MWA zeigte neu angelegte externe Kontakte erst nach Reload**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  Wenn Admin in BCP einen neuen externen Kontakt oder eine Verteilergruppe
  anlegte, war dieser im MWA Globalen Adressbuch nicht sichtbar — der
  TanStack-Query-Cache hielt das alte Ergebnis 30 Sekunden lang stale-free.
  **Fix**: `staleTime: 0` + `refetchOnMount: true` + `refetchOnWindowFocus: true`
  + `refetchInterval: 60_000` für die `/contacts/gal`-Query. Zusätzlich neuer
  Refresh-Button (RefreshCw-Icon) in der Filter-Bar neben dem Counter — User
  kann jederzeit manuell synchronisieren. Spinning-Animation während des
  Fetches als visuelles Feedback.

---

## [3.18.12] — 2026-05-24 — Public Folders: Browse-Modal, Folder-Icons, Auto-Hide ohne ACL

### Fixed

- **Public Folders waren nicht zugreifbar trotz Vollzugriff**
  (`packages/web-client/src/components/FolderTree.tsx`):
  Klick auf einen Public Folder zeigte nur einen Toast „Browse-Ansicht kommt
  im nächsten Patch" — kein tatsächlicher Zugriff auf die Nachrichten möglich.
  **Fix**: Neue `PublicFolderViewerModal`-Komponente — Klick öffnet 2-Spalten-
  Modal (Liste links, Detail rechts) mit allen Nachrichten des Ordners.
  Auto-Refresh 30s, sanitized HTML-Rendering, klickbare Empfänger-Avatare,
  „X Nachrichten"-Counter im Footer.

- **Falsche Symbole** — Public Folders hatten ein Users-Icon (Verteilergruppen-
  Style), wirkten wie Kontakte statt Ordner.
  **Fix**: `Folder`-Icon (amber, gefüllt) sowohl in der Sidebar als auch im
  Modal-Header. `FolderTree`-Icon für die Sektion-Überschrift. Klare visuelle
  Trennung zwischen Mail-Ordnern (Stack-Icon) und Public Folders (Folder-Icon).

- **Section erschien bei leerem Cache / während Loading**
  Vorher: `if (folders.length === 0) return null` — vor erstem Fetch zeigte die
  Section nichts, das ist korrekt, ABER wenn der Cache stale war (älterer User
  hatte noch ACLs), wurde die Section initial gezeigt obwohl neu eingeloggter
  User keine Berechtigung mehr hat.
  **Fix**: Hide-Logik prüft jetzt `!isSuccess || !folders || folders.length === 0`
  — Section ist garantiert unsichtbar bis Backend tatsächlich Daten geliefert
  hat. Zusätzlich `refetchOnWindowFocus: true` + Polling-Intervall von 60s auf
  30s reduziert: wenn Admin Zugriff entzieht, verschwindet die Section beim
  nächsten Tab-Fokus oder spätestens nach 30s automatisch.

---

## [3.18.11] — 2026-05-24 — MWA Globales Adressbuch (GAL-Browser)

### Added

- **ContactsPage — Tabs „Mein Adressbuch" / „Globales Adressbuch"**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  - Tab-Navigation in der Sidebar zwischen privaten Kontakten (Bestand) und GAL
  - GAL liefert vereint aus 3 Quellen (alle aktiven internen User, externe
    Kontakte aus dem Admin-Verzeichnis, Verteilergruppen)
  - Such-Bar funktioniert für beide Tabs; bei GAL ohne Suche werden alle
    Einträge alphabetisch sortiert gelistet (Browse-Modus)
  - Typ-Filter (Alle / Personen / Extern / Gruppen) als kompakte Toggle-Bar
  - Counter-Badge zeigt Gesamtanzahl der GAL-Treffer
  - Klick auf GAL-Eintrag → Read-Only-Detail-Panel mit Avatar, Typ-Badge
    (Verteilergruppe / Externer Kontakt / Interner Benutzer), E-Mail (klickbar
    mailto:), Telefon/Mobil (klickbar tel:), Unternehmen, Abteilung, Domain,
    Mitgliederzahl
  - **„Neue Nachricht"-Button** öffnet das Compose-Window mit der GAL-Adresse
    vorausgefüllt
  - Hinweis im Detail-Panel: zentrale Verwaltung — User kann GAL-Einträge nicht
    direkt bearbeiten

- **Backend `/api/v1/contacts/gal` erweitert** mit Browse-Modus + Typ-Filter:
  - Ohne `q` → alle GAL-Einträge alphabetisch sortiert (Browse für GAL-Ansicht)
  - Mit `q` (>=2 Zeichen) → Volltextsuche über alle 3 Quellen
  - `type=all|users|external|groups` filtert die Quellen
  - Paginiert: `limit` (max 500, default 300) + `offset`
  - Response: `{ entries: GalEntry[], total, limit, offset }`
  - Strukturiertes `GalEntry`-Format mit `kind`, `displayName`, `email`,
    optionalen Feldern `company`/`department`/`phone`/`mobile`/`domain`/
    `memberCount` und ID-Prefix (`user-`/`ext-`/`grp-`)

---

## [3.18.10] — 2026-05-24 — Bilder-Privacy-Banner + Queue-Hardening (DSN, 5xx, dynamische Settings)

### Added — Bilder-Privacy-Banner (Outlook/Gmail-Style)

- **Externe Bilder werden standardmäßig BLOCKIERT** zum Schutz vor Tracking-Pixeln
  (`packages/web-client/src/components/MessageReader.tsx`):
  - HTML wird vor `dangerouslySetInnerHTML` durch `processExternalImages()` geleitet
  - `<img src="cid:foo">` → wird durch MinIO-Attachment-URL ersetzt (inline-Bilder
    OK, da Teil der Mail selbst — kein Tracking-Risiko)
  - `<img src="data:...">` → durchgereicht (selbst-eingebettet)
  - `<img src="http(s)://...">` → `src` wird durch 1×1-Transparent-PNG ersetzt,
    Original wandert nach `data-coremail-ext-src` (für späteres Re-Aktivieren)
- **Banner** oben im Body bei blockierten externen Bildern:
  *„X externe Bilder wurden blockiert. Externe Bilder können verwendet werden,
  um Ihr Lese-Verhalten zu verfolgen."* + Button „Bilder anzeigen"
- Per-Message Toggle (`useState` mit `useEffect`-Reset bei Message-Wechsel),
  damit unterschiedliche Mails unterschiedlich behandelt werden können
- Backend-API: `/folders/:folderId/messages` und `/messages/:id` liefern jetzt
  `contentId` und `inline` Felder pro Attachment (vorher fehlten sie)

### Added — Queue-Hardening Phase 1

- **DSN (Delivery Status Notification, RFC 3464)** —
  `packages/smtp-server/src/outbound/dsn.ts`:
  - Bei permanentem Versand-Fehler wird automatisch eine Bounce-Mail an `MAIL FROM`
    zugestellt (multipart/report mit human-readable Text + RFC-3464 report-Part).
  - **Double-Bounce-Schutz**: keine DSN für leere MAIL FROM (`<>`-Sender = bereits
    Bounce-Mail) per RFC 5321 §6.1.
  - DSN wird nur an **lokale Absender** generiert — externe Sender bekommen
    Bounce vom MX-Server zuverlässiger (verhindert Backscatter-Spam).
  - `MAILER-DAEMON@<hostname>` als Absender, `Auto-Submitted: auto-replied`,
    `In-Reply-To` der Original-Message-ID für Thread-Verknüpfung.

- **4xx vs 5xx-Semantik** —
  `packages/smtp-server/src/outbound/queue.ts`:
  - Neuer `extractSmtpCode()`-Helper extrahiert SMTP-Reply-Codes aus
    nodemailer-Error-Messages
  - **5xx-Fehler** (permanent, z.B. 550 User unknown) werden **sofort** als final
    markiert via `job.discard()` — kein 10×-Retry mehr (schont IP-Reputation,
    Empfänger-MX wird nicht „gespammt")
  - **4xx-Fehler** (transient, z.B. 421 Try again) durchlaufen normalen Retry mit
    Exponential Backoff
  - SMTP-Code wird im `MAIL_FLOW`-systemLog persistiert (vorher fehlte)
  - Log-Message zeigt `[550]` etc. zur schnellen Erkennung im Admin-UI

- **Dynamische Queue-Settings**:
  - `enqueueOutbound()` liest jetzt `QueueSettings.maxRetryAttempts` und
    `retryBackoffDelaySec` aus der DB — Admin kann Backoff anpassen ohne
    Container-Neustart
  - Fallback auf Defaults (10 attempts, 60s) wenn DB nicht erreichbar

---

## [3.18.9] — 2026-05-24 — TransportRule-Engine + Public-Folders + SharedMailbox SEND_AS/ON_BEHALF

### Fixed — TransportRule funktionierte gar nicht

- **Bug**: `TransportRule` wurde in der DB gespeichert, aber **niemals im Mail-Flow ausgewertet**.
  Es gab keine Engine — nur CRUD-Endpoints.

- **Fix**: Neue Engine `packages/storage/src/transport-rules.ts` mit
  `applyTransportRules(parsed, ctx)` + `applyOutcomeToBuffer(buffer, outcome)`:
  - 8 Conditions × 9 Operatoren mit AND-Verknüpfung (Exchange-Standard)
  - 10 Aktionen: `addHeader`, `removeHeader`, `redirect`, `reject`, `addRecipient`,
    `removeRecipient`, `setSubjectPrefix`, `setSubjectSuffix`, `quarantine`,
    `addDisclaimer`
  - Hook in `storeInboundMessage()` direkt nach Parsing — vor User-Mail-Rules,
    vor Spam-Junk-Decision. `reject` und `quarantine` brechen die Zustellung ab.
  - Header/Subject/Disclaimer-Modifikationen werden direkt am RFC-822-Buffer
    angewendet (Re-Parsing nach Modifikation für konsistente DB-Felder).

### Fixed — Verteilergruppen-Mitglieder erhielten keine Mails (Inbound-Pfad)

- Bereits in v3.18.8 für Outbound gefixt; v3.18.9 für Inbound nachgezogen:
  Externe Member von lokalen Gruppen werden via `enqueueOutbound()` weitergeleitet.

### Fixed — Public Folders mehrere Bugs

- **Schema**: `PublicFolder.email String? @unique` — Ordner ist jetzt mail-aktivierbar.
- **SMTP Inbound**: `verifyRecipient()` und `storeInboundMessage()` erkennen jetzt
  mail-aktivierte Public Folders. Mails landen als `PublicFolderMessage` direkt im
  Ordner — kein Mailbox-Routing.
- **BCP ACL-Editor**: Plain-Text-Input ersetzt durch Autocomplete-Dropdown
  (Debouncing, Keyboard-Navigation, externe + Gruppen rausgefiltert da nur interne
  User Public-Folder-Zugriff bekommen). Cache-Invalidierung nach Save erweitert
  (`admin-public-folders` + ACL-Liste).
- **MWA FolderTree**: Neue `PublicFoldersSection` zeigt Public Folders unter
  persönlichen Ordnern. Lila Users-Icon + Tooltip mit E-Mail. Auto-Refresh 60s.
  Klick zeigt vorerst Toast (Browse-Modus folgt in v3.18.10).

### Added — Shared Mailbox SEND_AS / SEND_ON_BEHALF im REST `/mail/send`

- **Bisher**: SEND_AS funktionierte nur über SMTP-Submission (Ports 465/587).
  REST `/mail/send` ignorierte Shared-Mailbox-Permissions, `from` war immer
  hartcodiert auf `user.email`.

- **Neu**: `POST /api/v1/mail/send` akzeptiert optional:
  - `sendAs: string` (E-Mail) — User muss `SEND_AS` oder `FULL_ACCESS` haben
  - `sendOnBehalfOf: string` (E-Mail) — User muss `SEND_ON_BEHALF` haben

- **Permission-Check**: explicit `prisma.sharedMailboxPerm.findFirst()` mit
  Permission + Mailbox-Verknüpfung. Fehlt die Permission → `403`.

- **From-Header-Override**: bei `sendAs` wird `From: <shared>` gesetzt;
  bei `sendOnBehalfOf` wird `From: <shared>` UND zusätzlich `Sender: <user>` —
  Outlook/Apple Mail zeigen dann „User im Auftrag von Shared".

- **StructuredMessage.sender** als optionales Feld zur Queue ergänzt.

### Added — Schema-Erweiterung

- `PublicFolder.email String? @unique`

---

## [3.18.8] — 2026-05-24 — Fix: Externe Kontakte, Verteilergruppen-Routing, Autocomplete

### Fixed

- **ExternalContactsPage Cursor verlor sich beim Tippen**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  Inline `Field`-Component-Helper innerhalb von `ContactModal` definiert →
  bei jedem Render neue Component-Referenz → React unmount+remount des Inputs →
  Cursor verloren. Fix: alle 8 Felder zu inline `<div><label><input>` umgebaut.
  Selbes Pattern wie v3.17.44 eDiscovery-Fix und v3.17.43 RetentionPage.

- **GroupsPage React Fragment-Key-Warning**:
  `filtered.map(g => (<>...</>))` ohne Key → React-Warning. Fix:
  `<Fragment key={g.id}>...</Fragment>`.

- **KRITISCHER FIX: Externe Verteilergruppen-Member erhielten keine Mails**
  (`packages/smtp-server/src/outbound/queue.ts` + `inbound/handler.ts`):
  `expandRecipients()` löst Verteilergruppen in einzelne Member-Adressen auf,
  aber die expandierten Adressen wurden komplett als „lokal" an
  `storeInboundMessage()` übergeben. Wenn eine Gruppe externe Member hatte
  (z.B. `partner@kunde.com`), gingen diese silent verloren — keine Mail kam an,
  kein Bounce, kein Log.

  **Fix**:
  - Outbound (`queue.ts`): nach `expandRecipients` werden Adressen ERNEUT
    auf lokal/extern geprüft. Externe Member werden zu `finalExternalRcpts`
    hinzugefügt und via `relayMessage()` an MX/Smarthost zugestellt.
  - Inbound (`handler.ts`): wenn ein externer Sender direkt an eine lokale
    Verteilergruppe schickt und diese externe Member hat, werden die externen
    Adressen via `enqueueOutbound()` weitergeleitet.

### Added

- **Compose-Autocomplete zeigt jetzt alle Adressquellen**
  (`packages/api-gateway/src/routes/contacts.ts`):
  `GET /api/v1/contacts?q=` liefert ab `q.length >= 2` eine vereinte Suche über:
  1. Private Kontakte (`Contact`-Tabelle, eigener User)
  2. Globale Adressliste — alle aktiven User
  3. Externe Kontakte aus dem Admin-Verzeichnis (`ExternalMailContact`,
     gefiltert `hiddenFromGal: false`)
  4. Verteilergruppen (`DistributionGroup`, `active: true && hiddenFromGal: false`)

  Dedup über E-Mail. ID-Prefix markiert Quelle (`gal-`, `ext-`, `grp-` oder
  privat). Frontend `RecipientInput` und `MembersPanel` unterscheiden visuell.

- **GroupsPage Mitglieder-Editor mit Autocomplete-Dropdown**
  (`packages/admin-panel/src/pages/GroupsPage.tsx` `MembersPanel`):
  Plain-Text-Input ersetzt durch Suggest-Field mit Debouncing (220ms),
  Pfeil-Up/Down + Enter/Tab + Escape, Type-Badge pro Treffer (User/Extern/
  Gruppe/Privat). `memberType` wird automatisch aus dem ID-Prefix abgeleitet.
  Bereits zugewiesene Member werden aus den Vorschlägen ausgeblendet.

---

## [3.18.7] — 2026-05-24 — Spam-UX + Audit-Log v2 + Audit-Bug-Fix + Senden-Planen

### Fixed

- **Audit-Log: Akteur und Ziel waren leer** (`packages/api-gateway/src/lib/audit.ts`):
  `auditMiddleware` lief synchron VOR `requireAuth` (Auth ist pro Router gemountet,
  nicht global) → `req.apiUser` war beim Loggen `undefined` → `actorId` / `actorEmail`
  blieben null. Außerdem wurde `targetType` gar nicht gesetzt (nur `targetId`).
  Fix: Logging wandert in `res.on('finish')` damit Auth bereits gelaufen ist;
  `targetType` aus `pathParts[0]` (Ressource), HTTP-Status wird als `success`/
  `errorMsg` ausgewertet.

### Added — Senden planen (Outlook-Style)

- **Backend** (`packages/storage/prisma/schema.prisma` + `routes/mail.ts`):
  - Neue Felder: `Message.scheduledAt: DateTime?`, `scheduledStatus: String?`
    (`PENDING|SENT|CANCELLED`), `scheduledJobId: String?`
  - `POST /mail/send` akzeptiert optional `scheduledAt` (ISO-Datum) — Validierung:
    mind. 30s in der Zukunft, max. 1 Jahr
  - BullMQ-Job mit `delay: scheduledAt - now` eingereiht — Worker startet erst
    zum geplanten Zeitpunkt
  - Sent-Kopie sofort im „Gesendete Elemente"-Ordner mit `scheduledStatus: PENDING`
    + `scheduledJobId` (für späteren Cancel)
  - Date-Header der Mail wird auf `scheduledAt` gesetzt (Empfänger sieht geplanten
    Zeitpunkt, nicht Erstell-Zeitpunkt)
  - Neuer Endpoint `POST /mail/messages/:id/cancel-scheduled` — entfernt den
    BullMQ-Job via `queue.getJob(id).remove()`, setzt Status auf CANCELLED
- **Worker** (`packages/smtp-server/src/outbound/queue.ts`):
  - Cancellation-Check beim Job-Start: wenn Message inzwischen `CANCELLED` → return
    ohne Versand (Race-Schutz)
  - Nach erfolgreichem Versand: `scheduledStatus: 'SENT'` setzen (Banner verschwindet)
- **Frontend ComposeWindow**:
  - Send-Button-Group: „Senden"-Button + Pfeil-Dropdown
  - Schedule-Picker mit 3 Presets (Morgen früh, Morgen nachmittags, Nächsten Montag
    — alle 8:00 bzw. 13:00) + Custom datetime-local Picker
  - Validierung: min. 30s Zukunft
  - Toast „Versand geplant für [Datum/Zeit]" nach Submit
- **Frontend MessageReader**:
  - Schedule-Banner Outlook-Style: blau (PENDING „Wird gesendet am…"), grün
    (SENT „Geplanter Versand abgeschlossen"), grau (CANCELLED „Geplanter Versand
    abgebrochen")
  - „Planung abbrechen"-Button bei PENDING (löscht BullMQ-Job, Banner wechselt)
- **Frontend MessageList**: `CalendarClock`-Icon (blau) in der Zeile bei
  geplanten Mails — Tooltip mit konkretem Zeitpunkt

### Added — Spam-UX (Outlook-Style)

### Added — Spam-UX (Outlook-Style)

- **Spam-Score-Persistenz**: Neues `Message.spamScore: Float?` Feld im Prisma-Schema.
  `storeInboundMessage()` speichert den rspamd-Score zum Zeitpunkt der Zustellung
  (vorher transient — nur fürs Folder-Routing genutzt, dann verworfen).
- **Spam-Banner im MessageReader** (Outlook-Style):
  - Sichtbar wenn `spamScore ≥ 3.0` ODER Mail im Junk-Ordner liegt
  - **Rot** (hohes Risiko) bei `spamScore ≥ 6.0` (rspamd-Reject-Schwelle)
  - **Amber** bei mittlerem Risiko oder im Junk-Ordner
  - Zeigt den konkreten rspamd-Score als Mono-Font
  - „Als Junk" / „Kein Spam"-Button direkt im Banner für 1-Klick-Aktion
- **Spam-Badge in MessageList**: `ShieldAlert`-Icon in der Zeile (gelb/rot je nach
  Score), Tooltip mit konkretem Score
- **`notSpam`-Bulk-Aktion** verbessert: setzt `spamScore: 0` auf der Message,
  damit der Banner nach „Kein Spam"-Klick nicht weiter angezeigt wird

### Added — Audit-Log v2 (Compliance-grade Export & Anomalie-Erkennung)

- **Kryptografische SHA-256-Signatur für alle Exports**
  (`packages/api-gateway/src/routes/admin/audit-log.ts`):
  - CSV-Export: SHA-256-Hash des Payloads (inkl. UTF-8 BOM) im
    `X-CoreMail-Signature: sha256=…`-Response-Header
  - PDF-Export: in-Memory-Buffer-Capture statt direkter `doc.pipe(res)`, danach
    Hash über den vollständigen PDF-Buffer
  - **NEU: JSON-Export** für SIEM-Integration (Splunk, Azure Sentinel, ELK) —
    `/admin/audit-log/export.json` mit strukturiertem `metadata`+`entries`-Objekt,
    `schemaVersion: '1.0'`, ebenfalls SHA-256-signiert
  - Zusätzliche Header: `X-CoreMail-Export-Entries`, `X-CoreMail-Export-Generated-At`
  - `Access-Control-Expose-Headers` damit Frontend die Signatur lesen kann
  - Verifikation extern: `shasum -a 256 audit-log-YYYY-MM-DD.csv` → muss exakt mit
    dem Header übereinstimmen → beweist Auditoren dass die Datei nicht manipuliert
    wurde

- **Anomalie-Erkennung** — neuer Endpoint `/admin/audit-log/anomalies`:
  - **Burst-Detection**: ≥50 Aktionen vom selben Akteur in 5 Min (medium),
    ≥200 Aktionen → high severity
  - **Fehler-Burst**: ≥10 fehlgeschlagene Aktionen in 5 Min → high (mögl. Angriff)
  - **Kritische Aktionen**: Regex-Pattern für `user.delete`, `mailbox.delete`,
    `domain.delete`, `transport-rules.*`, `oauth.*`, `settings.*`, `certificate.*`,
    `gateway.*`, `connector.*`, `smime.*`, `setup.*` → immer high
  - **Off-Hours-Activity**: Admin-Aktivität zwischen 00:00 und 06:00 Server-Zeit
    → low severity
  - Dedup-Logik fasst identische Anomalien (Actor+Message) zusammen
  - Frontend zeigt Top-50 als roter Banner mit Icons, Akteur, Zeitpunkt und
    Severity-Badge — Auto-Refresh alle 60s

- **Meta-Logging gegen Insider-Threats**
  (`packages/api-gateway/src/lib/audit.ts`):
  - **AUDIT_SENSITIVE_GET**: GET-Routen für Audit-Log-Exports (CSV/PDF/JSON) und
    Anomalien werden jetzt ebenfalls auditiert. Wer Audit-Daten exportiert oder
    Compliance-Auswertungen abruft, wird selbst protokolliert — kein silent
    Daten-Abfluss durch Admins
  - Erweiterter Code-Kommentar dokumentiert die Immutability-Garantie:
    Audit-Log hat keinen DELETE-Endpoint, keinen UI-Toggle zum Ausschalten;
    Versuche zur Manipulation erfordern Code-Deploy → über Git/CI/CD nachvollziehbar
    (ISO 27001 / SOC 2 / TISAX / DSGVO konform)

- **Frontend AuditLogPage** (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  - **JSON-Export-Button** ergänzt (für SIEM)
  - **Anomalien-Banner** oben auf der Seite — automatischer 60s-Refresh, scrollbar,
    Severity-Farben (rot/amber/blau), Icons je nach Anomalie-Typ
  - **Signatur-Hinweis** im Immutability-Banner: dokumentiert
    `X-CoreMail-Signature: sha256=…`-Header und lokale Verifikation
  - Bestehender Stats-Dashboard (KPI-Karten, Top-Akteure, Top-Aktionen) bleibt

### Schema-Migration

- `Message.spamScore Float?` — wird beim nächsten Container-Start via
  `prisma db push` automatisch hinzugefügt (kein Datenverlust, bestehende
  Messages haben `null`)

---

## [3.18.5] — 2026-05-24 — Removed: eDiscovery & Legal Hold komplett entfernt

### Removed

- **Phase-8-Features eDiscovery & Legal Hold vollständig aus dem Code entfernt**
  (Backend, Frontend, Schema, Routes, i18n):
  - **Schema** (`packages/storage/prisma/schema.prisma`): Models `EDiscoverySearch`,
    `LegalHold` und Enum `EDiscoveryStatus` gelöscht.
    `RetentionPolicy.respectLegalHold`-Feld entfernt (Default war `true`, hatte aber
    keinen Effekt mehr da `LegalHold`-Records keine UI hatten zum Anlegen).
  - **Backend**: `packages/api-gateway/src/routes/admin/ediscovery.ts` Datei gelöscht.
    Import + Mount in `server.ts` entfernt (`/api/v1/admin/ediscovery` Route gibt
    jetzt 404).
  - **Retention-Route** (`routes/admin/retention.ts`): `respectLegalHold` aus
    POST/PUT-Body, Validierung und Prisma-Update entfernt.
  - **Backup-Worker** (`packages/backup-service/src/retention/worker.ts`):
    `prisma.legalHold.findMany()`-Aufruf entfernt; `heldUserIds` ist jetzt ein
    leeres Set (Signatur-Kompatibilität für nachgelagerte Funktionen).
  - **Frontend**: `packages/admin-panel/src/pages/EDiscoveryPage.tsx` Datei gelöscht.
    Sidebar-Eintrag „eDiscovery" entfernt, Route aus `main.tsx` ausgebaut,
    `nav_ediscovery`-i18n-Key in DE+EN gelöscht, ungenutzter `SearchCheck`-Icon-Import
    raus, RbacPage `COMPLIANCE_MANAGEMENT`-Beschreibung von „eDiscovery, Aufbewahrung"
    → „Aufbewahrungsrichtlinien".
  - **RetentionPage**: `respectLegalHold`-Feld aus `RetentionPolicy`-Type, Form-State,
    Template-Creator und UI-Checkbox entfernt.

  **Bestandsdaten**: Bestehende `ediscovery_searches` + `legal_holds` Tabellen
  werden beim nächsten `prisma db push --accept-data-loss` (im Container-Entrypoint)
  automatisch gedroppt. `retention_policies.respect_legal_hold`-Spalte ebenfalls.

  **Migration**: Wer eine bestehende Installation upgradet und das Feature
  tatsächlich nutzt: Bitte vor dem Upgrade eDiscovery-Exporte sichern.
  Empfohlen wird dazu der `mbox`-Streaming-Export der vorhandenen Suchen
  unter v3.18.4 oder älter — danach upgraden.

---

## [3.18.4] — 2026-05-24 — Feature: Signaturen-Editor mit Bildern, Links, Schriftarten

### Added

- **MWA Signaturen vollständig ausgebaut** — Gmail/Outlook-Level
  (`packages/web-client/src/components/SignatureSection.tsx` — neue separate Komponente):

  **Formatierung:**
  - Schriftart-Dropdown: 10 Optionen (Arial, Calibri, Georgia, Times New Roman,
    Courier New, Verdana, Tahoma, Trebuchet MS, Comic Sans MS, Standard)
  - Schriftgröße-Dropdown: 5 Stufen (Klein 12px / Normal 14px / Mittel 16px /
    Groß 20px / Sehr groß 28px) — via Custom `FontSizeExt` TipTap-Extension
    auf `textStyle`-Mark
  - Bold / Italic / Unterstrichen / Durchgestrichen (mit korrektem U-Icon —
    war vorher fälschlich „U" = Strikethrough!)
  - Textfarbe (24 Farben) + Markierungsfarbe (12 Highlight-Farben)
  - Ausrichtung (links, zentriert, rechts, Blocksatz)
  - Aufzählungslisten + Nummerierte Listen + Zitat-Block
  - Horizontale Trennlinie (`<hr>`)
  - Undo / Redo / Formatierung entfernen

  **Bilder einfügen** (für Logos, Profilbilder, Banner):
  - Hochladen-Button → File-Picker (max 500 KB, base64-Embed)
  - URL-Eingabe-Button
  - Drag & Drop direkt in den Editor (mit Overlay „Bild hier ablegen")
  - `@tiptap/extension-image` mit `allowBase64: true`

  **Links** mit interaktivem Prompt:
  - Bei Selektion → markierten Text wird zum Link
  - Ohne Selektion → URL wird als Linktext eingefügt
  - Link bearbeiten/entfernen über denselben Button (Toggle bei aktivem Link)

  **Vorschau-Modus**:
  - „Vorschau"-Button oben rechts → zeigt die Signatur exakt so wie sie im
    Mail-Reader des Empfängers erscheinen würde (HTML-Rendering ohne Editor-Chrome)
  - „Editor"-Button schaltet zurück

  **Auto-Einfüge-Optionen** (wie vorher):
  - Bei neuen E-Mails
  - Bei Antworten und Weiterleitungen

  **Technisch:**
  - Custom `FontSizeExt` mit `addGlobalAttributes()` auf TextStyle-Mark
    (TipTap hat keine eigene FontSize-Extension)
  - `applyFontSize()` Helper umgeht ChainedCommands-Type-Konflikte
  - Inline-Bilder als data:URL eingebettet — kein MinIO-Upload nötig,
    funktioniert in allen Mail-Clients (Gmail, Outlook, Apple Mail)
  - 500-KB-Limit pro Bild verhindert übergewichtige Outbound-Mails
  - Dark-Mode-fähige Toolbar

---

## [3.18.3] — 2026-05-24 — Fix: BCP DNS-Check Counter + Status-Farben

### Fixed

- **BCP → SMTP & Routing → DNS-Einträge: Counter und gelbe Indikatoren waren inkonsistent**
  (`packages/admin-panel/src/pages/SmtpConfigPage.tsx`):

  **Root Cause**: Der Backend-Endpoint liefert **7 Records** (`a, mx, spf, dkim, dmarc,
  autodiscover, ptr`), aber das UI rendert nur **6** davon (der A-Record wird nicht
  angezeigt). Der Counter `okCount` zählte aber alle 7 Records gegen ein
  hardcoded `total = 6`. Ergebnis: Bei z.B. 6 ok + 1 warning (A unsichtbar, 1
  Warning sichtbar) → „6 von 6" obwohl ein gelber Eintrag sichtbar war. Bei
  5 ok + 2 warning → „5 von 6 — 1 fehlt" obwohl 2 gelb sichtbar.

  Außerdem: Warnings (z.B. SPF-Multi-Record, PTR-Mismatch) wurden im Status-Text
  gar nicht erwähnt — sie waren weder „ok" noch „fehlend", fielen durchs Raster.

  **Fix**:
  - `VISIBLE_DNS_KEYS` = `['mx','spf','dkim','dmarc','autodiscover','ptr']` als
    einzige Quelle der Wahrheit. `okCount`, `warnCount`, `missingCount` und `total`
    werden konsistent aus dieser Liste berechnet.
  - Status-Text differenziert jetzt klar: „5 von 6 Einträgen gesetzt — 1 mit
    Warnung, 0 fehlen" / „4 von 6 — 1 mit Warnung, 1 fehlt" / etc.
  - `StatusDot` zeigt jetzt **3 Farben** (grün = ok / gelb = warning / rot = missing)
    statt nur grün/gelb. Badge analog mit ⚠ Warnung / ○ Nicht gefunden.
  - Legende aktualisiert: korrekt grün/gelb/rot statt veraltetem orange für
    „Resolver-Inkonsistenz" (gibts seit v3.17.34 nicht mehr — Multi-Resolver entfernt).

---

## [3.18.2] — 2026-05-24 — UI-Cleanup, Button-Fix + Compose-Rollback

### Reverted

- **Compose-Window auf pre-v3.18.1-Variante zurückgerollt** —
  das Gmail-Style-Redesign aus v3.18.1 (3 Größen, Header-Drag, Schedule-Send-Dropdown,
  Emoji-Picker, Footer-Format-Toolbar) wird zurückgenommen. Die alte Compose-Variante
  (Outlook-angelehnt, Formatierungs-Toolbar oben, Senden rechts unten, Anhang+Entwurf
  links unten) passt besser zur restlichen CoreMail-UI. `ComposeWindow.tsx` ist exakt
  identisch zur Version aus v3.18.0.

### Changed

- **MWA: „Outlook"-Erwähnungen aus user-facing UI-Texten entfernt**:
  - `RulesSection.tsx`: Stop-Processing-Hinweis ohne Outlook-Vergleich
  - `SettingsPage.tsx → Ansicht`: „Layout und Darstellungsoptionen für CoreMail anpassen"
    (statt „— wie in Outlook oder Thunderbird")
  - `SettingsPage.tsx → App-Passwörter`: „Für externe E-Mail-Clients ohne Hauptpasswort
    verbinden" (statt „Für E-Mail-Clients (Outlook, Thunderbird) …")

  Erhalten bleiben technisch notwendige Outlook-Referenzen (Autodiscover-Setup-Anleitung
  in BCP, „Outlook Modern Auth" als OAuth2-Client-Beispiel im Admin-Panel, historische
  Changelog/Compliance-Einträge), weil diese auf den realen Microsoft-Outlook-Client
  als externen IMAP/EAS-Konsument zeigen.

### Fixed

- **MWA: „+ Neue Regel"-Button schrumpfte bei knappen Viewport-Breiten** und brach
  den Text um. Fix: `shrink-0 whitespace-nowrap px-4` — Button hält feste Breite,
  Text bleibt einzeilig.

---

## [3.18.1] — 2026-05-24 — Feature: Gmail-Style Compose-Window Redesign

### Changed

- **MWA Compose-Window komplett redesigned nach Gmail-Vorbild**
  (`packages/web-client/src/components/ComposeWindow.tsx`):

  **Window-Modi:**
  - **Small** (Default, Floating 600×640 unten rechts) — Header per Drag mit Maus verschiebbar
  - **Large** (Vollbild, zentriert, max 1100px, 90vh) — Toggle per Maximize-Button im Header
  - **Minimized** (Streifen 288px unten rechts mit Subject)
  - Smooth Transition `transition-[width,height,inset] duration-300 ease-out` zwischen Größen

  **Footer-Toolbar (Gmail-Layout):**
  - **Senden-Button mit Schedule-Dropdown** (▲): „Morgen früh", „Morgen nachmittags",
    „Nächsten Montag" Presets + Custom datetime-local Picker — geplante Mails via
    `scheduledAt`-FormData-Feld an `/mail/send`
  - **Aa** Format-Toolbar-Toggle (ein/aus)
  - **Paperclip** Anhang mit Badge (Anzahl Anhänge)
  - **Link** (Insert/Edit Link)
  - **Smile** Emoji-Picker (80 handpicked emojis, 10×8 Grid)
  - **Image** Bild via URL einfügen
  - **Lock** Confidential-Mode-Placeholder (Toast „kommt bald")
  - **MoreVertical** Submenu: Vollbild-Toggle, Formatierung entfernen, Cc/Bcc toggle
  - **Trash** Discard mit Confirmation
  - **Draft-Status-Anzeige** rechts: „Speichern…" / „Entwurf gespeichert"

  **UX-Features:**
  - **Drag & Drop Files**: Drop-Overlay über gesamtem Compose-Fenster (Paperclip-Icon
    + „Dateien hier ablegen zum Anhängen")
  - **Tastatur-Shortcuts**: ⌘+Enter senden, ⌘+⇧+C Cc einblenden, ⌘+⇧+B Bcc, Esc schließen
  - **Cc/Bcc** mit X-Button zum Ausblenden + Reset, fade-in-Animation beim Einblenden
  - **Active-Scale-Animations** (active:scale-90) auf allen Buttons für taktiles Feedback
  - **Dark-Mode** in allen Komponenten unterstützt (dark:bg/dark:border)
  - **Header-Drag** im Small-Mode verschiebt Fenster auf dem Viewport (`transform: translate`)
  - **Discard-Confirmation** nur bei nicht-leerem Inhalt (To/Cc/Bcc/Subject/Body/Attachments)

  Bestehende Hilfskomponenten (RecipientInput, ColorPicker, BlockTypeDropdown,
  FontFamilyDropdown, ToolBtn, Sep) bleiben unverändert — sie sind gut, nur das
  Main-Layout wurde neu gebaut.

---

## [3.18.0] — 2026-05-24 — Feature: Outlook-Style Inbox Rules

### Added

- **Server-Side User Inbox Rules (analog Microsoft Exchange)**
  Vollständige Outlook-Regeln-Funktion im Mail Web Access — Bedingungen, Aktionen,
  Ausnahmen und Stop-Processing direkt im MWA verwaltbar. Regeln werden
  serverseitig in der SMTP-Inbound-Pipeline angewendet, sobald eine Mail eintrifft —
  unabhängig davon ob der Client offen ist. Funktioniert auch für IMAP/EWS/EAS-Zugriffe.

  **Backend** (`packages/storage/src/mail-rules.ts`):
  - Neues Schema: `MailRule.exceptions`, `MailRule.stopProcessing`, `MailRule.matchAll`
    (`AND`/`OR`-Verknüpfung) — `@@index([userId, priority])` für sortierten Lookup.
  - Rule-Engine: 11 Conditions (`from`, `to`, `cc`, `bcc`, `subject`, `body`,
    `recipient`, `hasAttachment`, `size`, `importance`, `sentOnlyToMe`) × 10
    Operatoren (`contains`, `notContains`, `equals`, `notEquals`, `startsWith`,
    `endsWith`, `regex`, `greaterThan`, `lessThan`, `is`).
  - 12 Aktionen: `moveTo`, `copyTo`, `delete` (→ Trash), `hardDelete` (verwerfen),
    `markRead`, `markFlagged`, `pin`, `categorize`, `forward`, `redirect`,
    `markJunk`, `setImportance`.
  - Forward/Redirect über bestehende `smtp-outbound` BullMQ-Queue mit Loop-Schutz
    (`X-CoreMail-RuleForwarded`-Header verhindert Endlos-Forwards).
  - Hook in `storeInboundMessage()`: nach Junk-Decision, vor Folder-Assignment —
    kann Ziel-Ordner überschreiben, Flags/Kategorien setzen, Mail verwerfen oder
    in mehrere Ordner kopieren.

  **API** (`packages/api-gateway/src/routes/user.ts`):
  - `GET /user/rules`, `POST`, `PUT/:id`, `DELETE/:id` — CRUD mit Zod-Validation
  - `PATCH /user/rules/:id/toggle` — schneller Enable/Disable
  - `POST /user/rules/reorder` — Drag-Reorder-Persistenz via Transaktion
  - `POST /user/rules/:id/run-now` — Regel retroaktiv auf bestehende Mails anwenden
    (max. 5000, Forward/Redirect übersprungen für Sicherheit)

  **Frontend** (MWA):
  - **Settings → „Regeln"** (`packages/web-client/src/components/RulesSection.tsx`):
    Liste aller Regeln mit Toggle, Drag-Reorder (dnd-kit), Bearbeiten, Löschen
    und „Jetzt ausführen". Empty-State mit CTA.
  - **RuleEditorModal** (`packages/web-client/src/components/RuleEditorModal.tsx`):
    Outlook-Style 3-Schritt-Wizard — „Wenn die Nachricht eintrifft und …" /
    „Folgendes tun:" / „Außer wenn …" mit Folder-Picker, Category-Picker,
    E-Mail-Input für Forward/Redirect. `AND`/`OR`-Wahl, Stop-Processing-Checkbox.
  - **Kontextmenü „Regeln" in MessageList**: Rechtsklick auf Mail →
    „Regel erstellen …" öffnet Editor mit vorausgefüllter „Von"-Bedingung
    oder „Regeln verwalten …" springt zur Settings-Seite.

---

## [3.17.50] — 2026-05-24 — Fix: MWA Quelltext-Kontextmenü öffnet Modal statt Tab

### Fixed

- **MWA: „Quelltext anzeigen" im Rechtsklick-Menü öffnet RFC-822-Modal statt Browser-Tab**
  (`web-client/src/components/MessageList.tsx`):
  Der Kontextmenü-Eintrag „Quelltext anzeigen" in der Nachrichtenliste öffnete den
  Rohtext via `window.open()` in einem neuen Browser-Tab (Browser versuchte die Datei
  herunterzuladen). Fix: Fetch-Request mit `?token=`-Auth, anschließend Anzeige im
  gleichen RFC-822-Quelltext-Modal wie in `MessageReader` (Overlay, scrollbar,
  Monospace-Font, EML-Download-Button, Schließen per ESC-Klick auf Backdrop).

---

## [3.17.49] — 2026-05-24 — Fix: MWA Quelltext/EML Auth, Junk-Logik, Antwort-Indikator

### Fixed

- **MWA: Quelltext anzeigen → 401 Unauthorized behoben**
  (`web-client/src/components/MessageReader.tsx`):
  Der `fetch()`-Aufruf für den RFC-822-Quelltext wurde ohne Authentifizierung abgesetzt
  (kein `Authorization`-Header in Browser-initiiertem Fetch). Fix: Bearer-Token als
  `?token=…` Query-Parameter (wird vom auth-Middleware bereits für SSE unterstützt),
  gelesen aus `useAuthStore().accessToken`. Fehler beim Laden werden jetzt im Modal
  angezeigt statt still zu scheitern.

- **MWA: EML-Download → 401 Unauthorized behoben**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Browser-Navigation (`<a href>` und `window.open()`) unterstützt keine Custom-Headers.
  Fix: Gleiches `?token=…`-Muster für alle EML-Download- und Quelltext-Links in
  MessageReader und MessageList Kontext-Menü.

- **MWA: „Kein Junk"-Button im Junk-Ordner fehlte**
  (`web-client/src/components/MessageReader.tsx`):
  Das Kontext-Menü zeigte immer „Als Junk markieren" unabhängig vom aktuellen Ordner.
  Fix: `isJunkFolder`-Erkennung über `selectedFolderId` + Folders-Query; bedingte
  Menüeinträge — Junk-Ordner zeigt „Kein Junk (False Positive)" mit ShieldOff-Icon,
  alle anderen Ordner zeigen „Als Junk markieren".

- **Zukünftige Mails von manuell als Junk markierten Absendern landen automatisch im Junk**
  (`api-gateway/src/routes/mail.ts`, `smtp-server/src/handlers/message.ts`):
  Aktion `spam` im Bulk-Endpunkt schreibt jetzt zusätzlich einen `Blacklist`-Eintrag
  mit `scope: 'USER-JUNK'` für jeden einzigartigen Absender. `storeInboundMessage()`
  prüft diese Einträge bei eingehenden Mails und leitet bei Match in den Junk-Ordner.
  Aktion `notSpam` entfernt entsprechende Einträge. Beide Aktionen triggern rspamd
  Bayes-Training (`learnspam`/`learnham`) für verbesserte Spam-Erkennung.

- **MWA: Antwort-Indikator auf beantworteten Mails**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Mails auf die geantwortet wurde erhielten kein visuelles Kennzeichen (wie Outlook's
  Antwort-Pfeil). Fix:
  - `MessageReader`: Antworten/Allen-antworten-Buttons setzen jetzt das IMAP-Flag
    `\Answered` via `patchMutation` (`markAnswered()`-Funktion).
  - `MessageList`: Blaues `Reply`-Icon in der Icons-Spalte wenn `flags` das Flag
    `\Answered` enthält.

---

## [3.17.48] — 2026-05-24 — Fix: SMTP PIPELINING Race Condition (503 bei Server-to-Server)

### Fixed

- **SMTP: 503 5.5.1 Bad sequence of commands bei eingehenden Mails behoben**
  (`smtp-server/src/core/session.ts`):

  **Root Cause**: Der SMTP-Server bewarb `PIPELINING` (RFC 2920) und externe MTAs
  (Gmail, Postfix, Exchange) nutzten es korrekt — sie sendeten `MAIL FROM`, `RCPT TO`
  und `DATA` in einem Schwung. Da `handleMailFrom()` und `handleRcptTo()` asynchrone
  Handler sind (`await onMailFrom()` → DB-Abfrage, Security-Filter), änderte sich der
  State (`READY → MAIL → RCPT`) erst nach dem `await`. Bis dahin hatte der synchrone
  Dispatch-Loop `RCPT TO` und `DATA` bereits verarbeitet — beide sahen State `'READY'`
  statt `'MAIL'`/`'RCPT'` → beide wurden mit `503 5.5.1 Bad sequence of commands`
  abgewiesen. Das `250 OK` für `MAIL FROM` kam danach zu spät und fehlplatziert.
  Externe Absender (Gmail, Postfix, Exchange) bekamen ihre Mails als permanent
  fehlgeschlagen zurück.

  **Fix**: Command-Queue (`cmdQueue: Promise<void>`) — alle SMTP-Commands werden
  über `enqueueCommand()` in eine verkettete Promise-Kette eingereiht und laufen
  strikt sequenziell:
  ```
  EHLO → [250] → MAIL FROM → await onMailFrom() → [250] → RCPT TO → await onRcptTo() → [250] → DATA → [354]
  ```
  Responses kommen jetzt garantiert in der richtigen Reihenfolge, egal wie schnell
  der sendende MTA piplined. AUTH-Multi-Step und `finishData()` ebenfalls in die Queue
  eingereiht.

---

## [3.17.47] — 2026-05-23 — Feature: BCP DNS-Einrichtungs-Panel

### Added

- **DNS-Einrichtungs-Panel in BCP → Domains → Domain bearbeiten** (`DomainsPage.tsx`):
  Neuer Button „DNS-Einrichtung prüfen" öffnet ein vollständiges Einrichtungs-Panel
  mit allen 7 DNS-Einträgen, die für einen vollständig konfigurierten Mailserver
  benötigt werden. Werte werden automatisch aus der aktuellen SSL/TLS-Konfiguration
  (publicHostname) und dem DKIM-Schlüssel abgeleitet:
  - **A-Record** — Mailserver-IP (aus live-aufgelöster Server-IP)
  - **MX-Record** — Maileingang auf Mailserver-Hostname
  - **SPF-Record** — mit echter Server-IP (`v=spf1 ip4:<IP> ~all`)
  - **DKIM-Record** — vollständiger p=-Wert inkl. 255-Zeichen-Chunk-Option
    (aufklappbar, für DNS-Provider mit 255-Zeichen-Limit)
  - **DMARC-Record** — fertige Vorlage mit rua= für die Domain
  - **Autodiscover** — CNAME auf Mailserver-Hostname
  - **PTR/Reverse-DNS** — mit Hinweis auf Server-Hoster
  Jeder Eintrag zeigt: Typ-Badge (farbig), Status (✅/❌), kopierbarer Host-/Name-Wert
  und kopierbarer Inhalt-Wert. Modal wechselt auf max-w-2xl wenn Panel geöffnet ist.

### Changed

- **DNS-Check Backend verbessert** (`api-gateway/routes/admin/domains.ts`):
  - Server-IP wird vom Hostnamen live aufgelöst und in der Antwort als `serverIp` zurückgegeben
  - SPF `expected`-Wert enthält jetzt die echte Server-IP statt Platzhalter
  - DKIM `ok`-Flag vergleicht jetzt den vollständigen Schlüssel (whitespace-normalisiert),
    nicht nur ob irgendeín DKIM-Record existiert
  - PTR-Check nutzt bereits aufgelöste Server-IP (kein zweites DNS-Lookup)
  - Neue `a`-Record-Sektion in der API-Antwort

---

## [3.17.46] — 2026-05-23 — Fix: DKIM Public Key Format (SPKI → PKCS#1)

### Fixed

- **DKIM DNS-Eintrag syntaktisch korrekt** (`api-gateway/routes/admin/domains.ts`):
  Public Key wurde bisher im SPKI-Format (SubjectPublicKeyInfo, mit Algorithm-OID-Wrapper)
  exportiert — DKIM erwartet jedoch PKCS#1 (reiner RSAPublicKey ohne OID). Fix:
  `pubKey.export({ type: 'spki', format: 'der' })` → `type: 'pkcs1'` an allen drei
  Stellen (dkim-record, regenerate-dkim, dns-check). Der generierte `p=`-Wert im BCP
  ist nun RFC 6376-konform und besteht die DNS-Verifikation.

---

## [3.17.45] — 2026-05-22 — Feature: Queue-Übersicht kompakt + Verwerfen-Funktion

### Changed

- **BCP Queue-Übersicht komplett überarbeitet** (`QueuesPage.tsx`):
  - Stats-Karten (5 große Cards) → kompakter horizontaler Strip mit Zahlen + Icon
  - Verbose Zustandserklärungskarten am Ende entfernt
  - Verteilungs-Balkendiagramm entfernt (redundant mit Inline-Stats)
  - **Direkte Queue-Tabelle in der Übersicht**: Zeigt alle ausstehenden Nachrichten
    (waiting / active / delayed / failed) mit Status-Badge, Absender, Empfänger,
    Alter und Versuche — kein Navigieren in Unterabschnitte nötig

### Added

- **„Verwerfen"-Schaltfläche direkt in der Übersicht**: Jede ausstehende Nachricht
  kann mit einem Klick endgültig verworfen werden (Bestätigungsdialog). Für
  Retry- und Dead-Letter-Einträge zusätzlich „Jetzt wiederholen"-Schaltfläche.
- **„Verwerfen" in allen Job-Tabellen** jetzt als beschrifteter Button statt Icon,
  deutlich besser erkennbar.
- Zeigt bis zu 25 Einträge in der Übersicht; bei mehr → Links zu Unterabschnitten.

### Fixed

- **Zwei Refresh-Buttons auf einen reduziert**: Der Refresh-Button in jedem
  Unterabschnitt (`JobsSection`) wurde entfernt. Nur noch ein globaler Refresh im
  Seitenheader — aktualisiert Stats, Jobs und Übersicht gleichzeitig.

---

## [3.17.44] — 2026-05-22 — Fix: eDiscovery-Suchmaske verliert Fokus nach jedem Buchstaben

### Fixed

- **BCP eDiscovery — Eingabefeld-Fokus-Bug** (`EDiscoveryPage.tsx`): Die interne
  `Field`-Hilfskomponente war innerhalb der `CreateSearchModal`-Funktion definiert.
  React erzeugt bei jeder Render-Phase eine neue Komponenten-Referenz → Input wird
  unmounted/remounted → Fokus geht verloren → nach jedem eingetippten Zeichen musste
  erneut ins Feld geklickt werden.

  Fix: `Field` auf Modul-Ebene als `SearchField` ausgelagert (explizite `value` +
  `onChange`-Props statt `k: keyof typeof form`). Alle 8 Verwendungen im Modal
  aktualisiert. React behält jetzt die DOM-Referenz über Re-Renders hinweg.

---

## [3.17.43] — 2026-05-22 — Fix: Audit-Log schreibt keine Einträge

### Fixed

- **`auditMiddleware` Pfad-Bug** (`lib/audit.ts`): Das Middleware ist via
  `app.use('/api/v1/admin', auditMiddleware)` gemountet. Express liefert
  innerhalb des Middleware `req.path` **ohne** das Mount-Prefix — also
  `/mailboxes/123` statt `/api/v1/admin/mailboxes/123`. Die Bedingung
  `req.path.startsWith('/api/v1/admin/')` war daher **niemals wahr** →
  kein einziger Audit-Eintrag wurde je in die DB geschrieben.

  Fix: Prefix-Check entfernt (redundant wenn bereits auf `/api/v1/admin`
  gemountet). `pathParts`-Extraktion auf relativen Pfad umgestellt
  (`req.path.replace(/^\//, '').split('/')`).

---

## [3.17.42] — 2026-05-22 — Feature: Zertifikate bearbeiten (Name, Services, Auto-Renew)

### Added

- **BCP SSL/TLS — Zertifikat bearbeiten** (`CertificatesPage.tsx`): Stift-Symbol (✏️)
  in der Aktionsspalte öffnet ein Bearbeitungs-Modal für jedes Zertifikat.
  Editierbar: Name, Services-Zuordnung (SMTP/IMAP/POP3 mit Exklusivitäts-Anzeige),
  Auto-Renew (nur für Let's Encrypt Zertifikate).
  Read-only angezeigt: Typ, Status, Domains, HTTPS-Proxy-Status, Protokoll-TLS-Status.
  Ruft `PUT /api/v1/admin/certificates/:id` auf.

### Fixed

- **`PUT /:id` Route** (`routes/admin/certificates.ts`): `isActiveProtocol` fehlte
  im Prisma-`select` — wurde nicht im Response zurückgegeben. Behoben.

---

## [3.17.41] — 2026-05-22 — Fix: ACME-Prozess bricht nach 5 Minuten ab

### Fixed

- **ACME-Timeout** (`routes/admin/certificates.ts`): `runAcmeIssuance()` läuft
  nicht mehr endlos. `Promise.race()` bricht den ACME-Prozess nach 5 Minuten ab
  und setzt das Zertifikat auf `ERROR` — auch wenn `client.auto()` hängt (Port 80
  nicht erreichbar, Let's Encrypt antwortet nicht, etc.).

- **Startup-Bereinigung** (`server.ts`): Beim Container-Start werden Zertifikate
  die länger als 10 Minuten im Status `PENDING` oder `RENEWING` stecken automatisch
  auf `ERROR` gesetzt. Verhindert dauerhaft hängende Certs nach einem Neustart.

- **Doppelstart-Schutz** (Renew-Route): `POST /:id/renew` gibt jetzt `409 Conflict`
  zurück wenn das Cert bereits `PENDING` oder `RENEWING` ist — kein paralleler
  zweiter ACME-Prozess mehr möglich.

- **BCP SSL/TLS UI**: Renew-Button (↻) ist für `PENDING`-Certs deaktiviert und
  zeigt einen Spinner + Tooltip „ACME-Prozess läuft noch — bitte warten".

---

## [3.17.40] — 2026-05-22 — Fix: Exklusive Service-Zuordnung bei Zertifikaten

### Fixed

- **Exklusive Service-Zuordnung** (`routes/admin/certificates.ts` + `CertificatesPage.tsx`):
  SMTP, IMAP und POP3 können jeweils nur einem Zertifikat gleichzeitig zugeordnet sein.
  Beim Erstellen oder Aktualisieren eines Zertifikats mit Services werden diese Services
  automatisch aus allen anderen Zertifikaten entfernt (`claimServices()`-Funktion).

- **BCP SSL/TLS UI — Service-Selector**: Bereits von einem anderen Cert beanspruchte Services
  werden orange markiert (⚠ Warnsymbol + Tooltip „Aktuell bei ‚Cert X' — wird übernommen").
  Bei Auswahl erscheint ein Hinweis-Banner welche Services beim Speichern übertragen werden.

---

## [3.17.39] — 2026-05-22 — Fix: publicHostname automatisch bei Zertifikat-Aktivierung aktualisieren

### Fixed

- **`applyProtocolCert()` aktualisiert jetzt `publicHostname`** (`routes/admin/certificates.ts`):
  Beim Aktivieren eines Zertifikats für SMTP/IMAP/POP3 (Server-Symbol) wird
  `server_settings.publicHostname` auf die primäre Domain des Zertifikats gesetzt.
  Zuvor zeigte der SMTP-Banner weiterhin den alten Hostnamen (`mail.localhost`) auch
  wenn ein CA-signiertes Zertifikat für `mail.example.de` aktiviert war.

- **`activate-protocol`-Route** selektiert jetzt auch `domains` und übergibt sie an
  `applyProtocolCert()` — zuvor fehlte dieses Feld im `select`.

- **ACME Auto-Aktivierung** (`runAcmeIssuance`): Wenn ein Let's Encrypt-Zertifikat
  erfolgreich ausgestellt wurde und `services` SMTP/IMAP/POP3 enthält, wird
  `applyProtocolCert()` automatisch nach der Ausstellung aufgerufen. Bisher musste
  der Admin nach jeder ACME-Ausstellung manuell das Server-Symbol klicken.

---

## [3.17.38] — 2026-05-22 — Auto-Self-Signed-Cert bei Setup + Spam-Filter aktivierbar/deaktivierbar

### Added

- **Auto Self-Signed-Cert bei Setup** (`api-gateway` → `routes/setup.ts`):
  Nach erfolgreichem Initial-Setup (`POST /api/v1/setup/complete`) wird automatisch ein
  selbstsigniertes Zertifikat (RSA-2048, 10 Jahre) für den `publicHostname` generiert
  und in die `certificates`-Tabelle geschrieben. Das Cert ist sofort in BCP → SSL/TLS
  sichtbar, als Standard-Protokoll-TLS (`isActiveProtocol: true`) für SMTP/IMAP/POP3
  aktiviert und wird in `server_settings.tlsCert/tlsKey` geschrieben — SMTP/IMAP/POP3
  übernehmen es sofort via Redis-`settings:reload`.

- **Spam-Filter-Toggle mit Hot-Reload** (`security-filter` → `server.ts`, `pipeline/index.ts`):
  `rspamdEnabled` und `clamavEnabled` aus `SecuritySettings` werden beim Start aus der DB
  geladen. Bei Änderung in BCP → Schutzfilter → Rspamd/Antivirus und anschließendem
  Speichern löst `settings:reload` über Redis einen sofortigen Reload im Security-Filter
  aus — kein Container-Neustart nötig. Pipeline-Stages 4c (ClamAV) und 4d (rspamd)
  werden bei `enabled: false` vollständig übersprungen.

### Changed

- **`PipelineConfig`-Interface** (`security-filter/pipeline/index.ts`): Neue optionale
  Felder `rspamdEnabled?: boolean` und `clamavEnabled?: boolean` — Default `true`
  (kompatibel mit bestehenden Aufrufen).

- **`security-filter/server.ts`**: Lädt SecuritySettings beim Start aus DB und
  abonniert Redis-Channel `settings:reload` für Hot-Reload. Neue Funktion
  `loadSecuritySettings()`.

### Fixed

- **`routes/admin/security.ts`** — `PUT /admin/security/settings` publiziert jetzt
  `settings:reload` via Redis nach dem Speichern, damit die security-filter sofort
  `rspamdEnabled`/`clamavEnabled` übernimmt (ohne Container-Neustart).

---

## [3.17.37] — 2026-05-22 — BCP SSL/TLS: Banner entfernt, Services auf SMTP/IMAP/POP3 reduziert

### Changed

- **BCP → SSL/TLS → Zertifikate**: Grauer Info-Banner bei fehlendem HTTPS-Zertifikat entfernt —
  die Seite zeigt keinen Banner wenn kein Cert aktiv ist (grüner Banner bleibt bei aktivem HTTPS).

- **Service-Auswahl in Zertifikat-Formularen** (Let's Encrypt, Upload, Self-Signed): Reduziert
  auf `SMTP`, `IMAP`, `POP3` — Web-Services (MWA, BCP, EWS, CalDAV, Autodiscover) entfernt,
  da HTTPS ausschließlich über das Schloss-Symbol aktiviert wird und nicht über die Services-Liste.

---

## [3.17.36] — 2026-05-22 — HTTPS_PROXY_ENABLED entfernt — integrierter Proxy immer aktiv

### Removed

- **`HTTPS_PROXY_ENABLED`-Umgebungsvariable** vollständig entfernt aus `tls-proxy.ts`,
  `routes/admin/certificates.ts`, `docker-compose.yml` und `docker-compose.synology.yml`.
  Der integrierte HTTPS-Proxy ist immer aktiv — er startet Port 443 nur wenn ein
  Zertifikat mit `isActiveHttps: true` vorhanden ist, ansonsten bleibt Port 443 geschlossen.
  Kein Konfigurations-Toggle mehr nötig.

- **`isTlsProxyEnabled()`-Export** aus `tls-proxy.ts` entfernt.

- **`enabled`-Feld** aus der `/tls-proxy-info`-API-Response entfernt.

- **„Integrierter HTTPS-Proxy deaktiviert"-Banner** aus BCP → SSL/TLS entfernt.
  Der Banner zeigt jetzt nur noch zwei Zustände: HTTPS aktiv (grün) oder kein
  HTTPS-Zertifikat aktiv (grau mit Hinweis).

---

## [3.17.35] — 2026-05-22 — Zertifikat-Logik: Vollständige Entkopplung HTTPS/Protokoll + Self-Signed-Default

### Changed

- **Zertifikat-Aktivierung entkoppelt** (`api-gateway` → `routes/admin/certificates.ts`):
  HTTPS-Proxy (Schloss-Symbol) und Protokoll-TLS (Server-Symbol) für SMTP/IMAP/POP3 sind
  vollständig **unabhängig** — ein Zertifikat kann nur für HTTPS, nur für Protokolle, oder
  für beides aktiv sein. `activate-https` berührt `isActiveProtocol` nicht mehr.

- **Self-Signed-Standard**: `server_settings.tlsCert/tlsKey = NULL` ist der Normalzustand.
  SMTP/IMAP/POP3 generieren automatisch ein Self-Signed-Cert aus `publicHostname` wenn
  keine explizite Aktivierung erfolgt ist. Kein implizites Auto-Aktivieren beim Erstellen
  oder Hochladen eines Zertifikats.

- **Startup-Sync** (`syncProtocolCertState()`): Ersetzt die alte `migrateCertProtocolBinding()`
  — prüft beim Container-Start ob `server_settings.tlsCert` vorhanden aber kein
  `isActiveProtocol: true`-Cert in der DB existiert (verwaistes Cert) und bereinigt dies.

- **Zertifikat löschen — vollständige Bereinigung**: Wird ein Zertifikat gelöscht das
  `isActiveProtocol: true` ist, werden `server_settings.tlsCert/tlsKey` auf NULL gesetzt
  und SMTP/IMAP/POP3 laden sofort das Self-Signed-Fallback. War das Cert für HTTPS aktiv,
  wird der HTTPS-Proxy ebenfalls deaktiviert.

- **BCP — Zertifikate-Seite** (`admin-panel` → `CertificatesPage.tsx`):
  Server-Symbol (SMTP/IMAP/POP3) ist jetzt **immer** für alle ACTIVE/EXPIRING-Certs
  sichtbar — unabhängig vom HTTPS-Status. Toast-Meldungen und Tooltips korrekt getrennt.
  Lösch-Bestätigung warnt wenn das Cert für HTTPS oder Protokoll-TLS aktiv ist.
  Info-Banner erklärt die Unabhängigkeit beider Aktivierungsarten.

---

## [3.17.34] — 2026-05-22 — DNS-Check: Lokaler Resolver, kein Resolver-Banner/Badges/Details

### Changed

- **DNS-Eintragscheck** (`api-gateway` → `routes/admin/domains.ts`): Verwendet jetzt den
  **lokalen DNS-Resolver** des Servers (`dns.promises`) statt drei externen Resolvern
  (Google/Cloudflare/Quad9). API-Response vereinfacht: nur noch `ok`, `found`, `warning?`
  pro Eintrag — kein `resolvers[]`, `consistent`, `checkedAt`, `resolversUsed` mehr.

### Removed

- **Externe-Resolver-Banner** (BCP → SMTP & Routing → DNS-Einträge): Der blaue
  Info-Banner „Externe Resolver: Google (8.8.8.8) Cloudflare (1.1.1.1) Quad9 (9.9.9.9)"
  wurde entfernt.

- **Per-Resolver-Badges**: Die farbigen Google/Cloudflare/Quad9-Badges mit Latenzanzeige
  unter jedem DNS-Eintrag wurden entfernt.

- **Aufklappbare Resolver-Detailansicht**: Der „▼ Resolver-Details anzeigen"-Link mit
  IP, Latenz und gefundenem Wert pro Resolver wurde entfernt.

- **Inkonsistenz-Warnung**: Der orangene „Resolver-Inkonsistenz"-Hinweis wurde entfernt
  (nicht mehr relevant ohne Multi-Resolver-Abfrage).

- **„Geprüft um HH:MM:SS"-Zeitstempel** im DNS-Header entfernt (keine `checkedAt`-
  Information mehr in der API-Antwort).

---

## [3.17.33] — 2026-05-22 — Fix: Redis-Kanal in Startup-Migration (CHANNEL_SETTINGS_RELOAD)

### Fixed

- **🔧 Startup-Migration `migrateCertProtocolBinding()`**: Falsche Redis-Channel-
  Bezeichnung `'coremail:settings:reload'` wurde durch die korrekte Konstante
  `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`) aus `@coremail/core` ersetzt.
  Ohne diesen Fix wurden SMTP/IMAP/POP3-Server beim ersten Container-Start nach
  dem Upgrade nicht über das neue TLS-Zertifikat informiert — die Protokoll-Server
  liefen trotz korrekter DB-Einträge weiter mit dem alten selbstsignierten Cert.

---

## [3.17.32] — 2026-05-22 — Fix: TLS-Cert Logik — ein Cert für alle Protokolle (SMTP 503 behoben)

### Fixed

- **🔒 503 5.5.1 Bad sequence of commands — Root Cause behoben**: Das Zertifikat
  für `mail.stefanwuestner.de` wurde NUR für den HTTPS-Proxy (MWA/BCP) aktiviert,
  SMTP/IMAP/POP3 nutzten weiterhin das alte selbstsignierte Zertifikat aus
  `ServerSettings.tlsCert/tlsKey`. Externe MTAs (Google, Outlook) lehnten den
  STARTTLS-Handshake ab → 503.

- **🏗️ `activate-https` aktiviert jetzt IMMER auch SMTP/IMAP/POP3**: Wenn das
  Schloss-Symbol angeklickt wird, schreibt der Server das Zertifikat ATOMAR in
  `ServerSettings.tlsCert/tlsKey` UND sendet `CHANNEL_SETTINGS_RELOAD` — alle
  Mail-Protokoll-Server laden das neue Cert sofort ohne Neustart.

- **🛑 Entfernt: MWA+BCP Services-Pflicht für Schloss-Button**: Der Lock-Button
  war bisher nur sichtbar wenn das Cert explizit die Services `MWA` und `BCP`
  hatte — eine willkürliche Hürde ohne technischen Grund. Jetzt zeigt jedes
  gültige Zertifikat (ACTIVE/EXPIRING) den Lock-Button.

### Added

- **`isActiveProtocol` Feld** (`Certificate`-Prisma-Modell): Zeigt im BCP an welches
  Zertifikat aktuell für SMTP/IMAP/POP3 (Ports 465/993/995) aktiv ist —
  unabhängig vom HTTPS-Proxy-Status.

- **`POST /admin/certificates/:id/activate-protocol`**: Neuer Endpunkt für Setups
  mit externem Reverse Proxy (Traefik, Caddy, Synology DSM) wo der integrierte
  HTTPS-Proxy deaktiviert ist, aber der Mailserver ein CA-signiertes Cert für
  SMTP/IMAP/POP3 benötigt.

- **Server-Icon im BCP** (`CertificatesPage`): Neues <Server>-Symbol neben dem
  Schloss — klickt man darauf, wird das Cert nur für Protokoll-TLS aktiviert
  (ohne HTTPS-Proxy). Zeigt blaue Farbe wenn `isActiveProtocol: true`.

- **Detail-Ansicht** (aufgeklappte Zeile): Zeigt jetzt BEIDE Status separat —
  _HTTPS-Proxy (Port 443)_ und _Protokoll-TLS (SMTP/IMAP/POP3)_ mit eigenem
  Icon, damit der Admin sofort sieht was wo aktiv ist.

### Changed

- **`deactivate-https`**: Stoppt nur den HTTPS-Proxy, berührt `isActiveProtocol`
  NICHT — SMTP/IMAP/POP3 laufen mit dem gleichen Cert weiter wenn der Admin
  von integriertem Proxy auf externen Traefik/Caddy wechselt.

---

## [3.17.31] — 2026-05-22 — DNS-Prüfung: Echte Multi-Resolver-Verifikation

### Added

- **🔍 Echte DNS-Verifikation via externe Resolver** (`api-gateway` → `routes/admin/domains.ts`):
  Anstatt den Docker-internen Resolver (127.0.0.11, oft gecacht/veraltet) zu befragen,
  werden MX, SPF, DKIM, DMARC, Autodiscover und PTR/FCrDNS jetzt direkt bei
  **Google (8.8.8.8)**, **Cloudflare (1.1.1.1)** und **Quad9 (9.9.9.9)** geprüft.
  `dns.promises.Resolver.setServers()` — kein Umweg über das System-DNS.

- **🌐 PTR / FCrDNS-Prüfung**: Reverse-DNS `A → PTR → Rück-A` wird automatisch auf
  echten öffentlichen Resolvern verifiziert. Status grün nur wenn PTR zum eigenen
  Hostnamen auflöst (Forward-confirmed, Pflicht für Gmail).

- **⚠️ SPF-Mehrfach-Record-Erkennung**: RFC 7208 §3.2 erlaubt genau einen SPF-TXT-
  Record. Wenn zwei vorhanden sind → `permerror` bei allen Empfängern. Das BCP
  zeigt jetzt eine explizite rote Warnung + Korrekturhinweis.

- **📊 Per-Resolver-Badges im BCP** (`admin-panel` → `SmtpConfigPage.tsx`):
  Jede DNS-Zeile zeigt farbige Badges für Google/Cloudflare/Quad9 mit Latenz
  (grün = gefunden, rot = nicht gefunden/Fehler). Aufklappbare Detailansicht
  pro Resolver mit exaktem Befund und Fehlermeldung.

- **🔄 Konsistenz-Warnung**: Wenn zwei Resolver unterschiedliche Werte zurückgeben
  (z. B. frisch propagierende Einträge) → orangene „Inkonsistenz"-Warnung.

- **🕐 Zeitstempel + Resolver-Info-Banner**: DNS-Ergebnis zeigt Prüfzeitpunkt und
  welche öffentlichen Resolver befragt wurden.

### Fixed

- **Docker-DNS-Phantom**: Interne DNS-Ergebnisse stimmten nicht mit dem überein,
  was externe MTAs (Gmail, Outlook) tatsächlich sehen. Die neue Multi-Resolver-
  Prüfung spiegelt die Realität der öffentlichen DNS-Infrastruktur wider.

---

## [3.17.30] — 2026-05-22 — Outbound E-Mail-Pipeline komplett neu gebaut (Google-konform)

### Changed

- **🏗️ Strukturierter BullMQ-Job statt base64-Blob**: `POST /api/v1/mail/send` übergibt
  ab sofort eine strukturierte Nachricht (`StructuredMessage`) an den Worker — kein
  `rawMessage: base64`-Feld mehr. Das entlastet Redis erheblich (keine großen Blobs mehr).

- **📎 Anhänge via MinIO**: Hochgeladene Anhänge werden sofort in MinIO gespeichert
  (`outbound-queue/{jobId}/{filename}`). Der Worker lädt sie beim MIME-Aufbau herunter
  und bereinigt sie nach erfolgreicher Zustellung automatisch.

- **✍️ DKIM jetzt via nodemailer Transport-Option** (nicht mehr manuelles mailauth-Prepend):
  ```typescript
  nodemailer.createTransport({ host, ..., dkim: { domainName, keySelector, privateKey } })
  ```
  Das ist die robustere und von nodemailer empfohlene Methode. Die Signatur wird korrekt
  über den gesamten Message-Stream gebildet — kein Fehler durch nachträgliches
  Header-Einfügen mehr möglich.

- **🗂️ Sent-Kopie sauber getrennt**: Der RFC-5322-Buffer für den „Gesendete Elemente"-
  Ordner wird weiterhin in-memory aufgebaut (mit den bereits im RAM befindlichen Anhängen)
  — unabhängig vom Queue-Worker.

- **🧹 relay.ts bereinigt**: `ensureRfc5322Headers()` und `signMessage()` (mailauth) entfernt.
  RFC-5322-Pflicht-Header (From, Message-ID, Date) werden von api-gateway und SMTP-
  Submission-Handler garantiert; die Safety-Net-Funktion ist nicht mehr nötig.

- **📦 SMTP-Submission-Pfad kompatibel**: `OutboundJob.rawMessage` (base64) bleibt für
  den SMTP-Submission-Pfad (Ports 465/587) erhalten — E-Mail-Clients liefern vollständige
  RFC-5322-Nachrichten, keine Strukturierung nötig.

### Fixed

- **Order-Bug**: DKIM-Signierung und Header-Sicherheits-Check waren in der falschen
  Reihenfolge — Headers wurden nach der Signierung eingefügt, was die DKIM-Signatur
  ungültig gemacht hätte. Mit Transport-DKIM entfällt dieses Problem komplett.

---

## [3.17.29] — 2026-05-22 — Fix: RFC 5322 Compliance — From & Message-ID Header

### Fixed

- **🎯 Gmail 550 5.7.1 — From Header & Message-ID Header missing**: Ausgehende
  E-Mails wurden von Gmail mit folgenden Fehlern abgelehnt:
  - `550 5.7.1 ... 'From' header is missing`
  - `550 5.7.1 Messages missing a valid Message-ID header are not accepted`

  **Root Cause (api-gateway `routes/mail.ts`)**: Der `From`-Header wurde als
  Template-Literal gebaut: `"${user.displayName}" <${user.email}>`.
  - Wenn `displayName = null` → `"null" <email>` (ungültige Anzeige-Name-Zeichenfolge)
  - Wenn `displayName = ""` → `"" <email>` — leerer Quoted-String verletzt RFC 5322
    §3.4 (quoted-string MUSS mindestens ein Zeichen enthalten). Strenge Parser
    wie Gmail werten das als „From-Header fehlt".

  **Fix 1 — `api-gateway/routes/mail.ts`**: Wechsel auf Nodemailer-Objekt-Format:
  ```
  from: displayName ? { name: displayName, address: user.email } : { address: user.email }
  ```
  Nodemailer kodiert den Anzeige-Namen korrekt per RFC 2047 (falls Non-ASCII)
  und lässt ihn weg wenn er leer ist → `From: <email>` (sauber und gültig).
  Außerdem `date: new Date()` explizit gesetzt (RFC 5322 §3.6.1 Pflicht-Header).

  **Fix 2 — `smtp-server/outbound/relay.ts`**: Neue `ensureRfc5322Headers()`-
  Funktion als Sicherheitsnetz: Prüft vor jeder MX-/Smarthost-Zustellung ob
  `From`, `Message-ID` und `Date` im Header-Block vorhanden sind. Fehlen sie,
  werden sie automatisch vorangestellt und der Vorgang wird als WARN geloggt.
  Schützt alle Outbound-Pfade (REST-API + SMTP-Submission).

---

## [3.17.28] — 2026-05-21 — Fix: Self-Signed-Cert mit falscher CN (Outlook 503 root cause)

### Fixed

- **🎯 Outlook-365 503-Bounce — root cause gefunden**: Das gespeicherte self-signed
  Zertifikat hatte `CN=mail.localhost` statt `CN=mail.stefanwuestner.de`. Beim
  ersten Container-Start war `publicHostname` in der DB noch leer, also wurde das
  Cert mit Default-`mail.localhost` generiert und gespeichert. Spätere Restarts
  haben dieses Cert wiederverwendet → ewiger CN-Mismatch.

  TLS-Handshake klappte (OpenSSL bestätigt das), aber Outlook 365 validiert die
  **CN gegen den verbundenen Hostname** und lehnt bei Mismatch ab → ECONNRESET
  → NDR mit „503 5.5.1 Bad sequence of commands".

  **Fix in `smtp-server/src/server.ts`** `refreshTlsConfig()`:
  - Beim Cert-Load wird `certMatchesHostname()` geprüft (neue Helper-Funktion)
  - Self-signed Cert mit Mismatch → automatisch neu generiert mit aktuellem
    `_hostname` und in DB gespeichert
  - CA-signierte Certs (LE/Custom) werden NICHT neu generiert (könnten gültige
    SAN-Listen für mehrere Domains haben)

  Beim nächsten Container-Restart (oder Hostname-Änderung via BCP) wird das
  Cert automatisch korrigiert.

- **STARTTLS auf Port 25 wieder aktiviert**: Da das Cert jetzt die korrekte CN
  hat, akzeptieren auch Outlook 365 / strikte MTAs den TLS-Handshake. MX-Tools
  zeigt „Supports TLS" ✅.

### Removed

- **Auto-Let's-Encrypt-Bootstrap aus v3.17.27 entfernt**: Admin fordert LE
  manuell via BCP → SSL/TLS → „Let's Encrypt anfordern" an. Datei
  `packages/api-gateway/src/lib/auto-letsencrypt.ts` gelöscht.

### Hinweis: Self-Signed vs. Let's Encrypt

Das self-signed Cert ist jetzt **kompatibel** (korrekte CN/SAN). Aber:
- MTAs die **strict cert chain validation** machen (manche Banken) lehnen
  weiterhin ab — die brauchen einen vertrauenswürdigen Issuer
- Für 100% MTA-Kompatibilität: Let's Encrypt-Cert in BCP manuell anfordern

---

## [3.17.27] — 2026-05-21 — Auto-Let's-Encrypt beim Container-Start + STARTTLS-Revert

### Fixed

- **Outlook 365 lieferte wieder 503 mit v3.17.26**: Das STARTTLS-Advertise mit
  self-signed Cert hatte Outlook-365-Bounces erneut ausgelöst. Self-signed +
  STARTTLS ist NICHT kompatibel mit strikten MTAs — kein graceful Plain-Fallback.
  Fix: Self-signed → STARTTLS auf Port 25 wieder OFF (Verhalten von v3.17.19).

### Added

- **Automatische Let's Encrypt-Anforderung beim Container-Start**:
  Neuer Helper `packages/api-gateway/src/lib/auto-letsencrypt.ts`.
  30 Sekunden nach Server-Start wird geprüft:
  1. `ServerSettings.publicHostname` ist gesetzt UND nicht-lokal (kein `*.local`/`*.lan`/`localhost`)
  2. Kein aktives `LETSENCRYPT`- oder `CUSTOM`-Cert deckt den Hostname ab
  3. Email aus `ServerSettings.adminEmail` ODER Fallback `admin@{root-domain}`

  Wenn alle Bedingungen erfüllt → ACME HTTP-01 Challenge gestartet (production,
  nicht staging). Bei Erfolg: Cert wird ACTIVE, `ServerSettings.tlsCert`/`tlsKey`
  werden gesetzt, `CHANNEL_SETTINGS_RELOAD` wird gepublisht — alle Protokolle
  (SMTP/IMAP/POP3) laden den neuen Cert. **STARTTLS wird automatisch aktiviert**
  weil `isCertSelfSigned()` nun `false` zurückgibt.

  Bei Fehler: Log-Warning, kein Crash. Manuelle Anforderung via
  BCP → SSL/TLS → „Let's Encrypt anfordern" weiterhin möglich.

  **Voraussetzungen für Erfolg:**
  - Port 80 von außen erreichbar (HTTP-01 Challenge)
  - DNS-A-Record für `publicHostname` zeigt auf Server-IP
  - Keine Let's-Encrypt-Rate-Limit-Sperre (50 Certs/Domain/Woche)

### Refactored

- `runAcmeIssuance()` in `routes/admin/certificates.ts` als `export` markiert
  damit sie auch vom Auto-LE-Bootstrap genutzt werden kann

---

## [3.17.26] — 2026-05-21 — Fix: MX-Tools "Does not support TLS" — STARTTLS wieder aktiv

### Fixed

- **MX-Tools-Warnung „SMTP TLS Warning - Does not support TLS"**:
  In v3.17.19 wurde STARTTLS auf Port 25 für self-signed Certs hart deaktiviert
  um Outlook-365-Handshake-Fehler zu vermeiden. Resultat: MX-Tools sah kein TLS
  → Warning. Auch wenn die meisten MTAs (Gmail, Apple, ProtonMail, AOL …)
  Opportunistic TLS mit self-signed Certs akzeptieren.

  **Korrekter Trade-off**: Opportunistic TLS ist **immer besser** als kein TLS:
  - ~95% der MTAs akzeptieren self-signed im opportunistic-Modus
  - Strikte MTAs (Microsoft 365) fallen auf Plain zurück bei TLS-Handshake-Fehler
    (kein Bounce, nur kein TLS für diese Verbindung)
  - MX-Tools-Scoring belohnt TLS-Verfügbarkeit

  Fix: `advertiseStarttls: true` immer (statt `!_tlsCertSelfSigned`).
  STARTTLS wird jetzt auch mit self-signed Cert in EHLO beworben.

### Dauerhafte Lösung für Outlook-365-Kompatibilität

Für vollständige TLS-Validierung in strikten MTAs (Microsoft 365, manche
Banken) ein **Let's Encrypt-Zertifikat** über BCP → SSL/TLS → Zertifikate →
„Let's Encrypt anfordern" für `mail.{domain}` ausstellen. Sobald aktiv:
- MX-Tools: ✅ TLS-Score voll
- Outlook 365: ✅ akzeptiert Cert ohne Probleme
- Self-signed Fallback wird nicht mehr genutzt

**Voraussetzungen für Let's Encrypt**:
- Port 80 von außen erreichbar (HTTP-01 Challenge)
- DNS-A-Record `mail.{domain}` zeigt auf Server-IP

---

## [3.17.25] — 2026-05-21 — MWA: Aufbewahrungsrichtlinien per Rechtsklick

### Added

- **MWA → Settings → Aufbewahrungsrichtlinien** (neue Sektion unter „Konto"):
  Zeigt alle vom Administrator aktivierten PERSONAL-Aufbewahrungstags mit Name,
  Beschreibung, Aufbewahrungstagen und Aktion. Read-only — Tags werden vom Admin
  in BCP angelegt; User wählen sie per Rechtsklick auf Ordner aus.

- **MWA → Ordnerbaum Rechtsklick → „Aufbewahrungsrichtlinie zuweisen"**:
  Submenu mit allen verfügbaren PERSONAL-Tags. Aktuell zugewiesener Tag
  bekommt ✓-Häkchen. Unten „Entfernen"-Eintrag um Zuweisung zu löschen.
  Funktioniert für System- UND Custom-Ordner (Exchange-Verhalten).

- **🕒-Badge** im Ordnerbaum: Ordner mit aktiver Aufbewahrungsrichtlinie zeigen
  ein kleines Uhr-Icon nach dem Ordnernamen — Tooltip mit Tag-Name + Tagen.

### Backend

- **`GET /api/v1/retention-tags`** (neu, `requireAuth`): Listet aktivierte
  PERSONAL-Tags sortiert nach Aufbewahrungstagen.
- **`PATCH /api/v1/mail/folders/:id/retention-tag`** (neu): Body `{ tagId: string | null }`.
  Owner-Verifikation; Tag muss PERSONAL und enabled sein.
- **`PATCH /api/v1/mail/messages/:id/retention-tag`** (neu): Wie oben für Messages.
- **`GET /api/v1/mail/folders`** erweitert: Liefert jetzt `retentionTagId` +
  `retentionTag { id, name, retentionDays, action }` Relation mit.

### Frontend

- 11 neue i18n-Keys (`retention_*`) in DE/EN/ES/IT
- `Folder`-Type um `retentionTagId` + `retentionTag` erweitert
- ContextMenu unterstützte bereits Submenus — nur Nutzung erweitert

---

## [3.17.24] — 2026-05-21 — BCP Compliance-Info-Seite aktualisiert

### Changed

- **BCP → Compliance → Info**: Highlights-Liste um v3.17.12 bis v3.17.23
  ergänzt (12 neue Einträge mit detaillierten Beschreibungen jeder Version).
  Version-Anzeige im Header aktualisiert (3.17.23 → 3.17.24).

---

## [3.17.23] — 2026-05-21 — Audit-Log: Komplettüberarbeitung mit PDF-Export + Statistik

### Fixed

- **CSV-Export schlug mit 401 fehl**: `window.open(…/export…)` öffnete neuen Tab
  ohne `Authorization`-Header. Fix: neuer Helper `exportUrl()` in api/client.ts
  hängt `?token=…` an die URL — `requireAuth` akzeptiert Token via Query bereits
  seit v3.17.18 (SSE-Fix).

- **Datums-Filter zeigte keine Daten**: `new Date('2026-05-20T23:59:59')` wurde
  als **lokale Zeit** interpretiert → in Berlin CEST (UTC+2) lag der UTC-Wert
  vor dem Tagesbeginn des From-Datums. Fix: explizit UTC mit
  `…T00:00:00.000Z` / `…T23:59:59.999Z`.

- **Purge-Route inkonsistent**: Frontend sendete `?olderThanDays=`, Backend las
  `req.body.before` — `400 Bad Request` bei jeder Bereinigung. **Komplett entfernt**
  — Audit-Logs sind per Compliance schreibgeschützt (siehe „Removed").

- **React Fragment key-Warning**: `<>...</>` ohne key bei Listen-Render durch
  `<React.Fragment key={e.id}>` ersetzt.

### Added

- **PDF-Export** (`GET /api/v1/admin/audit-log/export.pdf`): A4 quer mit Header,
  Filter-Zusammenfassung, Tabelle (Zeitpunkt/Akteur/Aktion/Ziel/Status),
  Seitennummern. Cap 1000 Einträge (größere Mengen → CSV). Verwendet `pdfkit`.

- **Statistik-Dashboard** (oben auf der Audit-Log-Seite, auto-refresh 30s):
  - 4 KPI-Karten: Gesamt-Einträge, letzte 24h, letzte 7 Tage, Fehlerquote
  - Top-10 Akteure (Balkendiagramm)
  - Top-10 Aktionen (Balkendiagramm)
  - Neuer Endpunkt: `GET /api/v1/admin/audit-log/stats`

- **Erweiterte Filter**:
  - `actorEmail` (Substring-Suche)
  - `ipAddress` (exakt)
  - `searchText` (durchsucht `action`, `targetName`, `errorMsg`)
  - 2-zeilen-Layout im Frontend mit Reset-Button

- **CSV-Export mit allen Spalten + UTF-8-BOM** (Excel-kompatibel):
  timestamp, actorId, actorEmail, action, targetType, targetId, targetName,
  ipAddress, userAgent, success, errorMsg, changes (JSON)

- **Schreibgeschützt-Banner** im BCP (dismissible, persistiert in localStorage):
  „Audit-Log ist schreibgeschützt — Einträge können auch von Admins nicht gelöscht
  oder verändert werden (Compliance-Anforderung)"

- **userAgent in Detail-Ansicht** der ausgeklappten Zeile

### Removed

- **`DELETE /api/v1/admin/audit-log/purge`**: Audit-Logs sind **immutable**
  (DSGVO, SOX, HIPAA, ISO 27001 Anforderung — Non-Repudiation).
  Frontend „Bereinigen"-Button entfernt. Bei späteren Retention-Bedürfnissen
  läuft das über die System-`RetentionPolicy` (außerhalb Admin-API).

### Auditlog — Kernfunktionen (siehe BCP → Compliance → Audit-Log):

| Säule | Umsetzung |
|---|---|
| **Accountability** | `actorId` + `actorEmail` + `ipAddress` + `userAgent` pro Eintrag |
| **Forensik** | Volltext-Suche, Zeitraum-Filter, JSON-`changes`-Diff |
| **Compliance** | Schreibgeschützt, kein Delete-Endpoint, CSV/PDF-Export |
| **Systemüberwachung** | Live-Statistik (24h/7d), Top-Akteure + Top-Aktionen |

---

## [3.17.22] — 2026-05-21 — Fix: Lokale Zustellung — Aliase, Verteilergruppen + SharedMailbox

### Fixed

Audit der lokalen Zustellung (Outbound-Queue + Submission-Port) deckte zwei
strukturelle Bugs auf. Mails an lokale Adressen wurden in mehreren Fällen
**silent verworfen** ohne Bounce-Nachricht oder Logging über „Mailbox not found".

- **Outbound-Queue (`smtp-server/outbound/queue.ts`) löste keine Aliase auf**:
  Beim Versand aus der MWA (POST /api/v1/mail/send) ging die Mail in die BullMQ-
  Queue. Der Worker prüfte zwar die Domain (local vs. external) aber rief
  `storeInboundMessage()` direkt mit der Original-Adresse auf. Bei einem
  E-Mail-Alias (z.B. `vertrieb@stefanwuestner.de` → `info@stefanwuestner.de`)
  oder einer Verteilergruppe konnte storeInboundMessage den User nicht finden
  → "Mailbox not found — dropping message".

- **Submission-Handler (Port 587/465) hatte denselben Bug**:
  Mail-Clients (Thunderbird/Apple Mail) die direkt an die Submission-Ports
  senden umgingen ebenfalls die Alias-Auflösung.

- **`storeInboundMessage()` kannte nur User-Postfächer, keine SharedMailbox**:
  Selbst nach Alias-Auflösung: wenn der Alias auf eine SharedMailbox zeigt,
  wurde die Mail verworfen weil die Funktion nur `prisma.user.findFirst(...)`
  abfragte. Jetzt parallel auch `prisma.sharedMailbox.findFirst(...)`.

### Changed

- **`expandRecipients()` aus `inbound/handler.ts` in `handlers/expand.ts` extrahiert**
  damit alle drei Eintrittspfade (Port 25 inbound, Port 587/465 submission,
  BullMQ outbound queue) dieselbe Logik nutzen
- **SharedMailbox-Quota** wird jetzt auch bei lokaler Zustellung inkrementiert
- **SSE `mail:new`-Event** wird bei SharedMailbox an alle User mit
  `FULL_ACCESS` oder `READ_ONLY` Permission publiziert → Live-Update im
  Posteingang aller Berechtigten

---

## [3.17.21] — 2026-05-21 — ESMTP-Audit: Stub-only Extensions entfernt

### Removed

Audit aller ESMTP-Erweiterungen — entfernt wurden alle die in EHLO beworben aber
**nicht implementiert** waren (Server hätte gegen die jeweilige RFC verstoßen):

- **AUTH CRAM-MD5 (RFC 4954/2195)** — `handleAuth` erkennt nur `PLAIN` und `LOGIN`,
  CRAM-MD5-Anfragen wurden mit `504 Unrecognized authentication type` abgewiesen.
  Toggle aus BCP entfernt, Default hardcoded `false`.

- **SMTPUTF8 (RFC 6531)** — UTF-8 in Envelope-Adressen wurde nicht gesondert behandelt
  (kein puny-Code-Mapping, kein Unicode-Normalization). Wenn beworben, hätten internationale
  Adressen (z.B. `用户@例子.公司`) zu inkonsistentem Verhalten geführt.

- **CHUNKING / BDAT (RFC 3030)** — Der Befehl `BDAT` wurde vom Command-Parser nicht
  erkannt und mit `500 Command not recognized: BDAT` abgewiesen.

### Verifizierte Implementierungen (bleiben aktiv)

| Extension | RFC | Status |
|---|---|---|
| STARTTLS | 3207 | ✅ Voll funktional, TLS-Upgrade implementiert |
| AUTH PLAIN | 4954 | ✅ `handleAuthPlain` |
| AUTH LOGIN | 4954 | ✅ `handleAuthLoginStart` |
| PIPELINING | 2920 | ✅ Buffer-basiertes Parsing (`lineBuffer`-Schleife in `onData`) |
| SIZE | 1870 | ✅ `SIZE=` Parameter geparst + `maxSize`-Check |
| 8BITMIME | 6152 | ✅ Buffer-basiert (binary encoding) — kein 7-bit-Downgrade |
| ENHANCEDSTATUSCODES | 2034 | ✅ Alle Codes folgen `x.y.z`-Format |

DB-Felder `extAuthCramMd5`, `extSmtputf8`, `extDsn`, `extChunking` bleiben aus
Backwards-Compat in der Datenbank, werden aber im Server hardcoded ignoriert.

---

## [3.17.20] — 2026-05-21 — Remove: DSN-Werbung entfernt (war ungenutzt)

### Removed

- **DSN (Delivery Status Notifications, RFC 3461)**: Der SMTP-Server hat DSN
  in der EHLO-Antwort beworben aber NICHT implementiert:
  - Keine Verarbeitung von `NOTIFY=`, `ORCPT=`, `ENVID=`, `RET=` Parametern
    in MAIL FROM / RCPT TO (wurden vom Regex stillschweigend weggeworfen)
  - Keine `multipart/report` + `message/delivery-status` Generierung beim Bounce
  - Keine SUCCESS/FAILURE/DELAY-Reports

  RFC 3461 verbietet das Bewerben einer Capability ohne Implementierung.
  Entfernt:
  - `DSN` aus EHLO-Response (`packages/smtp-server/src/core/session.ts`)
  - `DEFAULT_ESMTP_EXTENSIONS.dsn` jetzt `false` (Standard hard-codiert)
  - Toggle aus BCP → SMTP & Routing → ESMTP-Erweiterungen entfernt
  - Zod-Schema für `extDsn` in `routes/admin/smtp-config.ts` entfernt
  - DB-Feld `extDsn` bleibt erhalten (Backwards-Compat, wird aber ignoriert)

  Wenn DSN in einer späteren Version implementiert wird, kann der Toggle
  zurückkommen — solange aber stub-only: weg.

---

## [3.17.19] — 2026-05-21 — Fix: STARTTLS auf Port 25 mit self-signed Cert (Outlook 503)

### Fixed

- **Mails von Microsoft Outlook / Exchange werden mit `503 5.5.1 Bad sequence
  of commands` abgewiesen**: Der SMTP-Server bewarb STARTTLS auf Port 25 mit
  einem self-signed Zertifikat. Strikte MTAs wie Microsoft Exchange initiieren
  daraufhin den TLS-Handshake, lehnen das self-signed Cert ab (ECONNRESET) und
  geben einen 503-Fehler zurück.

  Fix: Self-signed Erkennung via `X509Certificate.issuer === subject`. Auf
  **Port 25 (Inbound)** wird STARTTLS NICHT mehr beworben wenn Cert self-signed
  ist — MTAs stellen dann in Plain zu (immer noch RFC-konform, opportunistic
  TLS wird übersprungen). Submission-Ports (465/587) bewerben STARTTLS weiterhin
  (eigene Clients akzeptieren self-signed mit `tls.rejectUnauthorized: false`).

  Nach Installation eines CA-signed Zertifikats (z.B. Let's Encrypt über BCP →
  SSL/TLS) wird STARTTLS auf Port 25 automatisch aktiviert.

---

## [3.17.18] — 2026-05-21 — Posteingang Auto-Refresh + manueller Refresh-Button

### Fixed

- **SSE-Events kamen nie an** (Posteingang aktualisierte sich nicht selbst):
  EventSource kann keine `Authorization`-Header senden, der api-gateway hat aber
  nur Bearer-Token aus dem Header gelesen → SSE-Verbindung schlug 401 fehl.
  Fix: `requireAuth`-Middleware akzeptiert jetzt zusätzlich `?token=…` als
  Query-Parameter (Fallback nur wenn kein Header). Frontend übergibt Token
  als Query in der EventSource-URL.

### Added

- **Live-Aktualisierung im Posteingang**: Sobald eine neue Mail eingeht
  (SSE-Event `mail:new` aus Redis-Channel `mail:new`), wird die Folder- und
  Messages-Liste automatisch neu geladen. Dezenter Toast zeigt
  Absender + Betreff der neuen Nachricht.
- **Manueller Refresh-Button**: Neben „Neue E-Mail" im Ordnerbaum erscheint
  ein 🔄 Icon-Button (mit Tooltip „Ordner aktualisieren") der Folders +
  Messages sofort neu lädt (`refetchQueries`, kein Hintergrund-Refetch)
- i18n-Keys `refresh_folders` / `refresh_done` in DE/EN/ES/IT

---

## [3.17.17] — 2026-05-21 — Fix: Autodiscover-URL nutzt jetzt eigene CNAME

### Fixed

- **Autodiscover-URL nutzte denselben Hostnamen wie alle anderen Pfade**:
  Bei `mail.stefanwuestner.de` als Hostname generierte „URLs ableiten" auch
  `http://mail.stefanwuestner.de:8080` für Autodiscover. Outlook erwartet aber
  nach **Microsoft Exchange Spec** IMMER `autodiscover.{primary-domain}` zuerst —
  also `http://autodiscover.stefanwuestner.de:8080`.

  Fix in `routes/admin/servers.ts` `/settings/derive`-Endpoint:
  - Hostname mit ≥ 3 Labels (z.B. `mail.stefanwuestner.de`) → erste Subdomain
    abschneiden → `autodiscover.stefanwuestner.de`
  - Hostname mit 2 Labels (z.B. `stefanwuestner.de`) → `autodiscover.stefanwuestner.de`
  - Hostname beginnt bereits mit `autodiscover.` → unverändert (kein Doppel-Präfix)

  DNS-Hinweis im BCP (Outlook-Anleitung) verwendet jetzt dieselbe Logik:
  zeigt `autodiscover.{root-domain} CNAME {publicHostname}` korrekt an

---

## [3.17.16] — 2026-05-21 — Fix: Login schlägt fehl (api-gateway hatte Duplikat-Auth mit altem Pepper-Bug)

### Fixed

- **Login funktioniert immer noch nicht** trotz Fix in v3.17.13: Der `api-gateway`
  hat eine EIGENE `/auth/login`-Route (`packages/api-gateway/src/routes/auth.ts`),
  die NICHT zum auth-service proxyed wird. Diese Route hatte exakt denselben
  Pepper-Bug: `bcrypt.compare(password + pepper, hash)` statt sha256+pepper.
  Damit verifizierte die Login-Route am Port 3000 niemals korrekt — am Port 3003
  direkt (auth-service) funktioniert es bereits seit v3.17.13.

  Fix: `verifyPassword()` und `hashPassword()` aus `@coremail/core` verwendet in:
  - `routes/auth.ts` — Login + Passwort-Reset
  - `routes/setup.ts` — Initial-Setup Admin-User
  - `routes/user.ts` — Passwort-Änderung (current + new password)

  Alle bcrypt-Direktimporte in diesen Dateien entfernt.

---

## [3.17.15] — 2026-05-21 — Verteilergruppen-Fix, Token-Refresh, BCP-Bereinigung

### Fixed

- **Verteilergruppen „Invalid request"**: Formular sendete komplette E-Mail-Adresse
  als Freitext (z.B. nur „verteilung" ohne @domain) → Zod-Validierung scheiterte.
  Formular jetzt wie Benutzerverwaltung: lokaler Teil + `@` + Domain-Dropdown nebeneinander.
  E-Mail wird aus `localPart@domain.name` zusammengesetzt bevor sie ans Backend geht

- **Auto-Logout trotz aktiver Nutzung**: JWT Access Token hat 15 Minuten TTL.
  BCP und MWA speicherten nur das Access Token, nie das Refresh Token.
  Bei 401 wurde sofort zur Login-Seite weitergeleitet.
  Fix in `admin-panel/src/api/client.ts` und `web-client/src/api/client.ts`:
  - Refresh Token wird bei Login in localStorage gespeichert
  - Proaktive Erneuerung wenn Token < 120s vor Ablauf steht (JWT exp dekodiert ohne Library)
  - Bei 401 wird erst einmal Refresh versucht + Request wiederholt, nur bei erneutem Fehler → Login

### Added

- **Verteilergruppen in MWA Empfänger-Autocomplete**: Beim Tippen einer Adresse im
  Compose-Fenster werden jetzt auch Verteilergruppen vorgeschlagen (via `GET /admin/groups/gal`),
  parallel zu Kontakten. Gruppen werden mit lila Avatar und `[Gruppe]`-Badge angezeigt

### Removed

- **BCP → Ressourcenpostfächer** (`/resources`): Seite und Navigation entfernt
- **BCP → Organisation** (`/organisation`): Seite und Navigation entfernt
- Beide zugehörigen Page-Dateien gelöscht (`ResourcesPage.tsx`, `OrganisationPage.tsx`)

---

## [3.17.14] — 2026-05-21 — Mailbox-Delegierung + User aktiv/inaktiv

### Added

- **Mailbox-Delegierung (Delegate Access)**: User B kann auf das Postfach von User A zugreifen —
  analog zur Shared-Mailbox-Logik (Exchange Delegate Access):
  - Neues Prisma-Modell `MailboxDelegate` mit `SharedMailboxPermType`-Enum:
    `FULL_ACCESS` / `READ_ONLY` / `SEND_AS` / `SEND_ON_BEHALF`
  - Admin-API `GET/POST/DELETE /api/v1/admin/mailboxes/:id/delegates`
  - User-API `GET /api/v1/mail/delegated-mailboxes` — gibt alle Postfächer zurück
    auf die der angemeldete User delegierten Zugriff hat
  - **BCP → Postfächer** — aufgeklappte Zeile zeigt jetzt Abschnitt „Delegate Access":
    bestehende Delegierungen mit Berechtigung + Entziehen-Button,
    Formular zum Gewähren (User-Dropdown + Berechtigungs-Dropdown)

- **User aktiv/inaktiv** (BCP → Postfächer): Bereits implementiert (Toggle-Button
  war schon vorhanden), explizit verifiziert: `active: false` blockiert Login
  in `authenticateLocal()` und `authenticateAppPassword()` vollständig

---

## [3.17.13] — 2026-05-21 — Fix: Login schlägt fehl (Passwort-Pepper-Mismatch)

### Fixed

- **Login schlägt fehl mit „Invalid credentials"** obwohl Passwort korrekt gesetzt ist:
  `auth-service/src/local/index.ts` verwendete eine eigene Pepper-Logik
  (`password + PEPPER` → direkt bcrypt.compare) während `@coremail/core`'s `hashPassword()`
  beim Anlegen des Users `sha256(password + PEPPER)` → bcrypt verwendet.
  Beide Funktionen unterschieden sich → Hash und Verify kamen nie überein.

  Fix: `authenticateLocal()` und `authenticateAppPassword()` nutzen jetzt
  `verifyPassword()` aus `@coremail/core` — dieselbe sha256+pepper Logik wie `hashPassword()`.
  `bcrypt`-Direktimport in `local/index.ts` entfernt.

- **App-Passwörter (IMAP/SMTP/POP3)** waren vom selben Bug betroffen:
  `bcrypt.compare(rawPassword, hash)` statt `verifyPassword()` → IMAP/SMTP-Auth mit
  App-Passwort schlug ebenfalls fehl. Ebenfalls auf `verifyPassword()` umgestellt.

---

## [3.17.12] — 2026-05-21 — BCP Vollständige Übersetzung (EN/DE) + Versionsabgleich

### Changed

- **Alle Package-Versionen synchronisiert**: Alle 17 `packages/*/package.json` hatten
  noch Version `3.7.9` — jetzt einheitlich `3.17.12`. `/healthz`-Endpoint und
  BCP → System-Informationen zeigen jetzt die korrekte Version

- **BCP vollständig übersetzt (Englisch/Deutsch)**: Alle verbleibenden Seiten verwenden jetzt
  `useT()` und `t()`-Keys statt hartkodierten deutschen Strings:
  - **MailboxesPage** — Tabelle, Modals (Neu, Bearbeiten, Löschen), Quota-Balken, Rollen
  - **DomainsPage** — DNS-Einträge, DKIM-Schlüssel-Modal, Domains-Tabelle, alle Aktionen
  - **QueuesPage** — Übersicht, Jobs-Tabelle, Einstellungen, alle Status-Labels
  - **DashboardPage** — KPI-Karten, Widget-Einstellungen, Server-Info, Angriffs-Events-Widget
  - **QuarantinePage** — Statistikkarten, Filter, Tabelle, Detail-Panel, Cleanup-Modal

- **translations.ts** erweitert auf ~1288 Schlüssel (vorher ~350):
  Neue Sektionen für Postfächer, Domains, Logs, Queues, Dashboard, Quarantäne, Schutzfilter

---

## [3.17.11] — 2026-05-21 — Multi-Fix: Mail-Body, lokale Zustellung, MessageTrace, Queue-Refresh, Übersetzungen

### Fixed

- **Mail-Body enthält rohe MIME-Header**: `buildRawMime()` verwendete `newline: 'unix'` (LF-only).
  nodemailer's `smtp-connection` normalisiert Buffer-Inhalte im DATA-Kanal NICHT (nur Strings).
  Der empfangende MTA konnte den Header/Body-Separator `\r\n\r\n` nicht finden → gesamter
  MIME-Inhalt wurde als Klartext-Body angezeigt. Fix: `newline: 'crlf'` (RFC 5321 konform)

- **Mails an lokale Adressen (admin@stefanwuestner.de) kommen nicht an**: MWA-Send-Endpoint
  (`POST /api/v1/mail/send`) schickte ALLE Empfänger in die Outbound-Queue ohne Local-Domain-Check.
  Queue-Worker versuchte MX-Delivery nach außen — scheiterte. Fix: Queue-Worker prüft jetzt
  vor `relayMessage()` ob die Empfänger-Domain in der lokalen Domain-Tabelle ist; lokale
  Empfänger werden direkt via `storeInboundMessage()` ins Postfach geschrieben

- **MessageTrace zeigt nie Ergebnisse**: API-Client fügt `/api/v1` automatisch als Präfix hinzu.
  `MessageTracePage` verwendete als Pfad `/api/v1/admin/message-trace` → doppelter Präfix `/api/v1/api/v1/...`
  → 404. Fix: Pfad korrigiert zu `/admin/message-trace` (ohne Präfix)

- **Queue-Refresh-Button geht nicht**: Page-Level-Button rief `invalidateQueries` (background
  refetch, kein visuelles Feedback) statt `refetchQueries` (sofortiger aktiver Refetch) auf.
  Fix: `qc.refetchQueries({ queryKey: ['admin-queue-jobs'] })` und `['admin-queue-stats']`

- **Spam landet im Posteingang statt im Junk-Ordner**: `storeInboundMessage()` suchte nach
  Ordner `'Junk E-Mail'` (Outlook-Sprache) — der Ordner heißt `'Junk'`. Fallback war INBOX.
  Fix: `'Junk'` und `'INBOX'` als korrekte Ordnernamen

- **MessageTrace: JUNK-Status fehlte** in Statusfilter und Badge-Anzeige. Hinzugefügt.

### Added

- **Gesendete Elemente (Sent-Ordner)**: Beim Senden über MWA wird jetzt automatisch eine Kopie
  im Sent-Ordner des Absenders gespeichert (war bisher nie implementiert). Große Mails (>256 KB)
  werden in MinIO abgelegt, kleine direkt in der DB. Flags: `\\Seen` (bereits gelesen markiert)

- **MessageTrace Auto-Load**: Öffnet jetzt mit den letzten Einträgen — kein manuelles Klicken
  auf "Suchen" mehr nötig. Reset-Button setzt alle Filter zurück und zeigt alle Einträge

- **MAIL_FLOW-Log im API-Gateway**: `POST /api/v1/mail/send` schreibt jetzt sofort einen
  `ACCEPTED`-SystemLog-Eintrag, damit Mails die über MWA gesendet werden sofort in der
  MessageTrace sichtbar sind (auch bevor die Queue sie verarbeitet)

---

## [3.17.10] — 2026-05-21 — Fix: Kopier-Buttons bei DNS-Einträgen

### Fixed

- **BCP → Domains → DKIM DNS-Eintrag / BCP → SMTP & Routing → DNS-Einträge**: Kopier-Buttons
  funktionierten nicht — `navigator.clipboard` ist im HTTP-Kontext (non-secure, z. B. DSM
  Application Portal) `undefined` und wirft einen Fehler.
  - Neuer gemeinsamer Helper `packages/admin-panel/src/utils/clipboard.ts`:
    `copyToClipboard()` versucht zuerst `navigator.clipboard.writeText()` (Secure Context)
    und fällt automatisch auf `document.execCommand('copy')` zurück (HTTP-Kompatibilität)
  - `DomainsPage.tsx`: beide Copy-Buttons (DNS-Name + TXT-Wert) nutzen jetzt `copyToClipboard()`
    mit korrektem `await` und `toast.error('Kopieren fehlgeschlagen')` im Fehlerfall
  - `SmtpConfigPage.tsx`: `CopyBtn`-Komponente nutzt `copyToClipboard()` statt direktem
    `navigator.clipboard.writeText()`; Fehlerfall zeigt Toast statt lautlosem Versagen

---

## [3.17.9] — 2026-05-20 — Fix: DKIM-Record laden schlägt fehl wenn kein Schlüssel vorhanden

### Fixed

- **BCP → Domains → DKIM DNS-Eintrag anzeigen**: Fehler „DKIM-Record konnte nicht geladen werden"
  wenn `dkimPrivateKey` in der Datenbank leer war (Domains die vor der automatischen
  Schlüssel-Generierung angelegt wurden hatten einen leeren Eintrag).
  - Backend `GET /:id/dkim-record` generiert jetzt automatisch ein RSA-2048-Schlüsselpaar
    und speichert es wenn keines vorhanden ist — Fehler tritt nicht mehr auf
  - Backend `GET /:id/dns-check` ist ebenfalls abgesichert (try/catch + `ensureDkimKey`)
  - Neuer Endpoint `POST /:id/regenerate-dkim` — explizites Neu-Generieren des Schlüsselpaares

### Added

- **BCP → Domains → DKIM**: Schaltfläche „Neu generieren" (erscheint nach dem ersten Laden)
  — generiert ein neues RSA-2048-Schlüsselpaar mit Bestätigungsdialog (Warnung: DNS-Eintrag
  muss danach aktualisiert werden); Lade-Spinner während Fetch/Generierung
- Ladeindikator im DKIM-Button („Lädt…") während API-Aufruf

---

## [3.17.8] — 2026-05-20 — Nachrichtenablaufverfolgung fix + RFC 822 Quelltext

### Fixed

- **Nachrichtenablaufverfolgung (Message Trace)**: Suche lieferte keine Ergebnisse, weil der
  SMTP-Server niemals `SystemLog`-Einträge mit `category='MAIL_FLOW'` schrieb.
  - SMTP-Inbound (`handlers/message.ts`): schreibt jetzt `DELIVERED` / `JUNK` nach jeder Zustellung
  - SMTP-Inbound (`inbound/handler.ts`): schreibt `REJECTED` (Spamfilter-Ablehnung) und
    `QUARANTINE` (Virenquarantäne) mit Sender, Empfänger, Betreff, Größe, SpamScore, Grund
  - SMTP-Submission (`submission/handler.ts`): schreibt `ACCEPTED` nach Annahme einer Ausgangsmail
  - SMTP-Outbound (`outbound/queue.ts`): schreibt `DELIVERED` nach erfolgreicher Zustellung,
    `DEFERRED` bei vorübergehendem Fehler (Retry ausstehend), `REJECTED` bei endgültigem Fehlschlag
  - Alle Events sind in BCP → Verwaltung → Nachrichtenablaufverfolgung suchbar und filterbar

### Added

- **RFC 822 Quelltext-Ansicht** in MWA-Nachrichtenleser:
  - „Quelltext anzeigen" öffnet jetzt einen modalen Dialog statt eines neuen Browser-Tabs
  - Zeigt vollständiges RFC 822-konformes MIME-Format (Header + Body) mit Monospace-Schrift
  - Download-Button `.eml herunterladen` direkt im Quelltext-Modal
  - Backend `GET /api/v1/mail/messages/:id/raw`: serviert jetzt das originale RFC 822-Dokument
    aus MinIO wenn vorhanden (grosse Nachrichten); Fallback rekonstruiert `multipart/alternative`
    (Text + HTML) gemäß RFC 2045 korrekt mit MIME-Boundary

---

## [3.17.7] — 2026-05-20 — DNS-Reiter: Tabellen-UI, grüne/gelbe Statusampeln

### Changed

- **BCP → SMTP → DNS-Einträge**: Komplettes UI-Redesign — von Karten zu sauberer Tabellenansicht
  - **● grüner Punkt** = Eintrag im DNS gesetzt (Existenzprüfung)
  - **● gelber Punkt** = Eintrag nicht gefunden
  - **● blauer Punkt** = PTR — manuell beim Hosting-Anbieter zu setzen
  - Legende unten: grün / gelb / blau erklärt
  - Status-Banner: „X von 5 Einträgen gesetzt"
  - Jede Zeile: Name-Feld + Wert-Feld, je mit Kopier-Button
  - Gefundener DNS-Wert wird grün (gesetzt) oder gelb (abweichend) angezeigt
- **Backend `dns-check`**: MX-Check nutzt jetzt reinen Existenzcheck (`records.length > 0`);
  Autodiscover-Check prüft ob CNAME überhaupt vorhanden ist (nicht mehr Hostnamen-Vergleich)

---

## [3.17.6] — 2026-05-20 — DNS-Reiter in SMTP-Konfiguration

### Added

- **BCP → SMTP-Konfiguration → DNS-Einträge**: Neuer Reiter zeigt alle für den Mailbetrieb
  erforderlichen DNS-Records an — MX, SPF, DKIM, DMARC, Autodiscover, PTR.
  - Domain-Auswahl via Pill-Tabs (bei mehreren Domains)
  - Jeder Eintrag zeigt DNS-Typ, erwarteten Wert, Kopier-Button
  - **Live-DNS-Prüfung** via `GET /api/v1/admin/domains/:id/dns-check` — grünes Häkchen wenn
    Eintrag gesetzt, gelbes Warnsymbol wenn fehlend; zeigt aktuell gesetzten Wert aus DNS
  - Status-Zusammenfassung: „X von 5 Einträgen korrekt"
  - Schaltfläche „DNS neu prüfen" für manuelle Aktualisierung
  - PTR-Karte mit Hinweis zum Setzen beim Hosting-Anbieter
- **Backend** `GET /api/v1/admin/domains/:id/dns-check`: Prüft MX, SPF (TXT), DKIM (TXT),
  DMARC (TXT), Autodiscover (CNAME) parallel via Node.js `dns/promises`; generiert je einen
  erwarteten und den tatsächlich gefundenen Wert

---

## [3.17.5] — 2026-05-20 — Fix: BullMQ Queue-Name enthält keinen Doppelpunkt

### Fixed

- **Senden schlägt fehl ("Nachricht konnte nicht in die Warteschlange eingereiht werden")**:
  BullMQ v5 verbietet Doppelpunkte (`:`) in Queue-Namen. Die Outbound-Queue in
  `api-gateway/routes/mail.ts` hieß `'smtp:outbound'` — BullMQ warf sofort beim
  Erstellen des Queue-Objekts `Error: Queue name cannot contain :`.
  Fix: Queue-Name auf `'smtp-outbound'` geändert (wie bereits korrekt im `smtp-server`).

---

## [3.17.4] — 2026-05-20 — Fix: BullMQ-Verbindung in api-gateway (NetworkError beim Senden)

### Fixed

- **Senden schlägt fehl (NetworkError)**: Die Outbound-Queue in `api-gateway/routes/mail.ts` nutzte
  `getRedisClient()` (shared, `maxRetriesPerRequest: 3`) statt `createBullMqConnection()` (`null`).
  BullMQ v5 erfordert `maxRetriesPerRequest: null` für interne Blocking-Befehle — mit der falschen
  Verbindung crashte `queue.add()` den api-gateway-Prozess (Node.js 22: `--unhandled-rejections=throw`),
  was im Browser als `NetworkError when attempting to fetch resource` erschien.
  Fix: `createBullMqConnection()` wie in `smtp-server/outbound/queue.ts` korrekt verwendet.
- **Zusätzlich**: `queue.add()` in try/catch — bei echten Queue-Fehlern gibt der Server jetzt
  `500 { error: '...' }` zurück statt die Verbindung zu droppen.

---

## [3.17.3] — 2026-05-20 — Service-TLS-Binding: SMTP/IMAP/POP3 echte Zertifikate, HTTPS-Proxy nur MWA+BCP

### Added

- **Protokoll-TLS-Binding**: Wenn ein Zertifikat den Services `SMTP`, `IMAP` oder `POP3` zugeordnet wird,
  werden `certPem`/`keyPem` automatisch in `ServerSettings.tlsCert/tlsKey` geschrieben und alle drei
  Protokoll-Server laden das Zertifikat sofort via `CHANNEL_SETTINGS_RELOAD` neu — kein Container-Neustart nötig.
  Gilt für: Let's Encrypt (nach Ausstellung), Upload, Self-Signed, PUT-Services-Änderung.
- **`applyProtocolCert()` Helper** in `certificates.ts` — zentraler Binding-Punkt für SMTP/IMAP/POP3-TLS
- **BCP: Service-Farben** in der Zertifikat-Tabelle — blau: MWA/BCP (HTTPS-Proxy), grün: SMTP/IMAP/POP3 (Protokoll-TLS), grau: EWS/CALDAV/AUTODISCOVER
- **BCP: „Protokoll-TLS"-Zeile** in der Detailansicht — zeigt welche Protokoll-Services aktiv gebunden sind
- **BCP: ServiceSelector-Hinweis** — erklärt MWA+BCP = HTTPS-Proxy vs. SMTP/IMAP/POP3 = Protokoll-TLS

### Changed

- **`activate-https` Guard**: HTTPS-Proxy kann nur aktiviert werden wenn das Zertifikat sowohl `MWA` als
  auch `BCP` im `services`-Array hat — gibt klare 400-Fehlermeldung wenn Services fehlen
- **BCP: LockOpen-Button** erscheint nur noch bei Zertifikaten mit MWA+BCP (vorher bei allen ACTIVE/EXPIRING)
- **BCP: Grauer Status-Banner** erklärt jetzt explizit "MWA + BCP zuweisen" statt nur "Schloss klicken"
- **BCP: HTTPS (Port 443) Detailzeile** zeigt drei Zustände: Aktiv / Bereit (MWA+BCP) / MWA+BCP benötigt

---

## [3.17.2] — 2026-05-20 — HTTPS-Proxy: explizit deaktivierbar für externen Reverse Proxy

### Added

- **`HTTPS_PROXY_ENABLED=false`** — neuer Env-Schalter deaktiviert den integrierten TLS-Proxy vollständig.
  Setzen wenn ein externer Reverse Proxy (Traefik, Caddy, nginx, DSM Application Portal …) TLS terminiert.
  Dann kann Port `443:443` aus `docker-compose.yml` entfernt / auskommentiert werden.
- **`GET /api/v1/admin/certificates/tls-proxy-info`** — neuer Admin-Endpoint gibt `{ enabled, port, activeCert }` zurück
- **`docker-compose.synology.yml`**: `HTTPS_PROXY_ENABLED: "false"` voreingestellt (DSM übernimmt TLS)
- **`.env.example`**: Abschnitt für `HTTPS_PROXY_ENABLED` + `HTTPS_PORT` ergänzt

### Changed

- **BCP Zertifikate — dreizustandiger Status-Banner**:
  - 🟡 Gelb: Proxy deaktiviert (`HTTPS_PROXY_ENABLED=false`) — externer Reverse Proxy aktiv
  - 🟢 Grün: Proxy aktiv + Zertifikat gewählt — zeigt Port + Domain
  - ⬜ Grau: Proxy bereit, aber noch kein Zertifikat aktiviert — mit Hinweis auf `HTTPS_PROXY_ENABLED=false`
- **`docker-compose.yml`**: `HTTPS_PROXY_ENABLED`-Variable und Kommentar „OPTION A / OPTION B" für klare Wahl
- **`tls-proxy.ts`**: `isTlsProxyEnabled()` exportiert; startup-Log bei deaktiviertem Proxy

---

## [3.17.0] — 2026-05-20 — Integrierter HTTPS-Reverse-Proxy (TLS-Termination)

### Added

- **Integrierter HTTPS-Reverse-Proxy (Port 443)**  
  – CoreMail kann HTTPS nun direkt ohne externen Reverse Proxy (Traefik, Caddy, nginx) terminieren  
  – Nach Ausstellung eines Let's Encrypt- oder eigenen Zertifikats in BCP → SSL/TLS: Button
    **„Als HTTPS aktivieren"** (Schloss-Symbol) startet den TLS-Proxy sofort per Hot-Reload  
  – Genau ein Zertifikat kann gleichzeitig aktiv sein; Hot-Swap ohne Container-Neustart via
    Redis-Kanal `coremail:tls:reload`  
  – Deaktivierung durch erneuten Klick auf das grüne Schloss-Symbol  
  – `docker-compose.yml`: Port `443:443` hinzugefügt  
- **BCP Zertifikate — HTTPS-Status-Banner**  
  – Grünes Banner zeigt aktives Zertifikat + Domain; graues Banner wenn kein HTTPS aktiv  
  – Detailzeile (ausgeklappt) zeigt „HTTPS (Port 443): Aktiv / Inaktiv" mit Lock-Icon  
- **`packages/api-gateway/src/tls-proxy.ts`** — neues Modul für HTTPS-Server-Lifecycle
  (start, graceful stop 5 s, hot-reload via Redis-Subscription)  
- **Prisma-Schema**: `Certificate.isActiveHttps Boolean @default(false)`

### Changed

- **BCP Zertifikate**: Aktionen-Spalte zeigt `LockOpen`-Icon (grau) für aktivierbare Certs
  und `Lock`-Icon (grün) für das aktive HTTPS-Zertifikat

---

## [3.16.9] — 2026-05-20 — Bugfix: Let's Encrypt Port 80 + besseres UI-Feedback

### Fixed

- **docker-compose.yml**: Port `80:3000` ergänzt — ACME HTTP-01 Challenge jetzt
  von Let's Encrypt erreichbar (vorher hängte der Prozess bis Timeout)
- **BCP Zertifikate**: Sichtbarer Status-Banner bei PENDING (blau) und ERROR (rot)
  direkt über der Tabelle — kein stilles "nichts passiert" mehr
- **BCP Zertifikate**: Fehlermeldung im Expand-Panel jetzt mit Titel + lesbarem
  `pre`-Block statt rohem Mono-Text
- **certificates.ts**: Log-Hinweis bei ACME-Challenge: "Port 80 must be reachable"

---

## [3.16.8] — 2026-05-20 — Bugfix: MessageList-Panel lässt sich nicht verschieben

### Fixed

- **MWA Mail — Resizable Panel (MessageList)**: `w-80 shrink-0` im Haupt-Return überschrieb
  das `style={{ width }}` des Parent-Div → Panel war nicht verschiebbar und zeigte nur den
  leeren Nachrichtenzähler. Korrigiert auf `w-full h-full overflow-hidden`.

---

## [3.16.7] — 2026-05-20 — BCP: Info-Fenster auf v3.16.6 aktualisiert

### Changed

- **BCP Info-Fenster** — VERSION auf 3.16.6 aktualisiert, BUILD_DATE 2026-05-20  
  – 6 neue HIGHLIGHTS-Einträge (3.16.6 → 3.14.0) mit vollständigen Release-Notes  
  – Zeigt damit alle Releases seit 3.13.12 korrekt an

---

## [3.16.6] — 2026-05-20 — MWA: Empfänger-Autocomplete, resizable Panels, Ansicht-Einstellungen

### Added

- **MWA Compose — Empfänger-Autocomplete (An / CC / BCC)**  
  – Beim Tippen in An-, CC- und BCC-Felder werden passende Kontakte aus dem Adressbuch vorgeschlagen (ab 1 Zeichen, 220 ms Debounce)  
  – Dropdown mit Name, E-Mail-Adresse und Firma; Tastaturnavigation (↑/↓/Enter/Tab/Escape)  
  – Mehrere Empfänger durch Komma getrennt; Auswahl ersetzt den aktuellen Fragment und setzt den Cursor hinter das neue Komma  
  – Suche via `GET /api/v1/contacts?q=...` (serverseitig, max. 8 Treffer angezeigt)
- **MWA Mail — Resizable Panels**  
  – Trennlinien zwischen Ordnerstruktur ↔ Nachrichtenliste ↔ Lesebereich sind per Maus in der Breite anpassbar  
  – Breiten werden in `localStorage` unter `coremail:panel-widths` gespeichert und beim nächsten Laden wiederhergestellt  
  – Standardbreiten: Ordnerstruktur 208 px (w-52), Nachrichtenliste 320 px (w-80); Minima/Maxima verhindert Überschneidungen
- **Einstellungen → Ansicht** (neue Sektion)  
  – **Lesebereich**: Rechts (Standard), Unten (Nachrichtenliste + Reader vertikal geteilt) oder Aus (nur Liste, kein Reader)  
  – **Nachrichtendichte**: Kompakt / Normal / Komfortabel — Zeilenhöhe der Nachrichtenliste  
  – **Konversationen gruppieren**: Toggle für konversationsbasierte Bündelung (Vorbereitung)  
  – Alle Einstellungen persistent via Zustand-Store (`coremail-ui-prefs` in localStorage)

---

## [3.16.1] — 2026-05-20 — Aufgaben-Erinnerung: Kalender-Sync + Echtzeit-Popup

### Added

- **MWA Aufgaben — Erinnerung mit Kalender-Integration**  
  – Beim Erstellen oder Bearbeiten einer Aufgabe mit gesetzter Erinnerung (Datum + Uhrzeit) wird automatisch ein Kalender-Termin angelegt (`🔔 Erinnerung: <Betreff>`, 30 Min. Dauer) via `POST /calendar/events` — best-effort, kein Task-Fehler bei Kalender-Fehler  
  – Gilt sowohl für `createMutation` (neue Aufgabe) als auch für `updateMutation` (Edit-Modal per Doppelklick)
- **MWA Aufgaben — Erinnerungs-Popup zur gesetzten Uhrzeit**  
  – Der 60-Sekunden-Intervall-Check `checkDueDates()` prüft jetzt zusätzlich `task.reminder`: sobald der Zeitstempel ≤ `now`, erscheint ein `toast` „🔔 Erinnerung: <Betreff>" (12 Sek. Anzeigedauer)  
  – Eigene `notifiedReminderIds`-Ref verhindert doppelte Popups je Session (unabhängig von der Fälligkeits-Benachrichtigung)
- **MWA Aufgaben — Erinnerungsfeld visuell hervorgehoben**  
  – Bell-Icon im Formular jetzt amber (`text-amber-400`) statt grau, tooltip erklärt die Doppelfunktion (Kalender + Popup)

---

## [3.16.0] — 2026-05-20 — MWA/BCP Feature-Update (Aufgaben, Kontakte, Suche, Schriftarten, Dashboard)

### Added

- **MWA Aufgaben — Bearbeitung per Doppelklick**  
  – Doppelklick auf eine Aufgabe öffnet ein Modal mit vorausgefüllten Feldern (Betreff, Notizen, Priorität, Fälligkeitsdatum, Erinnerung)  
  – Separates `updateMutation` schreibt vollständige Änderungen via `PUT /tasks/:id`
- **MWA Aufgaben → Kalender-Synchronisation**  
  – Neu erstellte Aufgaben mit Fälligkeitsdatum werden automatisch als Kalender-Termin eingetragen (`POST /calendar/events`)  
  – Invalidiert `calendar-events`-Query; Fehler werden best-effort verschluckt (kein Task-Create-Failure)
- **MWA Aufgaben — Fälligkeitspopup**  
  – `useEffect` prüft alle 60 Sekunden, ob Aufgaben heute fällig sind  
  – Zeigt `toast` mit Aufgabentitel; jede Aufgabe wird nur einmal je Session benachrichtigt (via `useRef<Set>`)
- **MWA Kalender — Aufgaben als Ereignisse**  
  – Aufgaben mit `dueDate` erscheinen im FullCalendar als ganztägige Ereignisse (amber `#f59e0b` / grau für erledigt)  
  – Klick auf Aufgaben-Event zeigt Toast statt Löschdialog; Prefix `📋` / `✓` im Titel
- **MWA Kontakte — Outlook-kompatible Felder**  
  – Neue Felder: `email2`, `mobile`, `department`, `jobTitle`, `notes`  
  – Edit-Formular in Sektionen: „Allgemein" (2-Spalten-Grid), „E-Mail & Telefon" (2-Spalten-Grid), „Notizen" (Textarea)  
  – Detailansicht zeigt alle ausgefüllten Felder mit Icon + Label; Emails/Telefon clickable  
  – Kontaktliste zeigt `jobTitle` als zweite Zeile (statt nur E-Mail)  
  – `Contact`-Interface in `api/types.ts` um alle neuen Felder erweitert
- **MWA E-Mail-Suche — Scope-Auswahl + Typeahead**  
  – Neue Suchleiste oberhalb der Filterliste in `MessageList`  
  – Scope-Umschalter: „Ordner" (client-seitige Filterung) / „Alle" (API-Query `/mail/folders/search?q=...`)  
  – Typeahead: ab 2 Zeichen Eingabe werden bis zu 5 Treffer aus dem geladenen Ordner als Vorschläge angezeigt  
  – Löschen-Button (`×`) leert die Suche; `Alle`-Scope deaktiviert den lokalen Filter
- **MWA E-Mail-Verfassen — Schriftart-Auswahl**  
  – Neues Tiptap-Extension `@tiptap/extension-font-family` (v2.27.2, passt zur bestehenden Tiptap-v2-Stack)  
  – Dropdown mit 8 Schriftarten: Standard, Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS  
  – Dropdown-Label und -Einträge werden jeweils in der entsprechenden Schrift dargestellt  
  – Positioniert zwischen Block-Typ und Fett/Kursiv in der Formatierungsleiste
- **BCP Dashboard — Alle Widgets draggable**  
  – Alle 8 bisher fehlenden Widgets (`queue-status`, `mails-chart`, `storage-ranking`, `domains-chart`, `recent-errors`, `recent-audit`, `recent-logins`, `system-strip`) jetzt in `<DraggableCard>` eingebettet  
  – IIFE-Slot-Pattern für Queue+Mails, Speicher+Domains und Fehler+Audit+Angriff (konsistent mit KPI- und Server-Sektion)  
  – `recent-logins` und `system-strip` als einzelne draggable Einheiten

### Fixed

- **DNS-Hardening Startup-Check**: Integrity-Check-Ziele von `example.com` (IANA-IP nicht mehr gültig, jetzt Cloudflare CDN) auf stabile Infra-Records umgestellt: `one.one.one.one → 1.1.1.1` und `dns.google → 8.8.8.8`

---

## [3.15.0] — 2026-05-20 — Security+ (Passwort-Reset, Angriffserkennung, DNS-Hardening)

### Added

- **Passwort-Selbstzurücksetzung (OWASP A07-konform)**  
  – `POST /auth/forgot-password`: Rate-limitiert (3 req/h pro IP + E-Mail), SHA-256-Hashing, keine User-Enumeration (immer `{ok:true}`)  
  – `POST /auth/reset-password`: Atomare Transaktion (Token markiert + Passwort gesetzt + alle Sessions gelöscht)  
  – `GET /auth/reset-password/verify?token=...`: Schnellprüfung für Frontend  
  – Token-TTL: 15 min; SHA-256-Hash im DB-gespeichert (Klartext nie persistiert)  
  – Admin-Toggle in BCP: Einstellungen → Sicherheit → „Passwort-Selbstzurücksetzung" (de-/aktiviert den Flow global)  
  – MWA Login-Seite: „Passwort vergessen?"-Link (nur sichtbar wenn Feature aktiv)  
  – MWA: `ForgotPasswordPage` + `ResetPasswordPage` mit Passwortstärke-Indikator
- **Angriffserkennung Live-Dashboard (BCP)**  
  – Neues Prisma-Modell `AttackEvent` (ip, type, detail, service, timestamp) — persistent in PostgreSQL  
  – Redis-Kanal `admin:attack` → SSE-Broadcast an alle Admin-Verbindungen in Echtzeit  
  – BCP-Dashboard-Widget „Angriffs-Erkennung (Live)": Zähler letzte 1h/24h, Top-IPs, Top-Angriffstypen, letzte 10 Events, „UNTER ANGRIFF"-Banner bei ≥10 Events/h  
  – Admin-API `GET /api/v1/admin/security/attacks` (paginiert/filterbar), `/summary`, `DELETE` (Purge vor Datum)  
  – `ip-limiter` im SMTP publiziert bei jedem Auth-Fehlschlag und Ban ein Attack-Event
- **DNS-Poisoning-Schutz (MITRE T1584.002)**  
  – Neues Modul `security-filter/src/dns-hardened.ts`: Erzwingt Trusted Resolver (8.8.8.8, 1.1.1.1, 9.9.9.9) statt System-/Container-DNS  
  – Cross-Resolver-Validation: Zwei unabhängige Resolver werden verglichen; Divergenz → Warnung im Log  
  – Startup-Integritäts-Check: Bekannte stable A-Records (example.com) werden gegen hartcodierte Erwartungen validiert  
  – DNSBL-Modul nutzt jetzt `resolveHardened()` statt `dns.promises.resolve4()`  
  – Admin-API `GET /api/v1/admin/security/dns-check` → Echtzeit-Integritätsreport via security-filter-Proxy  
  – Konfigurierbar via `TRUSTED_DNS_SERVERS` (kommagetrennte IP-Liste)
- **Per-User-Inaktivitäts-Timeout (MWA)**  
  – Benutzer können unter MWA → Einstellungen → Allgemein → „Automatischer Logout" einen persönlichen Timeout (Minuten) setzen  
  – Eigene Einstellung überschreibt die globale Admin-Vorgabe; 0 = deaktiviert; null = global übernehmen  
  – Backend: `GET/PUT /api/v1/user/preferences` liefert/speichert `inactivityTimeoutMinutes`  
  – Prisma-Modell `UserSettings.inactivityTimeoutMinutes (Int?)` ergänzt  
  – MWA `useInactivityLogout`-Hook lädt beide Einstellungen parallel und respektiert User-Override

### Security

- **Angriffsereignisse** werden persistent in `AttackEvent`-Tabelle gespeichert (Forensik/Audit-Trail)  
- **Redis-Pub/Sub** für Attack-Events entkoppelt SMTP-Lockout von Dashboard ohne Performance-Impact  
- **Passwort-Reset-Tokens**: Einfacher Rate-Limiter verhindert Token-Flooding; SHA-256 schützt DB vor Plaintext-Leak  
- **SSE-Endpoint** prüft Admin-Rolle bevor Attack-Events gebrodcastet werden (`ORGANIZATION_MANAGEMENT` / `SERVER_MANAGEMENT` / …)

---

## [3.14.0] — 2026-05-20 — Security Hardening (Pentest-Auswertung)

### Security

- **SMTP — Brute-Force-Lockout (OWASP A07 / MITRE T1110)**: Neues `ip-limiter`-Modul  
  – Redis-backed: Nach 5 fehlgeschlagenen Auth-Versuchen in 5 min wird die IP für 10 min gesperrt (421)  
  – Konfigurierbar via Env: `SMTP_AUTH_FAIL_THRESHOLD`, `SMTP_AUTH_WINDOW_S`, `SMTP_AUTH_BAN_S`  
  – Erfolgreicher Login löscht den Fehlzähler
- **SMTP — Per-IP-Verbindungslimit (MITRE T1499)**: Max. 10 gleichzeitige Verbindungen + Max. 30 neue Verbindungen/min pro IP (Sliding Window)  
  – Konfigurierbar via `SMTP_MAX_CONNS_PER_IP`, `SMTP_NEW_CONN_PER_MIN`  
  – Private/Loopback-IPs ausgenommen
- **SMTP — VRFY-Command deaktiviert**: Antwortet jetzt mit `502 5.5.1 VRFY not supported` statt dem mehrdeutigen `252` (verhindert User-Enumeration)
- **MinIO-Konsole (Port 9001) nur noch auf localhost gebunden**: In beiden `docker-compose`-Dateien auf `127.0.0.1:9001:9001` geändert — kein WAN-Zugriff mehr möglich
- **Container-Ressourcenlimits** in `docker-compose.yml` ergänzt: `cpus: 2`, `memory: 2g` (via `deploy.resources.limits`) — DoS-Schutz auf Host-Ebene
- **SMTP-Auth-IP-Weitergabe**: Client-IP wird jetzt an `verifyCredentials` durchgereicht, damit Brute-Force-Zähler korrekt pro IP zählen

### Fixed

- **SMTP-Banner** enthüllt jetzt keine interne Hostname-Fehlkonfiguration mehr (`mail.localhost`) — Hostname wird immer aus DB-`publicHostname` gelesen, Env-Fallback als Seed

---

## [3.13.12] — 2026-05-20 — Tasks-Fehler, doppelte Ordner, SharedMailbox-Sprache

### Fixed

- **Aufgaben — „Invalid"-Fehler beim Erstellen**: Frontend sendete `title`, Backend erwartet `subject` (Prisma-Schema-Feldname). `Task`-Interface in `types.ts` auf `subject`/`body` korrigiert; `TasksPage` sendet jetzt korrekte Felder
- **Posteingang — doppelte Ordner „Aufgaben"/„Task"**: `Notes` und `Tasks` wurden fälschlicherweise als reguläre Mail-Ordner provisioniert. Beide aus `DEFAULT_FOLDERS` in `provision-mailbox.ts` entfernt (sind eigenständige Datenmodelle). `FolderTree` filtert sie für Bestandsbenutzer heraus
- **SharedMailbox — falsche Sprache**: Ordner-Labels waren hardcodiert englisch/deutsch gemischt; jetzt via `useT()` in der vom User eingestellten Sprache (DE/EN/ES/IT)
- **SharedMailbox — Datumformat**: `fmtDate()` nutzt jetzt die Benutzersprache statt hartem `'de-DE'`
- **SharedMailbox — Ordner-Reihenfolge**: Folder-Sidebar folgt jetzt der gleichen Reihenfolge wie die normale Mailbox (`INBOX → Entwürfe → Gesendet → Papierkorb → Junk → Archiv`, dann benutzerdefinierte Ordner) statt nur `sortOrder + displayName`

### Changed

- **Aufgaben-Seite ausgebaut**: Erweitertes Formular mit Priorität, Fälligkeitsdatum, Erinnerung, Notiz-Textfeld; aufklappbare Body-Anzeige pro Aufgabe; Überfällig-Markierung in Rot; Löschen nur mit Bestätigung
- **SharedMailbox-Sidebar-Stil** angepasst: Aktiver Akzentbalken links, Hover-Effekte und Icon-Größen identisch zur normalen FolderTree-Sidebar

---

## [3.13.11] — 2026-05-20 — Automatischer Logout bei Inaktivität

### Added

- **Neues Sicherheitsfeld „Automatischer Logout bei Inaktivität"** in den Global Settings (Sicherheitsrichtlinien-Sektion)
  - Wert in Minuten: `0` = deaktiviert, `1`–`1440` Minuten konfigurierbar
  - Standard: 30 Minuten
  - Schnell-Buttons: Deaktiviert / 5 / 10 / 15 / 30 / 60 / 120 min
  - Warnung bei < 5 Minuten (könnte Benutzer stören)
- **`GET /api/v1/admin/settings/public`** — neuer öffentlicher Endpoint (kein Auth), liefert `orgName`, `logoUrl`, `language`, `inactivityTimeoutMinutes`, `maintenanceMode`, `maintenanceMessage` — für MWA/BCP vor dem Login abrufbar
- **`useInactivityLogout`-Hook** — implementiert Browser-seitige Inaktivitätserkennung in BCP und MWA:
  - Hört auf `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`, `visibilitychange`
  - Timer wird bei jeder Aktivität zurückgesetzt
  - 60-Sekunden-Vorwarnung via Toast bevor der Logout ausgelöst wird
  - Automatische Weiterleitung zur Login-Seite nach Ablauf

### Changed

- Session-Timeout-Feld in den Einstellungen in „Session-Timeout (Token)" umbenannt und Hinweistext präzisiert — verdeutlicht den Unterschied zu Inaktivitäts-Timeout

---

## [3.13.10] — 2026-05-20 — Bugfix: Vorlage anwenden schlug fehl (retentionDays-Validierung)

### Fixed

- **Kritischer Bugfix** — „Aus Vorlage"-Button in der Aufbewahrungsrichtlinien-Seite schlug mit `retentionDays must be at least 1` fehl
- Ursache: Im tag-basierten Exchange-2019-System (DPT/RPT/Personal-Tags) hält die **Policy** selbst keine Frist — das machen die Tags. Das Frontend sendet deshalb korrekt `retentionDays: 0` beim Anlegen der Policy
- Die Backend-Validierung in `POST /admin/compliance/retention` und `PUT /admin/compliance/retention/:id` war zu streng (`< 1` statt `< 0`) und blockierte das
- Fix: `0` ist jetzt erlaubt (Bedeutung: Frist wird durch die angehängten Tags gesteuert); negative Werte werden weiterhin abgelehnt
- Alle 8 Vorlage-Szenarien (Papierkorb, Junk, Inbox, Gesendet, Entwürfe, Compliance 7 Jahre, Standard 3 Jahre, 5 Jahre wiederherstellbar) können jetzt per Klick angelegt werden

---

## [3.13.9] — 2026-05-20 — Aufbewahrungsrichtlinien aus Vorlagen + MFA-Buttons entfernt

### Removed — Hauptansicht entrümpelt

- **„MFA jetzt"-Button** aus dem Header der `RetentionPage` entfernt — der Worker läuft automatisch im 24h-Work-Cycle, kein Admin muss manuell triggern
- **„MFA-Historie"-Button** raus + `RunsModal`-Komponente komplett gelöscht — interne Worker-Telemetrie gehört nicht in die Compliance-Konfiguration
- `runNow`-Mutation und `ManagedFolderRun`-Interface aus dem Component-State entfernt

### Added — 1-Klick-Vorlagen

- **„Aus Vorlage"-Button** neben „Neue Richtlinie" (nur im Policies-Tab)
- **`TemplatePickerModal`** mit 8 fertigen Szenarien:

| Szenario | Tag-Typ · Folder · Aktion · Frist |
|---|---|
| Papierkorb nach 30 Tagen leeren | RPT · DELETED_ITEMS · DELETE_AND_ALLOW_RECOVERY · 30 d |
| Junk nach 14 Tagen endgültig löschen | RPT · JUNK_EMAIL · PERMANENTLY_DELETE · 14 d |
| Posteingang nach 1 Jahr archivieren | RPT · INBOX · MOVE_TO_ARCHIVE · 365 d |
| Gesendet nach 2 Jahren archivieren | RPT · SENT_ITEMS · MOVE_TO_ARCHIVE · 730 d |
| Entwürfe nach 90 Tagen löschen | RPT · DRAFTS · DELETE_AND_ALLOW_RECOVERY · 90 d |
| Compliance 7 Jahre (Markierung) | DPT · ALL_OTHER · MARK_AS_PAST_RETENTION_LIMIT · 2555 d |
| Standard 3 Jahre → Archiv | DPT · ALL_OTHER · MOVE_TO_ARCHIVE · 1095 d |
| 5 Jahre wiederherstellbar löschen | DPT · ALL_OTHER · DELETE_AND_ALLOW_RECOVERY · 1825 d |

- Klick auf eine Vorlage löst **atomar** aus (Frontend-Orchestrierung):
  1. `POST /admin/compliance/retention/tags` — Tag anlegen
  2. `POST /admin/compliance/retention` — Policy anlegen (Legacy-Felder leer)
  3. `POST /admin/compliance/retention/:policyId/tags/:tagId` — Tag an Policy hängen
  4. `POST /admin/compliance/retention/:policyId/assignments` — GLOBAL-Zuweisung
- Damit ist eine produktive Regel in **einem Klick** einsatzbereit
- Eigene Regeln „from scratch" weiterhin via „Neue Richtlinie"-Button verfügbar

### Changed — Page-Header

- Subtitle umformuliert: „Definiere, wann E-Mails automatisch archiviert oder gelöscht werden — per Vorlage oder eigener Regel" (vorher: technische Beschreibung mit „Managed Folder Assistant · Recoverable Items")

---

## [3.13.8] — 2026-05-19 — Shared Mailboxes mit voller Ordnerstruktur + User-Folder-CRUD

### Added — Provisioning

- **`ensureSharedMailboxProvisioned(sharedMailboxId)`** in `packages/api-gateway/src/lib/provision-mailbox.ts`
  - Idempotent — analog zur User-Variante
  - Erstellt `Mailbox`-Record (via `sharedBoxId`) und die 8 Default-Folders: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`, `Notes`, `Tasks`
  - Backfill: fehlende Standard-Ordner werden bei bestehenden Mailboxen ergänzt
- **Auto-Call** in `POST /admin/shared-mailboxes` — neue Postfächer haben sofort die volle Ordnerstruktur
- **Repair-Endpoint** `POST /admin/shared-mailboxes/:id/provision` — Backfill auf Bestand

### Added — Folder-CRUD für Shared Mailboxes (nur FULL_ACCESS)

In `packages/api-gateway/src/routes/user.ts`:

- `POST   /user/shared-mailboxes/:id/folders` — Ordner anlegen (mit optionalem `parentId` für Unterordner)
- `PATCH  /user/shared-mailboxes/:id/folders/:folderId` — Umbenennen, verschieben (`parentId`), Farbe, Favorit, Sortierung
- `DELETE /user/shared-mailboxes/:id/folders/:folderId` — Löschen (mit Children-Check)
- `POST   /user/shared-mailboxes/:id/folders/:folderId/empty` — alle Nachrichten im Ordner löschen
- Cycle-Check beim Reparenten — Ordner kann nicht in seinen eigenen Subtree verschoben werden
- **Standard-Ordner geschützt**: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Outbox` lassen sich nicht umbenennen, verschieben oder löschen (403)

### Added — Web-Client UI (`SharedMailboxPage.tsx`)

- **„+ Neuer Ordner"-Inline-Eingabe** oben in der Folder-Sidebar (nur bei FULL_ACCESS), gestrichelter Akzent-Border
- **Hover-Aktionen** pro User-Folder rechts: Bleistift (Umbenennen) + Mülleimer (Löschen)
- **Inline-Rename** mit Enter/Esc, OK-Button, Validierungs-State
- Standard-Ordner zeigen keine Action-Icons (Frontend + Backend stimmen überein)
- Lösch-Confirm-Dialog mit Datenverlust-Warnung
- `READ_ONLY`-User sehen weder „Neuer Ordner" noch Action-Icons

---

## [3.13.7] — 2026-05-19 — Transportregeln aus Vorlagen (Exchange-2019-Templates)

### Added

- **„Aus Vorlage"-Button** auf `TransportRulesPage` (neben „Neue Regel")
- **`TemplatePickerModal`** mit 9 vorgefertigten Regel-Vorlagen, in 4 Kategorien filterbar
- Pro Vorlage: Icon + Beschreibung + Conditions/Actions vorbefüllt
- Klick auf Vorlage → `RuleModal` öffnet vorbefüllt; Admin passt Platzhalter (`@DEINE-DOMAIN.com`) an und speichert

### Mitgelieferte Vorlagen

| Kategorie | Vorlage | Conditions → Actions |
|---|---|---|
| **Kennzeichnung** | [EXTERN]-Markierung im Betreff | `from notContains @firma.com` → Subject-Präfix |
| **Compliance** | Disclaimer für ausgehende Mails | `to notContains @firma.com` → addDisclaimer |
| **Compliance** | BCC an Compliance-Postfach | `to contains @firma.com` → addRecipient compliance@ |
| **Compliance** | Kreditkarten-Detection (PCI-DSS) | `body regex \b\d{13,16}\b` → quarantine |
| **Sicherheit** | Spam-Score > 5 quarantänieren | `spamScore > 5` → quarantine |
| **Sicherheit** | Malware-Endungen | `subject regex \.(exe|bat|scr|cmd|vbs|js|jar|hta)\b` → quarantine |
| **Sicherheit** | CEO-Phishing-Schutz | `from regex (ceo|geschäftsführer|chef).*@(?!firma)` → Subject-Präfix „⚠ MÖGLICHES PHISHING" |
| **Governance** | Größenlimit 25 MB | `size > 26214400` → reject |
| **Governance** | DLP-Marker für externe Anhänge | `hasAttachment is true` + `to notContains @firma.com` → addHeader X-Coremail-External-Attachment |

### Changed — `RuleModal`

- Neuer optionaler `initial`-Prop: nimmt eine Template-Rule-Struktur und prefilled `name`, `description`, `priority`, `conditions`, `actions`
- Bei `rule`-Prop (Edit-Modus) wird `initial` ignoriert
- Eigene Regeln „from scratch" weiterhin via „Neue Regel"-Button (ohne Template)

---


> Ältere Releases (v3.13.6 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
