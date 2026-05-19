# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [3.13.6] — 2026-05-19 — Journaling-Feature komplett entfernt

### Removed

- **SMTP-Server** (`packages/smtp-server/src/`):
  - `journaling/engine.ts` (Engine + Retry-Loop + BCC-Detection + Report-Builder)
  - `journalMessage()`-Aufruf in `handlers/message.ts` (Inbound nach Storage)
  - `journalMessage()`-Aufruf in `outbound/queue.ts` (Outbound vor Relay)
  - `startJournalingRetryLoop()`-Bootstrap in `server.ts`
- **API-Gateway** (`packages/api-gateway/src/`):
  - `routes/admin/journaling.ts` (alle 9 Routen — Rules-CRUD, Settings, Failures-Liste/Retry/Delete)
  - Route-Registrierung in `server.ts`
- **Admin-Panel** (`packages/admin-panel/src/`):
  - `pages/JournalingPage.tsx` + `.js` Stale-Datei
  - Route `/journaling` in `main.tsx`
  - Sidebar-Eintrag (`Sidebar.tsx`) + `BookText`-Icon-Import
  - Translation-Keys `nav_journaling` (de + en) in `i18n/translations.ts`
  - „Journaling"-Referenz in `RbacPage.tsx` Compliance-Management-Beschreibung
- **Prisma-Schema** (`packages/storage/prisma/schema.prisma`):
  - `model JournalingRule`, `model JournalingSettings`, `model JournalingFailure`
  - `enum JournalScope`, `enum JournalRecipientType`, `enum JournalingFailureStatus`

### Database Migration

- `prisma db push --accept-data-loss` beim Deploy droppt die Tabellen `journaling_rules`, `journaling_settings`, `journaling_failures` aus der DB
- Eventuell vorhandene Journal-Failure-Exports unter MinIO-Pfad `journal-failures/*` bleiben erhalten (manuelles Cleanup falls gewünscht)

### Notes

- Mail-Flow läuft normal weiter — Journal-Hook war ein „best effort"-Sidecar, nicht im kritischen Zustellungs-Pfad
- Wer Journaling als Compliance-Funktion benötigt, kann es via externem MTA-Relay oder Mail-Server-Konfiguration auf SMTP-Ebene nachbauen (z. B. Postfix `always_bcc`)

---

## [3.13.5] — 2026-05-19 — E-Mail-Aliase für User- und Shared-Mailboxes

### Added — Schema

- **`model EmailAlias`** in `packages/storage/prisma/schema.prisma`:
  - `address` (unique, lowercase), `localPart`, `domainId`
  - Optionales Target: entweder `targetUserId` ODER `targetSharedId` (XOR, App-Level-validiert — Prisma kann das nicht direkt ausdrücken)
  - `active`, `description`, Timestamps
  - Cascade-Delete vom Target und der Domain
- `User.aliases` + `SharedMailbox.aliases` + `Domain.aliases` als Back-Relations

### Added — Backend-Routen (`packages/api-gateway/src/routes/admin/aliases.ts`)

- `GET    /api/v1/admin/aliases` — alle Aliase listen (mit Target + Domain joinable)
- `GET    /api/v1/admin/mailboxes/:id/aliases` + `POST` — User-Aliase
- `GET    /api/v1/admin/shared-mailboxes/:id/aliases` + `POST` — SharedMailbox-Aliase
- `PATCH  /api/v1/admin/aliases/:aliasId` — `active` / `description` ändern
- `DELETE /api/v1/admin/aliases/:aliasId` — Alias löschen
- POST akzeptiert entweder `address` ODER `localPart + domainId` (LocalPart-Validierung: `a-z 0-9 . _ + -`, nicht mit Punkt beginnen/enden)
- **Adress-Kollisions-Check** verhindert Doppel-Zuordnung gegen User-Mails, Shared-Mailbox-Mails und andere Aliase

### Added — SMTP-Inbound (`packages/smtp-server/src/inbound/handler.ts`)

