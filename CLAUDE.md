# CLAUDE.md — CoreMail Project Memory

This file is read automatically by Claude Code at the start of every conversation.
It contains all the important context information about the CoreMail project.

---

## Project Overview

**CoreMail** is a complete open-source alternative to Coremail, developed in this directory:
```
/Users/stefan/Library/CloudStorage/SynologyDrive-Data/Mailserver/coremail/
```

**Goal**: Coremail mail server for 10–500 users (SMB)
**Current version**: `5.9.0` (admin CLI `coremail` + new docker-compose + EWS coupled to the MAPI switch; v5.7.1 JMAP server RFC 8620/8621 + extensions; v5.7.0 MAPI over HTTP optionally back, default off + build hardening; distribution groups removed v5.6.1 + OAuth2 server removed v5.6.0 + IMAP4rev2 v5.5.0)
**GitHub**: https://github.com/MAGPEEK/CoreMail.git
**Docker Hub**: https://hub.docker.com/u/magpeek

## Architecture Decisions (v5.4.0+)

- **Admin CLI (v5.8.0)**: package `packages/cli/` (commander 12), binary `coremail` in the app image (`/usr/local/bin/coremail` → `packages/cli/dist/index.js`). Talks exclusively to the REST admin API (`/api/v1/admin/*`, `/auth/login`, `/auth/mfa/verify`, `/auth/refresh`) — no direct Prisma access, so that roles + audit log apply. Session in `~/.config/coremail/credentials.json` (0600) or `COREMAIL_TOKEN`/`COREMAIL_ADMIN_EMAIL`+`_PASSWORD`(+`_TOTP`). Command groups: `user`, `mailbox`, `shared`, `domain`, `connector` (listeners via `/admin/services/listeners/<slug>`, JMAP/MAPI via `/admin/servers/settings`), `smtp banner` (`/admin/smtp-config/settings`), `cert` (`/admin/certificates`). The shared-mailbox list returns `{items,total}`; the mailbox list returns an array. Docs `docs/cli.md`. Tests: `node --import tsx --test src/output.test.ts`.
- **EWS coupled to the MAPI switch (v5.8.0)**: `/EWS/*` + `/OAB/*` in the ews-server sit behind `requireMapiEnabled` (same flag `ServerSettings.mapiHttpEnabled`), Autodiscover v2 `Protocol=EWS` → 404 when off. EWS is no longer a standalone client path, only the companion protocol of MAPI/HTTP. BCP card "MAPI over HTTP + EWS".
- **docker-compose (v5.8.0)**: `infra/docker/docker-compose.yml` reduced to mandatory parameters with `${VAR:?message}` checks; internal service URLs/ports are no longer set (code defaults, exception `SECURITY_FILTER_URL=http://localhost:3002`, because one default points to `security-filter:3002`). `scripts/setup.sh` generates `.env` + symlink `infra/docker/.env`.

- **MAPI/HTTP optional (v5.7.0, had been removed in v5.4.0)**: code from v5.2 restored in `packages/ews-server/src/mapi/`, behind `ServerSettings.mapiHttpEnabled` (default **false**). Switch: BCP → Server → "MAPI over HTTP". Gate `requireMapiEnabled` (`mapi/feature-flag.ts`, 60s cache + Redis `CHANNEL_SETTINGS_RELOAD`) → `/mapi/*` 404 when off; Autodiscover returns the `mapiHttp` block only when on. **Limitation**: Outlook 2024 LTSC / M365 Classic enforce Modern Auth against Entra/ADFS → use IMAP there ("Other email accounts"); MAPI works for Outlook 2013–2021 (Basic Auth). ADFS emulation (v5.3.0) stays removed. New Outlook + Outlook for Mac: no MAPI.
- **JMAP server (v5.7.1)**: new package `packages/jmap-server/` (port 3006), api-gateway proxies `/jmap/*` + `/.well-known/jmap` (incl. WebSocket upgrade `/jmap/ws` on the HTTP server and the TLS proxy). RFC 8620 Core (Session, dispatcher with result references, Blobs, EventSource, PushSubscription), 8621 Mail (Mailbox/Email/Thread/Identity/EmailSubmission/SearchSnippet/VacationResponse), 8887 WebSocket, 9404 Blob, 9425 Quota, 9670 Principals, 9749 VAPID. Switch `ServerSettings.jmapEnabled` (default **true**), BCP → Server → "JMAP". Auth: Bearer JWT or Basic (app password with MFA). Accounts: `userId` (own), `shared-<id>` (Shared Mailbox), delegated mailboxes. `Message.threadId` lazily derived from `inReplyTo`. States: Email `<maxModSeq>.<highestModSeq>.<maxCreatedMs>.<count>`, Mailbox `<count>.<maxCreatedMs>.<hash>` — deletes without tombstones → `cannotCalculateChanges`. EmailSubmission in Redis (`jmap:sub:*`, 7d), sending via BullMQ `smtp-outbound` with `rawMessage`. Blob IDs: `m-<msgId>`, `a-<attId>`, `p-<msgId>-text|html`, `u-<hex>` (upload, MinIO `jmap-upload/`, 7d). Docs: `docs/jmap.md`.
- **Build hardening (v5.7.0)**: pnpm pinned (`packageManager: pnpm@11.28.9`, Dockerfile `pnpm@11`) — corepack `pnpm@latest` pulled pnpm 12 and broke the build. Frontend tsconfigs `noEmit: true`; no more `.js` files checked in next to `.tsx`.
- **OAuth2 server completely removed (v5.6.0)**: lived under `/oauth2/*` (authorization server for external apps). Since XOAUTH2 SASL has no mainstream client UI support (Apple Mail / Outlook LTSC / eM Client offer no UI for custom OAuth servers), the server had no real use case in practice. JWT back to **HS256** (`JWT_SECRET`). MWA + BCP use session JWTs via `/auth/login`, mail clients use app passwords.
- **Distribution groups completely removed (v5.6.1)**: DistributionGroups + DistributionGroupMember models deleted. Use case better served via Shared Mailboxes (team mailbox) or an external listserv (Mailman, listmonk). Reduces code complexity + one less BCP page to maintain.
- **IMAP4rev2** (RFC 9051) compliance: STARTTLS, AUTHENTICATE SASL (PLAIN+LOGIN), UNSELECT, ID, MOVE, UIDPLUS, STATUS=SIZE.
- **SSO via external IdPs** (auth-sso package, Azure AD/Keycloak/Authentik) **is retained** — this is OIDC client functionality (CoreMail logs users in through an external IdP), NOT to be confused with the removed OAuth2 authorization server.
- **English-only repository (v5.9.0)**: README.md, CHANGELOG.md, CLAUDE.md, docs/, code comments and infra comments are English; README.de.md keeps the German README. New comments and docs are written in English.

---

## Technology Stack

| Area | Technology |
|---------|------------|
| Frontend | React 19, Vite, TailwindCSS, shadcn/ui, TanStack Query v5, Zustand, Tiptap, FullCalendar |
| Backend | Node.js 22, TypeScript 5.5, ESM (`"type":"module"`), Express 4 |
| ORM | Prisma 5 (PostgreSQL) |
| Database | PostgreSQL 16, Redis 7, MinIO |
| Monorepo | pnpm Workspaces (pnpm@11) |
| Deployment | Docker Compose (dev/prod) + Kubernetes Helm Chart |
| CI/CD | GitHub Actions → Docker Hub Multi-Arch (amd64 + arm64) |

---

## Monorepo Structure

```
coremail/
├── packages/
│   ├── core/              # Logger, JWT, Redis client, auth helpers
│   ├── storage/           # Prisma schema + client, MinIO abstraction layer
│   ├── smtp-server/       # SMTP inbound/outbound (ports 25, 465, 587)
│   ├── imap-server/       # IMAP4rev1 + IDLE + CONDSTORE (ports 143, 993)
│   ├── pop3-server/       # POP3 (ports 110, 995)
│   ├── ews-server/        # Web Services EWS SOAP/XML (port 8080)
│   ├── autodiscover/      # Autodiscover v1 + v2 (port 8081)
│   ├── caldav-server/     # CalDAV + CardDAV (port 8082)
│   ├── jmap-server/       # JMAP RFC 8620/8621 + 8887/9404/9425/9670/9749 (port 3006)
│   ├── cli/               # Admin CLI `coremail` (REST admin API, in the image at /usr/local/bin/coremail)
│   ├── api-gateway/       # REST API + SSE (port 3000)
│   ├── auth-service/      # Local/LDAP/OIDC/MFA (port 3003)
│   ├── auth-ldap/         # LDAP connector (internal)
│   ├── auth-sso/          # OIDC/OAuth2/SAML (internal)
│   ├── backup-service/    # MBOX/EML/S3 backup (port 3004)
│   ├── security-filter/   # SPF/DKIM/DMARC/ClamAV/rspamd (port 3002)
│   ├── activesync/        # ActiveSync EAS 14.1 (port 3005)
│   ├── web-client/        # React OWA webmail (port 80)
│   └── admin-panel/       # React ECP admin panel (port 80)
├── infra/
│   ├── docker/            # docker-compose.yml, docker-compose.synology.yml, nginx/, postgres/, rspamd/
│   └── k8s/               # Helm Chart (Chart.yaml, values.yaml, templates/)
├── scripts/               # setup.sh, gen-dev-certs.sh, docker-push.sh
├── .github/workflows/     # docker-publish.yml (CI/CD)
├── CHANGELOG.md           # Keep a Changelog format
├── CLAUDE.md              # This file
└── .env.example
```

---

## Services & Docker Images (2-container architecture since v0.9.1)

Since v0.9.1 CoreMail uses a consolidated **2-container architecture**:

| Container | Docker Image | Contents |
|-----------|-------------|--------|
| `coremail` | `magpeek/coremail-app:3.17.39` | All Node.js services + MWA/BCP frontends (no nginx!) |
| `rspamd`   | `rspamd/rspamd:4.0.0`        | Anti-spam engine (Bayes, DKIM/SPF/DMARC, Fuzzy, URL) |
| `clamav`   | `clamav/clamav:stable`       | Open-source antivirus engine (GPL), freshclam updates |
| `postgres` | `postgres:16-alpine` | Standard image |
| `redis` | `redis:7-alpine` | Standard image |
| `minio` | `minio/minio` | Standard image |

**1 custom Docker Hub image**: `magpeek/coremail-app` — only this image is built/pushed.

**HTTP routing without nginx**: The `api-gateway` on port 3000 handles all HTTP routes:
- `/owa/` `/bcp/` — Express.static (frontend bundles from `/app/www/`)
- `/auth/` → proxy to auth-service (localhost:3003)
- `/EWS/` `/mapi/` `/OAB/` → proxy to ews-server (localhost:8080) — optional since v5.7.0/v5.8.0 (404 when "MAPI over HTTP + EWS" is off)
- `/Microsoft-Server-ActiveSync` → proxy to activesync (localhost:3005)
- `/dav/` → proxy to caldav-server (localhost:8082)
- `/jmap/` `/.well-known/jmap` → proxy to jmap-server (localhost:3006), WebSocket `/jmap/ws` — since v5.7.1
- `/api/v1/` `/PowerShell/` → direct handlers

**TLS**: External (Traefik, Caddy, DSM Application Portal) — no TLS inside the CoreMail stack.

**Internal ports in the app container** (localhost, managed by supervisord):

| Service | Port |
|---------|------|
| nginx | 80 / 443 |
| api-gateway | 3000 |
| storage-api | 3001 |
| security-filter | 3002 |
| auth-service | 3003 |
| backup-service | 3004 |
| activesync | 3005 |
| jmap-server | 3006 |
| ews-server | 8080 |
| autodiscover | 8081 |
| caldav-server | 8082 |
| smtp-server | 25 / 465 / 587 |
| imap-server | 143 / 993 |
| pop3-server | 110 / 995 |

**Docker Hub**: `magpeek/coremail-app` + `magpeek/coremail-db`
- Push manually: `bash scripts/docker-push.sh [VERSION]`
- Start: `docker compose -f infra/docker/docker-compose.yml up -d`

**New Dockerfiles:**
- `infra/docker/Dockerfile.app` — monolithic app container
- `infra/docker/Dockerfile.db` — database container
- `infra/docker/supervisord-app.conf` — supervisord for the app
- `infra/docker/supervisord-db.conf` — supervisord for the DB
- `infra/docker/nginx/nginx.app.conf` — nginx for the app container
- `infra/docker/entrypoint-db.sh` — entrypoint for the DB container

---

## Implementation Status (Phases)

| Phase | Status | Contents |
|-------|--------|--------|
| Phase 1 | ✅ Done | Foundation: Core, Storage, Prisma, Docker |
| Phase 2 | ✅ Done | SMTP + IMAP + POP3 + Security Filter |
| Phase 3 | ✅ Done | EWS + Autodiscover + Auth (LDAP/OIDC/MFA) |
| Phase 4 | ✅ Done | CalDAV/CardDAV + REST API + React OWA + React ECP |
| Infra | ✅ Done | Minimal stack: 1 custom image (coremail-app), standard DB images, no nginx/proxy |

---

## TypeScript Rules (CRITICAL)

The project uses `"exactOptionalPropertyTypes": true`. This has common pitfalls:

### Optional fields in Prisma updates
```typescript
// ❌ WRONG — exactOptionalPropertyTypes throws an error
prisma.task.update({ data: { dueDate: dueDate ? new Date(dueDate) : undefined } });

// ✅ CORRECT — conditional spread
prisma.task.update({ data: { ...(dueDate ? { dueDate: new Date(dueDate) } : {}) } });
```

### ESM imports
All imports must have the `.js` extension (even if the file is `.ts`):
```typescript
import { foo } from './utils.js'; // ✅
import { foo } from './utils';    // ❌
```

---

## Prisma Schema (important field names)

The Prisma schema file is the single source of truth:
`packages/storage/prisma/schema.prisma`

Common pitfalls (historical mistakes):

| Model | Correct field | Wrong field (outdated) |
|-------|---------------|--------------------------|
| `AppPassword` | `lastUsedAt` | ~~`lastUsed`~~ |
| `Session` | `tokenHash` | ~~`token`~~ |
| `User` | `mailbox` (1:1) | ~~`mailboxes`~~ |
| `Note` | `subject` | ~~`title`~~ |
| `Task` | `subject`, `body`, `reminder`, `reminderByMail` | ~~`title`~~, ~~`notes`~~, ~~`reminderAt`~~ |
| `LdapConfig` | `lastSyncAt` | ~~`lastSync`~~ |
| `Folder` | `displayName` (required!) | — |
| `CalendarEvent` | `uid` (required!) | — |
| `UserRole` | no `ADMIN` value | ~~`ADMIN`~~ |

