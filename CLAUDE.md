# CLAUDE.md — CoreMail Projektgedächtnis

Diese Datei wird von Claude Code automatisch bei jedem Gespräch eingelesen.
Sie enthält alle wichtigen Kontextinformationen über das CoreMail-Projekt.

---

## Projektüberblick

**CoreMail** ist eine vollständige Open-Source-Alternative zu Coremail, entwickelt in diesem Verzeichnis:
```
/Users/stefan/Library/CloudStorage/SynologyDrive-Data/Mailserver/coremail/
```

**Ziel**: Coremail Mailserver für 10–500 User (KMU)
**Aktuelle Version**: `5.6.1` (Verteilergruppen entfernt + OAuth2-Server entfernt v5.6.0 + IMAP4rev2 v5.5.0 + MAPI raus v5.4.0)
**GitHub**: https://github.com/MAGPEEK/CoreMail.git
**Docker Hub**: https://hub.docker.com/u/magpeek

## Architektur-Entscheidungen (v5.4.0+)

- **MAPI/HTTP komplett entfernt (v5.4.0)**: Outlook 2024 LTSC erzwingt Microsoft-Entra-only-Modern-Auth, was für non-Microsoft-Server fundamental nicht funktioniert. Custom-ADFS-Emulation wäre 3-4 Wochen Aufwand ohne Erfolgs-Garantie. Empfohlener Outlook-Client: „Andere E-Mail-Konten" → IMAP.
- **OAuth2-Server komplett entfernt (v5.6.0)**: war unter `/oauth2/*` (Authorization-Server für externe Apps). Da XOAUTH2 SASL keine Mainstream-Client-UI-Unterstützung hat (Apple Mail / Outlook LTSC / eM Client bieten keine UI für custom OAuth-Server), war der Server in der Praxis ohne realen Use-Case. JWT zurück auf **HS256** (`JWT_SECRET`). MWA + BCP nutzen Session-JWTs über `/auth/login`, Mail-Clients App-Passwörter.
- **Verteilergruppen komplett entfernt (v5.6.1)**: DistributionGroups + DistributionGroupMember Models gelöscht. Use-Case besser via Shared Mailboxes (Team-Postfach) oder externem Listserv (Mailman, listmonk). Reduziert Code-Komplexität + 1 BCP-Page weniger zu pflegen.
- **IMAP4rev2** (RFC 9051) compliance: STARTTLS, AUTHENTICATE SASL (PLAIN+LOGIN), UNSELECT, ID, MOVE, UIDPLUS, STATUS=SIZE.
- **SSO via externe IdPs** (auth-sso package, Azure AD/Keycloak/Authentik) **bleibt erhalten** — das ist OIDC-Client-Funktionalität (CoreMail loggt User über externen IdP ein), NICHT zu verwechseln mit dem entfernten OAuth2-Authorization-Server.

---

## Technologie-Stack

| Bereich | Technologie |
|---------|------------|
| Frontend | React 19, Vite, TailwindCSS, shadcn/ui, TanStack Query v5, Zustand, Tiptap, FullCalendar |
| Backend | Node.js 22, TypeScript 5.5, ESM (`"type":"module"`), Express 4 |
| ORM | Prisma 5 (PostgreSQL) |
| Datenbank | PostgreSQL 16, Redis 7, MinIO |
| Monorepo | pnpm Workspaces (pnpm@11) |
| Deployment | Docker Compose (dev/prod) + Kubernetes Helm Chart |
| CI/CD | GitHub Actions → Docker Hub Multi-Arch (amd64 + arm64) |

---

## Monorepo-Struktur

```
coremail/
├── packages/
│   ├── core/              # Logger, JWT, Redis-Client, Auth-Helpers
│   ├── storage/           # Prisma-Schema + -Client, MinIO-Abstraktionsschicht
│   ├── smtp-server/       # SMTP Inbound/Outbound (Port 25, 465, 587)
│   ├── imap-server/       # IMAP4rev1 + IDLE + CONDSTORE (Port 143, 993)
│   ├── pop3-server/       # POP3 (Port 110, 995)
│   ├── ews-server/        # Web Services EWS SOAP/XML (Port 8080)
│   ├── autodiscover/      # Autodiscover v1 + v2 (Port 8081)
│   ├── caldav-server/     # CalDAV + CardDAV (Port 8082)
│   ├── api-gateway/       # REST API + SSE (Port 3000)
│   ├── auth-service/      # Lokal/LDAP/OIDC/MFA (Port 3003)
│   ├── auth-ldap/         # LDAP-Connector (intern)
│   ├── auth-sso/          # OIDC/OAuth2/SAML (intern)
│   ├── backup-service/    # MBOX/EML/S3-Backup (Port 3004)
│   ├── security-filter/   # SPF/DKIM/DMARC/ClamAV/rspamd (Port 3002)
│   ├── activesync/        # ActiveSync EAS 14.1 (Port 3005)
│   ├── web-client/        # React OWA Webmail (Port 80)
│   └── admin-panel/       # React ECP Admin-Panel (Port 80)
├── infra/
│   ├── docker/            # docker-compose.yml, docker-compose.synology.yml, nginx/, postgres/, rspamd/
│   └── k8s/               # Helm Chart (Chart.yaml, values.yaml, templates/)
├── scripts/               # setup.sh, gen-dev-certs.sh, docker-push.sh
├── .github/workflows/     # docker-publish.yml (CI/CD)
├── CHANGELOG.md           # Keep a Changelog Format
├── CLAUDE.md              # Diese Datei
└── .env.example
```

---

## Services & Docker Images (2-Container-Architektur seit v0.9.1)

CoreMail verwendet ab v0.9.1 eine konsolidierte **2-Container-Architektur**:

| Container | Docker Image | Inhalt |
|-----------|-------------|--------|
| `coremail` | `magpeek/coremail-app:3.17.39` | Alle Node.js-Services + MWA/BCP-Frontends (kein nginx!) |
| `rspamd`   | `rspamd/rspamd:4.0.0`        | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy, URL) |
| `clamav`   | `clamav/clamav:stable`       | Open-Source Antivirus Engine (GPL), freshclam Updates |
| `postgres` | `postgres:16-alpine` | Standard-Image |
| `redis` | `redis:7-alpine` | Standard-Image |
| `minio` | `minio/minio` | Standard-Image |

**1 Custom Docker Hub Image**: `magpeek/coremail-app` — nur dieses Image wird gebaut/gepusht.

**HTTP-Routing ohne nginx**: Der `api-gateway` auf Port 3000 übernimmt alle HTTP-Routen:
- `/owa/` `/bcp/` — Express.static (Frontend-Bundles aus `/app/www/`)
- `/auth/` → proxy zu auth-service (localhost:3003)
- `/EWS/` `/Autodiscover/` → proxy zu ews-server (localhost:8080) — `/mapi/*` entfernt in v5.4.0
- `/Microsoft-Server-ActiveSync` → proxy zu activesync (localhost:3005)
- `/dav/` → proxy zu caldav-server (localhost:8082)
- `/api/v1/` `/PowerShell/` → direkte Handler

**TLS**: Extern (Traefik, Caddy, DSM Application Portal) — kein TLS im CoreMail-Stack.

**Interne Ports im App-Container** (localhost, von supervisord verwaltet):

| Service | Port |
|---------|------|
| nginx | 80 / 443 |
| api-gateway | 3000 |
| storage-api | 3001 |
| security-filter | 3002 |
| auth-service | 3003 |
| backup-service | 3004 |
| activesync | 3005 |
| ews-server | 8080 |
| autodiscover | 8081 |
| caldav-server | 8082 |
| smtp-server | 25 / 465 / 587 |
| imap-server | 143 / 993 |
| pop3-server | 110 / 995 |

**Docker Hub**: `magpeek/coremail-app` + `magpeek/coremail-db`
- Manuell pushen: `bash scripts/docker-push.sh [VERSION]`
- Starten: `docker compose -f infra/docker/docker-compose.yml up -d`

**Neue Dockerfiles:**
- `infra/docker/Dockerfile.app` — monolithischer App-Container
- `infra/docker/Dockerfile.db` — Datenbank-Container
- `infra/docker/supervisord-app.conf` — supervisord für App
- `infra/docker/supervisord-db.conf` — supervisord für DB
- `infra/docker/nginx/nginx.app.conf` — nginx für App-Container
- `infra/docker/entrypoint-db.sh` — Entrypoint für DB-Container

---

## Implementierungsstand (Phasen)

| Phase | Status | Inhalt |
|-------|--------|--------|
| Phase 1 | ✅ Fertig | Foundation: Core, Storage, Prisma, Docker |
| Phase 2 | ✅ Fertig | SMTP + IMAP + POP3 + Security-Filter |
| Phase 3 | ✅ Fertig | EWS + Autodiscover + Auth (LDAP/OIDC/MFA) |
| Phase 4 | ✅ Fertig | CalDAV/CardDAV + REST API + React OWA + React ECP |
| Infra | ✅ Fertig | Minimaler Stack: 1 Custom-Image (coremail-app), Standard-DB-Images, kein nginx/Proxy |

---

## TypeScript-Regeln (KRITISCH)

Das Projekt verwendet `"exactOptionalPropertyTypes": true`. Das hat häufige Fallstricke:

### Optionale Felder in Prisma-Updates
```typescript
// ❌ FALSCH — exactOptionalPropertyTypes wirft Fehler
prisma.task.update({ data: { dueDate: dueDate ? new Date(dueDate) : undefined } });

// ✅ RICHTIG — Conditional Spread
prisma.task.update({ data: { ...(dueDate ? { dueDate: new Date(dueDate) } : {}) } });
```

### ESM-Imports
Alle Imports müssen `.js`-Extension haben (auch wenn Datei `.ts` ist):
```typescript
import { foo } from './utils.js'; // ✅
import { foo } from './utils';    // ❌
```

---

## Prisma-Schema (wichtige Feldnamen)

Die Prisma-Schema-Datei ist die einzige Quelle der Wahrheit:
`packages/storage/prisma/schema.prisma`

Häufige Fallstricke (historische Fehler):

| Model | Richtiges Feld | Falsches Feld (veraltet) |
|-------|---------------|--------------------------|
| `AppPassword` | `lastUsedAt` | ~~`lastUsed`~~ |
| `Session` | `tokenHash` | ~~`token`~~ |
| `User` | `mailbox` (1:1) | ~~`mailboxes`~~ |
| `Note` | `subject` | ~~`title`~~ |
| `Task` | `subject`, `body`, `reminder`, `reminderByMail` | ~~`title`~~, ~~`notes`~~, ~~`reminderAt`~~ |
| `LdapConfig` | `lastSyncAt` | ~~`lastSync`~~ |
| `Folder` | `displayName` (required!) | — |
| `CalendarEvent` | `uid` (required!) | — |
| `UserRole` | kein `ADMIN`-Wert | ~~`ADMIN`~~ |

**Nach Schema-Änderungen immer** `prisma generate` ausführen:
```bash
pnpm --filter @coremail/storage exec prisma generate
```

**Phase-6-Modelle**:
- `ActiveSyncDevice` — Geräte-Registrierung, SyncKeys, PolicyKey
- `UserCertificate` — S/MIME Zertifikate (Fingerprint, MinIO-Pfad)

**Phase-7-Modelle**:
- ~~`DistributionGroup` / `DistributionGroupMember`~~ — komplett entfernt in v5.6.1
- `ResourceMailbox` / `ResourceCalendar` / `ResourceBooking` — Raum-/Ressourcenpostfächer
- ~~`PublicFolder` / `PublicFolderMessage`~~ — komplett entfernt in v3.18.31

**Phase-8-Modelle**:
- ~~`EDiscoverySearch`~~ — komplett entfernt in v3.18.5
- ~~`LegalHold`~~ — komplett entfernt in v3.18.5

**Phase-9-Modelle**:
- `SmimeSettings` — Pro-User: autoSign, autoEncrypt, verifyIncoming, decryptIncoming
- `JournalingRule` — Journaling-Regeln (scope, recipientType, journalAddress, wrapAsReport)
- `RetentionPolicy` — Aufbewahrungsrichtlinien (retentionDays, action, scope)
- `RetentionPolicyAssignment` — Zuweisung von Policies zu GLOBAL / DOMAIN / USER
- `Message.smimeMeta` — neues optionales String-Feld (JSON) für S/MIME-Signatur-/Verschlüsselungsmetadaten
- `TransportRule` — Transportregeln (conditions/actions als JSON, priority, enabled)

**Phase-10-Modelle**:
- `AuditLog` — Admin-Aktionen (actorId, actorEmail, action, targetType, targetId, targetName, ipAddress, userAgent, changes, success, errorMsg)
- `PushSubscription` — VAPID Web Push Subscriptions (userId, endpoint, p256dhKey, authKey, topics[], userAgent)
- ~~`OAuthClient` / `OAuthAuthorizationCode` / `OAuthToken` / `OAuthConsent`~~ — komplett entfernt in v5.6.0 (OAuth2-Server raus)
- `GatewaySettings` — SMTP-Gateway-Konfiguration (Singleton id="singleton": enabled, upstreamHost/Port/Tls, relayDomains[], filterBeforeRelay)

---

## Dockerfile-Muster

### Monolithischer App-Container (`infra/docker/Dockerfile.app`)

Drei Stages: `builder` (alle Node.js-Pakete), `frontend-builder` (React-Bundles), `runner` (Alpine + nginx + supervisord).
- `supervisord-app.conf` verwaltet alle Prozesse im Container
- nginx-Config: `infra/docker/nginx/nginx.app.conf` (alle Upstreams auf localhost)
- Frontends als statische Dateien in `/app/www/owa` und `/app/www/bcp`

### Einzel-Service-Dockerfile (Standard für Entwicklung)

Alle Dockerfiles folgen dem gleichen Multi-Stage-Muster. Beispiel von `ews-server`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/<service>/package.json ./packages/<service>/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./          # WICHTIG: muss kopiert werden!
COPY packages/core ./packages/core
COPY packages/storage ./packages/storage
COPY packages/<service> ./packages/<service>

RUN pnpm --filter @coremail/storage prisma:generate
RUN pnpm --filter @coremail/core build
RUN pnpm --filter @coremail/storage build
RUN pnpm --filter @coremail/<service> build

FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
# ... COPY --from=builder ...
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @coremail/storage exec prisma generate
EXPOSE <port>
CMD ["node", "packages/<service>/dist/server.js"]
```

**Häufige Fehler:**
- `COPY tsconfig.base.json ./` vergessen → TypeScript-Fehler beim Build
- `prisma generate` im Builder UND im Runner nötig
- `pnpm@latest` via corepack (nicht `npm install -g pnpm@9`)

---

## Redis-Muster (ioredis)

```typescript
// ❌ FALSCH — callback bekommt (err, count), NICHT die Message
subscriber.subscribe(CHANNEL, (message) => { ... });

// ✅ RICHTIG
void subscriber.subscribe(CHANNEL_NAME);
subscriber.on('message', (_channel, message) => {
  const event = JSON.parse(message) as MyType;
  // ...
});
```

---

## API-Struktur (REST)

Alle Endpunkte hinter nginx auf Port 443:

| Pfad | Service | Beschreibung |
|------|---------|-------------|
| `/owa/` | web-client | Outlook Web Access |
| `/bcp/` | admin-panel | Coremail Admin-Panel (ECP) |
| `/EWS/Exchange.asmx` | ews-server | EWS Web Services (SOAP) |
| `/Autodiscover/` | autodiscover | Autodiscover v1 |
| `/autodiscover/` | autodiscover | Autodiscover v2 |
| `/Microsoft-Server-ActiveSync` | activesync | EAS 14.1 |
| `/api/v1/` | api-gateway | REST API |
| `/auth/` | auth-service | Authentifizierung |

**api-gateway REST-Routen** (`/api/v1/`):
```
/mail/                    mailRouter
/calendar/                calendarRouter
/contacts/                contactsRouter
/tasks/                   tasksRouter
/notes/                   notesRouter
/user/                    userRouter
/smime/                   smimeRouter              S/MIME + Geräteverwaltung
# /public-folders/ → komplett entfernt in v3.18.31
/admin/mailboxes/         adminMailboxesRouter
/admin/domains/           adminDomainsRouter
/admin/queues/            adminQueuesRouter
/admin/logs/              adminLogsRouter
# /admin/groups/ → komplett entfernt in v5.6.1 (Verteilergruppen raus)
/admin/resources/         adminResourcesRouter      Raum-/Ressourcenpostfächer
# /admin/public-folders/ → komplett entfernt in v3.18.31
# /admin/ediscovery/ → komplett entfernt in v3.18.5
/admin/ems/               adminEmsRouter            EMS REST-Bridge (14+ Cmdlets)
/admin/compliance/journaling/ adminJournalingRouter Journaling-Regeln
/admin/compliance/retention/  adminRetentionRouter  Aufbewahrungsrichtlinien
/push/                    pushRouter                VAPID Web Push
/admin/audit-log/         adminAuditLogRouter       Audit-Log
# /admin/oauth/ → komplett entfernt in v5.6.0 (OAuth2-Server raus)
/admin/gateway/           adminGatewayRouter        SMTP-Gateway-Modus
/changelog                inline (server.ts)        Changelog-API
/events                   SSE Live-Events
```

**PowerShell Remoting** (Management Shell):
```
GET  /PowerShell/  → WSDL
POST /PowerShell/  → WSMan-Identify (antwortet) + Cmdlet-Routing zu EMS REST-Bridge
                     (erkannte Cmdlets → JSON-Antwort im SOAP-Envelope)
                     (unbekannte Cmdlets → SOAP-Fault mit Liste unterstützter Cmdlets)
