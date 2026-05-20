# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

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
