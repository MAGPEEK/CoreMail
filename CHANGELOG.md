# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [Unreleased]

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