```

**MAPI over HTTP**: ENTFERNT in v5.4.0 (siehe Architektur-Entscheidungen oben).

---

## Authentifizierung

```
Lokale DB (bcrypt) → LDAP/Active Directory (ldapts) → SSO/OIDC (openid-client)
                            ↓
                    MFA (TOTP / WebAuthn / Backup-Codes)
                            ↓
                    JWT Access Token + Refresh Token
```

**App-Passwörter**: Für IMAP/POP3/SMTP/EAS (kein MFA möglich)
- Tabelle `AppPassword`, Feld `hash` (bcrypt), `lastUsedAt`
- User generiert in OWA → Einstellungen → Sicherheit

**UserRole-Enum** (kein ADMIN!):
```
USER, HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT,
HYGIENE_MANAGEMENT, SERVER_MANAGEMENT, VIEW_ONLY_ORG, ORGANIZATION_MANAGEMENT
```

---

## ActiveSync (EAS 14.1)

**Package**: `packages/activesync/` — Port 3005
**Docker Image**: `magpeek/coremail-activesync:0.7.0`

### WBXML-Codec
`src/wbxml.ts` — Implementiert EAS Code Pages:
- 0: AirSync (Sync, SyncKey, Collection, Status ...)
- 2: Email (Subject, From, To, Body, Read ...)
- 7: FolderHierarchy (FolderSync, ServerId, DisplayName, Type ...)
- 14: Provision (PolicyKey, EASProvisionDoc ...)
- 17: Ping (HeartbeatInterval, Folders ...)
- 25: ComposeMail (SendMail, Mime ...)

### EAS-Befehle
| Befehl | Datei | Beschreibung |
|--------|-------|-------------|
| `Provision` | `commands/provision.ts` | Geräte-Registrierung + Policy |
| `FolderSync` | `commands/folder-sync.ts` | Ordnerhierarchie |
| `Sync` | `commands/sync.ts` | E-Mail-Delta-Sync |
| `SendMail` | `commands/send-mail.ts` | Ausgehende Mails |
| `SmartReply/Forward` | `commands/send-mail.ts` | Antworten/Weiterleiten |
| `Ping` | `commands/ping.ts` | Long-Poll (bis 59 min) |

### Ping Long-Poll
nginx muss `proxy_read_timeout 600s` für `/Microsoft-Server-ActiveSync` haben (bereits konfiguriert).

---

## S/MIME

**Router**: `packages/api-gateway/src/routes/smime.ts`
**Route-Prefix**: `/api/v1/smime/`

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/certificates` | GET | Liste aller eigenen Zertifikate |
| `/certificates` | POST | Neues Zertifikat importieren |
| `/certificates/:id` | PUT | Label/Default-Flags ändern |
| `/certificates/:id` | DELETE | Zertifikat löschen |
| `/public-key/:email` | GET | Public Key eines Kontakts abrufen |
| `/devices` | GET | ActiveSync-Geräte des Users |
| `/devices/:id` | DELETE | Gerät deregistrieren |

---

## Changelog-Format

Changelog (`CHANGELOG.md`) muss dem **Keep a Changelog** Format folgen:
- Kategorien: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
- Versionsschema: Semantic Versioning (PATCH/MINOR/MAJOR)
- Nächste Version: `## [Unreleased]` Abschnitt

---

## Häufig verwendete Befehle

```bash
# TypeScript-Check (alle Packages)
pnpm -r exec tsc --noEmit

# Prisma-Client generieren
pnpm --filter @coremail/storage exec prisma generate

# App-Container bauen + pushen
docker build -f infra/docker/Dockerfile.app -t magpeek/coremail-app:1.3.4 .
docker push magpeek/coremail-app:1.3.4

# DB-Container bauen + pushen
docker build -f infra/docker/Dockerfile.db -t magpeek/coremail-db:0.11.0 .
docker push magpeek/coremail-db:0.11.0

# Beide Images bauen + pushen (Skript)
bash scripts/docker-push.sh 0.11.0

# GitHub Push mit PAT
PAT="..." git -c url."https://x-access-token:${PAT}@github.com/".insteadOf="https://github.com/" push

# GitHub Release erstellen
GITHUB_TOKEN=$PAT gh release create v0.7.0 --title "..." --notes "..." --repo MAGPEEK/CoreMail

# Issue schließen
GITHUB_TOKEN=$PAT gh issue close <nr> --comment "..." --repo MAGPEEK/CoreMail
```

---

## Infrastruktur-Konfiguration

### Docker Compose
- `docker-compose.yml` — Standard-Stack (6 Container: coremail, rspamd, clamav, postgres, redis, minio)
- `docker-compose.synology.yml` — Synology NAS (Port 8080, /volume1-Pfade, rspamd + clamav enthalten)

### nginx (infra/docker/nginx/nginx.conf)
Alle Pfade sind Coremail-kompatibel. ActiveSync braucht 600s Timeout (Ping-Command).

### Kubernetes (infra/k8s/)
- CloudNativePG Operator (3 PostgreSQL-Instanzen, automatisches Failover)
- HPA + PDB für alle Services (min 2, max 10 Pods)
- Redis Cluster (6 Nodes: 3 Master + 3 Replicas)
- MinIO Distributed (4 Nodes, Erasure Coding)
- cert-manager + External Secrets Operator

---

## Sicherheits-Pipeline (eingehende Mails)

```
SMTP Verbindung
  → Greylisting (Redis, IP+Sender+Empfänger Tripel)
  → DNSBL (Spamhaus ZEN, SpamCop — parallel mit 2s Timeout)
  → Country-Filtering (MaxMind GeoLite2)
  → IP-Blacklist
  → SPF / DKIM / DMARC / ARC (mailauth)
  → E-Mail-Blacklist (Global/Domain/User)
  → ClamAV (clamd TCP 3310)
  → rspamd (HTTP API, Score → Inbox/Junk/Reject)
  → Attachment-Filter (MIME-Types, Doppelextensionen)
```

---

## Logging

- **Logs**: pino (strukturiertes JSON) über alle Services
- **Log-Level**: pro Service via BCP konfigurierbar (error | warn | info | debug)
- Grafana/Prometheus/Tempo/Loki/Alertmanager wurden in v2.1.19 aus dem Stack entfernt

---

## Aktuelle Architektur-Highlights (3.17.x)

- **MWA** (Mail Web Access) unter Root-URL `/` seit v3.5.5 — vorher `/owa/` (Redirect bleibt)
- **BCP** (Backend Control Panel) unter `/bcp/` seit v3.2.3 — vorher `/ecp/`
- **Journaling-Feature komplett entfernt** in v3.13.6 (war Phase 9 / RFC 3462) — DB-Tabellen `journaling_*` gedroppt, Routen 404
- **Aufbewahrungsrichtlinien** Exchange-2019-konform mit DPT/RPT/Personal-Tags + Managed Folder Assistant (Background-Worker, 24h Work-Cycle) + Recoverable Items Non-IPM Subtree
- **Shared Mailboxes** haben dieselbe Standard-Ordnerstruktur wie User-Postfächer (auto-provisioniert, INBOX/Drafts/Sent/Trash/Junk/Archive/Notes/Tasks) — Folder-CRUD im MWA für User mit FULL_ACCESS
- **E-Mail-Aliase** seit v3.13.5 pro User-Postfach + Shared-Mailbox; SMTP-Inbound löst Aliase zur Target-Primäradresse auf bevor sie ins Postfach geschrieben werden
- **Templates für Compliance**: 8 Retention-Vorlagen (Papierkorb 30d, Junk 14d, …) + 9 Transport-Rule-Vorlagen ([EXTERN], CEO-Phishing, PCI-DSS Detection, …)
- **OAuth2-Server** komplett (Authorization Code, Refresh, Client Credentials, Password Grant, OIDC, PKCE)
- **Dashboard** mit Server-Info (Uptime, RAM, CPU, V8-Heap-Limit) + konfigurierbaren Widgets (Drag-Reorder direkt auf Karten, persistiert in localStorage)
- **BCP-Dashboard** alle Widgets mit DraggableCard umhüllt (v3.16.0) — queue-status, mails-chart, storage-ranking, domains-chart, recent-errors, recent-audit, recent-logins, system-strip per Drag verschiebbar
- **MWA Aufgaben** (v3.16.x):
  - Doppelklick öffnet vollständiges Bearbeitungsmodal
  - Aufgaben mit Fälligkeitsdatum → automatischer Kalender-Termin (amber im FullCalendar)
  - Erinnerung (Datum + Uhrzeit) → Kalender-Termin `🔔 Erinnerung: …` + Popup-Benachrichtigung zum gesetzten Zeitpunkt
  - Checkbox **„per E-Mail"** — sendet bei Auslösung zusätzlich eine Mail an den eigenen Posteingang (`POST /mail/send`)
  - Popup-Tracking via `localStorage` (Key = `taskId:reminderISO`) — feuert exakt einmal pro Zeitstempel, auch nach Page-Reload
  - Prisma-Feld `reminderByMail Boolean @default(false)` in `tasks`-Tabelle
- **MWA Compose — Empfänger-Autocomplete** (v3.16.6): `RecipientInput`-Komponente in An/CC/BCC ersetzt `<input>`; debounced `GET /contacts?q=` ab 1 Zeichen; Dropdown mit Name+Mail+Firma; Keyboard-Nav ↑↓/Enter/Tab/Escape; Multi-Empfänger via Komma
- **MWA Mail — Resizable Panels** (v3.16.6): Drag-Handle zwischen Ordnerstruktur ↔ Liste ↔ Lesebereich; Breiten in `localStorage:coremail:panel-widths`; FolderTree/MessageList nutzen `w-full` statt px-Breite
- **Einstellungen → Ansicht** (v3.16.6): Lesebereich (rechts/unten/aus), Dichte (kompakt/normal/komfortabel), Konversationen-Toggle — alle persistent via `useUiPrefs` (Zustand + localStorage)
- **MWA Kontakte**: Erweiterte Felder (email2, mobile, department, jobTitle, notes) — Outlook-kompatibel (v3.16.0)
- **MWA E-Mail-Suche**: Scope-Umschalter (Ordner / Gesamtes Postfach) + Typeahead-Vorschläge beim Tippen (v3.16.0)
- **Tiptap-Schriftarten**: Schriftart-Auswahl (Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS) im E-Mail-Verfassen-Fenster — `@tiptap/extension-font-family@^2.27.2` (v3.16.0)
- **DNS-Hardening** (v3.15.0): trusted Resolver (8.8.8.8 / 1.1.1.1 / 9.9.9.9), Cross-Validation, Startup-Integrity-Check — `initDnsHardening()` in security-filter
- **Live-Server**: `84.247.191.198` (Contabo VPS, Ubuntu 24.04, 4 Cores, 7.8 GB RAM) — läuft v3.18.29; Deploy: `cd /opt/coremail && docker compose pull coremail && docker compose up -d coremail`
- **Integrierter HTTPS-Proxy** (v3.17.0): `packages/api-gateway/src/tls-proxy.ts` — Node.js-HTTPS-Server auf Port 443, Hot-Reload via Redis-Kanal `coremail:tls:reload`; Aktivierung in BCP → SSL/TLS → Schloss-Icon; `Certificate.isActiveHttps` Prisma-Feld; Port `443:443` in docker-compose
- **SSH**: `ssh root@84.247.191.198` (PW: `dihgos-nadzyn-muZmu6`)

## Wichtige technische Entscheidungen seit 3.x

- **`getAppVersion()`** liest `COREMAIL_VERSION`-Env BEVOR root `package.json` als Fallback — Runtime-Override ohne Image-Rebuild möglich
- **DraggableCard-Pattern**: React-Komponenten NIE inline in anderen Komponenten definieren (Reconciliation per Reference Equality → Re-Mount-Killer)
- **`prisma db push --accept-data-loss`** in `entrypoint-app.sh` — Schema-Migrations beim Container-Start, auch destruktive (z. B. Journaling-Drop)
- **Settings-Caches** (60s TTL, Greylisting + Outbound-Relay) invalidieren via Redis-`CHANNEL_SETTINGS_RELOAD` nach jedem Settings-Save
- **Erinnerungs-Popup-Tracking**: `localStorage`-Key `coremail:notified-reminders` (JSON-Array von `taskId:reminderISO`-Strings) — verhindert Doppel-Popups über Page-Reloads hinweg; `useCallback` + `useRef` statt direkter Closure im `setInterval` (kein stale-closure-Bug)
- **checkDueDates-Pattern**: stabile Callback-Referenz via `useCallback(fn, [])` + `allTasksRef` für stets aktuelle Daten im 30-Sekunden-Interval — kein `eslint-disable react-hooks/exhaustive-deps` mehr nötig
- **Resizable Panels**: `ResizeHandle`-Komponente auf Modul-Ebene (nicht inline!) — `mousemove`/`mouseup` auf `window`, `cursor: col-resize` + `userSelect: none` auf `document.body` während Drag; FolderTree/MessageList nutzen `w-full` und Breite kommt vom Parent-Div via `style.width`
- **RecipientInput-Autocomplete**: `useCallback` für `pickSuggestion` nötig (Closure über `value`); `onMouseDown` + `e.preventDefault()` in Dropdown-Buttons verhindert Fokus-Verlust des Inputs beim Klick

---

- **BullMQ Queue-Namen**: Kein `:` erlaubt (BullMQ v5) — Queue heißt `'smtp-outbound'` (mit Bindestrich), NICHT `'smtp:outbound'`. Producer (api-gateway/routes/mail.ts) und Consumer (smtp-server/outbound/queue.ts) müssen identische Namen haben.

## Aktuelle Version 5.6.1 — Highlights (Stack-Slim-down)

**v5.6.1** — Verteilergruppen (DistributionGroups) komplett entfernt. User-Entscheidung: „Entferne auch Verteilergruppen". In der Praxis selten genutzt — moderne Teams nutzen Shared Mailboxes (`/admin/shared-mailboxes/`) mit Aliasen für Team-Postfächer oder externe Listserv-Tools (Mailman, listmonk) für reine Outbound-Verteiler. Reduziert Code-Komplexität und einen Wartungspunkt im BCP. Analog zu v3.18.5 (eDiscovery), v3.18.31 (Public Folders), v3.18.33 (ExternalMailContacts), v5.4.0 (MAPI), v5.6.0 (OAuth2). **Schema (DESTRUCTIVE — Tabellen werden via `prisma db push --accept-data-loss` beim Container-Start gedroppt)**: `DistributionGroup` + `DistributionGroupMember` Models gelöscht, enum `GroupType { STATIC, DYNAMIC }` entfernt, `Domain.distributionGroups` Relation entfernt. **Frontend (BCP)**: `/groups/` Page (`GroupsPage.tsx`) gelöscht, Sidebar-Eintrag + Users-Icon-Import entfernt, Route + i18n-Keys (`nav_groups` DE+EN) entfernt, `OrganisationPage` GAL-Section ohne „Verteilergruppen"-Spalte, `SmtpConfigPage` Lokale-Zustellung-Hinweis ohne „Verteilergruppen werden aufgelöst". **Backend (api-gateway)**: `routes/admin/groups.ts` gelöscht, Mount `/api/v1/admin/groups` entfernt, EMS REST-Bridge (`routes/admin/ems.ts`) — alle 7 DistributionGroup-Endpoints + `formatGroup()` Helper entfernt (~150 LOC), 7 Cmdlet-Routes (Get-/New-/Set-/Remove-DistributionGroup + *DistributionGroupMember) entfernt, PowerShell Remoting (`routes/powershell.ts`) — 6 Cmdlets aus SUPPORTED_CMDLETS entfernt, GAL-Endpoint (`routes/contacts.ts`) ohne DistributionGroup-Quelle (GROUP-Kind aus GalEntry-Type entfernt), Dashboard (`routes/admin/dashboard.ts`) `distributionGroup.count()` → 0, Organisation (`routes/admin/organisation.ts`) `groups`-Array bleibt leer. **Backend (smtp-server)**: `handlers/expand.ts` komplett rewritten — `expandRecipients()` löst nur noch EmailAliase auf, Cycle-Protection bleibt; `inbound/handler.ts` `verifyRecipient()` Promise.all ohne DistributionGroup-Lookup, eingehende Mails an ehemalige Gruppen-Adressen werden mit 550 5.1.1 abgewiesen. **Migrations-Hinweis**: bestehende DistributionGroups + Mitgliedschaften gehen mit dem Upgrade unwiderruflich verloren — Use-Cases: Team-Inbox → Shared Mailbox + Permissions, reiner Verteiler → externer Listserv (Mailman/listmonk) oder Empfängerliste direkt im Client.