**After schema changes always** run `prisma generate`:
```bash
pnpm --filter @coremail/storage exec prisma generate
```

**Phase 6 models**:
- `ActiveSyncDevice` — device registration, SyncKeys, PolicyKey
- `UserCertificate` — S/MIME certificates (fingerprint, MinIO path)

**Phase 7 models**:
- ~~`DistributionGroup` / `DistributionGroupMember`~~ — completely removed in v5.6.1
- `ResourceMailbox` / `ResourceCalendar` / `ResourceBooking` — room/resource mailboxes
- ~~`PublicFolder` / `PublicFolderMessage`~~ — completely removed in v3.18.31

**Phase 8 models**:
- ~~`EDiscoverySearch`~~ — completely removed in v3.18.5
- ~~`LegalHold`~~ — completely removed in v3.18.5

**Phase 9 models**:
- `SmimeSettings` — per user: autoSign, autoEncrypt, verifyIncoming, decryptIncoming
- `JournalingRule` — journaling rules (scope, recipientType, journalAddress, wrapAsReport)
- `RetentionPolicy` — retention policies (retentionDays, action, scope)
- `RetentionPolicyAssignment` — assignment of policies to GLOBAL / DOMAIN / USER
- `Message.smimeMeta` — new optional string field (JSON) for S/MIME signature/encryption metadata
- `TransportRule` — transport rules (conditions/actions as JSON, priority, enabled)

**Phase 10 models**:
- `AuditLog` — admin actions (actorId, actorEmail, action, targetType, targetId, targetName, ipAddress, userAgent, changes, success, errorMsg)
- `PushSubscription` — VAPID Web Push subscriptions (userId, endpoint, p256dhKey, authKey, topics[], userAgent)
- ~~`OAuthClient` / `OAuthAuthorizationCode` / `OAuthToken` / `OAuthConsent`~~ — completely removed in v5.6.0 (OAuth2 server removed)
- `GatewaySettings` — SMTP gateway configuration (singleton id="singleton": enabled, upstreamHost/Port/Tls, relayDomains[], filterBeforeRelay)

---

## Dockerfile Patterns

### Monolithic app container (`infra/docker/Dockerfile.app`)

Three stages: `builder` (all Node.js packages), `frontend-builder` (React bundles), `runner` (Alpine + nginx + supervisord).
- `supervisord-app.conf` manages all processes in the container
- nginx config: `infra/docker/nginx/nginx.app.conf` (all upstreams on localhost)
- Frontends as static files in `/app/www/owa` and `/app/www/bcp`

### Single-service Dockerfile (standard for development)

All Dockerfiles follow the same multi-stage pattern. Example from `ews-server`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/core/package.json ./packages/core/
COPY packages/storage/package.json ./packages/storage/
COPY packages/<service>/package.json ./packages/<service>/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./          # IMPORTANT: must be copied!
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

**Common mistakes:**
- Forgetting `COPY tsconfig.base.json ./` → TypeScript errors during build
- `prisma generate` is needed in the builder AND in the runner
- `pnpm@latest` via corepack (not `npm install -g pnpm@9`)

---

## Redis Pattern (ioredis)

```typescript
// ❌ WRONG — the callback receives (err, count), NOT the message
subscriber.subscribe(CHANNEL, (message) => { ... });

// ✅ CORRECT
void subscriber.subscribe(CHANNEL_NAME);
subscriber.on('message', (_channel, message) => {
  const event = JSON.parse(message) as MyType;
  // ...
});
```

---

## API Structure (REST)

All endpoints behind nginx on port 443:

| Path | Service | Description |
|------|---------|-------------|
| `/owa/` | web-client | Outlook Web Access |
| `/bcp/` | admin-panel | Coremail admin panel (ECP) |
| `/EWS/Exchange.asmx` | ews-server | EWS Web Services (SOAP) |
| `/Autodiscover/` | autodiscover | Autodiscover v1 |
| `/autodiscover/` | autodiscover | Autodiscover v2 |
| `/Microsoft-Server-ActiveSync` | activesync | EAS 14.1 |
| `/api/v1/` | api-gateway | REST API |
| `/auth/` | auth-service | Authentication |

**api-gateway REST routes** (`/api/v1/`):
```
/mail/                    mailRouter
/calendar/                calendarRouter
/contacts/                contactsRouter
/tasks/                   tasksRouter
/notes/                   notesRouter
/user/                    userRouter
/smime/                   smimeRouter              S/MIME + device management
# /public-folders/ → completely removed in v3.18.31
/admin/mailboxes/         adminMailboxesRouter
/admin/domains/           adminDomainsRouter
/admin/queues/            adminQueuesRouter
/admin/logs/              adminLogsRouter
# /admin/groups/ → completely removed in v5.6.1 (distribution groups removed)
/admin/resources/         adminResourcesRouter      Room/resource mailboxes
# /admin/public-folders/ → completely removed in v3.18.31
# /admin/ediscovery/ → completely removed in v3.18.5
/admin/ems/               adminEmsRouter            EMS REST bridge (14+ cmdlets)
/admin/compliance/journaling/ adminJournalingRouter Journaling rules
/admin/compliance/retention/  adminRetentionRouter  Retention policies
/push/                    pushRouter                VAPID Web Push
/admin/audit-log/         adminAuditLogRouter       Audit log
# /admin/oauth/ → completely removed in v5.6.0 (OAuth2 server removed)
/admin/gateway/           adminGatewayRouter        SMTP gateway mode
/changelog                inline (server.ts)        Changelog API
/events                   SSE live events
```

**PowerShell Remoting** (Management Shell):
```
GET  /PowerShell/  → WSDL
POST /PowerShell/  → WSMan-Identify (answers) + cmdlet routing to the EMS REST bridge
                     (recognized cmdlets → JSON response inside the SOAP envelope)
                     (unknown cmdlets → SOAP fault with the list of supported cmdlets)
```

**MAPI over HTTP**: optional since v5.7.0, default off (see Architecture Decisions above).

---

## Authentication

```
Local DB (bcrypt) → LDAP/Active Directory (ldapts) → SSO/OIDC (openid-client)
                            ↓
                    MFA (TOTP / WebAuthn / backup codes)
                            ↓
                    JWT access token + refresh token
```

**App passwords**: For IMAP/POP3/SMTP/EAS (no MFA possible)
- Table `AppPassword`, field `hash` (bcrypt), `lastUsedAt`
- Users generate them in OWA → Settings → Security

**UserRole enum** (no ADMIN!):
```
USER, HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT,
HYGIENE_MANAGEMENT, SERVER_MANAGEMENT, VIEW_ONLY_ORG, ORGANIZATION_MANAGEMENT
```

---

## ActiveSync (EAS 14.1)

**Package**: `packages/activesync/` — port 3005
**Docker image**: `magpeek/coremail-activesync:0.7.0`

### WBXML codec
`src/wbxml.ts` — implements the EAS code pages:
- 0: AirSync (Sync, SyncKey, Collection, Status ...)
- 2: Email (Subject, From, To, Body, Read ...)
- 7: FolderHierarchy (FolderSync, ServerId, DisplayName, Type ...)
- 14: Provision (PolicyKey, EASProvisionDoc ...)
- 17: Ping (HeartbeatInterval, Folders ...)
- 25: ComposeMail (SendMail, Mime ...)

### EAS commands
| Command | File | Description |
|--------|-------|-------------|
| `Provision` | `commands/provision.ts` | Device registration + policy |
| `FolderSync` | `commands/folder-sync.ts` | Folder hierarchy |
| `Sync` | `commands/sync.ts` | Email delta sync |
| `SendMail` | `commands/send-mail.ts` | Outgoing mail |
| `SmartReply/Forward` | `commands/send-mail.ts` | Reply/forward |
| `Ping` | `commands/ping.ts` | Long poll (up to 59 min) |

### Ping long poll
nginx must have `proxy_read_timeout 600s` for `/Microsoft-Server-ActiveSync` (already configured).

---

## S/MIME

**Router**: `packages/api-gateway/src/routes/smime.ts`
**Route prefix**: `/api/v1/smime/`

| Endpoint | Method | Description |
|----------|---------|-------------|
| `/certificates` | GET | List all of the user's own certificates |
| `/certificates` | POST | Import a new certificate |
| `/certificates/:id` | PUT | Change label/default flags |
| `/certificates/:id` | DELETE | Delete certificate |
| `/public-key/:email` | GET | Fetch a contact's public key |
| `/devices` | GET | The user's ActiveSync devices |
| `/devices/:id` | DELETE | Deregister a device |

---

## Changelog Format

The changelog (`CHANGELOG.md`) must follow the **Keep a Changelog** format:
- Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
- Version scheme: Semantic Versioning (PATCH/MINOR/MAJOR)
- Next version: `## [Unreleased]` section

---

## Frequently Used Commands

```bash
# TypeScript check (all packages)
pnpm -r exec tsc --noEmit

# Generate Prisma client
pnpm --filter @coremail/storage exec prisma generate

# Build + push the app container
docker build -f infra/docker/Dockerfile.app -t magpeek/coremail-app:1.3.4 .
docker push magpeek/coremail-app:1.3.4

# Build + push the DB container
docker build -f infra/docker/Dockerfile.db -t magpeek/coremail-db:0.11.0 .
docker push magpeek/coremail-db:0.11.0

# Build + push both images (script)
bash scripts/docker-push.sh 0.11.0

# GitHub push with PAT
PAT="..." git -c url."https://x-access-token:${PAT}@github.com/".insteadOf="https://github.com/" push

# Create a GitHub release
GITHUB_TOKEN=$PAT gh release create v0.7.0 --title "..." --notes "..." --repo MAGPEEK/CoreMail

# Close an issue
GITHUB_TOKEN=$PAT gh issue close <nr> --comment "..." --repo MAGPEEK/CoreMail
```

---

## Infrastructure Configuration

### Docker Compose
- `docker-compose.yml` — standard stack (6 containers: coremail, rspamd, clamav, postgres, redis, minio)
- `docker-compose.synology.yml` — Synology NAS (port 8080, /volume1 paths, rspamd + clamav included)

### nginx (infra/docker/nginx/nginx.conf)
All paths are Coremail-compatible. ActiveSync needs a 600s timeout (Ping command).

### Kubernetes (infra/k8s/)
- CloudNativePG operator (3 PostgreSQL instances, automatic failover)
- HPA + PDB for all services (min 2, max 10 pods)
- Redis Cluster (6 nodes: 3 masters + 3 replicas)
- MinIO Distributed (4 nodes, erasure coding)
- cert-manager + External Secrets Operator

---

## Security Pipeline (inbound mail)

```
SMTP connection
  → Greylisting (Redis, IP+sender+recipient triple)
  → DNSBL (Spamhaus ZEN, SpamCop — in parallel with 2s timeout)
  → Country filtering (MaxMind GeoLite2)
  → IP blacklist
  → SPF / DKIM / DMARC / ARC (mailauth)
  → Email blacklist (global/domain/user)
  → ClamAV (clamd TCP 3310)
  → rspamd (HTTP API, score → Inbox/Junk/Reject)
  → Attachment filter (MIME types, double extensions)
```

---

## Logging

- **Logs**: pino (structured JSON) across all services
- **Log level**: configurable per service via BCP (error | warn | info | debug)
- Grafana/Prometheus/Tempo/Loki/Alertmanager were removed from the stack in v2.1.19

---

## Current Architecture Highlights (3.17.x)

- **MWA** (Mail Web Access) at the root URL `/` since v3.5.5 — previously `/owa/` (redirect remains)
- **BCP** (Backend Control Panel) at `/bcp/` since v3.2.3 — previously `/ecp/`
- **Journaling feature completely removed** in v3.13.6 (was Phase 9 / RFC 3462) — DB tables `journaling_*` dropped, routes 404
- **Retention policies** Exchange-2019-compliant with DPT/RPT/personal tags + Managed Folder Assistant (background worker, 24h work cycle) + Recoverable Items non-IPM subtree
- **Shared Mailboxes** have the same default folder structure as user mailboxes (auto-provisioned, INBOX/Drafts/Sent/Trash/Junk/Archive/Notes/Tasks) — folder CRUD in the MWA for users with FULL_ACCESS
- **Email aliases** since v3.13.5 per user mailbox + Shared Mailbox; SMTP inbound resolves aliases to the target primary address before they are written to the mailbox
- **Templates for compliance**: 8 retention templates (Trash 30d, Junk 14d, …) + 9 transport-rule templates ([EXTERNAL], CEO phishing, PCI-DSS detection, …)
- **OAuth2 server** complete (Authorization Code, Refresh, Client Credentials, Password Grant, OIDC, PKCE)
- **Dashboard** with server info (uptime, RAM, CPU, V8 heap limit) + configurable widgets (drag-reorder directly on cards, persisted in localStorage)
- **BCP dashboard** all widgets wrapped in DraggableCard (v3.16.0) — queue-status, mails-chart, storage-ranking, domains-chart, recent-errors, recent-audit, recent-logins, system-strip movable by drag
- **MWA Tasks** (v3.16.x):
  - Double-click opens the full edit modal
  - Tasks with a due date → automatic calendar event (amber in FullCalendar)
  - Reminder (date + time) → calendar event `🔔 Reminder: …` + popup notification at the set time
  - Checkbox **"by email"** — additionally sends a mail to the user's own inbox when triggered (`POST /mail/send`)
  - Popup tracking via `localStorage` (key = `taskId:reminderISO`) — fires exactly once per timestamp, even after page reload
  - Prisma field `reminderByMail Boolean @default(false)` in the `tasks` table
