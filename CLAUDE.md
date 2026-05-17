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
**Aktuelle Version**: `2.1.41`
**GitHub**: https://github.com/MAGPEEK/CoreMail.git
**Docker Hub**: https://hub.docker.com/u/magpeek

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
| `coremail` | `magpeek/coremail-app:1.9.19` | Alle Node.js-Services + OWA/ECP-Frontends (kein nginx!) |
| `rspamd`   | `rspamd/rspamd:4.0.0`        | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy, URL) |
| `clamav`   | `clamav/clamav:stable`       | Open-Source Antivirus Engine (GPL), freshclam Updates |
| `postgres` | `postgres:16-alpine` | Standard-Image |
| `redis` | `redis:7-alpine` | Standard-Image |
| `minio` | `minio/minio` | Standard-Image |

**1 Custom Docker Hub Image**: `magpeek/coremail-app` — nur dieses Image wird gebaut/gepusht.

**HTTP-Routing ohne nginx**: Der `api-gateway` auf Port 3000 übernimmt alle HTTP-Routen:
- `/owa/` `/bcp/` — Express.static (Frontend-Bundles aus `/app/www/`)
- `/auth/` → proxy zu auth-service (localhost:3003)
- `/EWS/` `/mapi/` `/Autodiscover/` → proxy zu ews-server (localhost:8080)
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
| `Task` | `subject`, `body`, `reminder` | ~~`title`~~, ~~`notes`~~, ~~`reminderAt`~~ |
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
- `DistributionGroup` / `DistributionGroupMember` — Verteilergruppen (statisch + dynamisch)
- `ResourceMailbox` / `ResourceCalendar` / `ResourceBooking` — Raum-/Ressourcenpostfächer
- `PublicFolder` / `PublicFolderMessage` — Öffentliche Ordner mit ACL

**Phase-8-Modelle**:
- `EDiscoverySearch` — Cross-Mailbox-Suche (JSON-Query, Status, resultCount, exportPath)
- `LegalHold` — Aufbewahrungssperre (mailboxIds[], active, appliedBy/releasedAt)

**Phase-9-Modelle**:
- `SmimeSettings` — Pro-User: autoSign, autoEncrypt, verifyIncoming, decryptIncoming
- `JournalingRule` — Journaling-Regeln (scope, recipientType, journalAddress, wrapAsReport)
- `RetentionPolicy` — Aufbewahrungsrichtlinien (retentionDays, action, scope, respectLegalHold)
- `RetentionPolicyAssignment` — Zuweisung von Policies zu GLOBAL / DOMAIN / USER
- `Message.smimeMeta` — neues optionales String-Feld (JSON) für S/MIME-Signatur-/Verschlüsselungsmetadaten
- `TransportRule` — Transportregeln (conditions/actions als JSON, priority, enabled)

**Phase-10-Modelle**:
- `AuditLog` — Admin-Aktionen (actorId, actorEmail, action, targetType, targetId, targetName, ipAddress, userAgent, changes, success, errorMsg)
- `PushSubscription` — VAPID Web Push Subscriptions (userId, endpoint, p256dhKey, authKey, topics[], userAgent)
- `OAuthClient` — OAuth2-Clients (clientId, clientSecret bcrypt, redirectUris, allowedScopes, trusted)
- `OAuthAuthorizationCode` — Authorization Codes (PKCE S256, expiresAt, used)
- `OAuthToken` — Access + Refresh Tokens (accessToken, refreshToken, revoked, expiresAt, refreshExpiresAt)
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
/public-folders/          publicFoldersRouter      Öffentliche Ordner (User)
/admin/mailboxes/         adminMailboxesRouter
/admin/domains/           adminDomainsRouter
/admin/queues/            adminQueuesRouter
/admin/logs/              adminLogsRouter
/admin/groups/            adminGroupsRouter         Verteilergruppen
/admin/resources/         adminResourcesRouter      Raum-/Ressourcenpostfächer
/admin/public-folders/    adminPublicFoldersRouter  Öffentliche Ordner (Admin)
/admin/ediscovery/        adminEDiscoveryRouter     eDiscovery & Legal Hold
/admin/ems/               adminEmsRouter            EMS REST-Bridge (20+ Cmdlets)
/admin/compliance/journaling/ adminJournalingRouter Journaling-Regeln
/admin/compliance/retention/  adminRetentionRouter  Aufbewahrungsrichtlinien
/push/                    pushRouter                VAPID Web Push
/admin/audit-log/         adminAuditLogRouter       Audit-Log
/admin/oauth/             adminOAuthClientsRouter   OAuth2-Clients
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

**MAPI over HTTP** (ews-server):
```
GET  /mapi/healthcheck.htm   → "MAPI" (Outlook Connectivity-Probe)
POST /mapi/emsmdb/           → Connect / Execute (EWS-Fallback) / Disconnect / NotificationWait
POST /mapi/nspi/             → Bind / QueryRows (GAL) / ResolveNames / Unbind
```

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
- **Log-Level**: pro Service via ECP konfigurierbar (error | warn | info | debug)
- Grafana/Prometheus/Tempo/Loki/Alertmanager wurden in v2.1.19 aus dem Stack entfernt

---

*Letzte Aktualisierung: 2026-05-17 (v2.1.41 — SMTP-Banner live-konfigurierbar, Outgoing Delivery MX/Smarthost, TLS Auto-Generierung)
