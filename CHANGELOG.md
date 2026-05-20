# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

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