- **MWA Compose — recipient autocomplete** (v3.16.6): `RecipientInput` component replaces `<input>` in To/CC/BCC; debounced `GET /contacts?q=` from 1 character; dropdown with name+mail+company; keyboard nav ↑↓/Enter/Tab/Escape; multiple recipients via comma
- **MWA Mail — resizable panels** (v3.16.6): drag handle between folder tree ↔ list ↔ reading pane; widths in `localStorage:coremail:panel-widths`; FolderTree/MessageList use `w-full` instead of px widths
- **Settings → View** (v3.16.6): reading pane (right/bottom/off), density (compact/normal/comfortable), conversations toggle — all persistent via `useUiPrefs` (Zustand + localStorage)
- **MWA Contacts**: extended fields (email2, mobile, department, jobTitle, notes) — Outlook-compatible (v3.16.0)
- **MWA email search**: scope switch (folder / entire mailbox) + typeahead suggestions while typing (v3.16.0)
- **Tiptap fonts**: font selection (Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS) in the compose window — `@tiptap/extension-font-family@^2.27.2` (v3.16.0)
- **DNS hardening** (v3.15.0): trusted resolvers (8.8.8.8 / 1.1.1.1 / 9.9.9.9), cross-validation, startup integrity check — `initDnsHardening()` in security-filter
- **Live server**: `84.247.191.198` (Contabo VPS, Ubuntu 24.04, 4 cores, 7.8 GB RAM) — runs v3.18.29; deploy: `cd /opt/coremail && docker compose pull coremail && docker compose up -d coremail`
- **Integrated HTTPS proxy** (v3.17.0): `packages/api-gateway/src/tls-proxy.ts` — Node.js HTTPS server on port 443, hot reload via Redis channel `coremail:tls:reload`; activation in BCP → SSL/TLS → lock icon; `Certificate.isActiveHttps` Prisma field; port `443:443` in docker-compose
- **SSH**: `ssh root@84.247.191.198` (key-based login; password removed from repo — rotate it)

## Important Technical Decisions since 3.x

- **`getAppVersion()`** reads the `COREMAIL_VERSION` env BEFORE falling back to the root `package.json` — runtime override possible without an image rebuild
- **DraggableCard pattern**: NEVER define React components inline inside other components (reconciliation by reference equality → re-mount killer)
- **`prisma db push --accept-data-loss`** in `entrypoint-app.sh` — schema migrations at container start, including destructive ones (e.g. the journaling drop)
- **Settings caches** (60s TTL, greylisting + outbound relay) are invalidated via Redis `CHANNEL_SETTINGS_RELOAD` after every settings save
- **Reminder popup tracking**: `localStorage` key `coremail:notified-reminders` (JSON array of `taskId:reminderISO` strings) — prevents duplicate popups across page reloads; `useCallback` + `useRef` instead of a direct closure in `setInterval` (no stale-closure bug)
- **checkDueDates pattern**: stable callback reference via `useCallback(fn, [])` + `allTasksRef` for always-current data in the 30-second interval — no more `eslint-disable react-hooks/exhaustive-deps` needed
- **Resizable panels**: `ResizeHandle` component at module level (not inline!) — `mousemove`/`mouseup` on `window`, `cursor: col-resize` + `userSelect: none` on `document.body` during drag; FolderTree/MessageList use `w-full` and the width comes from the parent div via `style.width`
- **RecipientInput autocomplete**: `useCallback` needed for `pickSuggestion` (closure over `value`); `onMouseDown` + `e.preventDefault()` in dropdown buttons prevents the input losing focus on click

---

- **BullMQ queue names**: No `:` allowed (BullMQ v5) — the queue is called `'smtp-outbound'` (with a hyphen), NOT `'smtp:outbound'`. Producer (api-gateway/routes/mail.ts) and consumer (smtp-server/outbound/queue.ts) must use identical names.

## Current Version 5.6.1 — Highlights (stack slim-down)

**v5.6.1** — Distribution groups (DistributionGroups) completely removed. User decision: "Remove distribution groups too". Rarely used in practice — modern teams use Shared Mailboxes (`/admin/shared-mailboxes/`) with aliases for team mailboxes, or external listserv tools (Mailman, listmonk) for pure outbound distribution lists. Reduces code complexity and one maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery), v3.18.31 (Public Folders), v3.18.33 (ExternalMailContacts), v5.4.0 (MAPI), v5.6.0 (OAuth2). **Schema (DESTRUCTIVE — tables are dropped via `prisma db push --accept-data-loss` at container start)**: `DistributionGroup` + `DistributionGroupMember` models deleted, enum `GroupType { STATIC, DYNAMIC }` removed, `Domain.distributionGroups` relation removed. **Frontend (BCP)**: `/groups/` page (`GroupsPage.tsx`) deleted, sidebar entry + Users icon import removed, route + i18n keys (`nav_groups` DE+EN) removed, `OrganisationPage` GAL section without the "Distribution groups" column, `SmtpConfigPage` local-delivery hint without "distribution groups are expanded". **Backend (api-gateway)**: `routes/admin/groups.ts` deleted, mount `/api/v1/admin/groups` removed, EMS REST bridge (`routes/admin/ems.ts`) — all 7 DistributionGroup endpoints + `formatGroup()` helper removed (~150 LOC), 7 cmdlet routes (Get-/New-/Set-/Remove-DistributionGroup + *DistributionGroupMember) removed, PowerShell Remoting (`routes/powershell.ts`) — 6 cmdlets removed from SUPPORTED_CMDLETS, GAL endpoint (`routes/contacts.ts`) without the DistributionGroup source (GROUP kind removed from the GalEntry type), dashboard (`routes/admin/dashboard.ts`) `distributionGroup.count()` → 0, organisation (`routes/admin/organisation.ts`) `groups` array stays empty. **Backend (smtp-server)**: `handlers/expand.ts` completely rewritten — `expandRecipients()` now only resolves email aliases, cycle protection remains; `inbound/handler.ts` `verifyRecipient()` Promise.all without DistributionGroup lookup, inbound mail to former group addresses is rejected with 550 5.1.1. **Migration note**: existing DistributionGroups + memberships are irrevocably lost with the upgrade — use cases: team inbox → Shared Mailbox + permissions, pure distribution list → external listserv (Mailman/listmonk) or a recipient list directly in the client.

**v5.6.0** — OAuth2 / Modern Auth completely removed from the stack (major release). User decision: "Remove, and remove from the code: BCP OAuth2 / Modern Auth". After the MAPI removal in v5.4.0 + the IMAP OAuth decision in v5.5.0, OAuth2 has no practical use case left in the stack: mail clients use IMAP/SMTP/POP3 with app passwords (MFA-capable), MWA + BCP use session JWTs via `/auth/login`. The entire OAuth2 codebase was dead weight. **Frontend**: BCP `/oauth-clients/` page (`OAuthClientsPage.tsx`) + sidebar entry + i18n keys + route removed, MWA `/oauth-consent/` page (`OAuthConsentPage.tsx`) + route + LoginPage OAuth2 flow detection removed. **Backend**: `packages/auth-service/src/oauth2/` entire directory deleted (router + ~970 LOC), `packages/api-gateway/src/routes/admin/oauth-clients.ts` deleted, api-gateway `/oauth2/*` proxy + `/api/v1/admin/oauth/*` mount + `/.well-known/openid-configuration` + `/.well-known/jwks.json` handlers removed, auth-service `/oauth2` mount removed, ews-server middleware Bearer branch completely removed (Basic Auth only — audience validation, OAuth token revocation check gone). **JWT back to HS256**: `packages/core/src/auth/jwt-keys.ts` deleted (RS256 key management was only for JWKS), `packages/core/src/auth/jwt.ts` rewritten back to HS256 with the `JWT_SECRET` env var (as pre-v5.2.17), `initJwtKeys()` removed from the api-gateway/auth-service/ews-server/backup-service/caldav-server startup. **Prisma schema (DESTRUCTIVE)**: 4 models deleted — `OAuthClient`, `OAuthAuthorizationCode`, `OAuthToken`, `OAuthConsent` (tables are dropped via `prisma db push --accept-data-loss` at container start). **IMPORTANT**: SSO via external IdPs (auth-sso package, Azure AD/Keycloak/Authentik) **is retained** — this is OIDC client functionality (CoreMail logs users in through an external IdP), NOT to be confused with the removed OAuth2 authorization server.

## Archived Highlights (v5.5.0–v5.2.0)

**v5.5.0** — IMAP4rev2 (RFC 9051) compliance + docs update + XOAUTH2 decision. STARTTLS, AUTHENTICATE SASL (PLAIN+LOGIN), UNSELECT, ID command. Docs update for the MAPI removal. Decision against XOAUTH2 documented (no mainstream client UI support for non-Microsoft servers).

**v5.4.0** — MAPI/HTTP completely removed from the stack (~12,000 LOC). Outlook 2024 LTSC enforces Microsoft-Entra-only Modern Auth, which fundamentally does not work for non-Microsoft servers (custom ADFS emulation = 3-4 weeks of effort with no guarantee of success). Recommended Outlook client path: "Other email accounts" → IMAP. Calendar + contacts via CalDAV/CardDAV.

## Current Version 5.2.0 — Highlights (MAPI/HTTP FINAL — archived, removed since v5.4.0)

**v5.2.0** — Completion of the MAPI/HTTP implementation. Bundles all originally planned v5.2/v5.3/v5.4/v5.5 features into one final release: Cached Mode (MS-OXCFXICS sync), recurrence pattern binary, search folders, server-side rules bridge, folder permission stubs, embedded messages, multi-value properties, RTF compression, gzip transport compression. Marks MAPI/HTTP as feature-complete for typical Outlook workflows. (1) **MS-OXCFXICS Sync (rop/sync.ts)** — Cached Mode for Outlook (default since 2007). RopSyncConfigure returns a FastTransfer source handle. RopFastTransferSourceGetBuffer streams ICS records (StartMessage 0x40000003 + TaggedProperties + EndMessage 0x40000004) chunk by chunk (max 28KB per chunk, TransferStatus 1=Partial/3=Done). Implemented: SyncConfigure, FastTransferSourceCopyFolder/Messages/Properties/GetBuffer, FastTransferDestinationConfigure/PutBuffer, SyncImportMessageChange/HierarchyChange/Deletes/MessageMove, SyncUploadStateStreamBegin/Continue/End, SyncOpenCollector, GetLocalReplicaIds, SyncGetTransferState. Initial sync goes through, delta sync degraded-but-stable. (2) **Recurrence Pattern Binary (recurrence-pattern.ts)** — encodeRecurrencePattern(rrule, dtStart, dtEnd) parses the iCal RRULE and converts it into the PidLidAppointmentRecur binary (MS-OXOCAL §2.2.1.44). Supports FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY (Mon-Sun bitmask), BYMONTHDAY, BYMONTH, COUNT, UNTIL. Outlook now shows the correct recurrence pattern in the appointment editor. (3) **PR_RTF_COMPRESSED stream (rtf-compress.ts)** — htmlOrTextToRtfCompressed() wraps HTML/text in the MELA uncompressed RTF format (MS-OXRTFCP), Outlook accepts it without CRC. Plus an LZ77 decoder for future Outlook→server RTF bodies. OpenStream on PR_RTF_COMPRESSED (0x10090102) is now functional. (4) **gzip transport compression** — the X-CompressedRequest:1 header triggers transparent gunzip decompression before the handler. Saves bandwidth on large ROP streams (typically 60-70% reduction). Middleware in handler.ts. (5) **Multi-value properties** — property-codec extended with PT_MV_INT16/INT32/STRING/UNICODE/SYSTIME/BINARY (MS-OXCDATA §2.11.1.6). Read+write. Outlook uses multi-value for PR_RECEIVED_BY_ADDRTYPE_LIST and PT_MV_BINARY-encoded RowSets. (6) **RopOpenEmbeddedMessage (v52-handlers.ts)** — forward-mail-as-attachment. Creates a sub-message handle on an attachment, Outlook can then read the embedded IPM.Note via OpenStream. (7) **Search folders** — RopGetSearchCriteria + RopSetSearchCriteria with minimal persistence (no crash in Outlook's "saved search" workflow). (8) **Server-side rules bridge** — RopGetRulesTable returns an empty table, RopUpdateRules accepts with SUCCESS. Outlook rules stay client-local (CoreMail MailRules are managed via the MWA, applied server-side in storeInboundMessage). (9) **Folder permissions** — RopGetPermissionsTable + RopModifyPermissions stubs (Outlook's permissions dialog no longer crashes — ACL management stays in the BCP). (10) **Misc message ROPs** — RopAbortSubmit, RopReloadCachedInformation (Outlook cached refresh), RopGetMessageStatus/SetMessageStatus for read tracking. (11) **NSPI pagination + SortTable (nspi-handler.ts)** — QueryRows with cursor pagination via StartMid + RowCount from the request body, alphabetical sorting by displayName (locale 'de'), hard limit raised to 1000 instead of 500. (12) **Codec + dispatcher** — all new ROPs (28 additional) wired up, correct payload parsing branches incl. variable-length handling. **Outlook behavior after v5.2.0**: Cached Mode works (.ost file is filled initially, Outlook is offline-capable), recurring appointments show the recurrence pattern, embedded mails open, clicking "Search Folders" no longer crashes, the rules dialog can be opened (stored locally), the permissions dialog is read-only without errors, RTF mails are displayed correctly formatted, a large GAL (>500 entries) is fully paginated. **MAPI/HTTP roadmap completion**: v4.0 (Foundation) → v4.7 (Phase 7) → v5.0 (GA + default-on) → v5.1 (Named Props + PIM details + native NSPI) → v5.2 (FINAL — Cached Mode + recurrence + misc). Effort: ~12,000 lines of MAPI code in one contiguous sprint instead of the estimated 6-9 months of weekly work. Optionally open for v5.3+: full ICS-OPCODE records (delta sync), DAV-ACL mapping onto MAPI permissions, RTF→HTML conversion via the LZ77 decoder.