**v5.6.0** — OAuth2 / Modern Auth komplett aus dem Stack entfernt (Major Release). User-Entscheidung: „Entfernen und aus Code entfernen bcp OAuth2 / Modern Auth". Nach MAPI-Removal in v5.4.0 + IMAP-OAuth-Decision in v5.5.0 hat OAuth2 keinen praktischen Use-Case mehr im Stack: Mail-Clients nutzen IMAP/SMTP/POP3 mit App-Passwörtern (MFA-tauglich), MWA + BCP nutzen Session-JWTs über `/auth/login`. Komplette OAuth2-Codebase war toter Ballast. **Frontend**: BCP `/oauth-clients/` Page (`OAuthClientsPage.tsx`) + Sidebar-Eintrag + i18n-Keys + Route entfernt, MWA `/oauth-consent/` Page (`OAuthConsentPage.tsx`) + Route + LoginPage OAuth2-Flow-Detection entfernt. **Backend**: `packages/auth-service/src/oauth2/` komplettes Verzeichnis gelöscht (Router + ~970 LOC), `packages/api-gateway/src/routes/admin/oauth-clients.ts` gelöscht, api-gateway `/oauth2/*` Proxy + `/api/v1/admin/oauth/*` Mount + `/.well-known/openid-configuration` + `/.well-known/jwks.json` Handler entfernt, auth-service `/oauth2` Mount entfernt, ews-server middleware Bearer-Branch komplett entfernt (nur noch Basic-Auth — Audience-Validation, OAuth-Token-Revocation-Check raus). **JWT zurück auf HS256**: `packages/core/src/auth/jwt-keys.ts` gelöscht (RS256-Key-Management war nur für JWKS), `packages/core/src/auth/jwt.ts` rewritten zurück auf HS256 mit `JWT_SECRET` env-Var (wie pre-v5.2.17), `initJwtKeys()` aus api-gateway/auth-service/ews-server/backup-service/caldav-server Startup entfernt. **Prisma Schema (DESTRUCTIVE)**: 4 Models gelöscht — `OAuthClient`, `OAuthAuthorizationCode`, `OAuthToken`, `OAuthConsent` (Tabellen werden via `prisma db push --accept-data-loss` beim Container-Start gedroppt). **WICHTIG**: SSO via externe IdPs (auth-sso package, Azure AD/Keycloak/Authentik) **bleibt erhalten** — das ist OIDC-Client-Funktionalität (CoreMail loggt User über externen IdP ein), NICHT zu verwechseln mit dem entfernten OAuth2-Authorization-Server.

## Archivierte Highlights (v5.5.0–v5.2.0)

**v5.5.0** — IMAP4rev2 (RFC 9051) Compliance + Doku-Update + XOAUTH2-Decision. STARTTLS, AUTHENTICATE SASL (PLAIN+LOGIN), UNSELECT, ID-Command. Doku-Update für MAPI-Removal. Entscheidung gegen XOAUTH2 dokumentiert (keine Mainstream-Client-UI-Unterstützung für non-Microsoft-Server).

**v5.4.0** — MAPI/HTTP komplett aus dem Stack entfernt (~12.000 LOC). Outlook 2024 LTSC erzwingt Microsoft-Entra-only-Modern-Auth, was für non-Microsoft-Server fundamental nicht funktioniert (Custom-ADFS-Emulation = 3-4 Wochen Aufwand ohne Erfolgs-Garantie). Empfohlener Outlook-Client: „Andere E-Mail-Konten" → IMAP. Kalender + Kontakte via CalDAV/CardDAV.

## Aktuelle Version 5.2.0 — Highlights (MAPI/HTTP FINAL — archiviert, raus seit v5.4.0)

