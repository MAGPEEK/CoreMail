# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [Unreleased]

---

## [1.3.9] — 2026-05-16 — Security Hardening (OWASP, Container-Härtung)

### Added

- **Helmet HTTP-Security-Header** (OWASP A05) — alle Antworten erhalten:
  - `Content-Security-Policy` (kein eval, kein fremdes CDN, kein iframe)
  - `Strict-Transport-Security` (HSTS, 1 Jahr, includeSubDomains, preload)
  - `X-Content-Type-Options: nosniff` — MIME-Sniffing verhindert
  - `X-Frame-Options: DENY` — Clickjacking verhindert
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-DNS-Prefetch-Control: off`, `Permissions-Policy`
- **Rate-Limiting** (OWASP A07 — Brute Force) — `express-rate-limit`:
  - Globales Limit: 500 Requests / 15 min / IP
  - Auth-Endpunkte (`/auth/*`): max. 20 Versuche / 15 min / IP
  - Setup-Endpunkt: max. 5 Versuche / Stunde
  - Admin-Mutations: 200 mutierende Calls / 15 min / IP
- **Suspicious-Input-Guard** — blockt CRLF-Injection (Header-Splitting), Null-Bytes in Headern, Path-Traversal (`../`), Oversized-Headers (> 16 KB)
- **Request-ID** — jede Antwort erhält `X-Request-Id` (UUID) für Logging/Tracing
- **trust proxy** in Express konfiguriert — korrektes Rate-Limiting bei Reverse-Proxy-Einsatz

### Security

- **Mass-Assignment verhindert** (OWASP A04) — `PATCH /messages/:id` im Storage-API akzeptiert nur Whitelist-Felder (`flags`, `changeKey`, `modSeq`, `deletedAt`); direkte `req.body → data: req.body`-Übergabe an Prisma vollständig entfernt
- **Input-Validierung Storage-API** — alle Endpunkte validieren IDs (CUID-Format), Typen und Längen; Path-Traversal in MinIO-Keys geblockt; `PATCH /folders`, `POST /mailboxes`, `POST /messages` mit expliziter Feld-Whitelist
- **Storage-API bindet auf 127.0.0.1** — nicht mehr auf `0.0.0.0`; von außen unerreichbar
- **Cache-Control für HTML-Dateien** — `no-cache, no-store, must-revalidate` auf `index.html` (verhindert Caching veralteter SPAs)
- **ACME-Token-Validierung** — Nur `[a-zA-Z0-9_-]{1,128}` als Token akzeptiert
- **Dockerfile** — `setcap 'cap_net_bind_service=+eip'` auf dem Node-Binary; Laufzeit-Verzeichnisse gehören `node:node`
- **supervisord** — alle 11 Node.js-Prozesse laufen jetzt als `user=node` (UID 1000), nicht mehr als root
- **docker-compose.yml** — Container-Härtung für alle 4 Services:
  - `cap_drop: ALL` auf allen Containern — keine Capabilities außer den explizit benötigten
  - `coremail`: `cap_add: [NET_BIND_SERVICE, SETUID, SETGID, CHOWN, DAC_OVERRIDE]`
  - `postgres/minio`: `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]`
  - `redis`: kein `cap_add` — bindet nur auf Port 6379 (kein privilegierter Port)
  - `pids_limit` für jeden Container (200 / 100 / 50 / 100)
  - `tmpfs: /tmp` mit `noexec,nosuid,size=256m` (kein Code-Ausführen aus /tmp)
  - `no-new-privileges:true` für postgres, redis, minio (und alle Observability-Container)
  - Observability-Container (Prometheus, Grafana, Loki, Tempo) ebenfalls gehärtet

---

## [1.3.8] — 2026-05-16 — Cleanup + Status & Monitoring

### Added

- **ECP „Status & Monitoring"** — neue Sidebar-Gruppe mit:
  - **Warteschlangen** — vollständige Queue-Ansicht mit Mail-Details:
    - Summary-Karten für alle 4 Queues (Ausgehend / Retry / Dead Letter / Eingehend) mit Live-Zähler (5s Refresh)
    - Klick auf Karte öffnet Detail-Panel mit tabellarischer Mail-Liste
    - Spalten: Absender, Empfänger, Betreff, Eingestellt, Versuche
    - Aufklappbare Detailzeile: vollständige Felder inkl. Fehlermeldung
    - Einzelne Mail löschen, Queue leeren (Dead Letter)
    - Seitenweise Paginierung (50 Mails/Seite)
  - **Server & Health** — Server-Status und Einstellungen (ehemals unter Infrastruktur)

### Changed

- **README.md**: Alle Erwähnungen von „Microsoft Exchange" / „Exchange 2019" durch „Coremail der OpenSource Mailserver für kleine Umgebungen" ersetzt; Protokollnamen (EWS, ActiveSync, ECP) behalten aber ohne „Exchange"-Branding
- **README.md + CLAUDE.md**: Alle „Phase 5" – „Phase 10" Annotationen entfernt
- **ECP Sidebar**: „Mobile Geräte" entfernt; „Status & Monitoring" als neue Gruppe mit Warteschlangen + Server & Health
- **Warteschlangen**: Aus Gruppe „Nachrichtenfluss" in neue Gruppe „Status & Monitoring" verschoben

### Removed

- **ECP „Mobile Geräte"** (`/ecp/#/mobile`) — Seite aus Navigation entfernt

---

## [1.3.7] — 2026-05-16 — Feature: Audit-Log + OAuth2-Clients + SMTP-Gateway + Öffentliche Ordner + Notizen (OWA)

### Added

- **ECP „Audit-Log"** (`/ecp/#/audit-log`) — vollständige Admin-Aktionsprotokollierung:
  - Filterbares Log: Aktion, Zieltyp, Zeitraum (von/bis), Erfolg/Fehlschlag
  - Farbkodierte Action-Badges (CREATE=grün, DELETE=rot, UPDATE/PUT=blau, LOGIN=violett)
  - Aufklappbare Detailzeilen: Ziel-ID, Akteur-ID, Fehlermeldung, Änderungen als JSON
  - Paginierung (100 Einträge/Seite), CSV-Export, Bereinigungsfunktion (>90 Tage)
- **ECP „OAuth2-Clients"** (`/ecp/#/oauth-clients`) — OAuth2-Client-Verwaltung:
  - Tabelle: Client-ID, Name, Scopes, Trusted-Badge, Aktionen
  - Client erstellen: Name, Beschreibung, Redirect-URIs (mehrzeilig), Scope-Auswahl (8 Scopes), Trusted-Flag
  - Secret-Anzeige als 15s-Toast nach Erstellen und Secret-Rotation
  - Tab „Aktive Tokens": Token-Übersicht mit User, Scopes, Ablauf, Widerruf-Aktion
- **ECP „SMTP-Gateway"** (`/ecp/#/gateway`) — ausgehende Mails über vorgelagerten SMTP-Relay:
  - Toggle: Gateway aktivieren/deaktivieren
  - Upstream-Konfiguration: Host, Port, TLS, Benutzername, Passwort (leer = unverändert)
  - Verbindungstest mit Inline-Ergebnis (CheckCircle2 / XCircle)
  - Relay-Domains (leer = alle Domains), filterBeforeRelay-Option
- **ECP „Öffentliche Ordner"** (`/ecp/#/public-folders`) — Öffentlicher Ordner-Baum:
  - Rekursive Baumansicht (bis 3 Ebenen tief), aufklappbar/einklappbar
  - Stammordner und Unterordner erstellen, bearbeiten, löschen
  - Pro Ordner: Nachrichten-Zähler, Berechtigungsverwaltung (ACL)
  - ACL-Dialog: Benutzer per E-Mail hinzufügen, Berechtigung wählen (READ/WRITE/FULL), Einträge entfernen
- **OWA „Notizen"** (`/owa/#/notes`) — Sticky-Note-Verwaltung:
  - Farbige Notizkarten (YELLOW / BLUE / GREEN / PINK / PURPLE) im Grid-Layout
  - Volltext-Suche in Echtzeit (Debounce via Query-Key)
  - Notiz-Editor: Betreff, Textinhalt (mehrzeilig), Farb-Picker im Header
  - Erstellen / Bearbeiten / Löschen (Hover-Aktionen)
- **TopBar (OWA)**: „Notizen"-Tab mit StickyNote-Icon
- **Sidebar (ECP)**: „Öffentl. Ordner" unter Empfänger, „SMTP-Gateway" unter Nachrichtenfluss, „OAuth2-Clients" unter Infrastruktur, „Audit-Log" als eigenständiger Eintrag

---

## [1.3.6] — 2026-05-16 — Feature: Externe Kontakte + RBAC + eDiscovery + Journaling + Aufbewahrung im ECP

### Added

- **ECP „Externe Kontakte"** (`/ecp/#/ext-contacts`) — Admin-verwaltete externe E-Mail-Kontakte in der GAL:
  - Tabelle: Anzeigename, E-Mail, Unternehmen, Telefon, GAL-Sichtbarkeit
  - Volltext-Suche über Name, E-Mail, Unternehmen
  - Erstellen/Bearbeiten: Vor-/Nachname, Anzeigename, E-Mail, Unternehmen, Abteilung, Telefon, Mobil, Notizen, GAL ausblenden
- **ECP „Berechtigungen (RBAC)"** (`/ecp/#/rbac`) — Rollenzuweisung für alle Benutzer:
  - Tabelle aller User mit aktueller Rolle und Status
  - Inline-Dropdown: 8 Exchange-kompatible Rollen (OrganizationManagement, RecipientManagement, ServerManagement, ComplianceManagement, HygieneManagement, HelpDesk, ViewOnlyOrg, User)
  - Rollenbeschreibungs-Übersicht + Filter nach Rolle/Nur Admins
- **ECP „eDiscovery"** (`/ecp/#/ediscovery`) — Cross-Mailbox-Suche und Legal Hold:
  - Suchen: Erstellen, Starten (POST /run), Exportieren (POST /export), Löschen
  - Suchkriterien: Stichwörter, Betreff, Absender, Empfänger, Datum von/bis
  - Aufklappbare Kriteriendetails pro Suche, Status-Polling alle 5s
  - Legal Holds: Erstellen (Name, Postfach-IDs), Aufheben, Status-Anzeige
- **ECP „Journaling-Regeln"** (`/ecp/#/journaling`) — Compliance-Archivierung nach RFC 3462:
  - Tabelle: Regelname, Journal-Adresse, Scope, Gilt-für, Status-Toggle
  - Erstellen/Bearbeiten: Name, Journal-Adresse, Scope (ALL/INBOUND/OUTBOUND/INTERNAL), Empfängertyp, wrapAsReport-Option
- **ECP „Aufbewahrungsrichtlinien"** (`/ecp/#/retention`) — Automatisches Archivieren/Löschen:
  - Tabelle: Name, Aufbewahrungsdauer (lesbare Darstellung), Aktion-Badge, Scope, Zuweisungen, Status-Toggle
  - Erstellen/Bearbeiten: Tage (mit lesbarer Vorschau), Aktion (ARCHIVE/DELETE/MOVE_TO_FOLDER), Scope, Legal-Hold-Beachten
- **Backend `adminExternalContactsRouter`** — CRUD für externe Mail-Kontakte (`/api/v1/admin/contacts`)
- **Prisma-Modell `ExternalMailContact`** — `email`, `displayName`, `firstName`, `lastName`, `company`, `department`, `phone`, `mobile`, `hiddenFromGal`, `notes`
- **Sidebar-Sektion „Compliance"** — eDiscovery, Journaling, Aufbewahrung
- Sidebar-Eintrag **„Berechtigungen"** (ShieldHalf-Icon) und **„Ext. Kontakte"** (BookUser-Icon)

---

## [1.3.5] — 2026-05-16 — Feature: Verteilergruppen + Ressourcenpostfächer im ECP

### Added

- **ECP „Verteilergruppen"** (`/ecp/#/groups`) — vollständige Verwaltung statischer und dynamischer Gruppen:
  - Tabelle: Anzeigename, E-Mail, Typ-Badge (Statisch/Dynamisch), Mitgliederzahl, Status-Toggle, GAL-Sichtbarkeit
  - Aufklappbare Mitgliederliste pro Gruppe (Expand/Collapse)
  - Mitglieder hinzufügen: E-Mail + Typ (User / Shared Mailbox / Gruppe / Extern), Enter-Kürzel
  - Mitglieder entfernen per Hover-Icon
  - Dynamische Gruppen: LDAP-Filter-Feld statt manueller Mitgliederliste
  - Optionen: requireSenderAuth, allowExternal, moderationEnabled, hiddenFromGal
  - Filter: Alle / Statisch / Dynamisch + Freitextsuche
  - Erstellen / Bearbeiten / Löschen (mit Bestätigungsdialog)
- **ECP „Ressourcenpostfächer"** (`/ecp/#/resources`) — Raum- und Geräteverwaltung:
  - Tab-Umschaltung Räume / Geräte (je mit Anzahl-Badge)
  - Tabelle: Icon, Name, E-Mail, Standort, Kapazität (Räume), Auto-Accept-Status, Status-Toggle
  - Aufklappbarer Buchungskalender pro Ressource mit Datumsbereichsfilter
  - Buchungen anzeigen: Zeitraum, Organisator, Betreff, Status-Badge (ACCEPTED/PENDING/DECLINED)
  - Buchungen stornieren per Admin
  - Ressource erstellen: Typ, E-Mail, Domain, Anzeigename, Standort, Kapazität, Telefon, max. Dauer, Buchungsfenster, Auto-Accept/Decline/Recurring/Approval
  - Ressource bearbeiten / löschen (inkl. alle Buchungen)
- Sidebar-Eintrag **„Verteilergruppen"** (Users-Icon) und **„Ressourcen"** (Building2-Icon) in der Sektion „Empfänger"

---

## [1.3.4] — 2026-05-16 — Feature: Nachrichtenfluss-Connectors + Organisation + Adresslisten

### Added

- **ECP „Connectors"** (`/ecp/#/connectors`) — Sende-/Empfangsconnectors verwalten:
  - Separate Tabellen für Send- und Receive-Connectors mit Priority, Host:Port, TLS-Badge, Enabled-Status
  - Create/Edit-Modal: Name, Typ (SEND/RECEIVE), Host, Port, TLS, Require-TLS, Source-IPs, Ziel-Domains, Benutzername/Passwort, Priorität
  - PATCH `/:id/toggle` — Aktivieren/Deaktivieren ohne Reload
  - Passwort nie in API-Antworten enthalten (serverseitig ausgeblendet)
- **ECP „Organisation"** (`/ecp/#/organisation`) — 3 Tabs:
  - **Freigaberichtlinien** — Kalender-/Kontaktfreigabe für externe Domains (isDefault-Radio-Semantik, CalendarDetail-Level: FREEBUSY/LIMITED/FULL)
  - **Adresslisten** — Benutzerdefinierte Adresslisten + GAL-Flag, JSON-Filter
  - **Globale Adressliste (GAL)** — Live-Abfrage über Users, Shared Mailboxes, Verteilergruppen und Ressourcenpostfächer mit Suche
- **Backend `adminConnectorsRouter`** — vollständiges CRUD + PATCH toggle (`/api/v1/admin/connectors`)
- **Backend `adminOrganisationRouter`** — Sharing Policies + Address Lists CRUD + GAL Live-Query (`/api/v1/admin/organisation`)
- **ECP „Nachrichtenfluss-Trace"** (`/ecp/#/message-trace`) — Bereits in v1.3.3 enthalten, jetzt vollständig verknüpft
- **Prisma-Modell `MailConnector`** — `id`, `name`, `description`, `type` (SEND/RECEIVE), `enabled`, `host`, `port`, `tls`, `requireTls`, `sourceIps[]`, `targetDomains[]`, `username?`, `password?`, `priority`, `createdBy`
- **Prisma-Modell `SharingPolicy`** — `id`, `name`, `description`, `enabled`, `allowedDomains[]`, `allowCalendar`, `allowContacts`, `calendarDetail`, `isDefault`
- **Prisma-Modell `AddressList`** — `id`, `name`, `description`, `filter` (JSON), `isGal`

---

## [1.3.3] — 2026-05-16 — Feature: Shared Mailboxes + Quarantäne + Transportregeln + Mobile Geräte + Nachrichtenfluss-Trace

### Added

- **ECP „Freigegebene Postfächer"** (`/ecp/#/shared-mailboxes`) — Shared Mailbox Verwaltung:
  - Tabelle: E-Mail, Name, Quota, Status, Mitgliederzahl
  - Create/Edit-Modal mit Quota-Feld
  - Berechtigungsmodal: User suchen, Berechtigungstyp (FULL_ACCESS / SEND_AS / SEND_ON_BEHALF / READ_ONLY) zuweisen und entfernen
- **ECP „Quarantäne"** (`/ecp/#/quarantine`) — Spam- und Virus-Quarantäne:
  - Stats-Karten: Gesamt, Viren, Spam, Policy, Freigegeben, Ausstehend
  - Filter nach Grund (Alle/Virus/Spam/Policy) + Freigegebene anzeigen/ausblenden + Suche
  - Freigabe-Aktion (nur Nicht-Virus), Löschen einzeln, Bulk-Löschen (nach Alter + Filter)
- **ECP „Transportregeln"** (`/ecp/#/transport-rules`) — E-Mail-Transportregeln:
  - Regelübersicht mit Bedingungen/Aktionen-Vorschau, Priorität, Enabled-Toggle
  - Regeleditor-Modal: Name, Beschreibung, Priorität, dynamische Bedingungen (SENDER/RECIPIENT/SUBJECT/HEADER/SIZE/ATTACHMENT) und Aktionen (REDIRECT/COPY/ADD_HEADER/REMOVE_HEADER/REJECT/QUARANTINE/SET_SPAM_SCORE/PREPEND_SUBJECT/APPEND_DISCLAIMER)
  - POST /reorder — Massenpriorität-Update per Transaction
  - PATCH /:id/toggle — Aktivieren/Deaktivieren
- **ECP „Mobile Geräte"** (`/ecp/#/mobile`) — ActiveSync-Geräteverwaltung:
  - Tabelle: Gerät, User, Typ/OS, Status-Badge (OK/PENDING/BLOCKED/WIPED), zuletzt gesehen
  - Aktionen: Status ändern (Block/Freigabe), Remote Wipe, Löschen
  - Filter nach Status + Suche
- **ECP „Nachrichtenfluss-Trace"** (`/ecp/#/message-trace`) — Mail-Flow-Debugging:
  - Suchformular: Absender, Empfänger, Betreff, Status, Datum von/bis
  - Ergebnistabelle mit Zeitstempel, Von, An, Betreff, Status-Badge, Details-Klappzeile
  - CSV-Export via GET /export mit Content-Disposition-Header
- **Backend `adminSharedMailboxesRouter`** — CRUD + Berechtigungsverwaltung (`/api/v1/admin/shared-mailboxes`)
- **Backend `adminQuarantineRouter`** — GET (gefiltert + paginiert), Stats, Release, Delete, Bulk-Delete (`/api/v1/admin/quarantine`)
- **Backend `adminTransportRulesRouter`** — CRUD + Toggle + Reorder-Transaction (`/api/v1/admin/transport-rules`)
- **Backend `adminMobileRouter`** — Geräteliste, Status-Patch, Wipe, Delete (`/api/v1/admin/mobile`)
- **Backend `adminMessageTraceRouter`** — Liest SystemLog `MAIL_FLOW`-Kategorie, In-Memory-Filter, CSV-Export (`/api/v1/admin/message-trace`)
- **Sidebar-Neustrukturierung** — Gruppierte Navigation mit Sektionen: Empfänger / Nachrichtenfluss / Schutz / Infrastruktur

---

## [1.3.2] — 2026-05-15 — Feature: SSL/TLS Zertifikat-Verwaltung

### Added

- **ECP „Zertifikate"** (`/ecp/#/certificates`) — vollständige SSL/TLS-Verwaltung:
  - Zertifikatliste mit Name, Domains, Typ-Badge (Let's Encrypt / Eigenes / Self-Signed), Status-Badge (Aktiv + Resttage, Läuft ab, Abgelaufen, Ausstehend, Fehler), Services, Aktionen
  - Aufklappbare Detailzeile: alle Domains, Ausstell-/Ablaufdatum, Auto-Renew, ACME-E-Mail, Fehlermeldung
  - **Let's Encrypt (ACME HTTP-01)**: Domains, E-Mail, Services-Auswahl, Auto-Renew-Toggle, Staging-Toggle
  - **Eigenes Zertifikat hochladen**: Cert-PEM, Key-PEM, Chain-PEM (optional)
  - **Self-Signed generieren**: Domains, Gültigkeitsdauer in Tagen
  - **Sofort-Erneuerung** (🔄) für Let's Encrypt-Zertifikate
  - **Löschen** mit Bestätigungsdialog
  - Auto-Refresh alle 10 Sekunden (Pending/Renewing-Status sichtbar)
- **Backend `POST /api/v1/admin/certificates/letsencrypt`** — async ACME HTTP-01-Issuance (202-Antwort sofort, Cert wird im Hintergrund ausgestellt)
- **Backend `POST /api/v1/admin/certificates/upload`** — Custom-PEM hochladen, expiresAt wird per `X509Certificate` geparst
- **Backend `POST /api/v1/admin/certificates/self-signed`** — via `node-forge` vollständig generiertes Self-Signed-Zertifikat inkl. SAN
- **Backend `POST /api/v1/admin/certificates/:id/renew`** — ACME-Erneuerung für bestehende Let's Encrypt Certs
- **ACME Challenge-Route** `GET /.well-known/acme-challenge/:token` — Redis-basierter Token-Store (TTL 600s), registriert vor allen Body-Parsern
- **Prisma-Modell `Certificate`** — `id`, `name`, `domains[]`, `services[]`, `type` (LETSENCRYPT/CUSTOM/SELF_SIGNED), `status` (PENDING/ACTIVE/EXPIRING/EXPIRED/ERROR/RENEWING), `certPem`, `keyPem`, `chainPem`, `issuedAt`, `expiresAt`, `autoRenew`, `acmeAccount`, `acmeEmail`, `lastError`
- **Sidebar-Eintrag „Zertifikate"** (`ShieldCheck`-Icon) zwischen Services und Berichte

### Changed

- `node-forge` + `@types/node-forge` zu `@coremail/api-gateway` dependencies hinzugefügt
- `packages/api-gateway/src/server.ts`: `adminCertificatesRouter` registriert, ACME-Challenge-Route vor Proxy-Routen

---

## [1.3.1] — 2026-05-15 — Feature: Manage Domains (komplette Überarbeitung)

### Added

- **ECP „Manage Domains"** (`/ecp/#/domains`) komplett nach Screenshot-Design:
  - Titel-Leiste „Manage Domains"
  - Suchfeld „Search domains" + blauer **+ ADD DOMAIN** Button
  - Tabelle: `#`, `DOMAIN NAME`, **MAKE PRIMARY**-Button / „Primary Domain"-Label, **STATUS-Toggle**, **Bearbeiten**-Stift
  - Pagination: Selektor „50 domains per page" (10/25/50/100), Gesamt-Anzeige, Blättern
- **Primäre Domain** — genau eine Domain kann als primär markiert werden (Radio-Semantik)
  - Bei MAKE PRIMARY: alle anderen Domains werden atomisch als nicht-primär gesetzt (DB-Transaction)
  - Erste angelegte Domain wird automatisch primär
  - Primäre Domain kann nicht gelöscht werden
- **Status-Toggle** — Domain per Toggle aktivieren/deaktivieren (PATCH /toggle)
- **Edit-Modal** — Name, DKIM-Selektor bearbeiten, DKIM-DNS-Eintrag einblenden + kopieren, Löschen (mit Guard)
- **Add-Domain-Modal** — Name + DKIM-Selektor, DKIM-Schlüsselpaar wird automatisch generiert
- **API `PATCH /api/v1/admin/domains/:id/toggle`** — active-Status umschalten
- **API `POST /api/v1/admin/domains/:id/make-primary`** — primäre Domain setzen
- **API `GET /api/v1/admin/domains`** — erweitert um `search`, `page`, `limit` Query-Parameter
- **Prisma `Domain.primary`** — neues Boolean-Feld (@default false)

---

## [1.3.0] — 2026-05-15 — Feature: Services-Verwaltung (Listener-Konfiguration)

### Added

- **Neue ECP-Seite „Services"** (`/ecp/#/services`) mit interner Sub-Navigation (dark sidebar):
  - **Services Management** — Übersichtskarten (SMTP Receiving, SMTP Sending, IMAP, POP3) mit Listener-Counts und Aktivitätsbalken
  - **SMTP Receiving** — Listener-Tabelle für Port 25, 465, 587 (mit SSL-Badge)
  - **SMTP Sending** — Listener-Tabelle für Port 587
  - **IMAP** — Listener-Tabelle für Port 143, 993
  - **POP3** — Listener-Tabelle für Port 110, 995
- **Listeners-Tabelle** exakt nach Vorbild (Screenshot): #, ADDRESS:PORT, SSL-Badge, STATUS-Toggle, Edit/Delete-Buttons
- **ADD LISTENER** Button öffnet Modal mit IP-Adresse, Port, SSL-Toggle, Aktiv-Toggle
- **Default-Seeding**: Beim ersten Abruf werden Standard-Listener automatisch angelegt
- **API `GET /api/v1/admin/services/overview`** — Listener-Counts pro Service
- **API `GET/POST /api/v1/admin/services/listeners/:service`** — Listener auflisten + hinzufügen
- **API `PUT /api/v1/admin/services/listeners/:id`** — Listener bearbeiten
- **API `PATCH /api/v1/admin/services/listeners/:id/toggle`** — aktivieren/deaktivieren
- **API `DELETE /api/v1/admin/services/listeners/:id`** — Listener löschen
- **Prisma-Modell `ServiceListener`** mit Enum `ServiceType` (SMTP_RECEIVE, SMTP_SEND, IMAP, POP3)
- **`api.patch()`** Methode im Admin-Panel API-Client ergänzt
- **Sidebar**: „Server & Health" durch „Services" ersetzt

---

## [1.2.9] — 2026-05-15 — Feature: Globale Server-Einstellungen (ECP)

### Added

- **Neue ECP-Seite „Einstellungen"** (`/ecp/#/settings`) — 4 konfigurierbare Sektionen mit je eigenem Speichern-Button:
  - **Organisation**: Servername (orgName), Beschreibung, Admin-E-Mail, Logo-URL (mit Live-Vorschau), Sprache (de/en), Zeitzone, Willkommensnachricht
  - **Mail-Limits**: Max. Nachrichtengröße (MB), Max. Anhangsgröße (MB), Papierkorb-Aufbewahrung (Tage)
  - **Sicherheitsrichtlinien**: Mindest-Passwortlänge (Schnellauswahl-Buttons), Max. Login-Versuche, Session-Timeout, MFA für Admins erzwingen, Selbstregistrierung erlauben
  - **Wartungsmodus**: An/Aus-Toggle mit Live-Vorschau der Wartungsmeldung, bearbeitbarer Hinweistext
- **Wartungsmodus-Banner** — wenn aktiv, erscheint im ECP ein orangefarbenes Warnier-Banner
- **API `GET /api/v1/admin/settings`** — liest alle Server-Einstellungen (Singleton-Pattern)
- **API `PUT /api/v1/admin/settings/org`** — Organisations-Einstellungen speichern (Zod-validiert)
- **API `PUT /api/v1/admin/settings/mail`** — Mail-Limits speichern
- **API `PUT /api/v1/admin/settings/security`** — Sicherheitsrichtlinien speichern
- **API `PUT /api/v1/admin/settings/maintenance`** — Wartungsmodus aktivieren/deaktivieren
- **Prisma-Schema** `ServerSettings` um 15 neue Felder erweitert (org, mail-limits, security, maintenance)
- **Sidebar-Navigation** Eintrag „Einstellungen" mit Settings2-Icon

---

## [1.2.8] — 2026-05-15 — Feature: Erweitertes Admin-Dashboard

### Added

- **ECP-Dashboard** vollständig überarbeitet — aggregierte Übersichtsseite mit:
  - **4 KPI-Karten** (Benutzer gesamt/aktiv/neu, Domains, E-Mails gesamt/heute, Gesamt-Speicherverbrauch)
  - **SMTP-Queue-Status** (Wartend / Aktiv / Fehlerhaft / Verzögert) mit Ampel-Anzeige
  - **E-Mail-Aktivitäts-Chart** (Area-Chart, letzte 7 Tage, Recharts)
  - **Speicher-Ranking** (Top-10 Nutzer mit Fortschrittsbalken, grün/gelb/rot je Auslastung)
  - **Domain-Übersicht** (Balkendiagramm Benutzerverteilung + Tabelle mit Online-Status)
  - **Letzte Fehler & Warnungen** (System-Logs der letzten 30 Tage, kompakte Liste)
  - **Admin-Aktions-Protokoll** (letzte 8 Audit-Events mit Erfolg-/Fehler-Indikator)
  - **Info-Leiste** (Queue-Gesamteinträge, kumulierte Zustellungen, neue Benutzer, Mails heute)
  - Auto-Refresh alle 30 Sekunden + manueller „Aktualisieren"-Button
- **API `GET /api/v1/admin/dashboard`** — aggregiert alle Metriken in einem einzigen DB-Aufruf:
  - Nutzerstatistiken, Domain-Liste, Nachrichtenanzahl (gesamt/Tag/Woche), Speicher-Ranking
  - BullMQ Job-Counts (waiting/active/failed/delayed/completed)
  - Letzte Fehler-Logs, letzte Audit-Events
  - Mail-pro-Tag-Zeitreihe (PostgreSQL `DATE_TRUNC` Aggregation)

---

## [1.2.7] — 2026-05-15 — Feature: Dateianhänge beim E-Mail-Versand

### Added

- **Anhänge im Compose-Fenster** (OWA): Dateien über „Anhang"-Schaltfläche auswählen (mehrere Dateien gleichzeitig möglich, max. 25 MB pro Datei, max. 20 Dateien)
- **Anhangsliste** über der Aktionsleiste: Dateiname + Größe (KB/MB) + einzeln entfernbar (×-Button)
- **Anhang-Zähler** am „Anhang"-Button (blauer Badge mit Anzahl)
- **Drag & Drop** für mehrere Dateien aus dem Dateiexplorer
- **Backend**: Versand-Endpunkt `POST /api/v1/mail/send` unterstützt jetzt `multipart/form-data` mit `multer` (Speicher im Arbeitsspeicher, danach direkt in MIME-Message eingebettet)
- **MIME-Aufbau**: Nodemailer baut die vollständige RFC 2822-Nachricht mit Anhängen auf (Inline-Kodierung als Base64/quoted-printable je MIME-Typ)
- **BullMQ-Fix**: Mail-Versand aus der OWA legte Nachrichten bislang in eine nie verarbeitete Redis-Liste (`smtp:outbound:api`). Jetzt werden sie korrekt in die BullMQ-Queue `smtp:outbound` eingereiht, die der SMTP-Server verarbeitet.

### Fixed

- E-Mail-Versand aus dem OWA-Compose-Fenster war de facto nicht funktionsfähig (Nachrichten landeten in einer unverarbeiteten Redis-Liste). Jetzt korrekte BullMQ-Integration.

---

## [1.2.6] — 2026-05-15 — Feature: Gmail-artiger Rich-Text-Editor im Compose-Fenster

### Added

- **Vollständige Formatierungsleiste** im E-Mail-Verfassen-Fenster (OWA):
  - **Rückgängig / Wiederholen** (Ctrl+Z / Ctrl+Y)
  - **Block-Typ-Dropdown**: Normal, Überschrift 1/2/3, Codeblock
  - **Zeichenformatierung**: Fett, Kursiv, Unterstrichen, Durchgestrichen
  - **Schriftfarbe** mit 24-Farben-Palette (Popover mit Live-Swatch-Vorschau)
  - **Markierungsfarbe (Highlight)** mit 12-Farben-Palette
  - **Link einfügen / bearbeiten** (Ctrl+K)
  - **Textausrichtung**: Linksbündig, Zentriert, Rechtsbündig, Blocksatz
  - **Aufzählungsliste** und **Nummerierte Liste**
  - **Einzug verringern / erhöhen** für Listen-Elemente
  - **Blockquote** (Zitat), **Inline-Code**, **Horizontale Trennlinie**
  - **Formatierung entfernen** (Radiergummi)
- **BCC-Feld**: neben CC jetzt auch BCC per Klick einblendbar
- **Breites Compose-Fenster**: von 580 px auf 660 px verbreitert für mehr Platz

---

## [1.2.5] — 2026-05-15 — Feature: Echtzeit-Speicherverbrauch pro Postfach im ECP

### Added

- **ECP Postfach-Speicherdetails** — aufklappbare Detailzeile pro Benutzer in der Postfachliste:
  - Quota-Fortschrittsbalken mit exakter GB/MB-Anzeige (belegt / gesamt)
  - Ordner-Tabelle: Anzeigename, Nachrichtenanzahl, Ungelesen-Zähler
  - Benutzer-Metadaten (ID, Erstellt-Datum)
  - „Speicher aktualisieren"-Schaltfläche zur Neu-Berechnung aller Quotas
- **API `POST /api/v1/admin/mailboxes/:id/recalculate-quota`** — Speicherverbrauch für einen einzelnen Benutzer neu berechnen (aggregiert `rawSize` aller nicht-gelöschten Nachrichten)
- **API `POST /api/v1/admin/mailboxes/recalculate-all-quotas`** — Speicherverbrauch für alle Benutzer neu berechnen (Admin-Wartungsfunktion)
- **Live-Berechnung** — `GET /api/v1/admin/mailboxes` berechnet `usedBytes` jetzt on-the-fly aus den tatsächlichen Nachrichtengrößen und synchronisiert den Wert lazy in die DB
- **Ordnerdetails** — `GET /api/v1/admin/mailboxes/:id` gibt jetzt `mailbox.folders` (Name, Anzeigename, Nachrichten- und Ungelesen-Zähler) mit zurück

---

## [1.2.4] — 2026-05-15 — Feature: Vollständige Benutzerverwaltung im ECP

### Added

- **ECP Benutzerverwaltung** — komplett überarbeitete Seite „Empfänger → Postfächer":
  - Benutzeravatar mit Initiale, E-Mail + Anzeigename in einer Zeile
  - Domain-Filter-Dropdown (zeigt Anzahl Benutzer pro Domain)
  - Quota-Fortschrittsbalken (grün/gelb/rot je nach Auslastung)
  - **Bearbeiten-Dialog**: Anzeigename, Rolle, Speicherkontingent ändern
  - **Passwort-Reset-Dialog** (Schlüssel-Symbol) — direkt aus der Liste
  - Aktivieren/Deaktivieren per Klick auf Status-Badge
  - **Neuer Benutzer**-Dialog: Domain zuerst wählen, dann nur Localpart eingeben (E-Mail wird automatisch zusammengesetzt)
  - Deutsche Rollenbezeichnungen (Benutzer, Helpdesk, Administrator etc.)
  - Speicherkontingent-Auswahl: 1 GB / 2 GB / 5 GB / 10 GB / 25 GB / 50 GB / Unbegrenzt

---

## [1.2.3] — 2026-05-15 — Feature: Serverkonfiguration im ECP (Outlook Autodiscover)

### Added

- **ECP → Server → Virtuelle Verzeichnisse** — neue Einstellungsseite im Admin-Panel: öffentlichen Hostnamen, HTTP-Port, HTTPS-Schalter, EWS-URL, OWA-URL, EAS-URL, Autodiscover-Basis, IMAP/POP3/SMTP-Host und -Port konfigurierbar
- **Prisma-Modell `ServerSettings`** — Singleton-Tabelle `server_settings` speichert alle Server-URLs persistent in der Datenbank
- **Admin-API** `GET/PUT /api/v1/admin/servers/settings` — Einstellungen lesen und speichern; `POST /api/v1/admin/servers/settings/derive` — URLs automatisch aus Hostname + Port ableiten
- **Autodiscover liest URLs aus DB** — `packages/autodiscover/src/settings.ts` mit 60-Sekunden-In-Memory-Cache; fällt auf Umgebungsvariablen zurück wenn noch kein DB-Eintrag existiert
- **Outlook 2019/2022/365 Einrichtungsanleitung** direkt im ECP angezeigt

---

## [1.2.2] — 2026-05-15 — Bugfix: BigInt-Serialisierungsfehler crasht api-gateway nach Login

### Fixed

- **api-gateway Crash nach Login** — Nach erfolgreichem Login rief das Frontend `/api/v1/user/profile` ab. Die Felder `quotaBytes` und `usedBytes` (Prisma `BigInt`) konnten von `JSON.stringify` nicht serialisiert werden → Node.js-Fehler + api-gateway-Neustart → Browser sah NetworkError. Globaler `BigInt.prototype.toJSON`-Patch in server.ts konvertiert BigInt → Number für alle Routen

---

## [1.2.1] — 2026-05-15 — Bugfix: "Invalid request" — express.json() vor Auth-Route

### Fixed

- **"Invalid request" beim Login** — `/auth`-Route wurde vor `express.json()` registriert, sodass `req.body` immer `undefined` war und die Zod-Validierung scheiterte. Auth-Route wird jetzt korrekt **nach** dem Body-Parser gemountet (nur echte Proxy-Routen bleiben vor `express.json()`)

---

## [1.2.0] — 2026-05-15 — Fix: Auth direkt im api-gateway (kein Proxy)

### Fixed

- **Login NetworkError** — Auth-Routen (`/auth/login`, `/auth/refresh`, `/auth/logout`) werden jetzt **direkt im api-gateway** verarbeitet statt über einen HTTP-Proxy an den auth-service weitergeleitet. Eliminiert alle Proxy-bedingten Verbindungsfehler (NetworkError, Body-Streaming, Path-Strip-Probleme)

---

## [1.1.9] — 2026-05-15 — Bugfix: Login "Invalid credentials" durch falschen Proxy-Pfad

### Fixed

- **Proxy `proxyReq`-Event** — `req.originalUrl` in `proxyReq.path` schreiben; `http-proxy-middleware` strippt wie Express den Mount-Prefix (`/auth/login` → `/login`), auth-service empfing falschen Pfad → 401 statt Login

---

## [1.1.8] — 2026-05-15 — Bugfix: NetworkError — Proxy vor express.json() registrieren

### Fixed

- **Middleware-Reihenfolge** — Proxy-Routen (`/auth`, `/EWS`, `/dav`, …) werden jetzt **vor** `express.json()` registriert; `express.json()` konsumiert den Body-Stream — danach konnte `http-proxy-middleware` keinen Body mehr weiterleiten → NetworkError im Browser

---

## [1.1.7] — 2026-05-14 — Bugfix: NetworkError beim Login (Proxy ersetzt)

### Fixed

- **Interner Proxy** — Custom Node.js HTTP-Proxy durch `http-proxy-middleware` ersetzt; handhabt Body-Streaming, Hop-by-hop-Header und Content-Length-Neuberechnung korrekt → NetworkError beim Login behoben

---

## [1.1.6] — 2026-05-14 — Bugfix: Login funktioniert nicht (Body leer + falscher Proxy-Pfad)

### Fixed

- **Interner Proxy — Hop-by-Hop-Header** — `connection`, `transfer-encoding` etc. werden jetzt korrekt gefiltert (RFC 2616); verhindert Connection-Konflikte (NetworkError im Browser)
- **Interner Proxy — Body-Streaming** — `express.json()` konsumiert den Request-Body-Stream vor dem Proxy; Auth-Service erhielt leeren Body → Login-Validierung schlug fehl. Fix: `req.body` wird als Buffer re-serialisiert mit exakter `content-length`
- **Interner Proxy — Pfad** — `req.path` → `req.originalUrl`; Express strippt bei `app.use('/auth', proxy)` den Prefix, sodass `POST /auth/login` als `POST /login` beim auth-service ankam → 404. Betrifft alle internen Proxys (auth, EWS, CalDAV, ActiveSync)

---

## [1.1.5] — 2026-05-14 — Bugfix: OWA/ECP Routing funktioniert nicht

### Fixed

- **BrowserRouter basename** — `basename="/owa"` (web-client) und `basename="/ecp"` (admin-panel) gesetzt; React Router hat `/owa/login` nicht als `/login` erkannt → Routing schlug komplett fehl, Login-Button tat nichts

---

## [1.1.4] — 2026-05-14 — Bugfix: OWA Login funktioniert nicht

### Fixed

- **Login-URL** — `fetch('http://localhost:3003/auth/login')` → `fetch('/auth/login')`; Browser hat Login-Request an eigenen PC statt an den Server gesendet

---

## [1.1.3] — 2026-05-14 — Feature: First-Run Setup Wizard

### Added

- **Setup Wizard** (`GET /api/v1/setup/status`, `POST /api/v1/setup/complete`)
  - Beim ersten Aufruf ohne Benutzer wird automatisch auf `/setup` weitergeleitet
  - Formular: Mail-Domain, Administrator-E-Mail + Passwort (min. 8 Zeichen)
  - Erstellt Domain, Admin-User (Rolle `ORGANIZATION_MANAGEMENT`) + Standard-Mailbox-Ordner
  - Endpoint gesperrt sobald erster User existiert (409 Conflict)
- **SetupPage** (`packages/web-client/src/pages/SetupPage.tsx`) — Exchange-Design, Erfolgs-Screen mit Weiterleitung zum Login
- **SetupGuard** in `App.tsx` — prüft Setup-Status bei jedem App-Start, leitet automatisch weiter

---

## [1.0.2] — 2026-05-14 — Bugfix: OWA/ECP leere Seite

### Fixed

- **Vite base path** — `base: '/owa/'` (web-client) und `base: '/ecp/'` (admin-panel) gesetzt; Assets wurden zuvor mit absolutem Pfad `/assets/...` gebaut — Browser konnte sie unter `/owa/assets/...` nicht finden → leere Seite

---

## [1.0.1] — 2026-05-14 — Bugfix: Prisma OpenSSL 3.x Kompatibilität

### Fixed

- **Prisma Engine OpenSSL 3.x** — `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` in `schema.prisma` hinzugefügt; behebt `libssl.so.1.1: No such file or directory` auf Alpine 3.20 / Node 22
- **Prisma Schema-Deployment** — `prisma db push` statt `prisma migrate deploy` (kein Migrationsverlauf nötig); `prisma` CLI von `devDependencies` in `dependencies` verschoben
- **Redis Synology** — AOF durch RDB-Snapshots ersetzt (`user: "0:0"`); behebt `Permission denied` auf Synology-Volumes
- **Docker Entrypoint** — `entrypoint-app.sh` wartet auf PostgreSQL und führt `prisma db push` vor `supervisord` aus

---

## [0.11.0] — 2026-05-14 — Phase 10: Benutzerverwaltung, Modern Auth, Audit-Log, Push, SMTP-Gateway

### Added

- **Automatische Mailbox-Provisionierung** (`packages/api-gateway/src/lib/provision-mailbox.ts`)
  - `ensureMailboxProvisioned(userId)` — idempotent: legt Mailbox + 8 Standard-Ordner an (INBOX, Drafts, Sent, Trash, Junk, Archive, Notes, Tasks), falls nicht vorhanden
  - Wird beim ersten Login, beim IMAP-Connect und beim Admin-Import aufgerufen
  - `POST /api/v1/admin/mailboxes/:id/provision` — einzelnen User provisionieren
  - `POST /api/v1/admin/mailboxes/bulk-provision` — alle aktiven User ohne Mailbox in einem Durchlauf

- **Audit-Log** (`packages/api-gateway/src/lib/audit.ts`, `src/routes/admin/audit-log.ts`)
  - `audit(entry)` — Fire-and-forget Write in `AuditLog`-Tabelle (blockiert nie)
  - `auditMiddleware` — Express-Middleware, loggt alle mutierenden Admin-Calls (POST/PUT/PATCH/DELETE) automatisch
  - `GET  /api/v1/admin/audit-log` — abfragbar nach actorId, action, targetType, success, from/to, limit/offset
  - `GET  /api/v1/admin/audit-log/export` — CSV-Export mit `Content-Disposition` Header
  - `DELETE /api/v1/admin/audit-log/purge` — alte Einträge löschen (`{ before: ISO-date }`)
  - **Neues Modell** `AuditLog`: actorId, actorEmail, action, targetType, targetId, targetName, ipAddress, userAgent, changes (Json), success, errorMsg

- **OAuth2 / Outlook Modern Auth** (`packages/auth-service/src/oauth2/router.ts`)
  - Authorization Code Flow + PKCE (S256) — vollständig nach RFC 7636
  - `GET  /.well-known/openid-configuration` — OIDC Discovery Document
  - `GET  /oauth2/jwks` — JSON Web Key Set (HS256)
  - `GET  /oauth2/authorize` — startet OAuth2-Flow (redirect zu OWA Login)
  - `POST /oauth2/authorize/complete` — gibt Auth-Code aus (server-seitig vom OWA-Backend aufgerufen)
  - `POST /oauth2/token` — `authorization_code` + `refresh_token` Grants
  - `POST /oauth2/token/revoke` — Token-Revozierung
  - `GET  /oauth2/userinfo` — OIDC UserInfo-Endpoint
  - **Admin API** (`/api/v1/admin/oauth`): Client-Verwaltung (CRUD), Secret-Rotation, Token-Übersicht + Revozierung
  - **Neue Modelle**: `OAuthClient`, `OAuthAuthorizationCode`, `OAuthToken`
  - **EWS Bearer-Token**: `packages/ews-server/src/auth/middleware.ts` prüft OAuth2-Revokation (DB-Lookup)

- **VAPID Web Push** (`packages/api-gateway/src/lib/push.ts`, `src/routes/push.ts`)
  - `sendPushToUser(userId, topic, payload)` — sendet an alle Subscriptions eines Users für ein Topic
  - `broadcastPush(topic, payload)` — systemweiter Broadcast (für Admin-Alerts)
  - Automatische Bereinigung abgelaufener Subscriptions (HTTP 410/404 → DB-Löschen)
  - `GET  /api/v1/push/vapid-public-key` — VAPID Public Key für `PushManager.subscribe()`
  - `POST /api/v1/push/subscribe` — Subscription registrieren (Upsert per Endpoint)
  - `PUT  /api/v1/push/subscribe/:id/topics` — abonnierte Topics aktualisieren
  - `DELETE /api/v1/push/subscribe/:id` — Subscription entfernen
  - `GET  /api/v1/push/subscriptions` — eigene Subscriptions auflisten
  - `POST /api/v1/push/test` — Test-Notification senden
  - **SSE-Integration**: neue Mails lösen automatisch Web Push aus (auch wenn Tab geschlossen)
  - **Neues Modell** `PushSubscription`: userId, endpoint, p256dhKey, authKey, topics, userAgent
  - **Neue Dependency**: `web-push` ^3.6.7 + `@types/web-push` ^3.6.3 in `api-gateway`
  - **ENV**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

- **SMTP-Gateway-Modus** (`packages/smtp-server/src/gateway/relay.ts`)
  - `getGatewayConfig()` — DB-first (GatewaySettings Singleton), ENV-Fallback, 60s-Cache
  - `shouldRelayToGateway(recipientEmail)` — prüft ob Gateway aktiv + Domain in relayDomains
  - `relayToUpstream(rawMessage, from, to)` — leitet via nodemailer an Upstream-MTA weiter
  - Eingebunden in `message.ts`: Relay statt lokaler Zustellung wenn Gateway aktiv
  - **Admin API** (`/api/v1/admin/gateway`):
    - `GET  /api/v1/admin/gateway/settings` — aktuelle Konfiguration (Passwort maskiert)
    - `PUT  /api/v1/admin/gateway/settings` — Gateway konfigurieren (upsert, Passwort nur bei expliziter Angabe überschrieben)
    - `POST /api/v1/admin/gateway/test` — Upstream-Verbindung testen (10s Timeout)
  - **Neues Modell** `GatewaySettings`: enabled, upstreamHost, upstreamPort, upstreamTls, upstreamUsername, upstreamPassword, relayDomains[], filterBeforeRelay
  - **ENV**: `GATEWAY_MODE`, `GATEWAY_UPSTREAM_HOST`, `GATEWAY_UPSTREAM_PORT`, `GATEWAY_UPSTREAM_TLS`, `GATEWAY_UPSTREAM_USER`, `GATEWAY_UPSTREAM_PASS`, `GATEWAY_DOMAINS`, `GATEWAY_FILTER`

- **Changelog-API** (`packages/api-gateway/src/server.ts`)
  - `GET /api/v1/changelog` — gibt `CHANGELOG.md` als strukturiertes JSON + Rohtext aus
  - Parst Keep-a-Changelog-Format in Versionen mit Sections (Added/Changed/Fixed …)
  - Pfad konfigurierbar via `CHANGELOG_PATH` ENV

### Changed
- `packages/api-gateway/src/server.ts` — Phase-10-Routen registriert: `/api/v1/push`, `/api/v1/admin/audit-log`, `/api/v1/admin/oauth`, `/api/v1/admin/gateway`; `auditMiddleware` als globale Admin-Middleware; Changelog-API-Endpunkt inline
- `packages/api-gateway/src/sse.ts` — VAPID Push-Notification bei neuer Mail (`CHANNEL_MAIL_NEW`)
- `packages/smtp-server/src/handlers/message.ts` — Gateway-Relay-Prüfung vor lokaler Zustellung

---

## [0.10.0] — 2026-05-14 — Phase 9: S/MIME Inline, Journaling-Regeln, Aufbewahrungsrichtlinien

### Added

- **S/MIME Inline-Signierung & -Verschlüsselung** (`packages/smtp-server/src/smime/`)
  - `sign.ts` — CMS SignedData (RFC 5652): erzeugt `multipart/signed` mit detachierter Signatur
  - `verify.ts` — Verifiziert eingehende S/MIME-Signaturen (`multipart/signed` + opaque signed); Result als JSON in `Message.smimeMeta` gespeichert
  - `encrypt.ts` — CMS EnvelopedData (AES-256-CBC): verschlüsselt ausgehende Nachrichten für den Empfänger wenn dessen Zertifikat in der DB vorhanden ist
  - `decrypt.ts` — Entschlüsselt eingehende verschlüsselte Nachrichten automatisch vor Speicherung
  - `loader.ts` — Lädt PKCS#12-Bundles aus MinIO (private Key + Zertifikatskette via `node-forge`)
  - `index.ts` — Re-Export aller S/MIME-Funktionen
  - **Neue Abhängigkeit**: `node-forge` ^1.3.1 + `@types/node-forge` ^1.3.11 in `smtp-server`

- **SmimeSettings-Modell** (Prisma-Schema, Phase 9)
  - Pro-User-Einstellungen: `autoSign`, `autoEncrypt`, `verifyIncoming`, `decryptIncoming`
  - Relation `User.smimeSettings` (1:1 optional)

- **SMTP Outbound Auto-Sign/-Encrypt** (`packages/smtp-server/src/outbound/queue.ts`)
  - `OutboundJob.senderUserId` — neue Eigenschaft für S/MIME-Lookup
  - Prüft `SmimeSettings.autoSign` → signiert mit Signing-Default-Zertifikat des Absenders
  - Prüft `SmimeSettings.autoEncrypt` (bei Single-Recipient) → verschlüsselt opportunistisch wenn Empfänger-Zertifikat vorhanden

- **SMTP Inbound Verify/Decrypt** (`packages/smtp-server/src/handlers/message.ts`)
  - Entschlüsselt eingehende `application/pkcs7-mime; smime-type=enveloped-data` automatisch
  - Verifiziert eingehende S/MIME-Signaturen; Ergebnis in `Message.smimeMeta` (JSON)
  - Feld `Message.smimeMeta` (String?) im Prisma-Schema hinzugefügt

- **S/MIME Settings API** (`packages/api-gateway/src/routes/smime.ts`)
  - `GET  /api/v1/smime/settings` — User S/MIME-Einstellungen abfragen
  - `PUT  /api/v1/smime/settings` — User S/MIME-Einstellungen setzen (mit Validierung: autoSign erfordert signingDefault-Zertifikat)

- **Journaling-Engine** (`packages/smtp-server/src/journaling/engine.ts`)
  - RFC 3462 Journal Reports: `multipart/report` mit Envelope-Metadaten + Original-Nachricht
  - `JournalingRule`-Matching: Scope (ALL / INBOUND / OUTBOUND / INTERNAL) + RecipientType (ALL_MAILBOXES / SPECIFIC_USERS / DOMAIN)
  - Wird nach jeder Inbound-Delivery und nach jedem Outbound-Relay aufgerufen (nie blockierend)
  - Dispatch via nodemailer (SMTP intern)

- **JournalingRule-Modell** (Prisma-Schema)
  - Felder: `name`, `journalAddress`, `scope` (JournalScope), `recipientType`, `recipientIds[]`, `wrapAsReport`, `enabled`

- **Admin API Journaling** (`packages/api-gateway/src/routes/admin/journaling.ts`)
  - `GET/POST   /api/v1/admin/compliance/journaling`          — Liste + Anlegen
  - `GET/PUT/DELETE /api/v1/admin/compliance/journaling/:id`  — Einzelne Regel
  - `POST       /api/v1/admin/compliance/journaling/:id/toggle` — Aktivieren/Deaktivieren

- **Aufbewahrungsrichtlinien-Worker** (`packages/backup-service/src/retention/worker.ts`)
  - `runRetentionPolicies()` — verarbeitet alle aktivierten Policies
  - Aktionen: `ARCHIVE` (in Archiv-Ordner verschieben), `DELETE` (Hart-Löschen mit Quota-Update), `MOVE_TO_FOLDER` (beliebiger Zielordner, wird angelegt falls nicht vorhanden)
  - Scope: `ALL_ITEMS` / `INBOX` / `SENT_ITEMS` / `DELETED_ITEMS` / `JUNK`
  - Legal Hold: Löschen wird bei aktiven Holds übersprungen (`respectLegalHold`)
  - Dry-Run-Modus via `RETENTION_DRY_RUN=true`
  - Läuft täglich 03:00 UTC via CronJob (`RETENTION_SCHEDULE` konfigurierbar)

- **RetentionPolicy + RetentionPolicyAssignment-Modelle** (Prisma-Schema)
  - `RetentionPolicy`: `retentionDays`, `action` (RetentionAction), `targetFolder`, `scope` (RetentionScope), `respectLegalHold`
  - `RetentionPolicyAssignment`: `target` (GLOBAL / DOMAIN / USER), `targetId`

- **Admin API Retention Policies** (`packages/api-gateway/src/routes/admin/retention.ts`)
  - `GET/POST   /api/v1/admin/compliance/retention`                     — Liste + Anlegen
  - `GET/PUT/DELETE /api/v1/admin/compliance/retention/:id`             — Einzelne Policy
  - `POST       /api/v1/admin/compliance/retention/:id/toggle`          — Aktivieren/Deaktivieren
  - `GET/POST   /api/v1/admin/compliance/retention/:id/assignments`     — Assignments verwalten
  - `DELETE     /api/v1/admin/compliance/retention/:id/assignments/:aid`
  - `POST       /api/v1/admin/compliance/retention/run`                 — Manueller Lauf (via backup-service)

- **Internes Retention-Endpoint** (`packages/backup-service/src/server.ts`)
  - `POST /internal/retention/run` — von api-gateway aufgerufen für manuellen Lauf

### Changed
- `packages/backup-service/src/scheduler/index.ts` — zweiter CronJob für Retention (03:00 UTC, `RETENTION_SCHEDULE` konfigurierbar); `startBackupScheduler()` gibt jetzt `{ backupJob, retentionJob }` zurück
- `packages/api-gateway/src/server.ts` — neue Phase-9-Routen registriert: `/api/v1/admin/compliance/journaling`, `/api/v1/admin/compliance/retention`

---

## [0.9.2] — 2026-05-14 — Kein Proxy: api-gateway übernimmt HTTP-Routing

### Changed
- **`packages/api-gateway/src/server.ts`** — HTTP-Routing ohne externen Proxy:
  - **Statische Dateien**: Express-Static-Middleware für `/owa/` und `/ecp/` (Frontend-Bundles aus `/app/www/`)
  - **Interner Proxy** (Node.js built-in `http.request`, keine neuen Dependencies) für:
    `/auth/` → auth-service (localhost:3003)
    `/EWS/`, `/mapi/`, `/OAB/`, `/Autodiscover/`, `/autodiscover/` → ews-server (localhost:8080)
    `/Microsoft-Server-ActiveSync` → activesync (localhost:3005)
    `/dav/` → caldav-server (localhost:8082)
  - Root `GET /` → Redirect zu `/owa/`
  - Konfigurierbar via `AUTH_SERVICE_URL`, `EWS_SERVICE_URL`, `EAS_SERVICE_URL`, `CALDAV_SERVICE_URL`
- **`infra/docker/Dockerfile.app`** — nginx entfernt, nur noch `supervisor curl tini` als System-Deps; EXPOSE 3000 statt 80/443
- **`infra/docker/supervisord-app.conf`** — nginx-Sektion entfernt
- **`infra/docker/docker-compose.yml`** — Vereinfacht auf 4 Services: `coremail` + `postgres:16-alpine` + `redis:7-alpine` + `minio/minio` (keine Custom-Images für DB); Port 3000 statt 80/443
- **`infra/docker/docker-compose.synology.yml`** — Gleiche Vereinfachung, `8080:3000` für DSM-Kompatibilität, kein TLS-Cert-Handling mehr (DSM Application Portal übernimmt)
- **`scripts/synology-setup.sh`** — TLS-Zertifikat-Schritte entfernt; Anleitung für DSM Reverse Proxy
- **`scripts/docker-push.sh`** — Nur noch 1 Image: `magpeek/coremail-app`

### Removed
- `infra/docker/Dockerfile.db` — nicht mehr nötig (Standard-Images)
- `infra/docker/entrypoint-db.sh` — nicht mehr nötig
- `infra/docker/supervisord-db.conf` — nicht mehr nötig
- `infra/docker/nginx/nginx.app.conf` — nginx vollständig entfernt

---

## [0.9.1] — 2026-05-14 — 2-Container-Architektur & Docker-Deployment-Dokumentation

### Added
- **Monolithischer App-Container** (`magpeek/coremail-app`) — alle 13 Node.js-Services + nginx + OWA/ECP-Frontends in einem einzigen Image, verwaltet von `supervisord`
  - `infra/docker/Dockerfile.app` — Multi-Stage-Build (Node.js Builder + Frontend Builder + Alpine Runner)
  - `infra/docker/supervisord-app.conf` — supervisord-Konfiguration mit Prioritäten (nginx → storage-api → auth → security-filter → Protokoll-Services)
  - `infra/docker/nginx/nginx.app.conf` — nginx-Konfiguration für App-Container (alle Upstream-Adressen auf localhost)
- **Datenbank-Container** (`magpeek/coremail-db`) — PostgreSQL 16 + Redis 7 + MinIO in einem Image
  - `infra/docker/Dockerfile.db` — abgeleitet von `postgres:16-alpine`, ergänzt um Redis (apk) und MinIO (Binary)
  - `infra/docker/supervisord-db.conf` — supervisord für PostgreSQL + Redis + MinIO
  - `infra/docker/entrypoint-db.sh` — Initialisierungs-Entrypoint: PostgreSQL-Init-Skript ausführen, dann supervisord starten
- **Docker-Deployment-Dokumentation** (`docs/deployment-docker.md`) — vollständige Anleitung für Docker-Betrieb: Schnellstart, Konfigurationsreferenz, Synology NAS, Updates, Fehlerbehebung, Produktions-Checkliste

### Changed
- **`infra/docker/docker-compose.yml`** — von 14-Service-Stack auf 2-Container-Stack vereinfacht (`coremail-app` + `coremail-db`)
  - Observability-Stack (Prometheus/Grafana/Loki/Tempo) bleibt als `--profile observability` erhalten
  - Alle internen Service-URLs auf `localhost:PORT` (gleicher App-Container)
- **`infra/docker/docker-compose.synology.yml`** — ebenfalls auf 2-Container vereinfacht (Ports 8080/8443 für DSM-Kompatibilität)
- **`scripts/docker-push.sh`** — baut und pusht nur noch 2 Images (`coremail-app` + `coremail-db`) statt 14 Einzel-Images
- **`README.md`** — Architektur-Diagramm auf 2-Container aktualisiert, Docker Hub Images-Tabelle vereinfacht, Deployment (Docker)-Abschnitt ergänzt

### Removed
- Alle 14 Einzel-Images aus der CI/CD-Pipeline entfernt: `magpeek/coremail-storage-api`, `magpeek/coremail-auth-service`, `magpeek/coremail-security-filter`, `magpeek/coremail-smtp-server`, `magpeek/coremail-imap-server`, `magpeek/coremail-pop3-server`, `magpeek/coremail-ews-server`, `magpeek/coremail-autodiscover`, `magpeek/coremail-caldav-server`, `magpeek/coremail-api-gateway`, `magpeek/coremail-backup-service`, `magpeek/coremail-activesync`, `magpeek/coremail-web-client`, `magpeek/coremail-admin-panel`
- `infra/docker/docker-compose.prod.yml` (separates Prod-Overlay nicht mehr nötig — `docker-compose.yml` verwendet direkt Hub-Images)

---

## [0.9.0] — 2026-05-13 — Phase 8: EMS REST-Bridge, MAPI over HTTP, eDiscovery & Legal Hold

### Added
- **EMS REST-Bridge** (`/api/v1/admin/ems/`)
  - `adminEmsRouter` — vollständige REST-Implementierung aller 20+ Exchange Management Shell Cmdlets
  - **Mailbox-Cmdlets**: `Get-Mailbox`, `New-Mailbox`, `Set-Mailbox`, `Remove-Mailbox`
  - **Gruppen-Cmdlets**: `Get/New/Set/Remove-DistributionGroup`, `Add/Remove/Get-DistributionGroupMember`
  - **Domain-Cmdlets**: `Get/New/Remove-AcceptedDomain`
  - **Transportregel-Cmdlets**: `Get/New/Set/Remove-TransportRule`, `Enable/Disable-TransportRule`
  - **Statistiken**: `Get-MailboxStatistics`
  - **Ressourcen**: `Get-ResourceMailbox`
  - POST `/cmdlet` — universeller Cmdlet-Dispatcher (EMS-kompatibles JSON-Interface)
- **PowerShell-Remoting Phase 8** (`/PowerShell/`)
  - Vollständiges Cmdlet-Routing: erkannte Cmdlets werden direkt an EMS REST-Bridge weitergeleitet
  - SOAP-Antwort: erkannte Cmdlets liefern strukturierten JSON-Output im SOAP-Envelope
  - SOAP-Fault mit vollständiger Cmdlet-Liste für nicht unterstützte Cmdlets
  - Unterstützte Cmdlets als `Set<string>` (SUPPORTED_CMDLETS) — einfach erweiterbar
- **MAPI over HTTP** (`/mapi/` — `packages/ews-server/src/mapi/handler.ts`)
  - `GET /mapi/healthcheck.htm` — Outlook Connectivity-Probe (antwortet "MAPI")
  - `POST /mapi/emsmdb/` — EMSMDB Session-Lifecycle:
    - `Connect` → Session-Cookie + Server-Metadaten (Exchange 2019 Versions-String)
    - `Execute` → ecNotSupported → transparenter EWS-Fallback für Outlook
    - `Disconnect` → Session beenden
    - `NotificationWait` → sofortige Antwort (kein Long-Poll)
  - `POST /mapi/nspi/` — NSPI Adressbuch-Service:
    - `Bind` → NSPI-Session
    - `QueryRows` → GAL-Einträge aus PostgreSQL (max. 500 User)
    - `ResolveNames` → Namensauflösung (Display Name + E-Mail)
    - `Unbind` → Session beenden
  - nginx routing: `/mapi/` → ews-server (bereits konfiguriert)
- **eDiscovery & Legal Hold** (`/api/v1/admin/ediscovery/`)
  - `adminEDiscoveryRouter` — vollständige eDiscovery-Verwaltung
  - **Suchen**: `GET/POST/DELETE /searches`, `GET /searches/:id`
  - **Suchausführung**: `POST /searches/:id/run` — asynchron via Redis Pub/Sub + `runSearch()`
  - **Suchergebnisse**: `GET /searches/:id/results?limit=&offset=` — paginierte Ergebnisliste
  - **Export**: `POST /searches/:id/export` — MBOX-Export-Job (Redis-Queue)
  - **Legal Hold**: `GET/POST /holds`, `GET/DELETE /holds/:id`
  - **Hold-Check**: `GET /holds/check/:userId` — User unter Legal Hold?
  - Suchparameter: `keywords`, `senderAddresses`, `recipientAddresses`, `dateFrom`, `dateTo`, `subjectContains`, `hasAttachment`, `mailboxIds` (leer = alle Postfächer)
- **Prisma-Schema Phase 8**
  - Neues Enum: `EDiscoveryStatus` (DRAFT / RUNNING / COMPLETED / FAILED)
  - Neues Model: `EDiscoverySearch` — Suchparameter als JSON, resultCount, exportPath
  - Neues Model: `LegalHold` — mailboxIds, active, appliedBy, appliedAt, releasedAt
  - Neues Model: `TransportRule` — conditions/actions als JSON, priority, enabled

---

## [0.8.0] — 2026-05-13 — Phase 7: Verteilergruppen, Raumverwaltung, Öffentliche Ordner, PowerShell-Stub

### Added
- **Verteilergruppen (Distribution Groups)**
  - `DistributionGroup`-Model: Statische und dynamische Gruppen (LDAP-Filter)
  - `DistributionGroupMember`-Model: Mitglieder (USER / SHARED_MAILBOX / GROUP / EXTERNAL)
  - SMTP-Expansion: Eingehende E-Mails an Gruppenadresse werden automatisch an alle Mitglieder zugestellt (rekursiv, Loop-Schutz)
  - Admin-REST-API: `GET/POST/PUT/DELETE /api/v1/admin/groups`
  - Mitglieder-API: `GET/POST/DELETE /api/v1/admin/groups/:id/members`
  - GAL-Endpunkt: `GET /api/v1/admin/groups/gal/list` — für Adress-Autovervollständigung
  - Konfigurierbar: Moderierung, externe Absender, verborgen aus GAL
- **Raum- und Ressourcenpostfächer (Resource Mailboxes)**
  - `ResourceMailbox`-Model: Typ ROOM / EQUIPMENT, Kapazität, Standort, Buchungsregeln
  - `ResourceCalendar`-Model + `ResourceBooking`-Model: Buchungsverwaltung
  - **Auto-Accept-Logik**: iCal-VEVENT aus eingehender E-Mail wird automatisch geparst und Buchung als ACCEPTED / DECLINED / PENDING gespeichert
  - Konflikterkennung: Überschneidende Buchungen werden automatisch abgelehnt (konfigurierbar)
  - Admin-REST-API: `GET/POST/PUT/DELETE /api/v1/admin/resources`
  - Buchungs-API: `GET /api/v1/admin/resources/:id/bookings`, `DELETE /api/v1/admin/resources/:id/bookings/:bookingId`
  - Free/Busy-Abfrage: `GET /api/v1/admin/resources/freebusy/query?email=&from=&to=`
- **Öffentliche Ordner (Public Folders)**
  - `PublicFolder`-Model: Hierarchischer Baum mit ACL-System (READ / POST / OWNER)
  - `PublicFolderMessage`-Model: Beiträge in öffentlichen Ordnern
  - Admin-API: `GET/POST/PUT/DELETE /api/v1/admin/public-folders` inkl. ACL-Verwaltung
  - User-API: `GET /api/v1/public-folders` (nur zugängliche Ordner), `GET/POST /api/v1/public-folders/:id/messages`
- **PowerShell-Remoting-Stub** (`/PowerShell/`)
  - WSMan-Identifizierung: `POST /PowerShell/` mit SOAP-Envelope
  - WSDL-Endpunkt: `GET /PowerShell/`
  - Stub-Antwort für alle Cmdlets mit klarer Fehlermeldung (Phase 8 geplant)
  - nginx-Routing: `/PowerShell/` → api-gateway mit Auth-Header-Weiterleitung
- **SMTP-Server-Erweiterungen**
  - `verifyRecipient()`: Akzeptiert nun auch Verteilergruppen- und Ressourcenpostfach-Adressen
  - `expandRecipients()`: Rekursive Gruppenexpansion mit Duplikateleminierung
  - `processResourceMailboxes()`: Auto-Accept-Verarbeitung für Raumkalender
- **Prisma-Schema**
  - Neue Enums: `GroupType` (STATIC / DYNAMIC), `ResourceType` (ROOM / EQUIPMENT)
  - Neue Modelle: `DistributionGroup`, `DistributionGroupMember`, `ResourceMailbox`, `ResourceCalendar`, `ResourceBooking`, `PublicFolder`, `PublicFolderMessage`
  - `Domain`-Relation: `distributionGroups`, `resourceMailboxes`
  - `Mailbox`-Relation: `resourceMailbox`

---

## [0.7.0] — 2026-05-13 — Phase 6: ActiveSync (EAS) + S/MIME

### Added
- **`packages/activesync`** — Microsoft Exchange ActiveSync (EAS 14.1) Server
  - WBXML binary codec mit vollständigem EAS-Codepage-Support (AirSync, Email, FolderHierarchy, Provision, Ping, ComposeMail)
  - **Provision-Befehl**: Geräte-Registrierung, Policy-Aushandlung (permissive Policy out-of-the-box)
  - **FolderSync-Befehl**: Initiale + inkrementelle Ordnerhierarchie-Synchronisation
  - **Sync-Befehl**: Bidirektionale E-Mail-Synchronisation mit Delta-Tracking, Read-Flag, Delete
  - **SendMail-Befehl**: Ausgehende E-Mails via Redis-Queue, optionales Speichern im Gesendeten-Ordner
  - **SmartReply / SmartForward**: Antworten/Weiterleiten mit MIME-Payload
  - **Ping-Befehl**: Long-Poll Push-Benachrichtigung (Heartbeat bis 59 Minuten)
  - **GetAttachment**: Anhang-Abruf per AttachmentName
  - Basic Auth + App-Passwort-Unterstützung
  - Express-Server auf Port 3005 mit `/health`-Endpoint
  - Eigenes Dockerfile
- **S/MIME API** (`packages/api-gateway/src/routes/smime.ts`)
  - `GET/POST/PUT/DELETE /api/v1/smime/certificates` — PKCS#12-Zertifikat-Verwaltung
  - `GET /api/v1/smime/public-key/:email` — Public Key für Verschlüsselung ausgehender Mails
  - `GET/DELETE /api/v1/smime/devices` — ActiveSync-Geräteverwaltung
- **Prisma-Schema-Erweiterungen**
  - `ActiveSyncDevice`-Model: Geräte-ID, Type, Policy-Key, Status, SyncKey-Map
  - `UserCertificate`-Model: Fingerprint, Subject/Issuer, Gültigkeit, Signing/Encrypt-Default
- **Autodiscover v1**: ActiveSync-Protokollblock (`<Type>ActiveSync</Type>`) hinzugefügt
- **nginx**: Proxy-Route für `/Microsoft-Server-ActiveSync` mit Long-Poll-Timeout (600s)
- **docker-compose.yml**: `activesync`-Service auf Port 3005

### Changed
- `packages/autodiscover/src/v1.ts`: `EAS_URL`-Umgebungsvariable + ActiveSync-Block im XML

---

## [0.6.1] — 2026-05-09 — Docker Hub Publishing & CI/CD

### Added
- **GitHub Actions Workflow** (`.github/workflows/docker-publish.yml`)
  - Baut und pusht alle 13 Service-Images bei jedem Push auf `main` und bei Git-Tags (`v*.*.*`)
  - Multi-Arch-Build: `linux/amd64` + `linux/arm64` via Docker Buildx / QEMU
  - Layer-Caching via GitHub Actions Cache (scope pro Service)
  - Semantisches Tagging: `1.2.3`, `1.2`, `1`, `latest`, `edge` (main-Branch), `sha-<hash>`
  - OCI-Labels: `image.title`, `image.version`, `image.revision`, `image.source`
  - Login-Schritt nur bei echten Pushes (nicht bei Pull Requests)
  - Matrix-Strategy: alle 13 Services parallel, `fail-fast: false`
- **`scripts/docker-push.sh`** — lokales Build-und-Push-Skript
  - Version automatisch aus CHANGELOG extrahiert oder explizit angegeben
  - `--no-push`-Flag zum reinen lokalen Bauen
  - Multi-Arch via `docker buildx`, OCI-Labels mit Git-SHA und Timestamp
  - Farbige Zusammenfassung mit allen gepushten Image-Namen
- **`infra/docker/docker-compose.prod.yml`** — Production-Override
  - Ersetzt `build:`-Direktiven durch fertige Docker-Hub-Images
  - Image-Tag über `COREMAIL_VERSION`-Env-Variable steuerbar
  - Verwendung: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`

### Docker Hub Images

Alle Images unter: **https://hub.docker.com/u/magpeek**

| Image | Beschreibung |
|-------|-------------|
| `magpeek/coremail-storage-api` | Interner Storage-API-Service |
| `magpeek/coremail-auth-service` | Authentifizierung (Local/LDAP/OIDC/MFA) |
| `magpeek/coremail-security-filter` | SPF/DKIM/DMARC/DNSBL/ClamAV/rspamd |
| `magpeek/coremail-smtp-server` | SMTP Inbound + Outbound (25/465/587) |
| `magpeek/coremail-imap-server` | IMAP4rev1 + IDLE + CONDSTORE (143/993) |
| `magpeek/coremail-pop3-server` | POP3 (110/995) |
| `magpeek/coremail-ews-server` | Exchange Web Services SOAP/XML (Outlook) |
| `magpeek/coremail-autodiscover` | Autodiscover v1 + v2 |
| `magpeek/coremail-caldav-server` | CalDAV + CardDAV (iOS/Android/Thunderbird) |
| `magpeek/coremail-api-gateway` | REST API + SSE Live-Events |
| `magpeek/coremail-backup-service` | Backup/Restore (MBOX/EML/S3) |
| `magpeek/coremail-web-client` | Webmail (OWA React UI) |
| `magpeek/coremail-admin-panel` | Admin-Panel (ECP React UI) |

---

## [0.6.0] — 2026-05-09 — Phase 5: Backup + Observability + Kubernetes

### Added
- **packages/backup-service** — Self-service and admin backup/restore on port 3004
  - MBOX export (RFC 4155) with page-based streaming and backpressure handling
  - EML-ZIP export — individual `.eml` files + `.vcf` contacts + `.ics` calendar events
  - S3-compatible upload via `@aws-sdk/lib-storage` (MinIO multipart, 10 MB parts)
  - Presigned download URLs (1 h TTL) via `@aws-sdk/s3-request-presigner`
  - Scheduled full-server backup (daily 02:00 UTC via `cron` CronJob)
  - Retention policy (configurable, default 30 days) applied after each scheduled run
  - Soft-delete restore: users can recover messages deleted within the last 30 days
  - MBOX import via streaming `readline` interface (no full-file buffering)
  - Admin endpoints: trigger immediate backup, list jobs, download signed URLs
  - User self-service endpoints: request backup, track status, download, list restorables
- **packages/core — OpenTelemetry instrumentation**
  - `initMetrics()` — PrometheusExporter on port 9464, MeterProvider with service labels
  - `createMailMetrics()` — counters/histograms for messages, auth, HTTP, queue depth, storage
  - `metricsMiddleware()` — Express middleware recording method/path/status/duration
  - `initTracing()` — NodeSDK + OTLPTraceExporter → otel-collector, SIGTERM shutdown hook
  - `withSpan()` — typed helper wrapping async functions with active spans and error recording
- **infra/observability** — Full observability stack (docker-compose `observability` profile)
  - **Prometheus** — scrapes all 9 CoreMail services + postgres-exporter + redis-exporter + node-exporter
  - **Alertmanager** — 8 alert rules (dead-letter queue, high spam rate, virus found, brute-force, quota exceeded, service down, HTTP errors, slow responses), email routing
  - **OTEL Collector** — OTLP gRPC+HTTP receivers, fan-out to Tempo + Prometheus remote write + Loki
  - **Grafana** — pre-provisioned Prometheus, Tempo, Loki datasources; `coremail-overview` dashboard (8 panels)
  - **Tempo** — distributed tracing backend, OTLP receiver, 7-day retention, local storage
  - **Loki** — log aggregation, filesystem storage, v13 schema, 7-day retention
  - **postgres-exporter**, **redis-exporter**, **node-exporter** — infrastructure metrics
- **infra/k8s** — Kubernetes Helm chart (`helm install coremail ./infra/k8s`)
  - `Chart.yaml` — chart metadata, Bitnami Redis subchart dependency
  - `values.yaml` — fully documented defaults for all services, HPA, resources, CNPG, MinIO, Ingress
  - `templates/_helpers.tpl` — shared helpers (image ref, secret name, env helpers)
  - `templates/secret.yaml` — chart-managed Secret (skipped if `existingSecret` set)
  - `templates/configmap.yaml` — shared env ConfigMap for all pods
  - `templates/cnpg-cluster.yaml` — CloudNativePG `Cluster` resource (3 instances, 2 read replicas, optional WAL backup)
  - `templates/minio.yaml` — MinIO distributed StatefulSet (4 nodes, erasure coding)
  - `templates/deployments.yaml` — Deployment + Service + HPA + PodDisruptionBudget for all 12 services
  - `templates/ingress.yaml` — nginx Ingress with cert-manager TLS, Exchange-compatible paths
  - `templates/NOTES.txt` — post-install instructions

### Changed
- `infra/docker/docker-compose.yml` — backup-service promoted to always-on; 9 observability services added under `observability` profile; new volumes for all observability data

---

## [0.5.0] — 2026-05-09 — Phase 4: CalDAV + API-Gateway + Frontend

### Added
- **packages/caldav-server** — CalDAV (RFC 4791) + CardDAV (RFC 6352) server on port 8082
  - PROPFIND, GET, PUT, DELETE for `.ics` (calendar events) and `.vcf` (contacts)
  - MKCALENDAR, REPORT (sync), OPTIONS with correct DAV headers
  - Well-known redirects (`/.well-known/caldav`, `/.well-known/carddav`)
  - Basic Auth + Bearer JWT via auth-service
- **packages/api-gateway** — REST API on port 3000
  - `GET/POST/PATCH/DELETE /api/v1/mail/folders`, `/messages`, `/search`, `/send`
  - `GET/POST/PUT/DELETE /api/v1/calendar`, `/calendar/events`
  - `GET/POST/PUT/DELETE /api/v1/contacts`, `/contacts/gal`
  - `GET/POST/PUT/DELETE /api/v1/tasks`, `/api/v1/notes`
  - `GET/PUT /api/v1/user/profile`, `/signature`, `/oof`, `/rules`, `/shared-mailboxes`
  - `GET/POST/PUT/DELETE /api/v1/admin/mailboxes` (incl. shared mailboxes + permissions)
  - `GET/POST/PUT/DELETE /api/v1/admin/domains` (incl. DKIM DNS record export)
  - `GET/POST/DELETE /api/v1/admin/queues` (SMTP queue monitoring)
  - `GET/PUT/DELETE /api/v1/admin/logs` (system log viewer + log-level control)
  - `GET /api/v1/events` — SSE live-events stream (Redis Pub/Sub → browser)
- **packages/web-client** — React 19 OWA-style webmail UI (Vite + TailwindCSS)
  - Mail: three-column layout (folder tree / message list / reader), compose window
  - Calendar: FullCalendar week/month/day view with create/delete
  - Contacts: search, detail view, create/edit/delete
  - Tasks: list with priority, due date, toggle complete
  - Settings: profile, rich-text signature (Tiptap), OOF, security (App Passwords / 2FA)
  - Real-time updates via SSE (`useMailEvents` hook)
  - Auth: login page, JWT in Zustand + localStorage, auto-redirect on 401
- **packages/admin-panel** — React 19 ECP-style admin UI (Vite + TailwindCSS)
  - Dashboard: queue stats, service health overview
  - Mailboxes: create/toggle/delete, quota display, role assignment
  - Domains: add domain, auto-generate DKIM key pair, export DNS TXT record
  - Queues: live queue counters, flush dead-letter queue
  - Logs: filterable log viewer (level / service / search)
  - Protection: security feature status matrix
  - Servers: service health grid (all 10 services)
  - Reports: mail flow bar chart (recharts), daily stats
- **infra/docker/nginx/owa.conf** + **ecp.conf** — nginx SPA configs for web + admin containers

### Changed
- `infra/docker/docker-compose.yml` — `caldav-server`, `api-gateway`, `web-client`, `admin-panel` services already wired; no further changes needed

---

## [0.4.0] — 2026-04-xx — Phase 3: EWS + Autodiscover + Auth

### Added
- **packages/ews-server** — Exchange Web Services (SOAP/XML) on port 8080
  - 13 EWS operations: FindItem, GetItem, CreateItem, UpdateItem, DeleteItem,
    SyncFolderHierarchy, SyncFolderItems, MoveItem, CopyItem,
    ResolveNames, GetUserAvailability, Subscribe, GetStreamingEvents
  - CalendarItem, Contact support
  - Bearer + Basic Auth (delegated to auth-service)
  - Shared Mailbox access via `X-AnchorMailbox` header
- **packages/autodiscover** — Autodiscover v1 (XML) + v2 (JSON) on port 8081
  - Exchange-compatible response with EXCH/IMAP/SMTP protocol blocks
  - Supports Outlook 2010–365
- **packages/auth-service** — Authentication & MFA on port 3003
  - Local (bcrypt + pepper), LDAP fallback, OIDC SSO
  - TOTP (otpauth), WebAuthn/FIDO2 (@simplewebauthn/server), Backup Codes
  - App Passwords for IMAP/POP3/SMTP clients
  - Session management
- **packages/auth-ldap** — LDAP/Active Directory connector (ldapts)
- **packages/auth-sso** — OIDC SSO connector (openid-client)

---

## [0.3.0] — 2026-03-xx — Phase 2: SMTP + IMAP + POP3 + Security

### Added
- **packages/smtp-server** — Inbound + Outbound SMTP (ports 25/465/587)
  - SPF/DKIM/DMARC validation (mailauth), DKIM signing on outbound
  - Redis outbound queue, retry with exponential backoff
- **packages/imap-server** — IMAP4rev1 + IDLE + CONDSTORE (ports 143/993)
- **packages/pop3-server** — POP3 (ports 110/995)
- **packages/security-filter** — Mail security pipeline
  - Greylisting, DNSBL (Spamhaus ZEN + SpamCop), reverse-DNS, SPF/DKIM/DMARC
  - ClamAV antivirus, rspamd anti-spam, attachment filter

---

## [0.2.0] — 2026-02-xx — Phase 1: Foundation

### Added
- **packages/core** — JWT auth, Redis client, logger (pino), shared types
- **packages/storage** — Prisma ORM (22 models), MinIO integration, MIME parser
- Docker Compose base stack: PostgreSQL 16, Redis 7, MinIO, rspamd, nginx
- pnpm monorepo, TypeScript 5.5, ESLint, Prettier