**v5.1.0** — Closes the last open v5.x items from the v5.0.0 release. (1) **Named Properties** (packages/ews-server/src/mapi/named-properties.ts) — full implementation of the MAPI named-property mapping for PSETID_Appointment ({00062002-…}), PSETID_Address, PSETID_Task, PSETID_Note. Standard LIDs from MS-OXOCAL/CNTC/TASK/NOTE (LID_APPOINTMENT_START_WHOLE 0x820D, LID_LOCATION 0x8208, LID_TASK_COMPLETE 0x811C, LID_NOTE_COLOR 0x8B00 etc.). resolveNamedProperties() assigns local uint16 IDs from 0x8000 in the session state (mapi:session:<token>.namedPropMap). reverseNamedProperties() for GetNamesFromPropertyIds. (2) **RopGetPropertyIdsFromNames** + **RopGetNamesFromPropertyIds** (rop/named-props-handler.ts) — full binary implementation. The ROP codec now passes the full payload to the handlers (instead of a pass-through stub). (3) **PIM detail views** (rop/pim-properties.ts) — buildPimPropertyList() loads CalendarEvent/Contact/Task/Note from Prisma and maps each item to a full property set: standard MAPI properties (Subject/Body/MessageClass/Times) + named properties via PSETID_*. Calendar: Subject/Body/Location/Start/End/Duration/AllDay/BusyStatus/Sequence/Recurring. Contact: DisplayName/Email1/Email2/AddressType/FileAs + PR_COMPANY_NAME/TITLE/DEPARTMENT/PHONE/MOBILE. Task: Status/PercentComplete/StartDate/DueDate/DateCompleted/Complete flag/Owner. Note: Color/Width/Height. (4) **handleRopGetPropertiesAll/Specific** in rop/message.ts dispatches to buildPimPropertyList() when the message handle has `pimKind !== 'mail'`. (5) **openVirtualPimMessage** now sets `pimKind` (appointment/contact/task/note) on the handle so that GetProperties knows which mapper to use. (6) **Native NSPI binary** (mapi/nspi-handler.ts) — replaces the v4.7.0 SUCCESS-empty fallback. Complete: GetSpecialTable (returns "Global Address List" as the root entry), QueryRows (paginates User+DistributionGroup), ResolveNames/GetMatches (substring match on displayName+email), GetProps (properties of a single entry by MinId), DnToMinId (legacy DN → MinEntryID), GetPropList. MinEntryID = FNV-1a 32-bit hash of the userId/groupId in the range [0x10000000, 0xFFFFFFFF]. Property set per row: PR_DISPLAY_NAME_W, PR_EMAIL_ADDRESS_W, PR_SMTP_ADDRESS_W, PR_ADDRTYPE_W='SMTP', PR_OBJECT_TYPE (6=MAILUSER/8=DISTLIST), PR_DISPLAY_TYPE (0/1). (7) **handler.ts** now dispatches NSPI operations to handleNspiOperation() instead of returning SUCCESS-empty. **Outlook behavior**: double-clicking a calendar appointment in Outlook now opens the full appointment window with subject, location, start/end, all-day flag, BusyStatus display (Free/Busy/Out of Office/Tentative). Contacts show all fields (company, job title, phones, Email1/Email2). Tasks show due date + progress + status. Notes with color code. Plus: the Outlook address book is now filled directly from the GAL (no more EWS round trips) — faster, less latency.

**v5.0.0** — MAPI/HTTP production hardening + default-enabled (major release). Completion of the v4.x iteration of the native Outlook Exchange connection. Marks MAPI/HTTP as production-ready. (1) **Autodiscover MAPI/HTTP default ON** (`packages/autodiscover/src/v1.ts`) — the feature flag `ENABLE_MAPI_HTTP` is now opt-out (`!== 'false'`) instead of opt-in. Outlook 2013 SP1+ discovers the `<Protocol Type="mapiHttp">` block automatically and sets itself up natively as an Exchange account (instead of the IMAP fallback). The complete ROP feature set from v4.1-v4.7 is available: logon, folder browse, reading mail, writing+sending mail, attachments, move/delete, push notifications via Redis pub/sub, virtual PIM folders (calendar/contacts/tasks/notes), server-side search via MAPI restriction → Prisma WHERE. (2) **Unit tests** for the most critical codec components — `property-codec.test.ts` with 13 round-trip tests (FILETIME, PT_LONG/INT64/BOOLEAN/UNICODE/BINARY/SYSTIME, TaggedProperty, PropertyRow, makePropTag), `entry-id.test.ts` with 6 tests (cuidToFolderId64 determinism, uint64 range, collision-freeness for virtual folder IDs). All 19 new tests green; together with the 16 codec tests from v4.0 now 35 Vitest round-trip tests in CI. (3) **OWA External Clients page** should reflect the v5.0.0 status: the native Outlook connection is now the recommended path (CalDav Synchronizer plugin as a fallback for bidirectional calendar sync with detail fields). **Outlook behavior after v5.0.0**: user enters mail+password → Autodiscover → Outlook detects MAPI/HTTP → account type "Exchange" → full feature set. No more "IMAP fallback" hint needed. A full MS-OXNSPI native implementation (instead of the EWS fallback) remains optional for v5.1+ hardening, but Outlook does not strictly need it since the SUCCESS-empty response switches Outlook over to EWS. **Roadmap status v4.x→v5.x completed**: the 6-9 month plan from v4.0.0-ARCHITECTURE.md implemented in one focused sprint (v4.1.0 ROP infra → v4.2.0 reading → v4.3.0 writing → v4.4.0 attachments → v4.5.0 push → v4.6.0 PIM folders → v4.7.0 NSPI+search → v5.0.0 production GA).

**v4.7.0** — MAPI/HTTP Phase 7: NSPI address-book fallback + server-side search (bundled from the planned v4.8.0). **NSPI part**: Outlook uses the Name Service Provider Interface for recipient autocomplete, "Check Names" and distribution-group member display. CoreMail's NSPI endpoint on /mapi/nspi/ previously returned binary ecNotSupported for QueryRows/ResolveNames/GetMatches/GetSpecialTable/GetProps/DnToMinId/GetPropList → Outlook considered NSPI "broken". A full MS-OXNSPI implementation (weeks of work for MinEntryID + binary RowSet + PropertyValueArrays) is deferred to v5.x. Fix: all NSPI ops now return SUCCESS-empty (StatusCode=OK, ErrorCode=OK, RowCount=0). Outlook automatically falls back to EWS ResolveNames/FindPeople (functional since CoreMail v3.x). **Search part**: (1) RopRestrict (rop/search.ts) — parses the MS-OXCDATA §2.12 restriction format (ResAnd/ResOr/ResNot/ResContent/ResProperty/ResExist), persists the ParsedRestriction on the table handle. (2) RopFindRow — accepts FindRowFlags + Restriction + Origin + Bookmark; v4.7.0 minimally returns "no match" (Outlook typically uses RopRestrict + RopQueryRows as its search workflow). (3) restrictionToPrismaWhere() — converts a ParsedRestriction into a Prisma where clause: tagToPrismaField() maps property IDs to DB fields (PR_SUBJECT_W→subject, PR_BODY_W→bodyText, PR_HTML→bodyHtml, PR_SENDER_NAME_W→fromName, PR_SENDER_EMAIL_ADDRESS_W→fromAddr, PR_DISPLAY_TO_W→toAddrs, PR_MESSAGE_DELIVERY_TIME→date, PR_MESSAGE_SIZE→rawSize, PR_MESSAGE_FLAGS→flags). Content fuzzy: FullString/Substring/Prefix + ignore-case. Property RelOps: LT/LE/GT/GE/EQ/NE. (4) QueryRows integration — on the standard mail contents table the restriction is applied as an additional filter next to folderId ({folderId, ...restrictionWhere}). (5) ROP codec — correct payload parsing for RopRestrict/RopFindRow. **Outlook behavior**: no more NSPI error, recipient autocomplete + name check + GAL browse functional. Server-side search (Ctrl+E in Outlook) filters inbox/folder directly via MAPI restriction → Prisma WHERE — no more client-side scan for large mailboxes (>1000 mails is performance-critical).

**v4.6.0** — MAPI/HTTP Phase 6: Calendar/Contacts/Tasks/Notes virtual folders. CoreMail does NOT store Calendar/Contacts/Tasks/Notes as mailbox folders (separate Prisma models), but Outlook MAPI needs them as folder entries in the hierarchy table. v4.6.0 synthesizes 4 virtual PIM folders with fixed IDs (`virtual-calendar`, `virtual-contacts`, `virtual-tasks`, `virtual-notes`) and PR_CONTAINER_CLASS_W (IPF.Appointment/IPF.Contact/IPF.Task/IPF.StickyNote). (1) **containerClassFor(folderName)** in rop/folder.ts — name→class mapping incl. German aliases (Kalender/Kontakte/Aufgaben/Notizen). (2) **VIRTUAL_FOLDERS constant** with 4 PIM folder definitions. (3) **GetHierarchyTable extended** — at root level (`parentFolderId === ''`) the rowCount is increased by VIRTUAL_FOLDERS.length. (4) **QueryRows on hierarchy** — injects virtualFolderToPropRow() for the 4 PIM folders. (5) **OpenFolder extended** — also matches virtual IDs via cuidToFolderId64(VIRTUAL_FOLDERS[*].id). (6) **GetContentsTable extended** — virtual folders return counts from Prisma calendarEvent/contact/task/note instead of message. (7) **QueryRows on contents** — `parentFolderId.startsWith('virtual-')` → loadVirtualContents() loads events/contacts/tasks/notes and maps them to PropRows with `PR_MESSAGE_CLASS_W = 'IPM.Appointment' / 'IPM.Contact' / 'IPM.Task' / 'IPM.StickyNote'`, plus Subject/Body/Date/Priority. (8) **GetRowCount extended** for virtual folders. (9) **OpenMessage extended** — detects virtual folder IDs and delegates to `openVirtualPimMessage()`, which finds the item via hash match in the respective PIM table. (10) **folderToPropRow** now uses `containerClassFor(name)` instead of the hardcoded 'IPF.Note'. **Outlook behavior**: 4 additional folders appear in Outlook under the mailbox: "Calendar", "Contacts", "Tasks", "Notes" — with the correct icon depending on Outlook's folder-type detection. The list view shows the respective items (appointments/contacts/etc.) with subject and date. A full property round trip on individual items (detail view, editing) still needs the full named-property mapping (PSETID_Appointment etc.) — comes in v5.0.0 or optionally as a v4.6.1 patch. Read-only browsing of the PIM data is functional, though.

**v4.5.0** — MAPI/HTTP Phase 5: push notifications via Redis pub/sub. Previously Outlook polled via long NotificationWait requests that returned after 30s with EventPending=false → noticeable delay for new mail. Now real server push. (1) **RopRegisterNotification** (rop/notification.ts) — Outlook subscribes via ROP to the desired event types (NewMail/MessageDeleted/MessageModified/FolderChanged) on a folder or mailbox handle. The subscription is persisted dynamically on the handle (subscription field via JSON round trip through Redis). (2) **NotificationWait long poll** (emsmdb-handler.ts) — duplicate()-ed ioredis client (subscribe needs a dedicated connection per ioredis requirement), subscribe on channel `coremail:mapi:notify:<userId>`, race between the Redis event and the 30s timeout, clean cleanup (unsubscribe + disconnect + clearTimeout) on both outcomes, plus req.on('close') for client-disconnect handling. Responds immediately on event with EventPending=1, otherwise after the timeout with EventPending=0. (3) **publishNotifyEvent helper** in rop/notification.ts with the `notifyChannelFor(userId)` channel generator. Event shape: `{kind, userId, folderId?, messageId?, subject?}`. (4) **SMTP hook**: `packages/smtp-server/src/handlers/message.ts` `storeInboundMessage()` now additionally publishes, after the existing CHANNEL_MAIL_NEW publish, on `coremail:mapi:notify:<userId>` with a MAPI notify event (`{kind:'NewMail', userId, folderId, messageId, subject}`) — non-fatal `.catch(() => {})` for backward compatibility when MAPI is not active. (5) **NotifyEvent TypeScript interface** exported for other modules that trigger push events (e.g. a future RopMoveCopyMessages hook for MessageDeleted events). **Outlook behavior**: new mail appears in Outlook within <1s (instead of waiting up to 30s before). Toast notification on new mail works. The folder refresh cache is invalidated. Battery drain on mobile Outlook clients significantly reduced (no more constant polling).

**v4.4.0** — MAPI/HTTP Phase 4: attachments + move/delete. Building on v4.3.0 compose, Outlook can now send + read attachments, move + delete mails. New ROPs (real implementation): (1) **RopGetAttachmentTable** (rop/attachment.ts) — new table type `attachments` with the `parentFolderId = MessageId` special convention. (2) **RopOpenAttachment** — loads the attachment via index (PR_ATTACH_NUM), creates an attachment handle. (3) **RopCreateAttachment** — creates a draft attachment handle (`attachmentId=null`, `pendingBuffer`, `pendingProperties`); SaveChangesAttachment persists to DB+MinIO. (4) **RopDeleteAttachment** — removes the attachment DB record. (5) **RopSaveChangesAttachment** — SHA256 hash, MinIO upload to `attachments/{messageId}/{sha256}`, DB insert or update with `filename/mimeType/size/sha256/storagePath/contentId`. (6) **RopOpenStream on attachment** — stream on PR_ATTACH_DATA_BIN: for an existing attachment via `loadAttachmentBytes()` from MinIO, for a draft attachment via `pendingBuffer`. WriteStream accumulates in pendingBuffer, CommitStream persists into the attachment handle. (7) **RopDeleteMessages** (rop/folder-ops.ts) — parses the MessageId array (uint64 hashes), deletes via prisma.message.delete, decrements the folder counter. (8) **RopMoveCopyMessages** — source handle (input) + destination handle (output), parses the WantCopy flag + MessageId array, move = update folderId, copy = duplicate via prisma.message.create. (9) **ROP codec**: proper payload parsing for GetAttachmentTable (TableFlags), OpenAttachment (AttachmentId uint32), CreateAttachment, DeleteAttachment, SaveChangesAttachment, DeleteMessages (WantAsync+NotifyNonRead+MessageIdCount+MessageIds[uint64]), MoveCopyMessages (DestHandleIndex+WantAsync+WantCopy+MessageIds[uint64]). (10) **RopObject extended**: `attachment` variant with `attachmentId:string|null`, `attachNum`, `pendingProperties`, `pendingBuffer`. `table` variant with the new `tableType:'attachments'`. (11) **Table handler extended**: `attachmentToPropRow()` maps attachment → PR_ATTACH_NUM/LONG_FILENAME_W/MIME_TAG_W/SIZE/METHOD; GetRowCount supports 'attachments'. (12) **buildMessagePropertyList extended**: loads `_count.attachments` and sets PR_HAS_ATTACH + the PR_MESSAGE_FLAGS HasAttach bit (0x10). (13) **SubmitMessage extended**: loads msg.attachments from the DB and fills OutboundJob.message.attachments with `{filename, minioPath, contentType, size}` — the worker builds RFC 5322 with real attachments via the existing buildRawFromMessage. (14) **New property tags**: PR_ATTACH_NUM, PR_ATTACH_METHOD, PR_ATTACH_LONG_FILENAME_W, PR_ATTACH_FILENAME_W, PR_ATTACH_MIME_TAG_W, PR_ATTACH_SIZE, PR_ATTACH_CONTENT_ID_W, PR_ATTACH_DATA_BIN, PR_ATTACHMENT_LINKID. **Outlook behavior**: attaching a file to a new mail (drag & drop or "Insert file") works end-to-end — stored in MinIO, handed to the outbound queue with `minioPath` on send, the worker loads + signs + sends. Received mails with attachments: Outlook shows the paperclip icon, attachment list, double-click opens the file. Moving mails (drag-and-drop into other folders) + multi-delete via the Delete key works. Push notifications on new mail: not yet (comes in v4.5.0).

