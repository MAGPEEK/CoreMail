# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

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
