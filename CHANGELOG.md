# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

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

## [3.13.3] — 2026-05-19 — Drag&Drop REPARIERT + Shared-Mailbox-Permissions-UX

### Fixed

- **🐛 Dashboard-Drag funktionierte nicht** — der Refactor in v3.13.2 hatte `DraggableCard` als innere Funktion innerhalb von `DashboardPage` definiert
  - **Bug**: Bei jedem Re-Render von DashboardPage (z. B. nach `setCardDrag(id)` im dragStart-Handler) entsteht eine neue Funktion-Referenz für `DraggableCard`. React reconciliation sieht „neuen Komponenten-Typ" und unmountet/mountet alle Karten neu. Mid-Drag werden die DOM-Nodes vernichtet → laufender Drag bricht sofort ab
  - **Fix**: `DraggableCard` auf Modul-Ebene extrahiert (außerhalb von `DashboardPage`), nimmt drag state als Props (`cardDrag`, `cardHover`, `setCardDrag`, `setCardHover`, `order`, `moveWidget`)
- **🐛 Text-Selektion statt Drag** — wenn Mousedown auf Text-Inhalt der Karte erfolgte, startete Chrome/Firefox Text-Selektion statt Drag
  - **Fix**: `select-none` Klasse am Drag-Wrapper
- **🐛 Shared-Mailbox-Permissions ließen sich nicht hinzufügen** (`packages/admin-panel/src/pages/SharedMailboxesPage.tsx`)
  - User-Suche war case-sensitive (`u.email.includes(userSearch)`) — „stefan" matchte „Stefan@…" nicht
  - `<select size={4}>`-Listbox war verwirrend: ohne expliziten Klick blieb `userId` leer → „Hinzufügen"-Button blieb disabled, ohne Hinweis warum
  - **Fix**: case-insensitive Filter, ganze User-Liste einmalig geladen mit 60s `staleTime`, klickbare Listenelemente statt Listbox (`<button>`-basiert mit Akzent-Ring auf Selection), „Kein Benutzer gefunden"-Meldung in Amber, bereits berechtigte User werden in der Liste ausgeblendet (für Änderungen gibt's „Bearbeiten" am bestehenden Eintrag), `disabled`-Tooltip am Button erklärt warum er nicht klickbar ist, `type="button"` explizit gesetzt

### Notes

- Dies ist der canonical React-Anti-Pattern „Komponenten dürfen niemals innerhalb anderer Komponenten definiert werden", weil jede neue Funktion-Referenz von React als neuer Komponenten-Typ behandelt wird (Reconciliation per Reference Equality)
- Die Popover-Drag-Funktion war nicht betroffen — dort waren die Drag-Handler direkt auf `<div>`-Elementen, nicht in einer wrapping component

---

> Ältere Releases (v3.13.2 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