**v4.3.0** — MAPI/HTTP Phase 3: writing + sending mail. After v4.2.0 mail reading, Outlook can now also compose + send. New ROPs (real implementation): (1) **RopCreateMessage** — creates a draft message handle (`messageId=null, isDraft=true`), accumulates pending properties/recipients in the Redis session until save. (2) **RopSetProperties** — parses the PropertyValueArray (PropertyValueSize + Count + TaggedPropertyValues), JSON-safe encoding for Buffer/BigInt/Date in Redis persistence. (3) **RopModifyRecipients** — parses the ColumnCount/Columns + RowCount/Rows structure from MS-OXCMSG §2.2.3.1.2, extracts RecipientType+DisplayName+EmailAddress from the RecipientRow header bytes. (4) **RopSaveChangesMessage** — persists the draft in the Drafts folder (mailbox UID increment, ModSeq update, `flags:['\\Draft']`), for an existing message: update. The response returns FolderId+MessageId(uint64). (5) **RopWriteStream** — append-style + overwrite-in-place + sparse write (padding with null bytes when offset > buffer length); accumulates until CommitStream. (6) **RopCommitStream** — writes the stream buffer into the parent message: for a saved message a direct Prisma update on bodyText/bodyHtml/subject (UTF-16-LE for PR_BODY_W/PR_SUBJECT_W, UTF-8 for PR_HTML), for a draft stream an update of the pendingProperties on the parent message handle. (7) **RopSubmitMessage** — submits the message via the BullMQ smtp-outbound queue (local queue instance with `createBullMqConnection()` from @coremail/core, no cross-package import needed), DKIM key from User.Domain, From/To/CC/BCC, moves to the Sent folder after submit. (8) **RopObject extended** — the `message` variant has `messageId:string|null`, `isDraft`, `pendingProperties:Record`, `pendingRecipients:Array`; the `stream` variant has `writable`, `parentMessageHandle` for draft streams. (9) **updateRopObject helper** in rop-handle-table.ts for patch updates. (10) **New property tags**: PR_EMAIL_ADDRESS_W, PR_ADDRTYPE_W, PR_SMTP_ADDRESS_W, PR_RECIPIENT_TYPE, PR_RECIPIENT_FLAGS, PR_OBJECT_TYPE, PR_DISPLAY_TYPE. (11) **ROP codec**: the ModifyRecipients payload now receives the full rest of the buffer (previously only 64 bytes were sliced — bugfix). (12) **bullmq** added as a dependency to @coremail/ews-server. **Outlook behavior**: the compose window works — create a new mail, type subject+body+recipients, "Send" → the mail arrives at the recipient. The Sent folder shows a copy. Reply/forward also works (Outlook loads the original via v4.2.0 → writes a draft via v4.3.0 → submitted). Attachments: still empty (coming in v4.4.0). Push notification on new mail: not yet (v4.5.0).

**v4.2.0** — MAPI/HTTP Phase 2: reading mail (OpenMessage + stream read). Building on the v4.1.0 ROP infrastructure: after logon Outlook can now not only see the folder hierarchy but also open and display individual mails. (1) **RopOpenMessage** (`rop/message.ts`): folder lookup via CUID→uint64 FNV-1a hash (entry-id.ts), message via Prisma, message handle in the session handle table. (2) **RopGetPropertiesAll** + **RopGetPropertiesSpecific**: full property set for Outlook's mail display — PR_SUBJECT_W, PR_SENDER_*, PR_SENT_REPRESENTING_*, PR_DISPLAY_TO/CC/BCC_W, PR_MESSAGE_DELIVERY_TIME/CLIENT_SUBMIT_TIME, PR_MESSAGE_FLAGS (Read/Unsent/HasAttach), PR_MESSAGE_SIZE, PR_BODY_W (UTF-16-LE), PR_HTML (UTF-8 bytes), PR_MESSAGE_CLASS_W (IPM.Note), PR_HAS_ATTACH, PR_INTERNET_MESSAGE_ID_W. `buildMessagePropertyList` maps a Prisma message → MAPI tagged properties. (3) **RopOpenStream** (`rop/stream.ts`): opens a stream on a message property, loads the complete value into a buffer, the response returns StreamSize. (4) **RopReadStream**: chunked read with offset tracking (persisted in Redis), max 30 KB per chunk (MAX_STREAM_CHUNK_BYTES — Outlook expects <32 KB), request format `Uint16 ByteCount | 0xBABE+Uint32 ExtendedByteCount`. (5) **RopGetStreamSize**: returns the buffer size. (6) **ROP codec**: parsing added for all v4.2.0+v4.3.0+v4.4.0+ ROPs; the v4.3.0 stubs (CreateMessage, SetProperties, SaveChangesMessage, SubmitMessage, WriteStream, CommitStream) parse the payload correctly and currently return ecNotSupported, becoming real handlers in v4.3.0. (7) **RopId** additions: MoveCopyMessages (0x33) + DeleteMessages (0x1E) in preparation for v4.4.0. **Outlook behavior**: mail list visible + individual mail readable with subject/sender/body; writing/sending/attachments/push follow in v4.3.0-v4.5.0.

**v4.1.0** — MAPI/HTTP Phase 1: ROP infrastructure + logon + folder browse. Building on the v4.0.0 foundation: full ROP stream codec with RopId/property tags/EntryID helpers, ROP dispatcher that parses binary Execute bodies, RopLogon handler (loads the user from Prisma, builds the folder-IDs array for IPM subtree/Inbox/Drafts/Sent/Trash, creates MailboxGuid+ReplGuid), RopOpenFolder/GetHierarchyTable/GetContentsTable, RopSetColumns/QueryRows/GetRowCount/Release. Property codec with FILETIME conversion. 16 codec tests green. Skeleton files for v4.2-v4.7 with detailed plans + property mappings. With v4.1.0 Outlook can log on after connect and see the folder hierarchy — reading mail comes in v4.2.0.

**v4.0.0** — MAPI-over-HTTP foundation + External Clients setup page. Start of the native Outlook Exchange connection. This foundation lays down: (1) `packages/ews-server/src/mapi/ARCHITECTURE.md` — complete implementation plan with roadmap v4.0.0 → v5.0.0, estimated 6-9 months for a 2-person team. (2) `codec.ts` — binary buffer reader/writer for the MS-OXCRPC wire format (LE uint8/16/32/64, ASCII/UTF-16-LE null-terminated strings, GUIDs, AUX header blocks). (3) `codec.test.ts` — 16 round-trip tests, all green. (4) `http-headers.ts` — X-RequestType/X-RequestId/X-ResponseCode/X-ExpirationInfo/Set-Cookie header handling. (5) `session-store.ts` — Redis-backed session store with 10-min TTL and auto-renew. (6) `emsmdb-handler.ts` — binary Connect/Disconnect/NotificationWait functional; Execute returns ecNotSupported (ROPs come iteratively). (7) NSPI handler stub: Bind/Unbind functional, QueryRows etc. ecNotSupported. (8) Express raw() body parser for /mapi/emsmdb/ + /mapi/nspi/ (binary instead of JSON). (9) Autodiscover feature flag `ENABLE_MAPI_HTTP=true` → adds the `<Protocol Type="mapiHttp" Version="1">` block (default off until ROP execution is functional). (10) OWA settings page "External Clients & Outlook" with IMAP/SMTP/CalDAV/CardDAV data + Outlook CalDav Synchronizer setup. Full Outlook functionality (login, folder browse, reading mail, sending, calendar, contacts) comes in v4.1.0-v4.7.0.

**v3.18.40** — External Clients & Outlook setup page in OWA. User request: "View + edit calendar and contacts via Outlook". Microsoft Outlook Desktop has no native CalDAV/CardDAV support — a full MAPI-over-HTTP implementation would be weeks of work. Pragmatic solution: new OWA settings section "External Clients & Outlook" with all required data + step-by-step guide for the (free, OSS) "Outlook CalDav Synchronizer" plugin. Backend: new endpoint `GET /api/v1/user/client-config` returns consolidated IMAP/SMTP/POP3 data from ServerSettings, CalDAV account + per-calendar URLs, CardDAV account + default address-book URL, plus a `requiresAppPassword` flag based on MFA status. Frontend: new ExternalClientsSection with copy buttons for all values, app-password hint with MFA, detailed plugin setup guide with pre-filled URLs (the user only has to copy+paste), and hints on alternatives (OWA in the browser, Apple Calendar, Thunderbird+TbSync, eM Client, DAVx⁵ for Android).

**v3.18.39** — Outlook: EXCH+EXPR removed from Autodiscover → IMAP fallback. User symptom (after the v3.18.38 deploy): the password prompt now appeared correctly, but Outlook hung for minutes in the RPC/TCP connect, then the error "This folder group cannot be opened — error logging on to Microsoft Exchange". Outlook's connection status showed VIDs with protocol RPC/TCP to `mail.<domain>` with status "connecting" — and type "Public..." (Public Folder). Root cause: the Autodiscover response returned `<Protocol Type="EXCH">` (intra-Exchange RPC) and `<Protocol Type="EXPR">` (Outlook Anywhere / RPC-over-HTTPS). Both use the binary MAPI/ROP protocol. We only had EWS + stubs on /mapi/emsmdb/. Outlook therefore spent minutes trying RPC connects to `rpcproxy.dll` (does not exist) or the RPC endpoint mapper on port 135. **Pragmatic fix**: the EXCH and EXPR blocks REMOVED from the Autodiscover XML. Outlook now automatically falls back to the IMAP configuration — mail works immediately. Calendar + contacts go via CalDAV/CardDAV (Apple Calendar, Thunderbird, eM Client) or directly via OWA in the browser. A full MAPI-over-HTTP implementation (EcDoConnectEx, ROP verbose binary, NSPI Bind/QueryRows) would be needed for a native Outlook Exchange connection — several weeks of work, comes later as its own feature.

**v3.18.38** — Outlook LTSC "no password prompt" root cause + Autodiscover completion. **CRITICAL**: the user symptom was "Outlook connects, but without a password prompt, then Personal Folders (PST) instead of an Exchange mailbox, plus the error 'information service incomplete'". Root cause: Outlook LTSC first probes `GET /EWS/Exchange.asmx` BEFORE it sends an Authorization header. The previous GET handler returned 200+WSDL stub without an auth check → Outlook assumed no auth was needed, never sent credentials → setup ended up with a local PST. Fix: `ewsAuthMiddleware` now BEFORE the GET handler + before the `/mapi/*` router (except `/healthcheck.htm`) + the OAB endpoint. Now sends 401 + `WWW-Authenticate: Basic realm="CoreMail EWS"` → Outlook asks for credentials. PLUS the `auth-service` URL fixed: was `http://auth-service:3001/auth/login` (port 3001 = storage-api!) → now env `AUTH_SERVICE_URL` with default `http://localhost:3003/auth/login`. PLUS the Autodiscover XML completed (research on MS Docs + Grommunio): `AuthPackage` from `basic` to `Basic` (case-sensitive on Outlook LTSC builds), mandatory `<User><LegacyDN>` added (`/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=<user-id>` — Outlook uses it as the internal user identity), `<AutoDiscoverSMTPAddress>` added, `<GroupingInformation>default</GroupingInformation>` in the EXPR block, `<PublicFolderInformation>` dummy, correct Exchange 2019 topology in ServerDN/MdbDN, `<EcpUrl>` added.

**v3.18.37** — Outlook LTSC Autodiscover XML extended (Exchange-2019-compatible) + audit translations completed. (1) **AUTODISCOVER**: the v1 XML response only had a minimal `<Protocol Type=EXCH>` block. Outlook 2016+ however needs `AuthPackage`, `OABUrl`, `ASUrl`, `OOFUrl`, `EmwsUrl`, `MdbDN`, `ServerVersion` PLUS a separate `<Protocol Type=EXPR>` block (Outlook Anywhere / MAPI-over-HTTP fallback). Without these the setup wizard aborts with "Something went wrong". Fix: all mandatory fields added, AuthPackage=basic, MicrosoftOnline=False (on-premises signal), CertPrincipalName=None. (2) **AUDIT TRANSLATIONS**: old pre-v3.18.34 entries (`anomalies.get`, `full.post`, `jobs.delete`, `tags.post`, `members.delete`) were not recognized because the ACTION_MAP only had the new long forms. Plus new v3.18.37 formats: `servers.settings.put`, `servers.settings.derive.post`, `retention.tags.*`, `dashboard.get`, `services.put`, `make-primary.post`. 25+ new mappings in total. (3) **ACTOR FALLBACK**: with an empty `actorEmail` (e.g. system/cron actions) nothing at all was displayed — now the fallback `System (cmpla8p1…)`.

**v3.18.36** — Hostname auto-derive (generic for all domains) + image privacy banner hardened. (1) **HOSTNAME AUTO-DERIVE GENERIC**: the schema defaults `mail.local:8080` for `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` previously had to be adjusted manually per installation — works for 1 test user but not for 1000+ users with individual domains (e.g. `firma.de`, `kunde.com`, `irgendwer.org`). Fix: central helper `lib/server-urls.ts` with `deriveServerUrls()` (computes URLs from hostname + useHttps + httpPort), `syncFromPrimaryDomain()` (sets `publicHostname=mail.<domain>` if still default, derives URLs), `syncServerUrlsFromHostname()` (idempotent re-sync at container start). Hooked into: setup wizard (`POST /setup/complete` — transaction stores domain+URLs atomically), domain create (`POST /admin/domains` — first domain = primary, derive URLs), make-primary (`POST /admin/domains/:id/make-primary` — respects an already-set hostname), settings PUT (`PUT /admin/servers/settings` — stale URLs are auto-derived), api-gateway startup (as a safety net). Autodiscover host per Microsoft spec from the root domain (`mail.firma.de` → `autodiscover.firma.de`). Redis publish `coremail:settings:reload` informs the autodiscover service immediately. (2) **IMAGE PRIVACY BANNER**: the banner from v3.18.10 did not work — DOMPurify removed our privacy markers. User report: despite the v3.18.10 feature, external images in mails were still loaded directly, the blue "Show images" banner never appeared. Root cause: `sanitize()` in MessageReader.tsx calls `DOMPurify.sanitize(html)` WITHOUT configuration → by default DOMPurify removes our privacy markers (the `data-coremail-ext-src` attribute, the transparent `data:image/png;base64` placeholder as src) → the blocking mechanism is undone right after being set up. Fix: `sanitize()` with an explicitly configured DOMPurify — `ADD_ATTR` whitelists our three `data-coremail-*` markers, `ALLOWED_URI_REGEXP` allows `data:image/...;base64,...`, `FORBID_TAGS` removes the tracking vectors `script`/`style`/`link`/`iframe`/`object`/`embed`/`meta`/`base`, `FORBID_ATTR` blocks event handlers + `srcset` (responsive-image trackers). ADDITIONALLY: CSS `background-image: url(...)` in inline `style` attributes is blocked as well — a common tracker vector (e.g. `<div style="background-image:url(http://tracker/pixel.png)">`); the original is stored in `data-coremail-ext-bg`. The "Show images" toggle cleans up the placeholder styles (dashed border, opacity:0.5) — images appear normally after the click instead of staying dimmed. CID inline images (real attachments) remain visible unchanged (no tracking risk, part of the mail).

