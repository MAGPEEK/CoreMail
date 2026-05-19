# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

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


> Ältere Releases (v3.13.4 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