- `verifyRecipient()` akzeptiert jetzt Alias-Adressen — Mails an aktive Aliase mit aktivem Target werden NICHT mehr mit 5.1.1 abgelehnt
- `expandRecipients()` löst Aliase **vor der Zustellung** zur Target-Primäradresse auf (User-E-Mail oder SharedMailbox-E-Mail). Die Mail wird in das Ziel-Postfach ausgeliefert, der Alias selbst hat kein eigenes Postfach
- `visited`-Set bricht Alias-Schleifen ab (z. B. wenn Alias A → User X → ungültige Konfig)

### Added — Admin-UI

- **`MailboxAliasesSection`** (`packages/admin-panel/src/components/MailboxAliasesSection.tsx`) — wiederverwendbare Komponente:
  - Liste vorhandener Aliase mit Aktiv/Inaktiv-Toggle und Lösch-Confirm
  - Eingabe: `localPart` + Domain-Dropdown (Default = Domain der Mailbox)
  - Live-Vorschau `info@firma.com`, Validierungs-Hint, disabled-Tooltip am Button
- Integriert in **MailboxesPage**-Edit-Modal (User) und **SharedMailboxesPage**-Edit-Modal (Shared)
- Für Shared-Mailbox-Aliase nur im Edit-Mode sichtbar (das Postfach muss erst angelegt sein)

---

## [3.13.4] — 2026-05-19 — OWA: „Weiteres Postfach öffnen" (Shared-Mailbox-Reader)

### Added

- **Konto-Dropdown → „Weiteres Postfach öffnen"** (`packages/web-client/src/components/TopBar.tsx`)
  - Neuer Menüeintrag oberhalb von „Abmelden"
  - Öffnet ein Modal mit allen freigegebenen Postfächern, auf die der User Zugriff hat
- **`OpenSharedMailboxModal`** (`packages/web-client/src/components/OpenSharedMailboxModal.tsx`)
  - Live-Suche nach E-Mail oder Display-Name
  - Permission-Badges pro Postfach (Vollzugriff / Senden als / Im Auftrag / Nur Lesen)
  - „Öffnen"-Button — disabled wenn keine Lese-Berechtigung (FULL_ACCESS oder READ_ONLY)
  - Klick navigiert zur Read-Only-Ansicht
- **`SharedMailboxPage`** (`packages/web-client/src/pages/SharedMailboxPage.tsx`)
  - Route `/shared-mailbox/:id`
  - 3-Spalten-Layout (Ordner / Nachrichten / Reader) im klassischen Mail-Style
  - Banner oben: „Du siehst gerade: support@firma.com" mit „Zurück zu meinem Postfach"-Button
  - HTML- oder Text-Body, Attachment-Chips, From/To/Date/Folder-Metadata
  - Hinweis am Mail-Ende bei Read-Only: „Antworten oder Verschieben ist nicht möglich"

### Added — Backend-Routen (`packages/api-gateway/src/routes/user.ts`)

- `GET /api/v1/user/shared-mailboxes` — **erweitert**: aggregiert mehrere Permissions pro Postfach in `permissions[]` (vorher: ein Eintrag pro Permission)
- `GET /api/v1/user/shared-mailboxes/:id` — Detail mit `permissions[]`
- `GET /api/v1/user/shared-mailboxes/:id/folders` — Ordnerliste der freigegebenen Mailbox (404/403 ohne Lese-Berechtigung)
- `GET /api/v1/user/shared-mailboxes/:id/folders/:folderId/messages?limit&offset` — Nachrichtenliste
- `GET /api/v1/user/shared-mailboxes/:id/messages/:messageId` — Detail mit Folder + Attachments
- Helper `getReadableSharedMailbox(userId, sharedId)` prüft `FULL_ACCESS` ODER `READ_ONLY` + Active-Status + auflöst die zugehörige `Mailbox`-ID

### Notes

- Schreib-Operationen (Antworten, Verschieben, Löschen) sind bewusst nicht implementiert — der User-Wunsch war explizit „öffnen können", und Read-only ist sicherer als Default. Schreib-Support folgt wenn nachgefragt
- Backend prüft `permission IN ('FULL_ACCESS', 'READ_ONLY')` pro Request; ohne passende Permission → 403

---


> Ältere Releases (v3.13.3 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