**v3.18.35** — Outlook LTSC connection fix. User report: "Outlook LTSC could not establish a connection — Something went wrong". Three related problems: (1) the API gateway routed `/Autodiscover/Autodiscover.xml` to the **EWS server** (port 8080), but the autodiscover server runs on port 8081 — Outlook got the Express default 404. Fix: new env `AUTODISCOVER_SERVICE_URL`, routes `/Autodiscover` + `/autodiscover` to the right service. (2) `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` in `ServerSettings` still pointed to `mail.local:8080` (schema default), although `publicHostname` had long been switched to the real domain — Autodiscover gave Outlook unreachable internal URLs. Fix: startup migration `syncAutodiscoverUrls()` automatically corrects stale URLs at api-gateway start; PUT /admin/servers/settings likewise. Computed from `publicHostname` + `useHttps` + `httpPort`; autodiscover host from the root domain (Microsoft spec). (3) The autodiscover service had a 60s cache without a Redis subscription — settings changes were not visible for up to 60s. Fix: subscription to `coremail:settings:reload` for immediate cache invalidation.

**v3.18.34** — Audit-log path fix + backup watchdog + UX cleanup. (1) CRITICAL audit bug: `req.path` was read in the `res.on('finish')` callback, but by then Express had already mutated the path during the sub-router descent → the audit showed CUIDs as actions (`cmplad51y0…post`). Fix: store the path at middleware entry in `capturedPath`. Plus a new CUID-aware `buildAction()` — CUIDs are filtered out of the action string + stored separately as `targetId`. `DELETE /backups/jobs/<cuid>` now becomes `action='backups.jobs.delete'` with `targetId=<cuid>`. 40+ new translations in the ACTION_MAP for backup subroutes, certificate subroutes (activate-https/activate-protocol), settings subsections (security/org/mail/maintenance), group members, aliases, Shared Mailboxes, transport rules, quarantine, queues, OAuth clients. (2) Backup service: startup orphan cleanup marks RUNNING/PENDING/RETRYING/PROCESSING/SCHEDULED jobs older than 60s as FAILED after a container restart (prevents the "runs forever" UI). Plus a watchdog timer (5-min interval): jobs > 30 min are marked FAILED. (3) Backup schedule editor: minute-precise (0..59) instead of a 5-step grid. (4) The red "Anomalies detected" banner removed from the audit log — it was confusing (showed one's own settings changes as a "critical action"); the backend endpoint `/admin/audit-log/anomalies` remains for export purposes.

**v3.18.33** — External contacts (ExternalMailContact) completely removed. The feature was rarely used in practice — external addresses are typically relevant individually per user (private contacts) or per group (e.g. a "suppliers" distribution list). Reduces code complexity, simplifies the GAL view (users + distribution groups) and removes a maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery) and v3.18.31 (Public Folders). **Removed**: Prisma model `ExternalMailContact` (table `external_mail_contacts` is dropped via `prisma db push --accept-data-loss`), backend router `routes/admin/external-contacts.ts` + mount `/api/v1/admin/contacts`, BCP page `ExternalContactsPage.tsx` + sidebar entry + route `/ext-contacts` + i18n keys (`nav_ext_contacts` DE+EN), MWA GAL filter "External" + detail-panel rendering for the `EXTERNAL` kind, `ext-` branches in the GroupsPage member autocomplete (dead code). **Changed**: the `routes/contacts.ts` GAL endpoint now only returns User+DistributionGroup, the `/contacts?q=` compose autocomplete likewise. External recipients are from now on typed directly into the compose window or maintained as `EXTERNAL` members in distribution groups (DistributionGroupMember.memberType=`EXTERNAL` remains unchanged).

**v3.18.32** — TLS proxy SNI multi-cert support (Outlook Autodiscover fix). User report: "Outlook Autodiscover reports a certificate error although the `autodiscover.<domain>` cert was issued via ACME". Root cause: the integrated HTTPS proxy on port 443 only loaded the **one** cert with `isActiveHttps=true` and served all incoming TLS connections with it — when connecting to `autodiscover.<domain>` Outlook always saw the `mail.<domain>` cert → hostname mismatch. Fix: TLS proxy refactored to **SNI multi-cert support**. On reload ALL certs with `status='ACTIVE'` are loaded, with a dedicated `tls.SecureContext` per hostname (CN + all SANs + `domains[]`). `SNICallback` matches exact → wildcard (`*.example.com`, RFC 6125) → default cert. The default cert is still the one with `isActiveHttps=true`, fallback the newest ACTIVE cert. Additionally, ACME issuance + self-signed generate + cert upload now also trigger the `coremail:tls:reload` channel — previously you had to click "Activate HTTPS" manually after creating a cert; with multi-SNI every ACTIVE cert is available immediately.

**v3.18.31** — Public folders completely removed. The feature was Exchange-public-folder-style (with ACL READ/WRITE/FULL + a mail-enabled variant since v3.18.9) and is hardly used by the market today — modern teams prefer Shared Mailboxes (`/admin/shared-mailboxes/`) and distribution groups (`/admin/groups/`) for the typical use cases (team mailbox, distribution list, collaborative inbox). **Removed**: Prisma models `PublicFolder` + `PublicFolderMessage` (tables `public_folders` + `public_folder_messages` dropped via `prisma db push --accept-data-loss`), backend routers `packages/api-gateway/src/routes/public-folders.ts` + `packages/api-gateway/src/routes/admin/public-folders.ts`, route mounts `/api/v1/public-folders` + `/api/v1/admin/public-folders`, BCP page `PublicFoldersPage.tsx` + sidebar entry + route + i18n keys (`nav_public_folders` DE+EN), MWA section `PublicFoldersSection` + `PublicFolderViewerModal` in `FolderTree.tsx`. **Changed**: `smtp-server/src/inbound/handler.ts` `verifyRecipient()` without the publicFolder lookup, `smtp-server/src/handlers/message.ts` `storeInboundMessage()` without the public-folder branch — mail to former public-folder addresses is now discarded as an unknown recipient. The migration is destructive, all existing public folders + their mails are lost (comparable to the eDiscovery removal in v3.18.5).

**v3.18.30** — BigInt crash fix + audit toggle + audit translations. **CRITICAL**: the backup-service had been crash-looping since v3.18.26 because `BackupJob.sizeBytes` as a Prisma BigInt is not serialized by `JSON.stringify` — `/jobs` and `/users` threw 500, which explains the user symptoms "Back up single mailbox shows no users" and "Jobs shows no status". Fix: global monkey-patch of `express.response.json` at module top with a recursive BigInt→string replacer. Applies to all endpoints. **Audit-log toggle** in BCP→Security (`ServerSettings.auditLogEnabled`). Critical-action override via the regex `ALWAYS_AUDIT` (`settings.*`, `audit.*`, `user.role`, `oauth.client`, `mailbox.delete`, `domain.delete`) — these are ALWAYS logged even with the toggle off. The toggle change itself is logged as `audit.enabled`/`audit.disabled` with a diff (compliance: GDPR Art. 32 / SOX / HIPAA / TISAX / ISO 27001). A 60s in-memory cache avoids a DB hit per audit write; `invalidateAuditCache()` after save. **Human-readable audit labels**: `ACTION_MAP` with 40+ mappings translates `settings.put`→"Settings changed", `mailboxes.delete`→"Mailbox deleted", `audit.disabled`→"Audit log DISABLED" (red critical tone) etc. The original string in the title tooltip for SIEM cross-references.

**v3.18.29** — Backup archive download + delete. Previously the archive table was read-only. Now: two new backend endpoints (`GET /backup/admin/archive/download?key=` as a stream proxy, `DELETE /backup/admin/archive?key=` deletes the S3 object and nulls the referencing BackupJob.downloadUrl with status=EXPIRED). Frontend: new actions column in the Archive tab with a download button (HardDriveDownload icon) and a trash button (with a "delete permanently" confirm). Audit-log entry `backup.archive.delete`.

**v3.18.28** — Calendar+backup UX fixes. **CRITICAL**: re-opening a created appointment → white page. Root: React Rules-of-Hooks violation in EventEditDialog — `useMemo` was called after `if (existingLoading) return` → the hook count changes between renders → crash. Fix: all hooks before any early return. **Backup jobs**: download (stream proxy instead of a Docker-internal MinIO URL the browser cannot reach) + delete (endpoint DELETE /admin/backups/jobs/:id with S3 object cleanup). **Save button** in the event dialog now bottom right (Outlook standard) + footer with Delete on the left / Cancel+Save on the right. **Time input** instead of dropdown only — `<input type="time" list="...">` with datalist: the browser shows 15-min suggestions, but the user can type any time. **BackupsPage refactor** as a 5-tab layout (Jobs / Quick actions / Schedules / Backup archive / Restore) with badge counters. **"S3 snapshots" → "Backup archive"** (AWS term avoided). **Schedule editor** complete with dropdowns: frequency (hourly/daily/weekly/monthly/custom), weekday, hour, minute, day of month, retention. The cron expression is generated automatically and shown as a read-only hint.

**v3.18.27** — Outlook-style event dialog for the calendar. (1) FIX: clicking an existing appointment previously only opened a "Delete?" confirm — the user could not edit the appointment. Now a full edit dialog. (2) FIX: datetime-local input replaced by a separate date + time dropdown (15-min steps, 96 options). The "All day" checkbox hides the time. (3) New `EventEditDialog` component with Outlook layout: header toolbar (Save/Delete/Refresh), calendar picker with color dot, title input, **attendee list with live PARTSTAT badges** (green ACCEPTED / red DECLINED / amber TENTATIVE / gray NEEDS-ACTION + counter "X accepted · Y declined · …"), date+time pickers, location, classification (Public/Private/Confidential), notes textarea, footer with organizer+SEQUENCE. Attendee status refreshes automatically every 30s + manual refresh button. (4) New GET endpoint `/calendar/events/:id` with `canWrite`/`readOnly` flags + privacy masking for PRIVATE/CONFIDENTIAL for grantees. CalendarPage state simplified: `eventDialog: { mode: 'create' | 'edit', ... } | null`.

**v3.18.26** — Backup system extended all around. (1) BUGFIX: full backup + refresh button did not work because the backup-service crashed with `NoSuchBucket` on the first `listBackups()` call. Fix: `ensureBackupBucket()` runs at service start, idempotent HeadBucket→CreateBucket. (2) PER-MAILBOX BACKUP: new endpoint `POST /admin/backups/mailbox/:userId`, frontend with user picker + format selection (zip/mbox). (3) SCHEDULES in the DB: new `BackupSchedule` model, the scheduler reads every 60s, CRUD in the BCP with cron presets (daily/weekly/...), Run-Now button. (4) EXTENDED STATUS LOG: BackupJob +10 columns (`startedAt`, `durationMs`, `sizeBytes`, `messageCount`, `errorClass`, `triggeredBy`, `progressMeta`, ...) for RTO/RPO measurement. `JobStatus` enum +5 values (SCHEDULED, RUNNING, RETRYING, ABORTED, EXPIRED). (5) PST EXPORT REJECTED: clear after research — proprietary format, all libs read-only. ZIP+EML instead (Outlook accepts via drag & drop). A banner in the UI points this out. The pre-built research report contains RTO/RPO best practices for SMB.

**v3.18.25** — Calendar invitations (iMIP/iTIP, A5). Creating an appointment with guests now sends iMIP-compliant invitation mails (RFC 6047/5546). Guests see "Accept / Maybe / Decline" buttons directly in the mail in Gmail/Outlook. Replies come back as REPLY mails → automatically detected in storeInboundMessage + Attendee.partstat updated in the event. UPDATE mails (with `sequence++`) on event change. CANCEL mails on delete. New helper `packages/api-gateway/src/lib/imip.ts` with `ical-generator`. iTIP inbound in `packages/storage/src/itip-inbound.ts` with regex-based VCALENDAR extraction (no heavy parser in the hot path). MIME structure: `multipart/mixed` with `multipart/alternative` (text/plain + text/html + text/calendar method=REQUEST) for Gmail + additionally an `.ics` attachment for Outlook Win32 RSVP buttons. Outlook quirks: `X-MICROSOFT-CDO-BUSYSTATUS`, `X-MS-OLK-FORCEINSPECTOROPEN`. The frontend calendar modal has a new field "Invite guests (comma-separated)". UID now with the `@publicHostname` suffix (RFC 5545 §3.8.4.7).

**v3.18.24** — Performance E4: MinIO lifecycle policies + iMIP preparation. New helper `ensureLifecyclePolicies()` in `packages/storage/src/minio/index.ts` is called in `ensureBuckets()` — sets prefix-based expiration rules: `outbound-queue/` 7 days (safety net for dead BullMQ jobs), `quarantine/` 90 days (rspamd), `backups/` 365 days. Attachments and raw messages are excluded. Idempotent + fail-safe (WARN on an old MinIO version). Additionally `CalendarEvent.sequence Int @default(0)` in preparation for the v3.18.25 iMIP updates (RFC 5546 §3.2). Dep `ical-generator@10` installed.

**v3.18.23** — Backup/restore UI in the BCP (D3). New page "Backup & Restore" in the sidebar with three sections: (1) backup-jobs table with date/scope/format/status (icons for PENDING/RUNNING/COMPLETED/FAILED/CANCELLED) + progress bar + download link when completed. Auto-polling every 5s while a job runs, otherwise 60s. (2) S3 snapshots table with key/size/last-modified from the MinIO bucket. (3) MBOX import (restore) with file picker (max 500MB) + target user ID. The full-backup button in the header immediately triggers a new job. Backend: wrapper router `adminBackupsRouter` in `packages/api-gateway/src/routes/admin/backups.ts` forwards `/api/v1/admin/backups/*` to `BACKUP_SERVICE_URL` (default `http://localhost:3004`). The Authorization header is passed through (the backup-service has its own requireAdmin). Audit log for `backup.full.trigger` and `backup.mbox.import`. i18n DE+EN. New sidebar entry with HardDriveDownload icon.