**v5.2.0** — Abschluss der MAPI/HTTP-Implementation. Bündelt alle ursprünglich geplanten v5.2/v5.3/v5.4/v5.5-Features in eine finale Release: Cached Mode (MS-OXCFXICS Sync), Recurrence Pattern Binary, Search Folders, Server-Side-Rules-Bridge, Folder-Permissions-Stubs, Embedded Messages, Multi-Value Properties, RTF-Compression, gzip-Transport-Compression. Markiert MAPI/HTTP als feature-complete für typische Outlook-Workflows. (1) **MS-OXCFXICS Sync (rop/sync.ts)** — Cached Mode für Outlook (Default ab 2007). RopSyncConfigure liefert FastTransfer-Source-Handle. RopFastTransferSourceGetBuffer streamt ICS-Records (StartMessage 0x40000003 + TaggedProperties + EndMessage 0x40000004) chunk-weise (max 28KB pro Chunk, TransferStatus 1=Partial/3=Done). Implementiert: SyncConfigure, FastTransferSourceCopyFolder/Messages/Properties/GetBuffer, FastTransferDestinationConfigure/PutBuffer, SyncImportMessageChange/HierarchyChange/Deletes/MessageMove, SyncUploadStateStreamBegin/Continue/End, SyncOpenCollector, GetLocalReplicaIds, SyncGetTransferState. Initial-Sync schlägt durch, Delta-Sync degraded-aber-stable. (2) **Recurrence Pattern Binary (recurrence-pattern.ts)** — encodeRecurrencePattern(rrule, dtStart, dtEnd) parst iCal RRULE und konvertiert in PidLidAppointmentRecur Binary (MS-OXOCAL §2.2.1.44). Unterstützt FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY (Mo-So Bitmask), BYMONTHDAY, BYMONTH, COUNT, UNTIL. Outlook zeigt jetzt korrekte Recurrence-Pattern im Termin-Editor. (3) **PR_RTF_COMPRESSED Stream (rtf-compress.ts)** — htmlOrTextToRtfCompressed() wrappt HTML/Text in MELA-uncompressed RTF-Format (MS-OXRTFCP), Outlook akzeptiert ohne CRC. Plus LZ77-Decoder für künftige Outlook→Server-RTF-Bodies. OpenStream auf PR_RTF_COMPRESSED (0x10090102) jetzt funktional. (4) **gzip Transport-Compression** — X-CompressedRequest:1 Header triggert transparente gunzip-Decompression vor dem Handler. Spart Bandwidth bei großen ROP-Streams (typisch 60-70% Reduktion). Middleware in handler.ts. (5) **Multi-Value Properties** — property-codec erweitert um PT_MV_INT16/INT32/STRING/UNICODE/SYSTIME/BINARY (MS-OXCDATA §2.11.1.6). Read+Write. Outlook nutzt Multi-Value für PR_RECEIVED_BY_ADDRTYPE_LIST und PT_MV_BINARY-Encoded-RowSets. (6) **RopOpenEmbeddedMessage (v52-handlers.ts)** — Mail-als-Attachment-weiterleiten. Erzeugt sub-message-Handle auf einem Attachment, Outlook kann dann das eingebettete IPM.Note via OpenStream lesen. (7) **Search Folders** — RopGetSearchCriteria + RopSetSearchCriteria mit minimaler Persistierung (kein Crash bei Outlook „gespeicherte Suche"-Workflow). (8) **Server-Side-Rules-Bridge** — RopGetRulesTable liefert leere Table, RopUpdateRules akzeptiert mit SUCCESS. Outlook-Rules bleiben client-local (CoreMail MailRules werden über MWA verwaltet, server-seitig in storeInboundMessage angewendet). (9) **Folder-Permissions** — RopGetPermissionsTable + RopModifyPermissions Stubs (Outlook-Berechtigungs-Dialog crasht nicht mehr — ACL-Verwaltung bleibt im BCP). (10) **Misc Message ROPs** — RopAbortSubmit, RopReloadCachedInformation (Outlook-Cached-Refresh), RopGetMessageStatus/SetMessageStatus für Read-Tracking. (11) **NSPI Pagination + SortTable (nspi-handler.ts)** — QueryRows mit Cursor-Pagination via StartMid + RowCount aus Request-Body, alphabetische Sortierung nach displayName (Locale 'de'), Hard-Limit auf 1000 statt 500. (12) **Codec + Dispatcher** — alle neuen ROPs (28 zusätzlich) verdrahtet, korrekte Payload-Parsing-Branches inkl. variable-Length-Handling. **Outlook-Verhalten nach v5.2.0**: Cached Mode funktioniert (.ost-Datei wird initial gefüllt, Outlook ist offline-fähig), Recurring-Termine zeigen Wiederholungs-Muster, Embedded-Mails öffnen sich, „Suchordner"-Klick crasht nicht mehr, Rules-Dialog kann geöffnet werden (lokal gespeichert), Permissions-Dialog read-only ohne Fehler, RTF-Mails werden korrekt formatiert angezeigt, große GAL (>500 Einträge) wird vollständig paginiert. **MAPI/HTTP-Roadmap-Abschluss**: v4.0 (Foundation) → v4.7 (Phase 7) → v5.0 (GA + default-on) → v5.1 (Named Props + PIM-Details + Native NSPI) → v5.2 (FINAL — Cached Mode + Recurrence + Misc). Aufwand: ~12.000 Zeilen MAPI-Code in einem zusammenhängenden Sprint statt 6-9 Monaten geschätzter Wochenarbeit. Optional offen für v5.3+: volle ICS-OPCODE-Records (Delta-Sync), DAV-ACL-Mapping auf MAPI-Permissions, RTF→HTML-Conversion via LZ77-Decoder.

**v5.1.0** — Schließt die letzten offenen v5.x-Punkte aus dem v5.0.0-Release. (1) **Named Properties** (packages/ews-server/src/mapi/named-properties.ts) — vollständige Implementierung des MAPI Named-Property-Mappings für PSETID_Appointment ({00062002-…}), PSETID_Address, PSETID_Task, PSETID_Note. Standard-LIDs aus MS-OXOCAL/CNTC/TASK/NOTE (LID_APPOINTMENT_START_WHOLE 0x820D, LID_LOCATION 0x8208, LID_TASK_COMPLETE 0x811C, LID_NOTE_COLOR 0x8B00 etc.). resolveNamedProperties() vergibt lokale uint16-IDs ab 0x8000 in der Session-State (mapi:session:<token>.namedPropMap). reverseNamedProperties() für GetNamesFromPropertyIds. (2) **RopGetPropertyIdsFromNames** + **RopGetNamesFromPropertyIds** (rop/named-props-handler.ts) — vollständige Binary-Implementierung. ROP-Codec gibt jetzt den vollständigen Payload an die Handler (statt Pass-Through-Stub). (3) **PIM Detail-Views** (rop/pim-properties.ts) — buildPimPropertyList() lädt CalendarEvent/Contact/Task/Note aus Prisma und mapt jedes Item auf vollständigen Property-Set: Standard MAPI-Properties (Subject/Body/MessageClass/Times) + Named Properties via PSETID_*. Calendar: Subject/Body/Location/Start/End/Duration/AllDay/BusyStatus/Sequence/Recurring. Contact: DisplayName/Email1/Email2/AddressType/FileAs + PR_COMPANY_NAME/TITLE/DEPARTMENT/PHONE/MOBILE. Task: Status/PercentComplete/StartDate/DueDate/DateCompleted/Complete-Flag/Owner. Note: Color/Width/Height. (4) **handleRopGetPropertiesAll/Specific** in rop/message.ts dispatcht auf buildPimPropertyList() wenn das Message-Handle `pimKind !== 'mail'` hat. (5) **openVirtualPimMessage** setzt jetzt `pimKind` (appointment/contact/task/note) auf das Handle, damit GetProperties weiß welcher Mapper zu verwenden ist. (6) **Native NSPI Binary** (mapi/nspi-handler.ts) — ersetzt v4.7.0 SUCCESS-empty Fallback. Vollständig: GetSpecialTable (liefert „Globale Adressliste" als root entry), QueryRows (paginiert User+DistributionGroup), ResolveNames/GetMatches (Substring-Match auf displayName+email), GetProps (Properties einer einzelnen Entry per MinId), DnToMinId (Legacy-DN → MinEntryID), GetPropList. MinEntryID = FNV-1a-32bit-Hash der userId/groupId im Range [0x10000000, 0xFFFFFFFF]. Property-Set per Row: PR_DISPLAY_NAME_W, PR_EMAIL_ADDRESS_W, PR_SMTP_ADDRESS_W, PR_ADDRTYPE_W='SMTP', PR_OBJECT_TYPE (6=MAILUSER/8=DISTLIST), PR_DISPLAY_TYPE (0/1). (7) **handler.ts** dispatcht NSPI-Operationen jetzt an handleNspiOperation() statt SUCCESS-empty zurückzugeben. **Outlook-Verhalten**: Doppelklick auf einen Kalender-Termin in Outlook öffnet jetzt das volle Termin-Fenster mit Subject, Ort, Start/Ende, Ganztägig-Flag, BusyStatus-Anzeige (Frei/Beschäftigt/Außer Haus/Vorläufig). Kontakte zeigen alle Felder (Firma, Position, Telefone, Email1/Email2). Tasks zeigen Fälligkeit + Fortschritt + Status. Notizen mit Farbcode. Plus: Outlook-Adressbuch ist jetzt direkt mit GAL gefüllt (keine EWS-Round-Trips mehr) — schneller, weniger Latenz.

**v5.0.0** — MAPI/HTTP Production-Hardening + Default-Enabled (Major Release). Abschluss der v4.x-Iteration der nativen Outlook-Exchange-Anbindung. Markiert MAPI/HTTP als production-ready. (1) **Autodiscover MAPI/HTTP Default-AKTIV** (`packages/autodiscover/src/v1.ts`) — Feature-Flag `ENABLE_MAPI_HTTP` ist jetzt opt-out (`!== 'false'`) statt opt-in. Outlook 2013 SP1+ entdeckt den `<Protocol Type="mapiHttp">`-Block automatisch und richtet sich nativ als Exchange-Konto ein (statt IMAP-Fallback). Kompletter ROP-Funktionsumfang aus v4.1-v4.7 ist verfügbar: Logon, Folder-Browse, Mail-Lesen, Mail-Schreiben+Senden, Attachments, Move/Delete, Push-Notifications via Redis-pub/sub, virtuelle PIM-Folder (Kalender/Kontakte/Aufgaben/Notizen), Server-Side-Search via MAPI-Restriction → Prisma WHERE. (2) **Unit-Tests** für die kritischsten Codec-Komponenten — `property-codec.test.ts` mit 13 Round-Trip-Tests (FILETIME, PT_LONG/INT64/BOOLEAN/UNICODE/BINARY/SYSTIME, TaggedProperty, PropertyRow, makePropTag), `entry-id.test.ts` mit 6 Tests (cuidToFolderId64 Determinismus, uint64-Range, kollisions-Freiheit für virtuelle Folder-IDs). Alle 19 neuen Tests grün; zusammen mit den 16 codec-Tests aus v4.0 jetzt 35 Vitest-Round-Trip-Tests in CI. (3) **OWA Externe-Clients-Page** sollte v5.0.0-Status reflektieren: native Outlook-Verbindung jetzt der empfohlene Weg (CalDav-Synchronizer-Plugin als Fallback für Kalender-bidirektionale-Sync mit Detailfeldern). **Outlook-Verhalten nach v5.0.0**: User trägt Mail+Passwort ein → Autodiscover → Outlook erkennt MAPI/HTTP → Account-Type „Exchange" → voller Funktionsumfang. Kein „IMAP-Fallback"-Hinweis mehr nötig. Volle MS-OXNSPI Native Implementation (statt EWS-Fallback) bleibt optional für v5.1+ Hardening, wird aber von Outlook nicht zwingend benötigt da SUCCESS-empty Response Outlook auf EWS umschaltet. **Roadmap-Status v4.x→v5.x abgeschlossen**: 6-9-Monats-Plan aus v4.0.0-ARCHITECTURE.md in einem konzentrierten Sprint umgesetzt (v4.1.0 ROP-Infra → v4.2.0 Lesen → v4.3.0 Schreiben → v4.4.0 Attachments → v4.5.0 Push → v4.6.0 PIM-Folder → v4.7.0 NSPI+Search → v5.0.0 Production GA).

**v4.7.0** — MAPI/HTTP Phase 7: NSPI Address-Book Fallback + Server-Side-Search (gebündelt aus geplanter v4.8.0). **NSPI-Teil**: Outlook nutzt das Name Service Provider Interface für Empfänger-Autocomplete, „Namen überprüfen" und Distribution-Group-Member-Anzeige. CoreMails NSPI-Endpoint auf /mapi/nspi/ lieferte bisher für QueryRows/ResolveNames/GetMatches/GetSpecialTable/GetProps/DnToMinId/GetPropList binäres ecNotSupported → Outlook erkannte NSPI als „defekt". Volle MS-OXNSPI-Implementation (Wochen Arbeit für MinEntryID + Binary-RowSet + PropertyValueArrays) wird auf v5.x verschoben. Fix: Alle NSPI-Ops liefern jetzt SUCCESS-empty (StatusCode=OK, ErrorCode=OK, RowCount=0). Outlook fällt automatisch auf EWS ResolveNames/FindPeople zurück (CoreMail v3.x-funktional). **Search-Teil**: (1) RopRestrict (rop/search.ts) — parst MS-OXCDATA §2.12 Restriction-Format (ResAnd/ResOr/ResNot/ResContent/ResProperty/ResExist), persistiert ParsedRestriction am Table-Handle. (2) RopFindRow — akzeptiert FindRowFlags + Restriction + Origin + Bookmark; v4.7.0 minimal liefert „kein Match" (Outlook nutzt typischerweise RopRestrict + RopQueryRows als Such-Workflow). (3) restrictionToPrismaWhere() — konvertiert ParsedRestriction in Prisma where-Clause: tagToPrismaField() mappt Property-IDs auf DB-Felder (PR_SUBJECT_W→subject, PR_BODY_W→bodyText, PR_HTML→bodyHtml, PR_SENDER_NAME_W→fromName, PR_SENDER_EMAIL_ADDRESS_W→fromAddr, PR_DISPLAY_TO_W→toAddrs, PR_MESSAGE_DELIVERY_TIME→date, PR_MESSAGE_SIZE→rawSize, PR_MESSAGE_FLAGS→flags). Content-Fuzzy: FullString/Substring/Prefix + Ignore-Case. Property-RelOps: LT/LE/GT/GE/EQ/NE. (4) QueryRows-Integration — bei Standard-Mail-Contents-Tabelle wird Restriction als zusätzlicher Filter neben folderId angewendet ({folderId, ...restrictionWhere}). (5) ROP-Codec — korrektes Payload-Parsing für RopRestrict/RopFindRow. **Outlook-Verhalten**: kein NSPI-Fehler mehr, Empfänger-Autocomplete + Namen-Check + GAL-Browse funktional. Server-Side-Search (Strg+E in Outlook) filtert Inbox/Folder direkt via MAPI-Restriction → Prisma WHERE — kein Client-Side-Scan mehr für große Postfächer (>1000 Mails performance-kritisch).

**v4.6.0** — MAPI/HTTP Phase 6: Calendar/Contacts/Tasks/Notes virtual folders. CoreMail speichert Calendar/Contacts/Tasks/Notes NICHT als Mailbox-Folder (separate Prisma-Modelle), aber Outlook MAPI braucht sie als Folder-Einträge in der Hierarchy-Tabelle. v4.6.0 synthesizt 4 virtuelle PIM-Folder mit fixen IDs (`virtual-calendar`, `virtual-contacts`, `virtual-tasks`, `virtual-notes`) und PR_CONTAINER_CLASS_W (IPF.Appointment/IPF.Contact/IPF.Task/IPF.StickyNote). (1) **containerClassFor(folderName)** in rop/folder.ts — name→Class-Mapping inkl. deutsche Aliase (Kalender/Kontakte/Aufgaben/Notizen). (2) **VIRTUAL_FOLDERS-Konstante** mit 4 PIM-Folder-Definitionen. (3) **GetHierarchyTable erweitert** — auf Root-Ebene (`parentFolderId === ''`) wird die rowCount um VIRTUAL_FOLDERS.length erhöht. (4) **QueryRows auf hierarchy** — injiziert virtualFolderToPropRow() für die 4 PIM-Folder. (5) **OpenFolder erweitert** — matched auch virtuelle IDs via cuidToFolderId64(VIRTUAL_FOLDERS[*].id). (6) **GetContentsTable erweitert** — virtuelle Folder liefern Counts aus Prisma calendarEvent/contact/task/note statt message. (7) **QueryRows auf contents** — `parentFolderId.startsWith('virtual-')` → loadVirtualContents() lädt Events/Contacts/Tasks/Notes und mappt sie zu PropRows mit `PR_MESSAGE_CLASS_W = 'IPM.Appointment' / 'IPM.Contact' / 'IPM.Task' / 'IPM.StickyNote'`, plus Subject/Body/Date/Priority. (8) **GetRowCount erweitert** für virtuelle Folder. (9) **OpenMessage erweitert** — erkennt virtuelle Folder-IDs und delegiert an `openVirtualPimMessage()` der das Item via hash-match in der jeweiligen PIM-Table findet. (10) **folderToPropRow** nutzt jetzt `containerClassFor(name)` statt hardcoded 'IPF.Note'. **Outlook-Verhalten**: 4 zusätzliche Folder erscheinen in Outlook unter dem Postfach: „Kalender", „Kontakte", „Aufgaben", „Notizen" — mit korrektem Icon je nach Outlook-Folder-Type-Detection. Listen-View zeigt jeweils Items (Termine/Kontakte/etc.) mit Subject und Date. Volle Property-Round-Trip auf einzelne Items (Detail-Anzeige, Bearbeitung) braucht noch volles Named-Property-Mapping (PSETID_Appointment etc.) — kommt in v5.0.0 oder optional als v4.6.1 Patch. Read-only Browsing der PIM-Daten ist aber funktional.

**v4.5.0** — MAPI/HTTP Phase 5: Push-Notifications via Redis pub/sub. Bisher pollte Outlook über lange NotificationWait-Requests die nach 30s mit EventPending=false zurückkamen → spürbare Verzögerung bei neuer Mail. Jetzt echter Server-Push. (1) **RopRegisterNotification** (rop/notification.ts) — Outlook abonniert per ROP gewünschte Event-Typen (NewMail/MessageDeleted/MessageModified/FolderChanged) auf einem Folder- oder Mailbox-Handle. Subscription wird dynamisch am Handle persistiert (subscription-Feld via JSON-Round-Trip durch Redis). (2) **NotificationWait Long-Poll** (emsmdb-handler.ts) — duplicate()-ed ioredis-Client (subscribe braucht dedizierten Connection nach ioredis-Pflicht), subscribe auf Channel `coremail:mapi:notify:<userId>`, Race zwischen Redis-Event und 30s-Timeout, sauberer Cleanup (unsubscribe + disconnect + clearTimeout) bei beiden Ausgängen, plus req.on('close') für Client-Disconnect-Handling. Antwortet sofort bei Event mit EventPending=1, sonst nach Timeout mit EventPending=0. (3) **publishNotifyEvent-Helper** in rop/notification.ts mit `notifyChannelFor(userId)`-Channel-Generator. Event-Shape: `{kind, userId, folderId?, messageId?, subject?}`. (4) **SMTP-Hook**: `packages/smtp-server/src/handlers/message.ts` `storeInboundMessage()` published nach der bestehenden CHANNEL_MAIL_NEW-Publish jetzt zusätzlich auf `coremail:mapi:notify:<userId>` mit MAPI-Notify-Event (`{kind:'NewMail', userId, folderId, messageId, subject}`) — non-fatal `.catch(() => {})` für Backward-Compatibility wenn MAPI nicht aktiv. (5) **NotifyEvent-TypeScript-Interface** exportiert für andere Module die Push-Events triggern (z.B. künftige RopMoveCopyMessages-Hook für MessageDeleted-Events). **Outlook-Verhalten**: neue Mail erscheint innerhalb von <1s in Outlook (statt vorher bis zu 30s warten). Toast-Notifikation bei neuer Mail funktioniert. Folder-Refresh-Cache wird invalidiert. Battery-Drain auf mobilen Outlook-Clients deutlich reduziert (kein Dauer-Polling mehr).

**v4.4.0** — MAPI/HTTP Phase 4: Attachments + Move/Delete. Aufbauend auf v4.3.0-Compose kann Outlook jetzt Anhänge senden + lesen, Mails verschieben + löschen. Neue ROPs (echte Implementierung): (1) **RopGetAttachmentTable** (rop/attachment.ts) — neuer Tabellen-Typ `attachments` mit `parentFolderId = MessageId`-Sonderkonvention. (2) **RopOpenAttachment** — lädt Attachment via Index (PR_ATTACH_NUM), erzeugt Attachment-Handle. (3) **RopCreateAttachment** — legt Draft-Attachment-Handle an (`attachmentId=null`, `pendingBuffer`, `pendingProperties`); SaveChangesAttachment persistiert in DB+MinIO. (4) **RopDeleteAttachment** — entfernt Attachment-DB-Record. (5) **RopSaveChangesAttachment** — SHA256-Hash, MinIO-Upload zu `attachments/{messageId}/{sha256}`, DB-Insert oder Update mit `filename/mimeType/size/sha256/storagePath/contentId`. (6) **RopOpenStream auf Attachment** — Stream auf PR_ATTACH_DATA_BIN: bei bestehendem Attachment via `loadAttachmentBytes()` aus MinIO, bei Draft-Attachment via `pendingBuffer`. WriteStream akkumuliert in pendingBuffer, CommitStream persistiert in attachment-handle. (7) **RopDeleteMessages** (rop/folder-ops.ts) — parst MessageId-Array (uint64-Hashes), löscht via prisma.message.delete, dekrementiert Folder-Counter. (8) **RopMoveCopyMessages** — Source-Handle (input) + Destination-Handle (output), parst WantCopy-Flag + MessageId-Array, Move = update folderId, Copy = duplicate via prisma.message.create. (9) **ROP-Codec**: Proper Payload-Parsing für GetAttachmentTable (TableFlags), OpenAttachment (AttachmentId uint32), CreateAttachment, DeleteAttachment, SaveChangesAttachment, DeleteMessages (WantAsync+NotifyNonRead+MessageIdCount+MessageIds[uint64]), MoveCopyMessages (DestHandleIndex+WantAsync+WantCopy+MessageIds[uint64]). (10) **RopObject erweitert**: `attachment`-Variante mit `attachmentId:string|null`, `attachNum`, `pendingProperties`, `pendingBuffer`. `table`-Variante mit neuem `tableType:'attachments'`. (11) **Table-Handler erweitert**: `attachmentToPropRow()` mappt Attachment → PR_ATTACH_NUM/LONG_FILENAME_W/MIME_TAG_W/SIZE/METHOD; GetRowCount unterstützt 'attachments'. (12) **buildMessagePropertyList erweitert**: lädt `_count.attachments` und setzt PR_HAS_ATTACH + PR_MESSAGE_FLAGS HasAttach-Bit (0x10). (13) **SubmitMessage erweitert**: lädt msg.attachments aus DB und füllt OutboundJob.message.attachments mit `{filename, minioPath, contentType, size}` — Worker baut RFC-5322 mit echten Anhängen via existing buildRawFromMessage. (14) **Neue Property-Tags**: PR_ATTACH_NUM, PR_ATTACH_METHOD, PR_ATTACH_LONG_FILENAME_W, PR_ATTACH_FILENAME_W, PR_ATTACH_MIME_TAG_W, PR_ATTACH_SIZE, PR_ATTACH_CONTENT_ID_W, PR_ATTACH_DATA_BIN, PR_ATTACHMENT_LINKID. **Outlook-Verhalten**: Anhang an neue Mail anhängen (Drag&Drop oder „Datei einfügen") funktioniert end-to-end — wird in MinIO gespeichert, beim Senden in die Outbound-Queue mit `minioPath` weitergereicht, Worker lädt + signiert + sendet. Empfangene Mails mit Attachments: Outlook zeigt Paperclip-Icon, Anhang-Liste, Doppelklick öffnet Datei. Mails verschieben (Drag-and-Drop in andere Ordner) + Mehrfach-Lösch über Delete-Taste funktioniert. Push-Notifications bei neuer Mail: noch nicht (kommt in v4.5.0).

**v4.3.0** — MAPI/HTTP Phase 3: Mail-Schreiben + Senden. Outlook kann nach v4.2.0-Mail-Lesen jetzt auch komponieren + senden. Neue ROPs (echte Implementierung): (1) **RopCreateMessage** — legt Draft-Message-Handle an (`messageId=null, isDraft=true`), akkumuliert Pending-Properties/Recipients in Redis-Session bis Save. (2) **RopSetProperties** — parst PropertyValueArray (PropertyValueSize + Count + TaggedPropertyValues), JSON-safe-Encoding für Buffer/BigInt/Date in Redis-Persistierung. (3) **RopModifyRecipients** — parst ColumnCount/Columns + RowCount/Rows-Struktur aus MS-OXCMSG §2.2.3.1.2, extrahiert RecipientType+DisplayName+EmailAddress aus RecipientRow-Header-Bytes. (4) **RopSaveChangesMessage** — persistiert Draft in Drafts-Folder (Mailbox-UID-Increment, ModSeq-Update, `flags:['\\Draft']`), bei bestehender Message: Update. Response liefert FolderId+MessageId(uint64). (5) **RopWriteStream** — Append-Style + Overwrite-in-place + Sparse-Write (Padding mit Null-Bytes wenn Offset > Buffer-Länge); akkumuliert bis CommitStream. (6) **RopCommitStream** — schreibt Stream-Buffer in parent Message: bei gespeicherter Message direktes Prisma-Update auf bodyText/bodyHtml/subject (UTF-16-LE für PR_BODY_W/PR_SUBJECT_W, UTF-8 für PR_HTML), bei Draft-Stream Update der pendingProperties am parent Message-Handle. (7) **RopSubmitMessage** — reicht Message via BullMQ smtp-outbound-Queue ein (lokale Queue-Instanz mit `createBullMqConnection()` aus @coremail/core, kein Cross-Package-Import nötig), DKIM-Key aus User.Domain, From/To/CC/BCC, verschiebt nach Submit in Sent-Folder. (8) **RopObject erweitert** — `message`-Variante hat `messageId:string|null`, `isDraft`, `pendingProperties:Record`, `pendingRecipients:Array`; `stream`-Variante hat `writable`, `parentMessageHandle` für Draft-Streams. (9) **updateRopObject-Helper** in rop-handle-table.ts für Patch-Updates. (10) **Neue Property-Tags**: PR_EMAIL_ADDRESS_W, PR_ADDRTYPE_W, PR_SMTP_ADDRESS_W, PR_RECIPIENT_TYPE, PR_RECIPIENT_FLAGS, PR_OBJECT_TYPE, PR_DISPLAY_TYPE. (11) **ROP-Codec**: ModifyRecipients-Payload bekommt jetzt vollständigen Rest des Buffers (vorher nur 64 Bytes geslicet — Bugfix). (12) **bullmq** als Dependency zu @coremail/ews-server hinzugefügt. **Outlook-Verhalten**: Compose-Window funktioniert — neue Mail anlegen, Subject+Body+Recipients eintippen, „Senden" → Mail kommt beim Empfänger an. Sent-Folder zeigt Kopie. Reply/Forward funktioniert auch (Outlook lädt Original via v4.2.0 → schreibt Draft via v4.3.0 → submitted). Attachments: noch leer (kommen in v4.4.0). Push-Notification bei neuer Mail: noch nicht (v4.5.0).

**v4.2.0** — MAPI/HTTP Phase 2: Mail-Lesen (OpenMessage + Stream-Read). Bauen auf v4.1.0-ROP-Infrastruktur: jetzt kann Outlook nach Logon nicht nur die Folder-Hierarchie sehen, sondern auch einzelne Mails öffnen und anzeigen. (1) **RopOpenMessage** (`rop/message.ts`): Folder-Lookup über CUID→uint64-FNV-1a-Hash (entry-id.ts), Message via Prisma, Message-Handle in Session-Handle-Table. (2) **RopGetPropertiesAll** + **RopGetPropertiesSpecific**: vollständiges Property-Set für Outlook-Mail-Anzeige — PR_SUBJECT_W, PR_SENDER_*, PR_SENT_REPRESENTING_*, PR_DISPLAY_TO/CC/BCC_W, PR_MESSAGE_DELIVERY_TIME/CLIENT_SUBMIT_TIME, PR_MESSAGE_FLAGS (Read/Unsent/HasAttach), PR_MESSAGE_SIZE, PR_BODY_W (UTF-16-LE), PR_HTML (UTF-8 bytes), PR_MESSAGE_CLASS_W (IPM.Note), PR_HAS_ATTACH, PR_INTERNET_MESSAGE_ID_W. `buildMessagePropertyList` mappt Prisma-Message → MAPI-Tagged-Properties. (3) **RopOpenStream** (`rop/stream.ts`): öffnet Stream auf Message-Property, lädt kompletten Wert in Buffer, Response liefert StreamSize. (4) **RopReadStream**: chunked Read mit Offset-Tracking (Redis-persistiert), max 30 KB pro Chunk (MAX_STREAM_CHUNK_BYTES — Outlook erwartet <32 KB), Request-Format `Uint16 ByteCount | 0xBABE+Uint32 ExtendedByteCount`. (5) **RopGetStreamSize**: liefert Buffer-Größe. (6) **ROP-Codec**: Parsing für alle v4.2.0+v4.3.0+v4.4.0+ ROPs ergänzt; v4.3.0-Stubs (CreateMessage, SetProperties, SaveChangesMessage, SubmitMessage, WriteStream, CommitStream) parsen Payload korrekt und liefern aktuell ecNotSupported, kommen in v4.3.0 als echte Handler. (7) **RopId** ergänzt: MoveCopyMessages (0x33) + DeleteMessages (0x1E) für v4.4.0-Vorbereitung. **Outlook-Verhalten**: Mail-Liste sichtbar + einzelne Mail mit Subject/Sender/Body lesbar; Schreiben/Senden/Attachments/Push folgt in v4.3.0-v4.5.0.

**v4.1.0** — MAPI/HTTP Phase 1: ROP-Infrastruktur + Logon + Folder-Browse. Bauen auf v4.0.0-Foundation: voller ROP-Stream-Codec mit RopId/Property-Tags/EntryID-Helpers, ROP-Dispatcher der binäre Execute-Bodies parsed, RopLogon-Handler (lädt User aus Prisma, baut Folder-IDs-Array für IPM-Subtree/Inbox/Drafts/Sent/Trash, erstellt MailboxGuid+ReplGuid), RopOpenFolder/GetHierarchyTable/GetContentsTable, RopSetColumns/QueryRows/GetRowCount/Release. Property-Codec mit FILETIME-Konvertierung. 16 Codec-Tests grün. Skeleton-Files für v4.2-v4.7 mit detaillierten Plänen + Property-Mappings. Mit v4.1.0 kann Outlook nach Connect Logon machen, Folder-Hierarchie sehen — Mail-Lesen kommt in v4.2.0.

**v4.0.0** — MAPI-over-HTTP Foundation + Externe Clients Setup-Page. Beginn der nativen Outlook-Exchange-Anbindung. Diese Foundation legt: (1) `packages/ews-server/src/mapi/ARCHITECTURE.md` — vollständiger Implementations-Plan mit Roadmap v4.0.0 → v5.0.0, geschätzt 6-9 Monate für ein 2-Personen-Team. (2) `codec.ts` — Binary-Buffer-Reader/Writer für MS-OXCRPC Wire-Format (LE-uint8/16/32/64, ASCII/UTF-16-LE null-terminated Strings, GUIDs, AUX-Header-Blocks). (3) `codec.test.ts` — 16 Round-Trip-Tests alle grün. (4) `http-headers.ts` — X-RequestType/X-RequestId/X-ResponseCode/X-ExpirationInfo/Set-Cookie Header-Handling. (5) `session-store.ts` — Redis-backed Session-Store mit 10-Min-TTL und Auto-Renew. (6) `emsmdb-handler.ts` — Binary Connect/Disconnect/NotificationWait funktional; Execute liefert ecNotSupported (ROPs kommen iterativ). (7) NSPI-Handler-Stub: Bind/Unbind funktional, QueryRows etc. ecNotSupported. (8) Express raw() body-parser für /mapi/emsmdb/ + /mapi/nspi/ (binary statt JSON). (9) Autodiscover Feature-Flag `ENABLE_MAPI_HTTP=true` → fügt `<Protocol Type="mapiHttp" Version="1">` Block hinzu (default off bis ROP-Execution funktional). (10) OWA Settings-Page „Externe Clients & Outlook" mit IMAP/SMTP/CalDAV/CardDAV-Daten + Outlook-CalDav-Synchronizer-Setup. Volle Outlook-Funktionalität (Login, Folder-Browse, Mail-Lesen, Senden, Kalender, Kontakte) kommt in v4.1.0-v4.7.0.

**v3.18.40** — Externe Clients & Outlook Setup-Page in OWA. User-Wunsch: „Kalender und Kontakte über Outlook einsehen + bearbeiten". Microsoft Outlook Desktop hat keinen nativen CalDAV/CardDAV-Support — volle MAPI-over-HTTP-Implementierung wäre Wochen-Arbeit. Pragmatische Lösung: neue OWA-Settings-Section „Externe Clients & Outlook" mit allen nötigen Daten + Schritt-für-Schritt-Anleitung für das (kostenlose, OSS) „Outlook CalDav Synchronizer"-Plugin. Backend: neuer Endpoint `GET /api/v1/user/client-config` liefert konsolidiert IMAP/SMTP/POP3-Daten aus ServerSettings, CalDAV-Account + per-Kalender-URLs, CardDAV-Account + Default-Adressbuch-URL, plus `requiresAppPassword`-Flag basierend auf MFA-Status. Frontend: neue ExternalClientsSection mit Copy-Buttons für alle Werte, App-Passwort-Hinweis bei MFA, ausführliche Plugin-Setup-Anleitung mit pre-filled URLs (User muss nur kopieren+einfügen), und Hinweise zu Alternativen (OWA-Browser, Apple Kalender, Thunderbird+TbSync, eM Client, DAVx⁵ für Android).

**v3.18.39** — Outlook: EXCH+EXPR aus Autodiscover entfernt → IMAP-Fallback. User-Symptom (nach v3.18.38-Deploy): Password-Prompt kam jetzt korrekt, aber Outlook hing minutenlang im RPC/TCP-Connect, dann Fehler „Diese Ordnergruppe kann nicht geöffnet werden — Fehler bei der Anmeldung bei Microsoft Exchange". Outlook-Verbindungsstatus zeigte VIDs mit Protokoll RPC/TCP auf `mail.<domain>` mit Status „wird hergestellt" — und Typ „Öffentlich..." (Public Folder). Root Cause: Autodiscover-Response lieferte `<Protocol Type="EXCH">` (intra-Exchange RPC) und `<Protocol Type="EXPR">` (Outlook Anywhere / RPC-over-HTTPS). Beide nutzen das binäre MAPI/ROP-Protokoll. Wir haben nur EWS + Stubs auf /mapi/emsmdb/. Outlook versuchte deshalb minutenlang RPC-Connects an `rpcproxy.dll` (existiert nicht) oder den RPC-Endpoint-Mapper auf Port 135. **Pragmatischer Fix**: EXCH- und EXPR-Blöcke aus Autodiscover-XML ENTFERNT. Outlook fällt jetzt auto auf IMAP-Konfiguration zurück — Mail funktioniert sofort. Kalender + Kontakte gehen via CalDAV/CardDAV (Apple Kalender, Thunderbird, eM Client) oder direkt über OWA im Browser. Volle MAPI-over-HTTP-Implementation (EcDoConnectEx, ROP-Verbose-Binary, NSPI Bind/QueryRows) wäre für native Outlook-Exchange-Anbindung nötig — mehrere Wochen Arbeit, kommt später als eigenes Feature.

**v3.18.38** — Outlook-LTSC „kein Passwort-Prompt"-Root-Cause + Autodiscover-Vervollständigung. **KRITISCH**: User-Symptom war „Outlook verbindet sich, aber ohne Password-Abfrage, dann Private Ordner (PST) statt Exchange-Mailbox, plus Fehler 'Informationsdienst incomplete'". Root Cause: Outlook LTSC probt zuerst `GET /EWS/Exchange.asmx` BEVOR es einen Authorization-Header sendet. Der bisherige GET-Handler lieferte 200+WSDL-Stub ohne Auth-Check → Outlook nahm an, keine Auth nötig, schickte nie Credentials → Setup landete bei lokaler PST. Fix: `ewsAuthMiddleware` jetzt VOR GET-Handler + vor `/mapi/*`-Router (außer `/healthcheck.htm`) + OAB-Endpoint. Sendet jetzt 401 + `WWW-Authenticate: Basic realm="CoreMail EWS"` → Outlook fragt nach Credentials. PLUS `auth-service`-URL gefixt: war `http://auth-service:3001/auth/login` (Port 3001 = storage-api!) → jetzt env `AUTH_SERVICE_URL` mit Default `http://localhost:3003/auth/login`. PLUS Autodiscover-XML vervollständigt (Recherche an MS Docs + Grommunio): `AuthPackage` von `basic` auf `Basic` (case-sensitive bei Outlook-LTSC-Builds), `<User><LegacyDN>` Pflicht ergänzt (`/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=<user-id>` — Outlook nutzt es als interne User-Identity), `<AutoDiscoverSMTPAddress>` ergänzt, `<GroupingInformation>default</GroupingInformation>` im EXPR-Block, `<PublicFolderInformation>` Dummy, korrekte Exchange-2019-Topologie in ServerDN/MdbDN, `<EcpUrl>` ergänzt.

**v3.18.37** — Outlook-LTSC Autodiscover-XML erweitert (Exchange-2019-kompatibel) + Audit-Übersetzungen vervollständigt. (1) **AUTODISCOVER**: Die v1-XML-Response hatte nur einen minimalen `<Protocol Type=EXCH>`-Block. Outlook 2016+ braucht aber `AuthPackage`, `OABUrl`, `ASUrl`, `OOFUrl`, `EmwsUrl`, `MdbDN`, `ServerVersion` PLUS einen separaten `<Protocol Type=EXPR>`-Block (Outlook Anywhere / MAPI-over-HTTP-Fallback). Ohne diese bricht der Setup-Wizard mit „Da hat etwas nicht geklappt" ab. Fix: alle Pflichtfelder ergänzt, AuthPackage=basic, MicrosoftOnline=False (On-Premises-Signal), CertPrincipalName=None. (2) **AUDIT-ÜBERSETZUNGEN**: alte Pre-v3.18.34-Entries (`anomalies.get`, `full.post`, `jobs.delete`, `tags.post`, `members.delete`) wurden nicht erkannt weil das ACTION_MAP nur die neuen Long-Forms hatte. Plus neue v3.18.37-Formats: `servers.settings.put`, `servers.settings.derive.post`, `retention.tags.*`, `dashboard.get`, `services.put`, `make-primary.post`. Insgesamt 25+ neue Mappings. (3) **AKTEUR-FALLBACK**: bei leerem `actorEmail` (z.B. System-/Cron-Aktionen) wurde gar nichts angezeigt — jetzt Fallback `System (cmpla8p1…)`.

**v3.18.36** — Hostname-Auto-Derive (generisch für alle Domains) + Bilder-Privacy-Banner gehärtet. (1) **HOSTNAME-AUTO-DERIVE GENERISCH**: Schema-Defaults `mail.local:8080` für `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` mussten bisher manuell pro Installation angepasst werden — funktioniert für 1 Test-User aber nicht für 1000+ User mit individuellen Domains (z.B. `firma.de`, `kunde.com`, `irgendwer.org`). Fix: zentraler Helper `lib/server-urls.ts` mit `deriveServerUrls()` (berechnet URLs aus Hostname + useHttps + httpPort), `syncFromPrimaryDomain()` (setzt `publicHostname=mail.<domain>` wenn noch Default, leitet URLs ab), `syncServerUrlsFromHostname()` (idempotenter Re-Sync beim Container-Start). Eingehängt in: Setup-Wizard (`POST /setup/complete` — Transaktion speichert Domain+URLs atomar), Domain-Create (`POST /admin/domains` — erste Domain = primary, URLs ableiten), Make-Primary (`POST /admin/domains/:id/make-primary` — respektiert bereits-gesetzten Hostname), Settings-PUT (`PUT /admin/servers/settings` — stale URLs werden auto-derived), api-gateway-Startup (als Sicherheitsnetz). Autodiscover-Host nach Microsoft-Spec aus Root-Domain (`mail.firma.de` → `autodiscover.firma.de`). Redis-Publish `coremail:settings:reload` informiert autodiscover-Service sofort. (2) **BILDER-PRIVACY-BANNER**: Banner aus v3.18.10 funktionierte nicht — DOMPurify entfernte unsere Privacy-Markierungen. User-Report: trotz v3.18.10-Feature werden externe Bilder in Mails immer noch direkt geladen, das blaue „Bilder anzeigen"-Banner erscheint nie. Root Cause: `sanitize()` in MessageReader.tsx ruft `DOMPurify.sanitize(html)` OHNE Konfiguration → DOMPurify entfernt standardmäßig unsere Privacy-Markierungen (`data-coremail-ext-src`-Attribut, transparenter `data:image/png;base64`-Placeholder als src) → Block-Mechanismus wird direkt nach Aufbau wieder ausgehebelt. Fix: `sanitize()` mit explizit konfiguriertem DOMPurify — `ADD_ATTR` whitelistet unsere drei `data-coremail-*`-Markierungen, `ALLOWED_URI_REGEXP` erlaubt `data:image/...;base64,...`, `FORBID_TAGS` entfernt Tracking-Vektoren `script`/`style`/`link`/`iframe`/`object`/`embed`/`meta`/`base`, `FORBID_ATTR` blockt Event-Handler + `srcset` (Responsive-Image-Tracker). ZUSÄTZLICH: CSS `background-image: url(...)` in inline `style`-Attributen wird ebenfalls geblockt — häufiger Tracker-Vektor (z.B. `<div style="background-image:url(http://tracker/pixel.png)">`); Original wird in `data-coremail-ext-bg` gespeichert. „Bilder anzeigen"-Toggle räumt Placeholder-Styles (gestrichelter Rahmen, opacity:0.5) auf — Bilder erscheinen nach Klick normal statt weiterhin gedimmt. CID-Inline-Bilder (echte Attachments) bleiben unverändert sichtbar (kein Tracking-Risiko, Teil der Mail).

**v3.18.35** — Outlook LTSC Verbindungs-Fix. User-Report: „Outlook LTSC konnte keine Verbindung aufbauen — Da hat etwas nicht geklappt". Drei zusammenhängende Probleme: (1) API-Gateway routete `/Autodiscover/Autodiscover.xml` zum **EWS-Server** (Port 8080), aber der autodiscover-Server läuft auf Port 8081 — Outlook bekam Express-Default-404. Fix: neue env `AUTODISCOVER_SERVICE_URL`, Routes `/Autodiscover` + `/autodiscover` zum richtigen Service. (2) `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` in `ServerSettings` zeigten noch auf `mail.local:8080` (Schema-Default), obwohl `publicHostname` längst auf die echte Domain umgestellt war — Autodiscover lieferte Outlook unerreichbare interne URLs. Fix: Startup-Migration `syncAutodiscoverUrls()` korrigiert stale URLs automatisch beim api-gateway-Start; PUT /admin/servers/settings ebenfalls. Berechnet aus `publicHostname` + `useHttps` + `httpPort`; Autodiscover-Host aus Root-Domain (Microsoft-Spec). (3) Autodiscover-Service hatte 60s-Cache ohne Redis-Subscription — Settings-Änderungen wurden bis zu 60s nicht sichtbar. Fix: Subscription auf `coremail:settings:reload` für sofortige Cache-Invalidation.

**v3.18.34** — Audit-Log-Path-Fix + Backup-Watchdog + UX-Cleanup. (1) KRITISCHER Audit-Bug: `req.path` wurde im `res.on('finish')`-Callback gelesen, aber Express hatte den Pfad da bereits beim Sub-Router-Descend mutiert → Audit zeigte CUIDs als Aktionen (`cmplad51y0…post`). Fix: Path am Middleware-Eintritt in `capturedPath` speichern. Plus neuer CUID-bewusster `buildAction()` — CUIDs werden aus Action-String herausgefiltert + separat als `targetId` gespeichert. Aus `DELETE /backups/jobs/<cuid>` wird jetzt `action='backups.jobs.delete'` mit `targetId=<cuid>`. 40+ neue Übersetzungen im ACTION_MAP für Backups-Subroutes, Zertifikate-Subroutes (activate-https/activate-protocol), Settings-Subsections (security/org/mail/maintenance), Gruppen-Members, Aliase, Shared Mailboxes, Transport Rules, Quarantine, Queues, OAuth-Clients. (2) Backup-Service: Startup-Orphan-Cleanup markiert RUNNING/PENDING/RETRYING/PROCESSING/SCHEDULED-Jobs älter als 60s als FAILED nach Container-Restart („läuft endlos"-UI verhindert). Plus Watchdog-Timer (5min-Interval): Jobs > 30min werden als FAILED markiert. (3) Backup-Zeitplan-Editor: minutengenau (0..59) statt 5er-Schritt-Raster. (4) Rotes „Anomalien erkannt"-Banner aus Audit-Log entfernt — war verwirrend (zeigte eigene Settings-Änderungen als „kritische Aktion"); Backend-Endpoint `/admin/audit-log/anomalies` bleibt für Export-Zwecke.

**v3.18.33** — Externe Kontakte (ExternalMailContact) komplett entfernt. Feature wurde in der Praxis selten genutzt — externe Adressen sind typischerweise individuell pro User relevant (private Kontakte) oder pro Gruppe (z. B. „Lieferanten-Verteiler"). Reduziert Code-Komplexität, vereinfacht die GAL-Ansicht (User + Verteilergruppen) und entfernt einen Wartungspunkt im BCP. Analog zu v3.18.5 (eDiscovery) und v3.18.31 (Public Folders). **Entfernt**: Prisma-Model `ExternalMailContact` (Tabelle `external_mail_contacts` wird via `prisma db push --accept-data-loss` gedroppt), Backend-Router `routes/admin/external-contacts.ts` + Mount `/api/v1/admin/contacts`, BCP-Page `ExternalContactsPage.tsx` + Sidebar-Eintrag + Route `/ext-contacts` + i18n-Keys (`nav_ext_contacts` DE+EN), MWA-GAL-Filter „Extern" + Detail-Panel-Rendering für `EXTERNAL`-Kind, `ext-`-Branches in GroupsPage Member-Autocomplete (toter Code). **Geändert**: `routes/contacts.ts` GAL-Endpoint liefert nur noch User+DistributionGroup, `/contacts?q=` Compose-Autocomplete ebenso. Externe Empfänger werden ab sofort direkt im Compose-Fenster eingetippt oder als `EXTERNAL`-Mitglieder in Verteilergruppen gepflegt (DistributionGroupMember.memberType=`EXTERNAL` bleibt unverändert).

**v3.18.32** — TLS-Proxy SNI-Multi-Cert-Support (Outlook-Autodiscover-Fix). User-Report: „Outlook-Autodiscover liefert Zertifikatsfehler, obwohl `autodiscover.<domain>`-Cert via ACME ausgestellt wurde". Root Cause: Der integrierte HTTPS-Proxy auf Port 443 lud nur das **eine** Cert mit `isActiveHttps=true` und bediente damit alle eingehenden TLS-Verbindungen — Outlook sah beim Verbinden mit `autodiscover.<domain>` immer das `mail.<domain>`-Cert → Hostname-Mismatch. Fix: TLS-Proxy auf **SNI-Multi-Cert-Support** refactort. Beim Reload werden ALLE Certs mit `status='ACTIVE'` geladen, pro Hostname (CN + alle SANs + `domains[]`) ein eigener `tls.SecureContext`. `SNICallback` matcht exact → wildcard (`*.example.com`, RFC 6125) → Default-Cert. Default-Cert ist weiterhin das mit `isActiveHttps=true`, Fallback das neueste ACTIVE-Cert. Zusätzlich triggern jetzt auch ACME-Issuance + Self-Signed-Generate + Cert-Upload den `coremail:tls:reload`-Channel — vorher musste man nach Cert-Erstellung manuell „HTTPS aktivieren" klicken, mit Multi-SNI ist jeder ACTIVE-Cert sofort verfügbar.

**v3.18.31** — Öffentliche Ordner komplett entfernt. Das Feature war Exchange-Public-Folder-Style (mit ACL READ/WRITE/FULL + Mail-Enabled-Variante seit v3.18.9) und wird vom Markt heute kaum noch genutzt — moderne Teams bevorzugen Shared Mailboxes (`/admin/shared-mailboxes/`) und Distribution Groups (`/admin/groups/`) für die typischen Use-Cases (Team-Postfach, Verteiler, kollaborative Inbox). **Entfernt**: Prisma-Modelle `PublicFolder` + `PublicFolderMessage` (Tabellen `public_folders` + `public_folder_messages` via `prisma db push --accept-data-loss` gedroppt), Backend-Router `packages/api-gateway/src/routes/public-folders.ts` + `packages/api-gateway/src/routes/admin/public-folders.ts`, Route-Mounts `/api/v1/public-folders` + `/api/v1/admin/public-folders`, BCP-Page `PublicFoldersPage.tsx` + Sidebar-Eintrag + Route + i18n-Keys (`nav_public_folders` DE+EN), MWA-Sektion `PublicFoldersSection` + `PublicFolderViewerModal` in `FolderTree.tsx`. **Geändert**: `smtp-server/src/inbound/handler.ts` `verifyRecipient()` ohne publicFolder-Lookup, `smtp-server/src/handlers/message.ts` `storeInboundMessage()` ohne Public-Folder-Branch — Mails an ehemalige Public-Folder-Adressen werden jetzt als unbekannter Empfänger verworfen. Migration ist destruktiv, alle bestehenden Public Folders + deren Mails gehen verloren (vergleichbar mit eDiscovery-Removal in v3.18.5).

**v3.18.30** — BigInt-Crashfix + Audit-Toggle + Audit-Translations. **KRITISCH**: backup-service crashloopte seit v3.18.26 weil `BackupJob.sizeBytes` als Prisma-BigInt nicht von `JSON.stringify` serialisiert wird — `/jobs` und `/users` warfen 500, was die User-Symptome „Einzelne Mailbox sichern zeigt keine Benutzer" und „Jobs zeigt keinen Status" erklärt. Fix: globaler Monkey-Patch von `express.response.json` am Modul-Top mit rekursivem BigInt→String-Replacer. Wirkt für alle Endpoints. **Audit-Log-Toggle** in BCP→Sicherheit (`ServerSettings.auditLogEnabled`). Critical-Action-Override via Regex `ALWAYS_AUDIT` (`settings.*`, `audit.*`, `user.role`, `oauth.client`, `mailbox.delete`, `domain.delete`) — diese werden IMMER protokolliert auch bei abgeschaltetem Toggle. Toggle-Wechsel selbst als `audit.enabled`/`audit.disabled` mit Diff geloggt (Compliance: DSGVO Art. 32 / SOX / HIPAA / TISAX / ISO 27001). 60s In-Memory-Cache vermeidet DB-Hit pro Audit-Write; `invalidateAuditCache()` nach Save. **Human-Readable Audit-Labels**: `ACTION_MAP` mit 40+ Mappings übersetzt `settings.put`→„Einstellungen geändert", `mailboxes.delete`→„Postfach gelöscht", `audit.disabled`→„Audit-Log DEAKTIVIERT" (rote Critical-Tone) etc. Original-String im title-Tooltip für SIEM-Querverweise.

**v3.18.29** — Backup-Archiv Download + Delete. Vorher war die Archive-Tabelle read-only. Jetzt: zwei neue Backend-Endpoints (`GET /backup/admin/archive/download?key=` als Stream-Proxy, `DELETE /backup/admin/archive?key=` löscht S3-Object und nullt referenzierende BackupJob.downloadUrl mit Status=EXPIRED). Frontend: neue Aktionsspalte im Archive-Tab mit Download-Button (HardDriveDownload-Icon) und Trash-Button (mit „endgültig löschen"-Confirm). Audit-Log-Entry `backup.archive.delete`.

**v3.18.28** — Calendar+Backup UX-Fixes. **KRITISCH**: Erneutes Öffnen eines erstellten Termins → weiße Seite. Root: React-Rules-of-Hooks-Verletzung in EventEditDialog — `useMemo` wurde nach `if (existingLoading) return` aufgerufen → Hook-Count ändert sich zwischen Renders → Crash. Fix: alle Hooks vor jedem early-return. **Backup-Jobs**: Download (Stream-Proxy statt Docker-interne MinIO-URL die Browser nicht erreicht) + Delete (Endpoint DELETE /admin/backups/jobs/:id mit S3-Object-Cleanup). **Speichern-Button** im Event-Dialog jetzt unten rechts (Outlook-Standard) + Footer mit Löschen links / Abbrechen+Speichern rechts. **Time-Input** statt nur Dropdown — `<input type="time" list="...">` mit datalist: Browser zeigt 15-min-Vorschläge, User kann aber jede beliebige Zeit eintippen. **BackupsPage refactor** als 5-Tab-Layout (Jobs / Schnellaktionen / Zeitpläne / Backup-Archiv / Restore) mit Badge-Counters. **„S3-Snapshots" → „Backup-Archiv"** (AWS-Begriff vermieden). **Zeitplan-Editor** vollständig mit Dropdowns: Frequenz (Stündlich/Täglich/Wöchentlich/Monatlich/Custom), Wochentag, Stunde, Minute, Tag-des-Monats, Retention. Cron-Expression wird automatisch generiert und als read-only-Hinweis angezeigt.

**v3.18.27** — Outlook-Style Event-Dialog für Kalender. (1) FIX: Klick auf bestehenden Termin öffnete vorher nur „Löschen?"-Confirm — User konnte Termin nicht bearbeiten. Jetzt vollwertiger Edit-Dialog. (2) FIX: datetime-local-Input ersetzt durch separates Date + Time-Dropdown (15-min Steps, 96 Optionen). „Ganztägig"-Checkbox blendet Zeit aus. (3) Neue `EventEditDialog`-Komponente mit Outlook-Layout: Header-Toolbar (Speichern/Löschen/Refresh), Kalender-Picker mit Farbpunkt, Titel-Input, **Attendee-Liste mit Live-PARTSTAT-Badges** (grün ACCEPTED / rot DECLINED / amber TENTATIVE / grau NEEDS-ACTION + Counter „X zugesagt · Y abgesagt · …"), Date+Time-Pickers, Ort, Klassifizierung (Public/Private/Confidential), Notizen-Textarea, Footer mit Organisator+SEQUENCE. Attendee-Status refresht automatisch alle 30s + manueller Refresh-Button. (4) Neuer GET-Endpoint `/calendar/events/:id` mit `canWrite`/`readOnly`-Flags + Privacy-Masking für PRIVATE/CONFIDENTIAL bei Grantees. CalendarPage-State vereinfacht: `eventDialog: { mode: 'create' | 'edit', ... } | null`.

**v3.18.26** — Backup-System rundum erweitert. (1) BUGFIX: Vollbackup + Refresh-Button funktionierten nicht weil backup-service beim ersten `listBackups()`-Aufruf mit `NoSuchBucket` crashte. Fix: `ensureBackupBucket()` läuft beim Service-Start, idempotent HeadBucket→CreateBucket. (2) PER-MAILBOX-BACKUP: neuer Endpoint `POST /admin/backups/mailbox/:userId`, Frontend mit User-Picker + Format-Auswahl (zip/mbox). (3) ZEITPLÄNE in DB: neues `BackupSchedule`-Modell, Scheduler liest alle 60s, CRUD im BCP mit Cron-Presets (täglich/wöchentlich/...), Run-Now-Button. (4) ERWEITERTES STATUS-LOG: BackupJob +10 Spalten (`startedAt`, `durationMs`, `sizeBytes`, `messageCount`, `errorClass`, `triggeredBy`, `progressMeta`, ...) für RTO/RPO-Messung. `JobStatus`-Enum +5 Werte (SCHEDULED, RUNNING, RETRYING, ABORTED, EXPIRED). (5) PST-EXPORT VERWORFEN: nach Research klar — proprietäres Format, alle Libs read-only. Stattdessen ZIP+EML (Outlook akzeptiert per Drag&Drop). Banner im UI weist darauf hin. Pre-Built Recherche-Report enthält RTO/RPO-Best-Practices für SMB.

**v3.18.25** — Calendar-Invitations (iMIP/iTIP, A5). Terminerstellung mit Gästen sendet jetzt iMIP-konforme Einladungs-Mails (RFC 6047/5546). Gäste sehen in Gmail/Outlook „Annehmen / Vielleicht / Ablehnen"-Buttons direkt in der Mail. Antworten kommen als REPLY-Mails zurück → werden in storeInboundMessage automatisch erkannt + Attendee.partstat im Event geupdated. UPDATE-Mails (mit `sequence++`) bei Event-Änderung. CANCEL-Mails beim Löschen. Neuer Helper `packages/api-gateway/src/lib/imip.ts` mit `ical-generator`. iTIP-Inbound in `packages/storage/src/itip-inbound.ts` mit Regex-basierter VCALENDAR-Extraktion (kein schwerer Parser im Hot-Path). MIME-Struktur: `multipart/mixed` mit `multipart/alternative` (text/plain + text/html + text/calendar method=REQUEST) für Gmail + zusätzlich `.ics`-Attachment für Outlook-Win32-RSVP-Buttons. Outlook-Quirks: `X-MICROSOFT-CDO-BUSYSTATUS`, `X-MS-OLK-FORCEINSPECTOROPEN`. Frontend Calendar-Modal hat neues Feld „Gäste einladen (kommagetrennt)". UID jetzt mit `@publicHostname`-Suffix (RFC 5545 §3.8.4.7).

**v3.18.24** — Performance E4: MinIO Lifecycle-Policies + Vorbereitung iMIP. Neuer Helper `ensureLifecyclePolicies()` in `packages/storage/src/minio/index.ts` wird in `ensureBuckets()` aufgerufen — setzt prefix-basierte Expiration-Regeln: `outbound-queue/` 7 Tage (Sicherheitsnetz für tote BullMQ-Jobs), `quarantine/` 90 Tage (rspamd), `backups/` 365 Tage. Anhänge und Raw-Messages sind ausgenommen. Idempotent + fail-safe (WARN bei alter MinIO-Version). Zusätzlich `CalendarEvent.sequence Int @default(0)` als Vorbereitung für v3.18.25 iMIP-Updates (RFC 5546 §3.2). Dep `ical-generator@10` installiert.

**v3.18.23** — Backup-Restore-UI im BCP (D3). Neue Page „Backup & Restore" in der Sidebar mit drei Sektionen: (1) Backup-Jobs-Tabelle mit Datum/Scope/Format/Status (Icons für PENDING/RUNNING/COMPLETED/FAILED/CANCELLED) + Progress-Bar + Download-Link bei completed. Auto-Polling alle 5s wenn Job läuft, sonst 60s. (2) S3-Snapshots-Tabelle mit Key/Size/Last-Modified aus MinIO-Bucket. (3) MBOX-Import (Wiederherstellung) mit File-Picker (max 500MB) + Ziel-User-ID. Vollbackup-Button im Header triggert sofort einen neuen Job. Backend: Wrapper-Router `adminBackupsRouter` in `packages/api-gateway/src/routes/admin/backups.ts` leitet `/api/v1/admin/backups/*` an `BACKUP_SERVICE_URL` (Default `http://localhost:3004`). Authorization-Header wird durchgereicht (backup-service hat eigenen requireAdmin). Audit-Log für `backup.full.trigger` und `backup.mbox.import`. i18n DE+EN. Neuer Sidebar-Eintrag mit HardDriveDownload-Icon.

**v3.18.22** — Security: OAuth2-Consent-UI (D1). Backend `/oauth2/authorize/complete` granted vorher Consent blind beim ersten Aufruf eines nicht-trusted Clients — User hatten keine Chance, eine Drittanbieter-App vor dem Zugriff zu sehen/ablehnen. Jetzt: Backend liefert `requiresConsent: true` mit Client-Info + Scope-Liste statt direkt Code auszustellen. Neue `OAuthConsentPage` zeigt Client-Name, Scopes mit deutschen Labels (z.B. mail.send → „E-Mails senden in deinem Namen"), Allow/Deny-Buttons. „Erlauben" → zweiter Call mit `consentConfirmed: true` → Code + Redirect. „Ablehnen" → RFC-6749-konformer `error=access_denied` zurück an Client. LoginPage parst `?oauth2=1` aus URL und navigiert nach Login zur ConsentPage statt zu `/mail`. Neue Route `/oauth-consent` mit AuthGuard ohne Layout-Wrapper.

**v3.18.21** — Calendar-Toolbar Filter + Drucken funktionsfähig. (1) Filter-Button öffnete vorher nur ein Dropdown ohne tatsächliche Wirkung — State war lokal in Toolbar. Außerdem Outlook-Begriffe (Besprechungen, Kategorien) bedeutungslos. Reduziert auf 5 realistische Optionen die auf CalendarEvent-Felder mappen: Wiederholende Termine, Aufgaben, Private/Vertrauliche Termine, Geteilte Kalender. State zu CalendarPage lifted, `fcEvents.filter()` wendet sie an. (2) „Drucken" druckte komplette Seite mit Sidebar/Toolbar. Fix: `coremail-printing`-Class auf `<html>` + `@media print`-Block in `index.css` blendet `aside/nav/header` aus, Events bekommen Print-Border.

**v3.18.20** — Dark-Mode-Patches: LoginPage komplett (war erste Seite die neue User sehen, hatte aber gar keine `dark:`-Klassen → komplett weiße Card auf dunklem Hintergrund). SettingsPage: Sektion-Headers + Form-Labels + disabled Inputs jetzt im Dark-Mode korrekt. Bekannt offen: ComposeWindow (~22 Stellen) + SignatureSection (~9 Stellen) für dedizierten Dark-Mode-Sweep in v3.19.

**v3.18.19** — Security: Forced 2FA für Admin-Login. ServerSettings.requireMfaForAdmins-Toggle bestand seit längerem, wurde aber nirgendwo enforced. Jetzt prüft `requireAdmin`-Middleware in `packages/api-gateway/src/middleware/auth.ts` bei aktivem Toggle die UserMfa-Tabelle (totpEnabled OR webAuthnCredentials nicht leer). Ohne MFA → 403 `{ code: "MFA_REQUIRED" }`. BCP-Frontend-API-Client leitet auf neue `MfaRequiredPage` (Pfad `/bcp/mfa-required`) mit Anleitung zur Aktivierung im MWA. Kein Chicken-and-Egg: MFA-Setup-Routes (`/auth/mfa/*`) sind außerhalb der Admin-Sperre. Fail-safe bei DB-Fehler (durchlassen + ERROR-Log) damit Admins nicht bei Postgres-Ausfall ausgesperrt werden.

**v3.18.18** — Toolbar-Share-Button funktioniert + CalDAV-URL-Anzeige. (1) **Fix Toolbar „Kalender teilen"**: Button zeigte vorher nur Toast, jetzt öffnet er ShareCalendarDialog mit Picker-Dropdown im Header wenn User mehrere eigene Kalender hat. Bei einem direkt geöffnet, bei keinem Toast-Error. ShareCalendarDialog akzeptiert optionalen `ownedCalendars`-Prop für Picker-Modus. (2) **CalDAV-URL-Anzeige**: Neuer Endpoint `GET /api/v1/calendar/caldav-info` liefert `accountUrl` (Auto-Discovery) + Pro-Kalender-URL + Username + Auth-Hinweis (App-Passwort wegen MFA). ShareDialog zeigt neue Sektion „Externer Zugriff (CalDAV)" mit Copy-Buttons. Sidebar-Kontextmenü hat zusätzlich „CalDAV-URL kopieren" auf eigenen Kalendern. HTTPS empfohlen außer bei explizit `useHttps=false` (Reverse-Proxy-Setup).

**v3.18.17** — Calendar SSE-Push + Free/Busy. (A2) **SSE-Push für Share-Lifecycle** — neuer Redis-Channel `coremail:calendar:shares` (`CHANNEL_CALENDAR_SHARES` in @coremail/core). Backend published JSON-Event mit `affectedUserIds[]` bei create/update/delete/self_remove. SSE-Handler filtert pro Verbindung und forwardet als `event: calendar:shares` an betroffene User. Frontend `useMailEvents()` invalidiert `['calendars']`+`['calendar-shares']`-Caches → instant Live-Sync. Toast bei `action=create`. CalendarPage-Polling von 60s auf 5min reduziert (nur Fallback). (A4) **Free/Busy-Query** — `POST /api/v1/calendar/freebusy` mit Body `{ userEmails[], start, end }`. Liefert Busy-Slots aus Kalendern mit Zugriff. CONFIDENTIAL für Foreign-Caller ausgeblendet, PRIVATE ohne Subject. Hard-Limits 90 Tage / 50 User (DoS). Response-Shape `{ start, end, users: [{ email, found, busy: [{ start, end, type, subject? }] }] }`.

**v3.18.16** — Calendar Sharing Quick-Wins. (A1) **Notification-Mail an Grantee** — neuer Helper `packages/api-gateway/src/lib/internal-notify.ts` mit `notifyUserInbox()` schreibt direkt in `Message`-Tabelle (kein SMTP-Roundtrip, kein DKIM/Spam-Check). Wird im `POST /calendar/:id/shares`-Handler getriggert. Heuristik (5s-Schwelle) verhindert Spam bei Permission-Update via Upsert. (A3) **Per-Grantee-Farbe** — `CalendarShare.localColor String?` + `PATCH /calendar/mine-shares/:shareId`. Grantee kann lokal umfärben, Owner-Farbe bleibt unverändert. `listAccessibleCalendars` liefert `localColor ?? color`. (A8) **Reorder shared section** — `CalendarShare.sortOrder Int @default(0)` + `POST /calendar/mine-shares/reorder`. Kontextmenü mit ArrowUp/Down. CalendarSidebar sortiert geteilte Kalender nach `sortOrder` statt alphabetisch. (C1) **`Calendar.acl Json` gedroppt** (v3.18.14 als @deprecated markiert, kein Code-Reference). `PublicFolder.acl` bleibt. Frontend bekommt jetzt `shareId` direkt im `GET /calendar`-Response — vereinfacht Self-Removal/Color-Change/Reorder.

**v3.18.15** — Folge-Release zu v3.18.14: (1) **CalDAV-WRITE für Grantees** — Apple Kalender / Thunderbird Lightning können jetzt Termine in geteilten Kalendern erstellen, ändern, löschen (wenn WRITE-Permission). Volle RFC-3744-DAV-ACL: `<DAV:owner>`, `<DAV:current-user-privilege-set>` mit `read`/`write`/`bind`/`unbind`/`write-content`, `<DAV:acl>`-Block für Owner. OPTIONS mit `Allow: …, ACL` + `DAV: access-control`. (2) **Private/vertrauliche Termine** (RFC 5545 `CLASS:`) — neues Feld `CalendarEvent.classification` mit Werten `PUBLIC`/`PRIVATE`/`CONFIDENTIAL`. PRIVATE-Events erscheinen bei Grantees nur als „Beschäftigt" (Subject/Description/Location maskiert), CONFIDENTIAL-Events sind komplett ausgeblendet. Owner sieht alles. Masking greift in REST `GET /events`, CalDAV `GET`/`PROPFIND`/`REPORT`. Dropdown im MWA-Neuer-Termin-Dialog. (3) **Audit-Log für Sharing** — neue Aktionen `calendar.share.create|update|delete|self_remove` mit Diff im `changes`-Feld (Compliance-Lücke aus v3.18.14 geschlossen, DSGVO Art. 32). (4) **i18n EN/ES/IT** für die kompletten Sharing-UI-Texte (25 neue Keys `cal_share_*` + `cal_event_class_*`).

**v3.18.14** — Neues Feature: Kalender teilen und berechtigen. User können eigene Kalender intern an andere User mit READ oder READ+WRITE-Permission freigeben. Geteilte Kalender erscheinen beim Empfänger in neuer Sidebar-Sektion „Geteilt mit mir" mit Share-Icon + Permission-Badge + Owner-Name. **Schema**: neues Model `CalendarShare` + Enum `CalendarPermType` (READ/WRITE), `Calendar.acl` als `@deprecated` markiert. **Backend**: zentraler Helper `canAccessCalendar()` + `listAccessibleCalendars()` in `packages/api-gateway/src/lib/calendar-access.ts`, REST-Endpoints `GET/POST/PUT/DELETE /calendar/:id/shares` + `GET /calendar/mine-shares`, Event-Routen prüfen jetzt durchgängig READ/WRITE-Permission. Owner sind immer OWNER. Self-Share verboten. **CalDAV**: Grantees sehen geteilte Kalender in `calendar-home-set` (Prefix `[Geteilt]`), PROPFIND/REPORT/GET erlaubt, PUT/DELETE bleiben in v3.18.14 OWNER-only. `<DAV:current-user-privilege-set>` korrekt gesetzt. **Frontend**: `ShareCalendarDialog` mit Benutzer-Autocomplete (reuse `/contacts?q=`, gefiltert auf User-Treffer, Keyboard-Nav), Permission-Select, Liste bestehender Freigaben mit Toggle + Delete. CalendarPage rendert READ-only Events als nicht editierbar, Neuer-Termin-Dropdown listet nur Schreib-Kalender. TanStack Query mit `staleTime: 30s` + `refetchInterval: 60s` für Live-Sync von Widerrufen. **v3.18.15 (folgt)**: volle CalDAV-WRITE via RFC-3744-DAV-ACL.

**v3.18.13** — Zwei Fixes. (1) BCP ExternalContactsPage: Vorname/Nachname-Eingaben aus dem Modal entfernt — nur noch das Pflichtfeld „Anzeigename". Backend-Felder firstName/lastName bleiben mit Default-`""` in der DB erhalten (kein Schema-Bruch). (2) MWA GAL-Cache Live-Sync: neu in BCP angelegte ExternalContacts/DistributionGroups waren bisher erst nach Reload sichtbar (30s Cache). Fix: `staleTime:0` + `refetchOnMount:true` + `refetchOnWindowFocus:true` + `refetchInterval:60_000` für `/contacts/gal`-Query, plus expliziter Refresh-Button (RefreshCw-Icon mit Spin) in der Filter-Bar.

**v3.18.12** — Public Folders: drei Fixes. (1) Browse-Modal: Klick auf Public Folder zeigte vorher nur Toast, jetzt neue `PublicFolderViewerModal`-Komponente mit 2-Spalten-Layout (Liste + Detail), Auto-Refresh 30s, sanitized HTML-Rendering. (2) Folder-Icon (amber, gefüllt) statt Users-Icon — Public Folders sehen jetzt wie Ordner aus, nicht wie Kontakte. (3) Section komplett unsichtbar wenn keine ACL: Hide-Logik via `!isSuccess || !folders || folders.length === 0`. `refetchOnWindowFocus: true` + Polling-Intervall 30s — wenn Admin Zugriff entzieht, verschwindet Section beim Tab-Fokus oder spätestens nach 30s.

**v3.18.11** — MWA Globales Adressbuch (GAL-Browser): ContactsPage hat jetzt Tabs „Mein Adressbuch" / „Globales Adressbuch". GAL liefert vereint aus 3 Quellen (alle aktiven User + ExternalMailContacts + DistributionGroups), alphabetisch sortiert (Browse-Modus ohne Query), Typ-Filter (Alle/Personen/Extern/Gruppen), Counter-Badge. Klick auf GAL-Eintrag → Read-Only-Detail-Panel mit Typ-Badge, klickbarem E-Mail/Telefon/Mobil, Unternehmen/Abteilung/Domain/Mitgliederzahl + „Neue Nachricht"-Button mit vorausgefüllter Adresse. Backend: `/contacts/gal` erweitert mit Browse-Modus + `type=`-Filter + Paginierung. ID-Prefix (`user-`/`ext-`/`grp-`) markiert Quelle.

**v3.18.10** — Zwei Features: (1) **Bilder-Privacy-Banner (Outlook/Gmail-Style)** — externe `<img>` werden mit transparentem 1×1-PNG ersetzt, Original wandert nach `data-coremail-ext-src`. Banner zeigt Anzahl blockierter Bilder + „Bilder anzeigen"-Button. `cid:` (inline-Attachments) bleiben sichtbar — werden zu MinIO-URLs aufgelöst. Backend liefert jetzt `contentId`+`inline` pro Attachment. (2) **Queue-Hardening Phase 1**: DSN-Bounce (RFC 3464, multipart/report) bei permanentem Versand-Fehler an MAIL FROM zugestellt mit Double-Bounce-Schutz. 4xx (transient) vs. 5xx (permanent) Semantik: SMTP-Codes werden extrahiert und 5xx sofort als final markiert via `job.discard()` — kein 10×-Retry mehr für „550 User unknown". SMTP-Code wird im MAIL_FLOW-Log persistiert. Dynamische QueueSettings: `enqueueOutbound` liest `maxRetryAttempts` + `retryBackoffDelaySec` aus DB.

**v3.18.9** — Drei kritische Backend-Features: (1) **TransportRule-Engine** — neue Engine `packages/storage/src/transport-rules.ts` mit 8 Conditions × 9 Operators und 10 Actions (addHeader, removeHeader, redirect, reject, addRecipient, removeRecipient, setSubjectPrefix/Suffix, quarantine, addDisclaimer). Hook in `storeInboundMessage` direkt nach Parsing. Regeln wurden vorher in DB gespeichert aber niemals evaluiert. (2) **Public Folders Mail-Enabled** — `PublicFolder.email String? @unique`, `verifyRecipient` + `storeInboundMessage` erkennen sie, Mails landen als `PublicFolderMessage` direkt im Ordner. MWA-FolderTree zeigt sie als „Öffentliche Ordner"-Sektion mit lila Users-Icon. BCP ACL-Editor mit Autocomplete-Dropdown. (3) **SharedMailbox SEND_AS/SEND_ON_BEHALF in REST `/mail/send`** — Permission-Check via `sharedMailboxPerm`, From-Override, `Sender:`-Header für „im Auftrag von".

**v3.18.8** — Vier Fixes: (1) **ExternalContactsPage Cursor-Bug** — Field-Helper-Component inline → Recreation pro Render → Cursor-Verlust; alle Felder zu inline `<div>` umgebaut. (2) **GroupsPage Fragment-Key-Warning** — `<>` zu `<Fragment key>`. (3) **KRITISCH: Verteilergruppen externe Mitglieder erhielten keine Mails** — `expandRecipients` lieferte alle Member als „lokal", externe gingen silent verloren. Fix in `queue.ts` + `inbound/handler.ts`: nach Expansion erneut auf lokal/extern teilen, externe via `relayMessage`/`enqueueOutbound`. (4) **Compose-Autocomplete vereinte Adressquellen** — `/contacts?q=` liefert ab 2 Zeichen Private Kontakte + GAL-User + ExternalMailContacts + DistributionGroups mit ID-Prefix (gal-/ext-/grp-) zur Quellen-Markierung. GroupsPage MembersPanel mit Autocomplete-Dropdown statt Plain-Text-Input.

**v3.18.7** — Vier Features kombiniert: (1) **Fix Audit-Akteur/Ziel** — `auditMiddleware` lief vor `requireAuth` → `apiUser` undefined → Akteur leer. Fix: Logging in `res.on('finish')`, `targetType` gesetzt, HTTP-Status als `success`/`errorMsg`. (2) **Senden planen (Outlook-Style)** — `Message.scheduledAt/Status/JobId`, BullMQ-`delay`-Job, `POST /mail/messages/:id/cancel-scheduled`, Worker-Cancellation-Check, ComposeWindow mit Pfeil-Dropdown + 3 Presets + Custom-Picker, MessageReader-Banner (blau/grün/grau) mit „Planung abbrechen"-Button, CalendarClock-Icon in MessageList. (3) **Spam-UX (Outlook-Style)** — `Message.spamScore` persistiert, Spam-Banner in MessageReader (rot ≥6.0 / amber ≥3.0 / Junk-Ordner) mit Score und Inline-Button, ShieldAlert-Badge in MessageList. (4) **Audit-Log v2** — SHA-256-Signatur für CSV/PDF/JSON-Exports (`X-CoreMail-Signature`-Header), JSON-Export für SIEM (Splunk/Sentinel/ELK), `/anomalies`-Endpoint (Burst, Failure-Burst, kritische Aktionen, Off-Hours), Meta-Logging gegen Insider-Threats (GET-Routen für Exports auch auditiert), Frontend mit Anomalien-Banner (60s refresh) und Signatur-Hinweis.

**v3.18.5** — Removed: eDiscovery & Legal Hold komplett aus dem Code entfernt. Schema (EDiscoverySearch, LegalHold, EDiscoveryStatus enum, RetentionPolicy.respectLegalHold), Backend-Router `/admin/ediscovery`, Frontend-Page EDiscoveryPage.tsx, Sidebar-Eintrag, i18n-Keys (DE+EN), SearchCheck-Icon-Import, RbacPage-Beschreibung, RetentionPage-Checkbox. backup-worker.ts lädt keine legalHold-Records mehr. Bestehende Tabellen werden via `prisma db push --accept-data-loss` automatisch gedroppt.

**v3.18.4** — Feature: Signaturen-Editor mit Bildern, Links und Schriftarten (Gmail/Outlook-Level). 10 Schriftarten, 5 Schriftgrößen, Textfarbe (24)/Markierungsfarbe (12), B/I/U/S, Ausrichtung, Listen, Trennlinie, Link (markiert → wird zum Link / nichts markiert → URL als Text), Bild-Upload (max 500 KB als base64) + URL + Drag&Drop mit Overlay, Vorschau/Editor-Toggle. Custom FontSizeExt via TipTap `addGlobalAttributes`. SignatureSection in eigene Komponente ausgelagert.

**v3.18.3** — Fix: BCP DNS-Check Counter und Status-Farben konsistent. Counter zählte 7 Backend-Records gegen total=6 (A-Record nicht im UI), warnings wurden im Text nicht erwähnt. Neu: `VISIBLE_DNS_KEYS` als Single Source of Truth (mx/spf/dkim/dmarc/autodiscover/ptr), Status-Text unterscheidet jetzt klar „mit Warnung" und „fehlen", StatusDot mit 3 Farben (grün/gelb/rot), Legende ohne veraltetes Orange.

**v3.18.2** — UI-Cleanup + Compose-Rollback: (1) „Outlook"-Erwähnungen aus user-facing UI-Texten entfernt (Stop-Processing-Hinweis in RulesSection, Ansicht-Section, App-Passwords-Hinweis). Erhalten bleiben technische Outlook-Referenzen (Autodiscover-Setup, OAuth2-Client-Beispiele). (2) Fix: „+ Neue Regel"-Button bekommt `shrink-0 whitespace-nowrap px-4`. (3) **Revert**: v3.18.1-Gmail-Style-ComposeWindow zurückgerollt auf v3.18.0-Variante (Outlook-angelehnt) — passt besser zur restlichen CoreMail-UI.

**v3.18.1** — Feature: Gmail-Style Compose-Window Redesign. 3 Modi (small/large/minimized) mit smooth Transitions, Header-Drag im Floating-Modus, Aa-Toggle für Format-Toolbar, Schedule-Send mit Presets (morgen 8/13, Montag, custom), Emoji-Picker, Bild-Insert, Drag&Drop Files mit Overlay, Tastatur-Shortcuts (⌘+Enter, ⌘+⇧+C/B, Esc), Draft-Save-Indikator, Dark-Mode überall, active:scale-Animations für taktiles Feedback.

**v3.18.0** — Feature: Outlook-Style Inbox Rules. Vollständige User-Regeln im MWA (Bedingungen/Aktionen/Ausnahmen/Stop-Processing). Engine in `packages/storage/src/mail-rules.ts`, Hook in `storeInboundMessage()`, Forward/Redirect via bestehende BullMQ-Outbound-Queue mit Loop-Schutz. Frontend: Settings → „Regeln" mit Drag-Reorder + RuleEditorModal (3-Schritt-Wizard) + Kontextmenü „Regel erstellen" in MessageList. Schema-Erweiterung: `MailRule.exceptions`, `stopProcessing`, `matchAll`. API: `/user/rules/:id/toggle`, `/reorder`, `/:id/run-now`.

**v3.17.50** — Fix: MWA Kontextmenü „Quelltext anzeigen" öffnet RFC-822-Modal statt Browser-Tab (fetch + Modal analog zu MessageReader, mit EML-Download-Button).

**v3.17.49** — Fix: MWA Quelltext/EML 401-Fehler behoben (Bearer-Token als `?token=`-Query-Param). „Kein Junk"-Button im Junk-Ordner ergänzt. USER-JUNK-Blacklist: Mails von manuell als Junk markierten Absendern landen automatisch im Junk + rspamd Bayes-Training. Antwort-Indikator: `\Answered`-Flag wird beim Antworten gesetzt; blaues Reply-Icon in MessageList.

**v3.17.48** — Fix: SMTP PIPELINING Race Condition. Eingehende Mails (Server-to-Server) wurden mit "503 5.5.1 Bad sequence of commands" abgewiesen. Root Cause: `handleMailFrom()` + `handleRcptTo()` sind async; mit PIPELINING sah RCPT TO noch State `'READY'` (MAIL FROM war noch nicht fertig). Fix: Command-Queue (`cmdQueue: Promise<void>`) serialisiert alle SMTP-Commands — States werden garantiert in richtiger Reihenfolge gesetzt. Alle Commands inkl. AUTH-Steps und `finishData()` via `enqueueCommand()`.

**v3.17.47** — Feature: BCP DNS-Einrichtungs-Panel. Neuer Button „DNS-Einrichtung prüfen" in Domains → Domain bearbeiten öffnet vollständiges Panel mit allen 7 Einträgen (A, MX, SPF, DKIM, DMARC, Autodiscover, PTR). Werte stammen live aus SSL/TLS-Konfiguration + DKIM-Key. Jeder Eintrag: Typ-Badge, Status (✅/❌), kopierbarer Host + Wert. DKIM: 255-Zeichen-Chunk-Option für netcup & Co. SPF-Expected jetzt mit echter Server-IP.

**v3.17.46** — Fix: DKIM DNS-Eintrag syntaktisch korrekt. Public Key wurde bisher im SPKI-Format exportiert (enthält Algorithm-OID-Wrapper) — DKIM (RFC 6376) erwartet PKCS#1 (reiner RSAPublicKey). Fix: `type: 'spki'` → `type: 'pkcs1'` an allen drei Export-Stellen in `domains.ts` (dkim-record, regenerate-dkim, dns-check).

**v3.17.45** — Feature: BCP Queue-Übersicht kompakt + Verwerfen-Funktion. Stats-Karten durch kompakten horizontalen Strip ersetzt. Übersicht zeigt jetzt alle ausstehenden Nachrichten direkt als Tabelle mit „Verwerfen"- und „Jetzt wiederholen"-Schaltflächen — kein Sub-Navigationswechsel nötig. Zweiter Refresh-Button entfernt (war in jedem Unterabschnitt).

**v3.17.44** — Fix: BCP eDiscovery-Suchmaske verlor Fokus nach jedem Buchstaben. `Field`-Hilfskomponente war inline in `CreateSearchModal` definiert → neue Komponenten-Referenz pro Render → React unmount/remount des Inputs → Fokus verloren. Fix: `SearchField` auf Modul-Ebene ausgelagert, alle 8 Verwendungen aktualisiert.

**v3.17.43** — Fix: Audit-Log schreibt seit Einführung (Phase 10) keine Einträge. `auditMiddleware` ist auf `/api/v1/admin` gemountet — Express liefert `req.path` OHNE Mount-Prefix. Bedingung `req.path.startsWith('/api/v1/admin/')` war niemals wahr. Fix: Prefix-Check + `replace('/api/v1/admin/', '')` entfernt, relativer Pfad korrekt geparst.

**v3.17.42** — Feature: Zertifikate bearbeiten. Stift-Symbol (✏️) in BCP SSL/TLS Aktionsspalte öffnet `EditCertModal`: Name, Services-Zuordnung (mit Exklusivitäts-Anzeige + `currentCertId`), Auto-Renew (nur Let's Encrypt) editierbar. Read-only: Typ, Status, Domains, HTTPS-Proxy-Status, Protokoll-TLS-Status. Fix: `PUT /:id` fehlte `isActiveProtocol` im Prisma-Select.

**v3.17.41** — Fix: ACME-Prozess bricht nach 5 Min. ab (war endlos). `Promise.race()` in `runAcmeIssuance()` + Doppelstart-Guard (409 wenn PENDING/RENEWING) + Startup-Cleanup stale Certs + BCP Renew-Button deaktiviert bei PENDING.

**v3.17.40** — Fix: Exklusive Service-Zuordnung bei Zertifikaten. SMTP/IMAP/POP3 können jeweils nur einem Cert gleichzeitig zugeordnet sein. `claimServices()` in `certificates.ts` entfernt Services automatisch aus anderen Certs beim Erstellen/Aktualisieren. BCP-UI zeigt belegte Services orange mit Tooltip und Übernahme-Hinweis.

**v3.17.39** — Fix: `applyProtocolCert()` aktualisiert jetzt automatisch `server_settings.publicHostname` auf die primäre Domain des aktivierten Zertifikats. SMTP-Banner zeigte bisher immer `mail.localhost` auch wenn ein CA-Zert für `mail.example.de` aktiviert war. ACME-Zertifikate mit SMTP/IMAP/POP3 in Services werden jetzt automatisch nach der Ausstellung aktiviert.

**v3.17.38** — Auto-Self-Signed-Cert bei Setup: `POST /api/v1/setup/complete` erstellt
jetzt automatisch ein RSA-2048 Self-Signed-Cert für `publicHostname` in der `certificates`-Tabelle
→ sofort in BCP → SSL/TLS sichtbar, `isActiveProtocol: true` für SMTP/IMAP/POP3.
Spam-Filter-Toggle: `security-filter` liest `rspamdEnabled` + `clamavEnabled` aus
SecuritySettings und reagiert auf Redis-`settings:reload` (Hot-Reload ohne Container-Neustart).

**v3.17.37** — `HTTPS_PROXY_ENABLED`-Umgebungsvariable entfernt. Integrierter HTTPS-Proxy
immer aktiv — startet Port 443 nur wenn ein Cert mit `isActiveHttps=true` vorhanden ist.
`isTlsProxyEnabled()` entfernt. BCP-Banner: nur noch zwei Zustände (aktiv / kein Cert).

**v3.17.35** — Zertifikat-Logik: HTTPS-Proxy (Schloss) und Protokoll-TLS (Server-Symbol)
vollständig entkoppelt. Self-Signed-Cert ist Default (`server_settings.tlsCert=NULL`).
Löschen eines aktiven Certs → clearProtocolCert() → SMTP/IMAP/POP3 zurück auf Self-Signed.
BCP-UI: Server-Symbol immer sichtbar für ACTIVE/EXPIRING Certs, Lösch-Warnung.
Startup: `syncProtocolCertState()` ersetzt `migrateCertProtocolBinding()`.

**v3.17.34** — DNS-Check: Lokaler Server-Resolver statt externe Google/Cloudflare/Quad9.
API vereinfacht (`ok`, `found`, `warning?` pro Eintrag). BCP-UI: Resolver-Banner,
Per-Resolver-Badges, aufklappbare Detail-Ansicht und Inkonsistenz-Warnung entfernt.

**v3.17.33** — Fix: Redis-Kanal in Startup-Migration. `migrateCertProtocolBinding()` in
`api-gateway/server.ts` verwendete falsch `'coremail:settings:reload'` statt der korrekten
Konstante `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`). Ohne diesen Fix wurden
SMTP/IMAP/POP3 beim ersten Container-Start nach Upgrade von <3.17.32 nicht über das
neue CA-Cert informiert — Protokoll-Server liefen weiter mit self-signed Cert trotz
korrekter DB-Einträge.

**v3.17.32** — Fix: TLS-Cert-Logik. `activate-https` schreibt das Zertifikat jetzt
AUCH in `ServerSettings.tlsCert/tlsKey` + sendet `CHANNEL_SETTINGS_RELOAD` →
SMTP/IMAP/POP3 laden Cert sofort. Root cause von 503 5.5.1: self-signed Cert für
Mail-Protokolle, CA-Cert nur für HTTPS-Proxy. Neues `isActiveProtocol`-Feld in
`Certificate`. Neuer `POST /:id/activate-protocol`-Endpunkt. MWA+BCP-Pflicht entfernt.

**v3.17.31** — DNS-Prüfung: Echte Multi-Resolver-Verifikation. `dns.promises.Resolver.
setServers()` — befragt Google (8.8.8.8), Cloudflare (1.1.1.1), Quad9 (9.9.9.9) direkt
statt Docker-internem DNS (127.0.0.11 ist gecacht/veraltet). PTR/FCrDNS-Check neu.
SPF-Mehrfach-Record-Erkennung (RFC 7208 §3.2 — → permerror). Per-Resolver-Badges
im BCP mit Latenz + Konsistenz-Warnung + aufklappbarer Detailansicht.

**v3.17.30** — Outbound-Pipeline komplett neu: Strukturierter BullMQ-Job
(`StructuredMessage` statt base64-blob), Anhänge via MinIO (`outbound-queue/{jobId}/`),
DKIM via nodemailer Transport-Option (kein mailauth-Prepend mehr, kein Order-Bug).
`ensureRfc5322Headers()` + manuelles `signMessage()` aus relay.ts entfernt.
SMTP-Submission-Pfad (rawMessage base64) bleibt kompatibel.

**v3.17.29** — RFC 5322 Fix: Gmail 550 5.7.1 „From header is missing" + „Message-ID
header missing". Root cause: `from` als Template-Literal `"${displayName}" <email>`
→ leerer Quoted-String verletzt RFC 5322 §3.4. Fix: Nodemailer Address-Objekt
`{ name: displayName.trim(), address: email }`. `ensureRfc5322Headers()` in relay.ts
als Sicherheitsnetz (in v3.17.30 entfernt — jetzt garantiert die Pipeline die Header).

**v3.17.28** — Audit-Log-Komplettüberarbeitung: PDF-Export, Statistik-Dashboard
(KPI-Karten, Top-Akteure, Top-Aktionen — auto-refresh 30s), erweiterte Filter
(actorEmail/ipAddress/searchText), CSV-Bug fix (Token via query), Datums-Bug fix
(UTC), Purge-Route entfernt (Compliance-Immutability DSGVO/SOX/HIPAA)

**v3.17.28** — Lokale Zustellung: `expandRecipients()` aus inbound nach
`handlers/expand.ts` extrahiert; jetzt in allen Pfaden (inbound/submission/outbound-queue)
aufgerufen. `storeInboundMessage()` unterstützt jetzt auch SharedMailbox.
Verteilergruppen + Aliase werden bei lokaler Zustellung korrekt aufgelöst.

**v3.17.21** — ESMTP-Audit: CRAM-MD5, SMTPUTF8, CHUNKING aus EHLO + BCP entfernt
(waren Stub-only ohne Implementierung). Bleiben aktiv: STARTTLS, AUTH PLAIN+LOGIN,
PIPELINING, SIZE, 8BITMIME, ENHANCEDSTATUSCODES.

**v3.17.20** — DSN-Stub aus EHLO entfernt (RFC 3461 nicht implementiert).

**v3.17.19** — STARTTLS auf Port 25 bei self-signed Cert deaktiviert
(X509Certificate.issuer === subject Erkennung) — Outlook/Exchange ECONNRESET fix.

**v3.17.18** — SSE Live-Update bei neuer Mail (Posteingang) + manueller
Refresh-Button im FolderTree (MWA). SSE-Auth via `?token=` query param.

**v3.17.17** — Autodiscover-URL nutzt jetzt `autodiscover.{root-domain}` statt
identischem Hostname (Microsoft Exchange Spec).

**v3.17.16** — Fix: api-gateway `/auth/login` hatte denselben Pepper-Bug wie v3.17.13
(direkter `bcrypt.compare(password + pepper, hash)` statt `verifyPassword()` mit
sha256+pepper). Login funktionierte am Port 3003 (auth-service) aber nicht am
Port 3000 (api-gateway). Gefixt in `routes/auth.ts`, `routes/setup.ts`, `routes/user.ts`.

**v3.17.15** — Verteilergruppen-Formular (E-Mail + Domain nebeneinander wie Benutzeranlage),
JWT Token-Refresh in BCP + MWA (verhindert Auto-Logout bei aktiver Nutzung),
Verteilergruppen in MWA Empfänger-Autocomplete, BCP-Bereinigung (ResourcesPage +
OrganisationPage entfernt)

**v3.17.14** — Mailbox-Delegierung (User B kann auf Postfach von User A zugreifen via
neuem `MailboxDelegate` Prisma-Modell, Admin-API `GET/POST/DELETE /admin/mailboxes/:id/delegates`,
User-API `GET /mail/delegated-mailboxes`, BCP-UI in aufgeklappter Postfach-Zeile)

**v3.17.13** — Fix: `auth-service/local/index.ts` Pepper-Mismatch (sha256 + pepper vs
direkter Pepper-Append) — Login schlug fehl trotz korrektem Passwort

**v3.17.12** — BCP vollständig übersetzt EN/DE: MailboxesPage, DomainsPage, QueuesPage,
DashboardPage, QuarantinePage + ~1288 i18n-Keys; alle package.json Versionen auf 3.17.12
synchronisiert

## Auth-Architektur (KRITISCH — historische Fallstricke)

Passwort-Hashing nutzt **immer** `hashPassword()` und `verifyPassword()` aus
`@coremail/core`. Beide nutzen die **gleiche** Logik:
```
bcrypt(sha256(password + PEPPER))
```

❌ **NIEMALS** `bcrypt.compare(password + PEPPER, hash)` direkt — das überspringt
den sha256-Schritt und macht Hash und Verify inkompatibel.

Login-Routen die diese Funktionen verwenden (alle gleichzeitig gefixt in v3.17.13/v3.17.28):
- `packages/auth-service/src/local/index.ts` — IMAP/SMTP/POP3 + auth-service Port 3003
- `packages/api-gateway/src/routes/auth.ts` — REST API /auth/login (Port 3000)
- `packages/api-gateway/src/routes/setup.ts` — Initial-Setup
- `packages/api-gateway/src/routes/user.ts` — Passwort-Änderung
- `packages/smtp-server/src/auth/verifier.ts` — SMTP AUTH
- `packages/pop3-server/src/session.ts` — POP3 AUTH

Außerdem: **`@coremail/core` ist die Quelle der Wahrheit** — `bcrypt` nie direkt in
Routen importieren wenn User-Passwörter betroffen sind (außer für OAuth-Client-Secrets
und MFA-Backup-Codes — die brauchen keinen Pepper).

*Letzte Aktualisierung: 2026-05-27 (v5.6.1 — Verteilergruppen entfernt; v5.6.0 — OAuth2 / Modern Auth entfernt; v5.5.0 — IMAP4rev2 Compliance; v5.4.0 — MAPI komplett raus)*