**v3.18.22** — Security: OAuth2 consent UI (D1). The backend `/oauth2/authorize/complete` previously granted consent blindly on the first call of a non-trusted client — users had no chance to see/reject a third-party app before access. Now: the backend returns `requiresConsent: true` with client info + scope list instead of issuing a code directly. The new `OAuthConsentPage` shows the client name, scopes with German labels (e.g. mail.send → "Send emails on your behalf"), Allow/Deny buttons. "Allow" → second call with `consentConfirmed: true` → code + redirect. "Deny" → RFC-6749-compliant `error=access_denied` back to the client. LoginPage parses `?oauth2=1` from the URL and navigates to the ConsentPage after login instead of `/mail`. New route `/oauth-consent` with AuthGuard without the layout wrapper.

**v3.18.21** — Calendar toolbar filter + print functional. (1) The filter button previously only opened a dropdown with no actual effect — the state was local in the toolbar. Also the Outlook terms (meetings, categories) were meaningless. Reduced to 5 realistic options that map to CalendarEvent fields: recurring appointments, tasks, private/confidential appointments, shared calendars. State lifted to CalendarPage, `fcEvents.filter()` applies them. (2) "Print" printed the whole page with sidebar/toolbar. Fix: `coremail-printing` class on `<html>` + an `@media print` block in `index.css` hides `aside/nav/header`, events get a print border.

**v3.18.20** — Dark-mode patches: LoginPage complete (it was the first page new users see, but had no `dark:` classes at all → completely white card on a dark background). SettingsPage: section headers + form labels + disabled inputs now correct in dark mode. Known open: ComposeWindow (~22 places) + SignatureSection (~9 places) for a dedicated dark-mode sweep in v3.19.

**v3.18.19** — Security: forced 2FA for admin login. The ServerSettings.requireMfaForAdmins toggle had existed for a while but was enforced nowhere. Now the `requireAdmin` middleware in `packages/api-gateway/src/middleware/auth.ts` checks the UserMfa table (totpEnabled OR webAuthnCredentials non-empty) when the toggle is active. Without MFA → 403 `{ code: "MFA_REQUIRED" }`. The BCP frontend API client redirects to the new `MfaRequiredPage` (path `/bcp/mfa-required`) with instructions for activation in the MWA. No chicken-and-egg: the MFA setup routes (`/auth/mfa/*`) are outside the admin lock. Fail-safe on DB error (let through + ERROR log) so that admins are not locked out during a Postgres outage.

**v3.18.18** — Toolbar share button works + CalDAV URL display. (1) **Fix toolbar "Share calendar"**: the button previously only showed a toast, now it opens the ShareCalendarDialog with a picker dropdown in the header if the user has several own calendars. With one it opens directly, with none a toast error. ShareCalendarDialog accepts an optional `ownedCalendars` prop for picker mode. (2) **CalDAV URL display**: new endpoint `GET /api/v1/calendar/caldav-info` returns `accountUrl` (auto-discovery) + per-calendar URL + username + auth hint (app password because of MFA). The ShareDialog shows a new section "External access (CalDAV)" with copy buttons. The sidebar context menu additionally has "Copy CalDAV URL" on own calendars. HTTPS recommended unless explicitly `useHttps=false` (reverse-proxy setup).

**v3.18.17** — Calendar SSE push + free/busy. (A2) **SSE push for the share lifecycle** — new Redis channel `coremail:calendar:shares` (`CHANNEL_CALENDAR_SHARES` in @coremail/core). The backend publishes a JSON event with `affectedUserIds[]` on create/update/delete/self_remove. The SSE handler filters per connection and forwards as `event: calendar:shares` to the affected users. Frontend `useMailEvents()` invalidates the `['calendars']`+`['calendar-shares']` caches → instant live sync. Toast on `action=create`. CalendarPage polling reduced from 60s to 5 min (fallback only). (A4) **Free/busy query** — `POST /api/v1/calendar/freebusy` with body `{ userEmails[], start, end }`. Returns busy slots from calendars with access. CONFIDENTIAL hidden for foreign callers, PRIVATE without subject. Hard limits 90 days / 50 users (DoS). Response shape `{ start, end, users: [{ email, found, busy: [{ start, end, type, subject? }] }] }`.

**v3.18.16** — Calendar sharing quick wins. (A1) **Notification mail to the grantee** — new helper `packages/api-gateway/src/lib/internal-notify.ts` with `notifyUserInbox()` writes directly into the `Message` table (no SMTP round trip, no DKIM/spam check). Triggered in the `POST /calendar/:id/shares` handler. A heuristic (5s threshold) prevents spam on permission update via upsert. (A3) **Per-grantee color** — `CalendarShare.localColor String?` + `PATCH /calendar/mine-shares/:shareId`. The grantee can recolor locally, the owner color remains unchanged. `listAccessibleCalendars` returns `localColor ?? color`. (A8) **Reorder shared section** — `CalendarShare.sortOrder Int @default(0)` + `POST /calendar/mine-shares/reorder`. Context menu with ArrowUp/Down. CalendarSidebar sorts shared calendars by `sortOrder` instead of alphabetically. (C1) **`Calendar.acl Json` dropped** (marked @deprecated in v3.18.14, no code reference). `PublicFolder.acl` remains. The frontend now gets `shareId` directly in the `GET /calendar` response — simplifies self-removal/color change/reorder.

**v3.18.15** — Follow-up release to v3.18.14: (1) **CalDAV WRITE for grantees** — Apple Calendar / Thunderbird Lightning can now create, change, delete appointments in shared calendars (with WRITE permission). Full RFC-3744 DAV ACL: `<DAV:owner>`, `<DAV:current-user-privilege-set>` with `read`/`write`/`bind`/`unbind`/`write-content`, `<DAV:acl>` block for the owner. OPTIONS with `Allow: …, ACL` + `DAV: access-control`. (2) **Private/confidential appointments** (RFC 5545 `CLASS:`) — new field `CalendarEvent.classification` with values `PUBLIC`/`PRIVATE`/`CONFIDENTIAL`. PRIVATE events appear to grantees only as "Busy" (subject/description/location masked), CONFIDENTIAL events are hidden completely. The owner sees everything. Masking applies in REST `GET /events`, CalDAV `GET`/`PROPFIND`/`REPORT`. Dropdown in the MWA new-appointment dialog. (3) **Audit log for sharing** — new actions `calendar.share.create|update|delete|self_remove` with a diff in the `changes` field (compliance gap from v3.18.14 closed, GDPR Art. 32). (4) **i18n EN/ES/IT** for the complete sharing UI texts (25 new keys `cal_share_*` + `cal_event_class_*`).

**v3.18.14** — New feature: share calendars and grant permissions. Users can share their own calendars internally with other users with READ or READ+WRITE permission. Shared calendars appear for the recipient in the new sidebar section "Shared with me" with share icon + permission badge + owner name. **Schema**: new model `CalendarShare` + enum `CalendarPermType` (READ/WRITE), `Calendar.acl` marked `@deprecated`. **Backend**: central helpers `canAccessCalendar()` + `listAccessibleCalendars()` in `packages/api-gateway/src/lib/calendar-access.ts`, REST endpoints `GET/POST/PUT/DELETE /calendar/:id/shares` + `GET /calendar/mine-shares`, event routes now consistently check READ/WRITE permission. Owners are always OWNER. Self-share forbidden. **CalDAV**: grantees see shared calendars in `calendar-home-set` (prefix `[Geteilt]`), PROPFIND/REPORT/GET allowed, PUT/DELETE remain OWNER-only in v3.18.14. `<DAV:current-user-privilege-set>` set correctly. **Frontend**: `ShareCalendarDialog` with user autocomplete (reuses `/contacts?q=`, filtered to user hits, keyboard nav), permission select, list of existing shares with toggle + delete. CalendarPage renders READ-only events as non-editable, the new-appointment dropdown lists only writable calendars. TanStack Query with `staleTime: 30s` + `refetchInterval: 60s` for live sync of revocations. **v3.18.15 (follows)**: full CalDAV WRITE via RFC-3744 DAV ACL.

**v3.18.13** — Two fixes. (1) BCP ExternalContactsPage: first-name/last-name inputs removed from the modal — only the mandatory field "Display name" remains. The backend fields firstName/lastName stay in the DB with default `""` (no schema break). (2) MWA GAL cache live sync: ExternalContacts/DistributionGroups newly created in the BCP were previously only visible after a reload (30s cache). Fix: `staleTime:0` + `refetchOnMount:true` + `refetchOnWindowFocus:true` + `refetchInterval:60_000` for the `/contacts/gal` query, plus an explicit refresh button (RefreshCw icon with spin) in the filter bar.

**v3.18.12** — Public folders: three fixes. (1) Browse modal: clicking a public folder previously only showed a toast, now a new `PublicFolderViewerModal` component with a 2-column layout (list + detail), auto-refresh 30s, sanitized HTML rendering. (2) Folder icon (amber, filled) instead of the Users icon — public folders now look like folders, not like contacts. (3) Section completely invisible without ACL: hide logic via `!isSuccess || !folders || folders.length === 0`. `refetchOnWindowFocus: true` + 30s polling interval — when an admin revokes access, the section disappears on tab focus or after 30s at the latest.

**v3.18.11** — MWA global address book (GAL browser): ContactsPage now has tabs "My address book" / "Global address book". The GAL returns a union of 3 sources (all active users + ExternalMailContacts + DistributionGroups), sorted alphabetically (browse mode without a query), type filter (All/People/External/Groups), counter badge. Clicking a GAL entry → read-only detail panel with type badge, clickable email/phone/mobile, company/department/domain/member count + a "New message" button with the address pre-filled. Backend: `/contacts/gal` extended with browse mode + `type=` filter + pagination. ID prefix (`user-`/`ext-`/`grp-`) marks the source.

**v3.18.10** — Two features: (1) **Image privacy banner (Outlook/Gmail style)** — external `<img>` are replaced with a transparent 1×1 PNG, the original moves to `data-coremail-ext-src`. The banner shows the number of blocked images + a "Show images" button. `cid:` (inline attachments) stay visible — resolved to MinIO URLs. The backend now returns `contentId`+`inline` per attachment. (2) **Queue hardening phase 1**: DSN bounce (RFC 3464, multipart/report) on a permanent send failure, delivered to MAIL FROM with double-bounce protection. 4xx (transient) vs. 5xx (permanent) semantics: SMTP codes are extracted and 5xx is immediately marked final via `job.discard()` — no more 10× retry for "550 User unknown". The SMTP code is persisted in the MAIL_FLOW log. Dynamic QueueSettings: `enqueueOutbound` reads `maxRetryAttempts` + `retryBackoffDelaySec` from the DB.

**v3.18.9** — Three critical backend features: (1) **TransportRule engine** — new engine `packages/storage/src/transport-rules.ts` with 8 conditions × 9 operators and 10 actions (addHeader, removeHeader, redirect, reject, addRecipient, removeRecipient, setSubjectPrefix/Suffix, quarantine, addDisclaimer). Hook in `storeInboundMessage` right after parsing. Rules were previously stored in the DB but never evaluated. (2) **Public folders mail-enabled** — `PublicFolder.email String? @unique`, `verifyRecipient` + `storeInboundMessage` recognize them, mails land as `PublicFolderMessage` directly in the folder. The MWA FolderTree shows them as a "Public folders" section with a purple Users icon. BCP ACL editor with autocomplete dropdown. (3) **SharedMailbox SEND_AS/SEND_ON_BEHALF in REST `/mail/send`** — permission check via `sharedMailboxPerm`, From override, `Sender:` header for "on behalf of".

**v3.18.8** — Four fixes: (1) **ExternalContactsPage cursor bug** — field helper component inline → recreation per render → cursor loss; all fields rebuilt as inline `<div>`. (2) **GroupsPage fragment-key warning** — `<>` to `<Fragment key>`. (3) **CRITICAL: external members of distribution groups received no mail** — `expandRecipients` returned all members as "local", external ones were silently lost. Fix in `queue.ts` + `inbound/handler.ts`: after expansion split again into local/external, external via `relayMessage`/`enqueueOutbound`. (4) **Compose autocomplete with unified address sources** — `/contacts?q=` returns from 2 characters private contacts + GAL users + ExternalMailContacts + DistributionGroups with an ID prefix (gal-/ext-/grp-) to mark the source. GroupsPage MembersPanel with autocomplete dropdown instead of a plain-text input.

**v3.18.7** — Four features combined: (1) **Fix audit actor/target** — `auditMiddleware` ran before `requireAuth` → `apiUser` undefined → actor empty. Fix: logging in `res.on('finish')`, `targetType` set, HTTP status as `success`/`errorMsg`. (2) **Schedule send (Outlook style)** — `Message.scheduledAt/Status/JobId`, BullMQ `delay` job, `POST /mail/messages/:id/cancel-scheduled`, worker cancellation check, ComposeWindow with arrow dropdown + 3 presets + custom picker, MessageReader banner (blue/green/gray) with a "Cancel scheduling" button, CalendarClock icon in the MessageList. (3) **Spam UX (Outlook style)** — `Message.spamScore` persisted, spam banner in the MessageReader (red ≥6.0 / amber ≥3.0 / Junk folder) with score and inline button, ShieldAlert badge in the MessageList. (4) **Audit log v2** — SHA-256 signature for CSV/PDF/JSON exports (`X-CoreMail-Signature` header), JSON export for SIEM (Splunk/Sentinel/ELK), `/anomalies` endpoint (burst, failure burst, critical actions, off-hours), meta-logging against insider threats (GET routes for exports are audited too), frontend with anomalies banner (60s refresh) and signature hint.

**v3.18.5** — Removed: eDiscovery & Legal Hold completely removed from the code. Schema (EDiscoverySearch, LegalHold, EDiscoveryStatus enum, RetentionPolicy.respectLegalHold), backend router `/admin/ediscovery`, frontend page EDiscoveryPage.tsx, sidebar entry, i18n keys (DE+EN), SearchCheck icon import, RbacPage description, RetentionPage checkbox. backup-worker.ts no longer loads legalHold records. Existing tables are dropped automatically via `prisma db push --accept-data-loss`.

**v3.18.4** — Feature: signature editor with images, links and fonts (Gmail/Outlook level). 10 fonts, 5 font sizes, text color (24)/highlight color (12), B/I/U/S, alignment, lists, divider, link (selection → becomes the link / nothing selected → URL as text), image upload (max 500 KB as base64) + URL + drag & drop with overlay, preview/editor toggle. Custom FontSizeExt via TipTap `addGlobalAttributes`. SignatureSection extracted into its own component.

**v3.18.3** — Fix: BCP DNS-check counter and status colors consistent. The counter counted 7 backend records against total=6 (the A record is not in the UI), warnings were not mentioned in the text. New: `VISIBLE_DNS_KEYS` as the single source of truth (mx/spf/dkim/dmarc/autodiscover/ptr), the status text now clearly distinguishes "with warning" and "missing", StatusDot with 3 colors (green/yellow/red), legend without the outdated orange.

**v3.18.2** — UI cleanup + compose rollback: (1) "Outlook" mentions removed from user-facing UI texts (stop-processing hint in RulesSection, View section, app-passwords hint). Technical Outlook references remain (Autodiscover setup, OAuth2 client examples). (2) Fix: the "+ New rule" button gets `shrink-0 whitespace-nowrap px-4`. (3) **Revert**: the v3.18.1 Gmail-style ComposeWindow rolled back to the v3.18.0 variant (Outlook-inspired) — fits the rest of the CoreMail UI better.

**v3.18.1** — Feature: Gmail-style compose-window redesign. 3 modes (small/large/minimized) with smooth transitions, header drag in floating mode, Aa toggle for the format toolbar, schedule send with presets (tomorrow 8/13, Monday, custom), emoji picker, image insert, drag & drop files with overlay, keyboard shortcuts (⌘+Enter, ⌘+⇧+C/B, Esc), draft-save indicator, dark mode everywhere, active:scale animations for tactile feedback.

**v3.18.0** — Feature: Outlook-style inbox rules. Complete user rules in the MWA (conditions/actions/exceptions/stop processing). Engine in `packages/storage/src/mail-rules.ts`, hook in `storeInboundMessage()`, forward/redirect via the existing BullMQ outbound queue with loop protection. Frontend: Settings → "Rules" with drag-reorder + RuleEditorModal (3-step wizard) + context menu "Create rule" in the MessageList. Schema extension: `MailRule.exceptions`, `stopProcessing`, `matchAll`. API: `/user/rules/:id/toggle`, `/reorder`, `/:id/run-now`.

**v3.17.50** — Fix: the MWA context menu "View source" opens an RFC-822 modal instead of a browser tab (fetch + modal analogous to MessageReader, with an EML download button).

**v3.17.49** — Fix: MWA source/EML 401 error fixed (Bearer token as the `?token=` query param). "Not junk" button added in the Junk folder. USER-JUNK blacklist: mail from senders manually marked as junk lands automatically in Junk + rspamd Bayes training. Reply indicator: the `\Answered` flag is set when replying; blue Reply icon in the MessageList.

**v3.17.48** — Fix: SMTP PIPELINING race condition. Inbound mail (server-to-server) was rejected with "503 5.5.1 Bad sequence of commands". Root cause: `handleMailFrom()` + `handleRcptTo()` are async; with PIPELINING, RCPT TO still saw state `'READY'` (MAIL FROM was not finished yet). Fix: a command queue (`cmdQueue: Promise<void>`) serializes all SMTP commands — states are guaranteed to be set in the right order. All commands incl. AUTH steps and `finishData()` via `enqueueCommand()`.

**v3.17.47** — Feature: BCP DNS setup panel. New button "Check DNS setup" in Domains → Edit domain opens a complete panel with all 7 records (A, MX, SPF, DKIM, DMARC, Autodiscover, PTR). Values come live from the SSL/TLS configuration + DKIM key. Each record: type badge, status (✅/❌), copyable host + value. DKIM: 255-character chunk option for netcup & co. SPF expected now with the real server IP.

**v3.17.46** — Fix: DKIM DNS record syntactically correct. The public key was previously exported in SPKI format (contains the algorithm OID wrapper) — DKIM (RFC 6376) expects PKCS#1 (pure RSAPublicKey). Fix: `type: 'spki'` → `type: 'pkcs1'` at all three export sites in `domains.ts` (dkim-record, regenerate-dkim, dns-check).

**v3.17.45** — Feature: BCP queue overview compact + discard function. Stats cards replaced by a compact horizontal strip. The overview now shows all pending messages directly as a table with "Discard" and "Retry now" buttons — no sub-navigation switch needed. Second refresh button removed (was in every subsection).

**v3.17.44** — Fix: the BCP eDiscovery search form lost focus after every letter. The `Field` helper component was defined inline in `CreateSearchModal` → new component reference per render → React unmount/remount of the input → focus lost. Fix: `SearchField` extracted to module level, all 8 usages updated.

**v3.17.43** — Fix: the audit log had written no entries since its introduction (Phase 10). `auditMiddleware` is mounted on `/api/v1/admin` — Express returns `req.path` WITHOUT the mount prefix. The condition `req.path.startsWith('/api/v1/admin/')` was never true. Fix: prefix check + `replace('/api/v1/admin/', '')` removed, relative path parsed correctly.

**v3.17.42** — Feature: edit certificates. The pencil icon (✏️) in the BCP SSL/TLS actions column opens `EditCertModal`: name, service assignment (with exclusivity display + `currentCertId`), auto-renew (Let's Encrypt only) editable. Read-only: type, status, domains, HTTPS proxy status, protocol TLS status. Fix: `PUT /:id` was missing `isActiveProtocol` in the Prisma select.

**v3.17.41** — Fix: the ACME process aborts after 5 min (was endless). `Promise.race()` in `runAcmeIssuance()` + double-start guard (409 when PENDING/RENEWING) + startup cleanup of stale certs + BCP renew button disabled when PENDING.

**v3.17.40** — Fix: exclusive service assignment for certificates. SMTP/IMAP/POP3 can each be assigned to only one cert at a time. `claimServices()` in `certificates.ts` automatically removes services from other certs on create/update. The BCP UI shows occupied services in orange with a tooltip and a takeover hint.

**v3.17.39** — Fix: `applyProtocolCert()` now automatically updates `server_settings.publicHostname` to the primary domain of the activated certificate. The SMTP banner previously always showed `mail.localhost` even when a CA cert for `mail.example.de` was activated. ACME certificates with SMTP/IMAP/POP3 in their services are now activated automatically after issuance.

**v3.17.38** — Auto self-signed cert at setup: `POST /api/v1/setup/complete` now
automatically creates an RSA-2048 self-signed cert for `publicHostname` in the `certificates` table
→ immediately visible in BCP → SSL/TLS, `isActiveProtocol: true` for SMTP/IMAP/POP3.
Spam-filter toggle: `security-filter` reads `rspamdEnabled` + `clamavEnabled` from
SecuritySettings and reacts to Redis `settings:reload` (hot reload without a container restart).

**v3.17.37** — `HTTPS_PROXY_ENABLED` environment variable removed. The integrated HTTPS proxy
is always active — starts port 443 only when a cert with `isActiveHttps=true` exists.
`isTlsProxyEnabled()` removed. BCP banner: only two states left (active / no cert).

**v3.17.35** — Certificate logic: HTTPS proxy (lock) and protocol TLS (server icon)
fully decoupled. Self-signed cert is the default (`server_settings.tlsCert=NULL`).
Deleting an active cert → clearProtocolCert() → SMTP/IMAP/POP3 back to self-signed.
BCP UI: server icon always visible for ACTIVE/EXPIRING certs, delete warning.
Startup: `syncProtocolCertState()` replaces `migrateCertProtocolBinding()`.

**v3.17.34** — DNS check: local server resolver instead of external Google/Cloudflare/Quad9.
API simplified (`ok`, `found`, `warning?` per record). BCP UI: resolver banner,
per-resolver badges, expandable detail view and inconsistency warning removed.

**v3.17.33** — Fix: Redis channel in the startup migration. `migrateCertProtocolBinding()` in
`api-gateway/server.ts` wrongly used `'coremail:settings:reload'` instead of the correct
constant `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`). Without this fix,
SMTP/IMAP/POP3 were not informed about the new CA cert on the first container start after
an upgrade from <3.17.32 — the protocol servers kept running with the self-signed cert despite
correct DB entries.

**v3.17.32** — Fix: TLS cert logic. `activate-https` now ALSO writes the certificate
into `ServerSettings.tlsCert/tlsKey` + sends `CHANNEL_SETTINGS_RELOAD` →
SMTP/IMAP/POP3 load the cert immediately. Root cause of 503 5.5.1: self-signed cert for
the mail protocols, CA cert only for the HTTPS proxy. New `isActiveProtocol` field in
`Certificate`. New `POST /:id/activate-protocol` endpoint. MWA+BCP requirement removed.

**v3.17.31** — DNS check: real multi-resolver verification. `dns.promises.Resolver.
setServers()` — queries Google (8.8.8.8), Cloudflare (1.1.1.1), Quad9 (9.9.9.9) directly
instead of the Docker-internal DNS (127.0.0.11 is cached/stale). PTR/FCrDNS check new.
SPF multiple-record detection (RFC 7208 §3.2 — → permerror). Per-resolver badges
in the BCP with latency + consistency warning + expandable detail view.

**v3.17.30** — Outbound pipeline completely new: structured BullMQ job
(`StructuredMessage` instead of a base64 blob), attachments via MinIO (`outbound-queue/{jobId}/`),
DKIM via the nodemailer transport option (no more mailauth prepend, no order bug).
`ensureRfc5322Headers()` + manual `signMessage()` removed from relay.ts.
The SMTP submission path (rawMessage base64) remains compatible.

**v3.17.29** — RFC 5322 fix: Gmail 550 5.7.1 "From header is missing" + "Message-ID
header missing". Root cause: `from` as a template literal `"${displayName}" <email>`
→ an empty quoted string violates RFC 5322 §3.4. Fix: Nodemailer address object
`{ name: displayName.trim(), address: email }`. `ensureRfc5322Headers()` in relay.ts
as a safety net (removed in v3.17.30 — the pipeline now guarantees the headers).

**v3.17.28** — Audit-log complete overhaul: PDF export, statistics dashboard
(KPI cards, top actors, top actions — auto-refresh 30s), extended filters
(actorEmail/ipAddress/searchText), CSV bug fix (token via query), date bug fix
(UTC), purge route removed (compliance immutability GDPR/SOX/HIPAA)

**v3.17.28** — Local delivery: `expandRecipients()` extracted from inbound into
`handlers/expand.ts`; now called in all paths (inbound/submission/outbound-queue).
`storeInboundMessage()` now also supports SharedMailbox.
Distribution groups + aliases are resolved correctly on local delivery.

**v3.17.21** — ESMTP audit: CRAM-MD5, SMTPUTF8, CHUNKING removed from EHLO + BCP
(were stub-only without implementation). Remain active: STARTTLS, AUTH PLAIN+LOGIN,
PIPELINING, SIZE, 8BITMIME, ENHANCEDSTATUSCODES.

**v3.17.20** — DSN stub removed from EHLO (RFC 3461 not implemented).

**v3.17.19** — STARTTLS on port 25 disabled with a self-signed cert
(X509Certificate.issuer === subject detection) — Outlook/Exchange ECONNRESET fix.

**v3.17.18** — SSE live update on new mail (inbox) + manual
refresh button in the FolderTree (MWA). SSE auth via the `?token=` query param.

**v3.17.17** — The Autodiscover URL now uses `autodiscover.{root-domain}` instead of
the identical hostname (Microsoft Exchange spec).

**v3.17.16** — Fix: api-gateway `/auth/login` had the same pepper bug as v3.17.13
(direct `bcrypt.compare(password + pepper, hash)` instead of `verifyPassword()` with
sha256+pepper). Login worked on port 3003 (auth-service) but not on
port 3000 (api-gateway). Fixed in `routes/auth.ts`, `routes/setup.ts`, `routes/user.ts`.

**v3.17.15** — Distribution-group form (email + domain side by side like user creation),
JWT token refresh in BCP + MWA (prevents auto-logout during active use),
distribution groups in the MWA recipient autocomplete, BCP cleanup (ResourcesPage +
OrganisationPage removed)

**v3.17.14** — Mailbox delegation (user B can access user A's mailbox via the
new `MailboxDelegate` Prisma model, admin API `GET/POST/DELETE /admin/mailboxes/:id/delegates`,
user API `GET /mail/delegated-mailboxes`, BCP UI in the expanded mailbox row)

**v3.17.13** — Fix: `auth-service/local/index.ts` pepper mismatch (sha256 + pepper vs
direct pepper append) — login failed despite a correct password

**v3.17.12** — BCP fully translated EN/DE: MailboxesPage, DomainsPage, QueuesPage,
DashboardPage, QuarantinePage + ~1288 i18n keys; all package.json versions synchronized
to 3.17.12

## Auth Architecture (CRITICAL — historical pitfalls)

Password hashing **always** uses `hashPassword()` and `verifyPassword()` from
`@coremail/core`. Both use the **same** logic:
```
bcrypt(sha256(password + PEPPER))
```

❌ **NEVER** call `bcrypt.compare(password + PEPPER, hash)` directly — that skips
the sha256 step and makes hash and verify incompatible.

Login routes that use these functions (all fixed at the same time in v3.17.13/v3.17.28):
- `packages/auth-service/src/local/index.ts` — IMAP/SMTP/POP3 + auth-service port 3003
- `packages/api-gateway/src/routes/auth.ts` — REST API /auth/login (port 3000)
- `packages/api-gateway/src/routes/setup.ts` — initial setup
- `packages/api-gateway/src/routes/user.ts` — password change
- `packages/smtp-server/src/auth/verifier.ts` — SMTP AUTH
- `packages/pop3-server/src/session.ts` — POP3 AUTH

Also: **`@coremail/core` is the source of truth** — never import `bcrypt` directly in
routes when user passwords are involved (except for OAuth client secrets
and MFA backup codes — those need no pepper).

*Last updated: 2026-10-28 (v5.8.0 — admin CLI, new compose, EWS↔MAPI; v5.7.1 — JMAP server; v5.7.0 — MAPI over HTTP optionally back + build hardening; v5.6.1 — distribution groups removed; v5.6.0 — OAuth2 / Modern Auth removed; v5.5.0 — IMAP4rev2 compliance; v5.4.0 — MAPI completely removed)*
