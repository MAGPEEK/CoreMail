# CoreMail

> 🇬🇧 English · 🇩🇪 [Deutsche Fassung](README.de.md)

> **Coremail — the open-source mail server for small and medium-sized environments.**  
> Built on React + Node.js/TypeScript, container-first, fully self-hosted.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-5.9.0-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)
[![IMAP4rev2](https://img.shields.io/badge/IMAP4-rev2-blue.svg)](https://datatracker.ietf.org/doc/html/rfc9051)
[![CalDAV](https://img.shields.io/badge/CalDAV%2FCardDAV-supported-blue.svg)](https://datatracker.ietf.org/doc/html/rfc4791)

📄 **[docker-compose.yml](infra/docker/docker-compose.yml)** — ready to run: generate `.env`, `up -d`, done  
⌨️ **[docs/cli.md](docs/cli.md)** — admin CLI `coremail`: users, mailboxes, connectors, SMTP banner, certificates  
📋 **[COMMANDS.md](COMMANDS.md)** — command reference: check services, create users, queues, logs, backup  
📝 **[CHANGELOG.md](CHANGELOG.md)** — complete version history

**CoreMail** is a complete, self-hosted mail server for small and medium-sized businesses with **10–500 users** — no licence fees, no vendor lock-in, full data sovereignty.

**🎯 Standard mail protocols.** CoreMail speaks **IMAP4rev2** (RFC 9051) + **JMAP** (RFC 8620/8621, since v5.7.1) + **SMTP submission** + **POP3** + **CalDAV/CardDAV** + **ActiveSync** — every client (Apple Mail, Thunderbird, Outlook, K-9 Mail, eM Client, iOS Mail) works natively. Optionally enabled: **MAPI over HTTP + EWS** for Outlook 2013–2021 as an "Exchange account". **App passwords** for MFA-compatible sign-in. No VPN, no connector, no third-party software.

> **Current version: v5.9.0** — English-only repository (German README: [README.de.md](README.de.md)) · **admin CLI `coremail`** ([docs](docs/cli.md)) · **new, commented `docker-compose.yml`** with mandatory-value check of the .env · EWS only together with MAPI over HTTP (default off) · JMAP server (v5.7.1, [docs](docs/jmap.md)) · distribution groups removed (v5.6.1) · OAuth2 server removed (v5.6.0) · IMAP4rev2 (v5.5.0) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/r/magpeek/coremail-app)
>
> **Note on Outlook (v5.7.0)**: MAPI over HTTP is included again, but **off by default** (BCP → Server → "MAPI over HTTP"). Once enabled, Outlook 2013–2021 connect as a native Exchange account (Basic Auth). Outlook 2024 LTSC and Microsoft 365 Classic enforce Modern Auth against Microsoft Entra/ADFS — there, **Outlook → "Other email accounts" → IMAP** remains the way to go, with calendar + contacts via CalDAV/CardDAV (Apple Calendar, Outlook CalDav Synchronizer plugin, Thunderbird Lightning). The new Outlook and Outlook for Mac do not support MAPI.
>
> **Note (since v5.6.0)**: The OAuth2 authorization server under `/oauth2/*` has been removed entirely — in practice, XOAUTH2 has no mainstream client UI support for non-Microsoft servers. JWT is back on HS256 (`JWT_SECRET`). REST API + MWA/BCP use session JWTs via `/auth/login`; mail clients use app passwords.
>
> **Note (since v5.6.1)**: Distribution groups have been removed — modern teams use Shared Mailboxes (with aliases) for team mailboxes, or external listserv tools (Mailman, listmonk) for pure outbound distribution lists.

---

## Contents

1. [Features](#features)
2. [Connecting Clients](#connecting-clients)
3. [Quick Start](#quick-start)
4. [Docker Compose](#docker-compose)
   - [Admin CLI `coremail`](#admin-cli-coremail-since-v580)
5. [Access](#access)
6. [Configuration](#configuration)
7. [DNS Setup](#dns-setup)
8. [TLS Certificates](#tls-certificates)
9. [Command Reference](#command-reference)
10. [Docker Hub](#docker-hub)
11. [Version History](#version-history)
12. [License](#license)

---

## Features

### Email Protocols

| Feature | Status | RFC |
|---------|--------|-----|
| **SMTP** inbound (port 25) + submission (465 implicit TLS, 587 STARTTLS) | ✅ | 5321 + 6409 |
| SMTP outbound with MX lookup & DKIM signing | ✅ | 6376 |
| **IMAP4rev2** (port 143 STARTTLS, 993 implicit TLS) | ✅ | **9051** |
| IMAP capabilities: AUTHENTICATE PLAIN/LOGIN, IDLE, CONDSTORE, ESEARCH, SPECIAL-USE, LIST-EXTENDED, NAMESPACE, MOVE, UNSELECT, UIDPLUS, ID | ✅ | 2087, 2971, 3502, 3691, 4314, 4978, 5161, 5256, 5267, 5258, 6154, 6851 |
| **POP3** (port 110 STLS, 995 implicit TLS) + SASL PLAIN/LOGIN + app-password support | ✅ | 1939 + 5034 |
| **JMAP** (Core + Mail + WebSocket/Blob/Quota/Sharing/VAPID) | ✅ | 8620, 8621, 8887, 9404, 9425, 9670, 9749 |
| MAPI over HTTP + EWS — Outlook 2013–2021 "Exchange account" (optional, default off) | ⚙️ | MS-OXCMAPIHTTP, MS-OXWSCORE |
| Admin CLI `coremail` inside the container (users, mailboxes, connectors, banner, certificates) | ✅ | — |
| Autodiscover v1 (XML) + v2 (JSON) — IMAP/SMTP/ActiveSync | ✅ | MS-OXDISCO |
| ActiveSync EAS 14.1 — iOS Mail, Android, Outlook Mobile | ✅ |
| MWA — Mail Web Access (React, Exchange-like layout) | ✅ |
| RFC 822 source view (modal in MWA) | ✅ |
| Recipient autocomplete in compose (To/CC/BCC, keyboard navigation) | ✅ |
| Resizable panels in MWA (folder tree / list / reading pane) | ✅ |
| Shared Mailboxes with full folder structure (Inbox, Sent, Trash, …) | ✅ |
| Shared Mailbox reader in MWA — "Open another mailbox" via account dropdown | ✅ |
| Folder CRUD in Shared Mailboxes (new folder, rename, delete, default folders protected) | ✅ |
| Email aliases per user mailbox and Shared Mailbox | ✅ |
| Room and equipment mailboxes with auto-accept | ✅ |
| Out-of-office assistant | ✅ |
| Inbox rules & transport rules + 9 Exchange templates (disclaimer, CEO phishing, PCI-DSS, …) | ✅ |
| Full-text search (< 200 ms, PostgreSQL GIN index) | ✅ |
| S/MIME — signing, encryption, verification | ✅ |
| SMTP gateway mode (relay to upstream MTA) | ✅ |
| Retention policies, Exchange 2019 compliant (DPT/RPT/personal tags · 8 templates · Recoverable Items) | ✅ |
| Managed Folder Assistant (tag hierarchy, soft/hard delete, legal-hold-aware) | ✅ |
| PowerShell remoting (EMS with 14+ cmdlets — Mailbox/Domain/TransportRule/ResourceMailbox) | ✅ |

### Calendar & Collaboration

| Feature | Status |
|---------|--------|
| Personal calendar | ✅ |
| Shared team calendars | ✅ |
| Meeting requests (iCal standard) | ✅ |
| Free/busy lookup | ✅ |
| Room and resource booking with auto-accept | ✅ |
| CalDAV (iOS, Android, Thunderbird) | ✅ |
| Contacts & CardDAV | ✅ |
| Tasks & notes | ✅ |
| Global Address List (GAL) | ✅ |

### Security

| Feature | Status |
|---------|--------|
| SPF / DKIM / DMARC / ARC validation | ✅ |
| DKIM signing of outgoing email | ✅ |
| DNSBL (Spamhaus ZEN, SpamCop, configurable) | ✅ |
| Greylisting with automatic whitelist | ✅ |
| Country filtering (MaxMind GeoIP) | ✅ |
| ClamAV antivirus (separate container) | ✅ |
| Rspamd 4.0 anti-spam (Bayes, self-learning, separate container) | ✅ |
| Address blacklist (global / domain / user) | ✅ |
| Attachment filter (MIME types, double extensions) | ✅ |
| Quarantine management with detail view and MIME preview | ✅ |
| TLS (STARTTLS + implicit TLS) on all ports | ✅ |
| Integrated HTTPS proxy (port 443, hot reload, managed in BCP) | ✅ |
| DNS hardening (trusted resolvers, cross-validation, integrity check) | ✅ |
| eDiscovery & Legal Hold (cross-mailbox search, MBOX export) | ✅ |
| Message trace with CSV export | ✅ |
| SMTP brute-force protection & rate limiting | ✅ |

### Authentication

| Feature | Status |
|---------|--------|
| Local login (bcrypt + pepper) | ✅ |
| LDAP / Active Directory (managed in BCP, attribute mapping, sync) | ✅ |
| SSO via OIDC / OAuth2 (Azure AD, Keycloak, Google, Authentik, Okta) | ✅ |
| SAML 2.0 | ✅ |
| MFA: TOTP (authenticator app) | ✅ |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) | ✅ |
| MFA: backup codes | ✅ |
| App passwords for mail clients (IMAP/SMTP/POP3/EAS — MFA-compatible) | ✅ |
| Password change in the web client (MWA) | ✅ |

### Administration (BCP Admin Panel)

| Feature | Status |
|---------|--------|
| RBAC with 7 roles | ✅ |
| SMTP queue management (BullMQ-native, retry, dead letter, retention) | ✅ |
| DNS check in BCP SMTP configuration (MX, SPF, DKIM, DMARC, Autodiscover, PTR — live) | ✅ |
| DNS records table UI with status indicators (green/yellow) | ✅ |
| Message trace with filters & CSV export | ✅ |
| Quarantine management with detail slide-over and MIME preview | ✅ |
| SMTP infrastructure configuration (ESMTP, banner, relay, greylisting) | ✅ |
| SSL/TLS management (integrated HTTPS proxy, certificate upload) | ✅ |
| SSO provider management (OIDC/OAuth2, SAML, quick-select presets) | ✅ |
| LDAP/AD connection management (attribute mapping, connection test, sync) | ✅ |
| Rspamd integration (thresholds, Bayes training, module overview) | ✅ |
| Audit log (every admin action traceable) | ✅ |
| Service configuration (live, no restart required) | ✅ |
| Log viewer with per-service log level | ✅ |
| Backup: MBOX/EML export (self-service per user) | ✅ |
| Backup: admin full backup to S3 (point-in-time recovery) | ✅ |
| Kubernetes Helm chart (HPA, HA) | ✅ |
| Structured JSON logs (pino) + per-service log level | ✅ |
| Web Push / VAPID notifications | ✅ |
| Automatic mailbox provisioning on first login | ✅ |

### MWA User Settings

| Feature | Status |
|---------|--------|
| Edit display name | ✅ |
| Change password (strength meter, visibility toggle) | ✅ |
| Signatures (rich-text editor, auto-insert) | ✅ |
| Out-of-office assistant with date-range calendar integration | ✅ |
| Storage overview per folder with donut chart | ✅ |
| Reading pane layout (right / bottom / off) | ✅ |
| Message density (compact / normal / comfortable) | ✅ |
| Conversation view (on/off) | ✅ |
| Theme: light / dark / system + 6 accent colours | ✅ |
| Security: app passwords & 2FA management | ✅ |

---

## Connecting Clients

CoreMail works with every standard mail client. The recommended configuration depends on the client:

### Setup Overview

| Client | Account type | Mail | Calendar + contacts |
|--------|--------------|------|---------------------|
| **Outlook 2024 LTSC** | "Other email accounts" → **IMAP** | IMAP+SMTP | Outlook CalDav Synchronizer plugin (free OSS) |
| **Outlook 2013–2021** | **IMAP** (default) — or "Exchange account" when **MAPI over HTTP + EWS** is enabled in the BCP | IMAP+SMTP or MAPI | Outlook CalDav Synchronizer (IMAP) · native (MAPI) |
| **Apple Mail** (Mac + iOS) | "Other Mail Account" → IMAP | IMAP+SMTP | Apple Calendar/Contacts separately (CalDAV/CardDAV) |
| **Thunderbird** | IMAP account | IMAP+SMTP | Lightning (CalDAV) + TbSync (CardDAV) |
| **eM Client** | IMAP account | IMAP+SMTP | CalDAV+CardDAV natively |
| **K-9 Mail** (Android) | IMAP account | IMAP+SMTP | DAVx⁵ for CalDAV/CardDAV |
| **Browser** | — | **MWA** at `https://<your-host>/` | incl. calendar/contacts on the web |

### IMAP Settings

| Setting | Value |
|---------|-------|
| IMAP server | `mail.<your-domain>` |
| IMAP port | **993** (implicit TLS, recommended) or **143** (STARTTLS) |
| SMTP server | `mail.<your-domain>` |
| SMTP port | **465** (implicit TLS) or **587** (STARTTLS, recommended) |
| Authentication | **PLAIN** or **LOGIN** (SASL) |
| Username | `max@firma.de` (full email address) |
| Password | account password OR **app password** (required when MFA is enabled) |

### JMAP (since v5.7.1)

For JMAP-capable clients (e.g. Thunderbird with JMAP support, Ltt.rs, your own web apps):

| Setting | Value |
|---------|-------|
| Discovery | `https://mail.example.de/.well-known/jmap` |
| Session URL | `https://mail.example.de/jmap/session` |
| Username | full email address |
| Password | account password or **app password** (required when MFA is enabled) |
| DNS (optional) | `_jmap._tcp.example.de. SRV 0 1 443 mail.example.de.` |

Push: EventSource (`/jmap/eventsource`) or WebSocket (`wss://…/jmap/ws`, subprotocol `jmap`).
Toggle: BCP → Server → "JMAP" (default: on). Details: [docs/jmap.md](docs/jmap.md).

### App Passwords (for MFA Accounts)

With 2FA enabled, mail clients can no longer use the regular password — the MFA code cannot be transmitted via IMAP/SMTP. Solution: create an **app password** per client.

1. Sign in to MWA → Settings → **Security** → "App passwords"
2. "New app password" → enter a name (e.g. "Apple Mail Mac")
3. Copy the generated 32-character password
4. Enter it as the password in the client
5. If lost/stolen: revoke that single app password — the others remain valid

### Note on Outlook 2024 LTSC

Outlook 2024 LTSC enforces **Modern Auth (OAuth2)** on Exchange endpoints and accepts only Microsoft Entra ID as identity provider. For non-Microsoft servers (such as CoreMail) the practical configuration there is **IMAP+SMTP** (via "Other email accounts"). The Exchange path **MAPI over HTTP + EWS** is optional (BCP → Server, default off) and only helps Outlook 2013–2021, which still speak Basic Auth. Since v5.8.0, EWS is no longer a standalone client path: `/EWS/*` only responds while this toggle is active.

---

## Quick Start

> **Prerequisites:** Docker ≥ 24 and Docker Compose ≥ 2.20.  
> Node.js is **not** required for pure Docker operation.

### 1. Clone the repository

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Set up the environment

```bash
bash scripts/setup.sh
```

The script checks Docker, creates the `.env` with randomly generated secrets and shows the next steps. Alternatively, by hand:

```bash
cp .env.example .env
```

### 3. Check the `.env`

`scripts/setup.sh` has already set the five mandatory values to random secrets. For a manual setup, replace:

```env
JWT_SECRET=<openssl rand -hex 32>
PEPPER=<openssl rand -hex 32>
POSTGRES_PASSWORD=<openssl rand -hex 20>
REDIS_PASSWORD=<openssl rand -hex 20>
MINIO_ROOT_PASSWORD=<openssl rand -hex 20>
```

The mail hostname is set in the setup wizard or in the BCP, not in the `.env`.

### 4. Configure TLS

**Option A — Integrated HTTPS proxy (default):**  
CoreMail terminates TLS itself. After startup, upload a certificate in the BCP under **SSL/TLS**. Port `443` is already mapped in the `docker-compose.yml`.

**Option B — External reverse proxy:**  
Traefik, Caddy, nginx or the Synology DSM Application Portal handle TLS.  
Comment out `"443:443"` in the `docker-compose.yml`.

### 5. Start the stack

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

All services are ready after roughly 60–90 seconds.

### 6. Create the first admin account

On the first visit to `https://<MAIL_HOSTNAME>/bcp/`, the setup wizard for creating the first admin account appears automatically.

Alternatively via the API:

```bash
curl -s -X POST https://<MAIL_HOSTNAME>/api/v1/admin/setup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@meinedomain.de",
    "password": "secure-password",
    "displayName": "Administrator"
  }'
```

---

## Docker Compose

### Structure of the CoreMail Stack

CoreMail consists of **six containers** (one custom image, five standard images):

| Container | Image | Purpose |
|-----------|-------|---------|
| `coremail` | `magpeek/coremail-app:5.9.0` | All mail services + webmail + admin panel + CLI |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-spam engine (Bayes, DKIM/SPF/DMARC, fuzzy) |
| `clamav` | `clamav/clamav:stable` | Open-source antivirus (GPL), freshclam updates |
| `postgres` | `postgres:16-alpine` | Database for mail, users, calendars |
| `redis` | `redis:7-alpine` | Sessions, SMTP queue (BullMQ), live updates |
| `minio` | `minio/minio` | Object storage for attachments, quarantine and backups |

The app container (`coremail`) internally holds all mail services — SMTP, IMAP, POP3, JMAP, ActiveSync, CalDAV/CardDAV, optionally MAPI/EWS, webmail, admin panel and the admin CLI — managed by `supervisord`. Externally, port 3000 (HTTP), 80/443 (ACME + HTTPS) and the mail ports (25, 465, 587, 143, 993, 110, 995) are exposed.

### The `docker-compose.yml`

Since v5.8.0, `infra/docker/docker-compose.yml` is reduced to the essentials and commented throughout. It needs exactly **five values** from the `.env` — if one is missing, `docker compose up` aborts immediately with a clear message instead of failing later with a half-started stack:

```yaml
# Excerpt — full file in the repository
services:
  coremail:
    image: magpeek/coremail-app:${COREMAIL_VERSION:-5.9.0}
    environment:
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET missing in .env  →  openssl rand -hex 32}
      PEPPER:     ${PEPPER:?PEPPER missing in .env  →  openssl rand -hex 32}
      DATABASE_URL: postgresql://coremail:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing in .env}@postgres:5432/coremail
      REDIS_URL:    redis://:${REDIS_PASSWORD:?REDIS_PASSWORD missing in .env}@redis:6379
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD missing in .env}
      RSPAMD_URL:  http://rspamd:11334
      CLAMAV_HOST: clamav
    ports:
      - "25:25"     # SMTP inbound          - "143:143"  # IMAP
      - "465:465"   # SMTPS                 - "993:993"  # IMAPS
      - "587:587"   # SMTP submission       - "110:110"  # POP3  (optional)
      - "80:3000"   # Let's Encrypt + redirect   - "995:995"  # POP3S (optional)
      - "443:443"   # HTTPS (integrated TLS proxy)
      - "3000:3000" # HTTP without TLS — initial setup / your own reverse proxy
  postgres: { image: postgres:16-alpine }
  redis:    { image: redis:7-alpine }
  minio:    { image: minio/minio:latest }
  rspamd:   { image: rspamd/rspamd:4.0.0 }
  clamav:   { image: clamav/clamav:stable }
```

Everything else (hostname, domains, DNS templates, certificates, connectors, banner) is configured **after startup** in the admin panel at `http://<server>:3000/bcp/` or via the CLI — not in the compose file. Internal service ports and URLs have fixed defaults in the image and no longer appear in the compose file.

Behind your own reverse proxy (Traefik, Caddy, nginx, Synology): remove the lines `"80:3000"` and `"443:443"` and point the proxy at `http://<server>:3000`.

### Common Commands

```bash
# Start the stack (images are pulled from Docker Hub automatically)
docker compose -f infra/docker/docker-compose.yml up -d

# Check the status of all containers
docker compose -f infra/docker/docker-compose.yml ps

# Follow logs in real time
docker compose -f infra/docker/docker-compose.yml logs -f coremail

# Restart a single service inside the container
docker exec coremail supervisorctl restart api-gateway

# Stop the stack (data is preserved)
docker compose -f infra/docker/docker-compose.yml down

# Upgrade to a new version
docker compose -f infra/docker/docker-compose.yml pull && \
docker compose -f infra/docker/docker-compose.yml up -d
```

### Viewing Logs

```bash
# All containers, live
docker compose -f infra/docker/docker-compose.yml logs -f

# CoreMail app only
docker compose -f infra/docker/docker-compose.yml logs -f coremail
```

---

## Access

| URL | Description |
|-----|-------------|
| `https://<MAIL_HOSTNAME>/` | Webmail (MWA — Mail Web Access) |
| `https://<MAIL_HOSTNAME>/bcp/` | Admin panel (BCP — Backend Control Panel) |
| `https://<MAIL_HOSTNAME>/.well-known/jmap` | JMAP discovery |
| `https://<MAIL_HOSTNAME>/EWS/Exchange.asmx` · `/mapi/` | Outlook "Exchange account" (only with **MAPI over HTTP + EWS** enabled) |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover |
| `http://localhost:9001` | MinIO web console (local only) |

**Mail ports:**

| Port | Protocol | Encryption |
|------|----------|------------|
| 25 | SMTP (inbound) | STARTTLS |
| 465 | SMTPS (submission) | Implicit TLS |
| 587 | SMTP submission | STARTTLS |
| 143 | IMAP | STARTTLS |
| 993 | IMAPS | Implicit TLS |
| 110 | POP3 | STARTTLS |
| 995 | POP3S | Implicit TLS |

---

## Configuration

The `.env` contains only what the stack needs to know before its first start. `bash scripts/setup.sh` generates it with random values.

```env
# ── Required ───────────────────────────────────────────────
JWT_SECRET=…            # openssl rand -hex 32 — signs login tokens
PEPPER=…                # openssl rand -hex 32 — NEVER change afterwards
POSTGRES_PASSWORD=…     # internal database passwords
REDIS_PASSWORD=…
MINIO_ROOT_PASSWORD=…

# ── Optional (defaults in parentheses) ─────────────────────
#COREMAIL_VERSION=5.9.0         # image tag
#LOG_LEVEL=info                 # error | warn | info | debug
#TZ=Europe/Berlin
#MINIO_ROOT_USER=minioadmin
#BACKUP_SCHEDULE=0 2 * * *      # full backup (cron, UTC)
#BACKUP_RETENTION_DAYS=30
#RETENTION_SCHEDULE=0 3 * * *   # retention policies
#COREMAIL_CPU_LIMIT=2  /  COREMAIL_MEM_LIMIT=2g
#VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY= / VAPID_SUBJECT=   # browser push (npx web-push generate-vapid-keys)
#HTTPS_PORT=8443                # if 443 is already taken on the host
```

Hostname, domains, certificates, connectors, spam/antivirus settings, LDAP/SSO and backups are managed in the **BCP** (`/bcp/`) or via the **CLI** and stored in the database.

---

## DNS Setup

Create the following DNS records for `mail.domain.de`:

```dns
; A record
mail.domain.de.           A     <server-ip>

; MX record
domain.de.                MX 10 mail.domain.de.

; SPF
domain.de.                TXT   "v=spf1 mx -all"

; DKIM (copy the public key from the BCP admin panel)
coremail._domainkey.domain.de. TXT "v=DKIM1; k=rsa; p=<public-key>"

; DMARC
_dmarc.domain.de.         TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@domain.de"

; Autodiscover SRV (for older Outlook versions)
_autodiscover._tcp.domain.de. SRV 0 0 443 mail.domain.de.
```

The DKIM public key can be found in the BCP under **Domains → select domain → DKIM**.

Since v3.17.6, CoreMail verifies all DNS records live in the BCP under **SMTP configuration → DNS check** — including status indicators for MX, SPF, DKIM, DMARC, Autodiscover and PTR.

---

## TLS Certificates

CoreMail supports two TLS operating modes:

### Option A — Integrated HTTPS Proxy (default)

Since v3.17.0, CoreMail terminates TLS itself (Node.js HTTPS on port 443).  
Upload and activate the certificate in the BCP under **Server → SSL/TLS**. Hot reload without restart.

### Option B — External Reverse Proxy

For operation behind Traefik, Caddy, nginx, DSM Application Portal or similar:  
Comment out the line `"443:443"` in the `docker-compose.yml`. CoreMail then runs on port 3000 (HTTP) only.

**Let's Encrypt with Certbot (for Option B with your own nginx):**

```bash
certbot certonly --standalone -d mail.meinedomain.de
```

Self-signed certificates are sufficient for local development:

```bash
bash scripts/gen-dev-certs.sh
```

---

## Admin CLI `coremail` (since v5.8.0)

The CLI ships inside the app image and talks to the same admin API as the BCP — same roles, same checks, same audit log. Full reference: **[docs/cli.md](docs/cli.md)**.

```bash
alias coremail='docker exec -it coremail coremail'

coremail login -u admin@example.de                   # save a session (prompts for TOTP)
coremail user list --domain example.de               # list users
coremail user create max@example.de --name "Max Muster" --quota 10GB
coremail user delete max@example.de
coremail mailbox list --sort used                    # mailboxes with usage
coremail shared create team@example.de --name "Team" # Shared Mailbox …
coremail shared grant team@example.de max@example.de FULL_ACCESS SEND_AS   # … grant permissions
coremail connector status                            # SMTP/IMAP/POP3/JMAP/MAPI+EWS with ports and state
coremail connector disable pop3                      # connector off (on: enable; single port: --port 995)
coremail connector listener set <id> --port 1143 --ssl false
coremail smtp banner set "mail.example.de ESMTP"     # SMTP greeting (reset: default)
coremail cert letsencrypt --domains mail.example.de,autodiscover.example.de \
    --email admin@example.de --services SMTP,IMAP,POP3
coremail cert activate mail.example.de --https --protocol
coremail --json user list | jq                       # everything available as JSON, too
```

For scripts: `COREMAIL_ADMIN_EMAIL`/`COREMAIL_ADMIN_PASSWORD` (plus `COREMAIL_ADMIN_TOTP`) or a ready-made `COREMAIL_TOKEN`; against remote servers use `--server https://mail.example.de`.

---

## Command Reference

All important commands for day-to-day operation are collected in **[COMMANDS.md](COMMANDS.md)**:

| Section | Contents |
|---------|----------|
| Containers & services | Start/stop the stack, service status, health check |
| Admin token | Authentication against the REST API |
| Managing users | Create, set password, quota, role, provision mailbox |
| Domains | Add domain, fetch DKIM key |
| Queues | Queue stats, job details, retry, dead letter, flush queue |
| Logs & diagnostics | Container logs, audit log, per-service log level |
| Message trace | Message trace, filtering, CSV export |
| Database | PostgreSQL queries (users, mail, storage) |
| Redis | Queue lengths, sessions, greylisting |
| Testing SMTP | Connection test, TLS check, send test mail |
| Backup | Database dump, restore, MinIO backup |
| Updates | Upgrade to a new image version |

```bash
# Examples

# Health check
curl -s http://localhost:3000/healthz | jq

# Queue stats (BullMQ-native)
curl -s http://localhost:3000/api/v1/admin/queues/stats \
  -H "Authorization: Bearer $TOKEN" | jq

# Show dead-letter jobs
curl -s "http://localhost:3000/api/v1/admin/queues/jobs?state=failed" \
  -H "Authorization: Bearer $TOKEN" | jq '.jobs[].failedReason'

# Retry all dead-letter jobs
curl -s -X POST http://localhost:3000/api/v1/admin/queues/retry-failed \
  -H "Authorization: Bearer $TOKEN" | jq

# Check Rspamd status
curl -s http://localhost:3000/api/v1/admin/security/status \
  -H "Authorization: Bearer $TOKEN" | jq
```

→ **[Full command reference in COMMANDS.md](COMMANDS.md)**

---

## Docker Hub

CoreMail consists of **a single custom image** — all services in one container, managed by `supervisord`.

| Image | Contents |
|-------|----------|
| [`magpeek/coremail-app`](https://hub.docker.com/r/magpeek/coremail-app) | All services + MWA/BCP frontends |

Rspamd and ClamAV run from official standard images — no custom image needed.

```bash
# Pull and start the latest version
docker compose -f infra/docker/docker-compose.yml pull
docker compose -f infra/docker/docker-compose.yml up -d

# Specific version
docker pull magpeek/coremail-app:5.9.0
```

**Multi-arch:** The image is built for `linux/amd64` and `linux/arm64` (Synology NAS, Raspberry Pi, Apple Silicon).

---

## Version History

### v5.x — IMAP4rev2 + RFC Compliance + Stack Slim-down

| Version | Highlights |
|---------|-----------|
| **v5.9.0** | **English-only repository**: README, CHANGELOG, docs, code and infra comments, CLI output in English; German README kept as `README.de.md`. Ships the v5.8.0 features as the first published image (`magpeek/coremail-app:5.9.0`). |
| **v5.8.0** | **Admin CLI `coremail`** (new package `cli`, in the image at `/usr/local/bin/coremail`): list, create and delete users/mailboxes/Shared Mailboxes; enable/disable SMTP/IMAP/POP3/JMAP/MAPI connectors, listener ports/TLS; SMTP banner; certificates (self-signed, Let's Encrypt, activate, renew). **New `docker-compose.yml`**: only the necessary parameters, mandatory values with startup-abort check, `setup.sh` generates the `.env`. **EWS coupled to the MAPI toggle**: `/EWS/*`, `/OAB/*` and Autodiscover EWS only with "MAPI over HTTP + EWS" (default off). |
| **v5.7.1** | **JMAP server** — new package `jmap-server` (port 3006): RFC 8620 Core, 8621 Mail (Mailbox/Email/Thread/Identity/EmailSubmission/SearchSnippet/VacationResponse), 8887 WebSocket, 9404 Blob, 9425 Quota, 9670 Principals/Sharing, 9749 VAPID. Discovery `/.well-known/jmap`, push via EventSource + WebSocket, toggle in the BCP (default on). See [docs/jmap.md](docs/jmap.md). |
| **v5.7.0** | **MAPI over HTTP optionally back** (default off, toggle in the BCP, hot reload, 404 when off). pnpm pinned to 11, 70 stale `src/*.js` artifacts removed, `noEmit` in frontend tsconfigs. |
| **v5.6.1** | **Distribution groups (DistributionGroups) removed entirely** — rarely used; the use case is better served by Shared Mailboxes (team mailboxes) or an external listserv tool. Schema drop of 2 tables + enum, BCP page removed, EMS cmdlets removed. |
| **v5.6.0** | **OAuth2 / Modern Auth removed entirely from the stack** (~970 LOC + 4 Prisma tables). XOAUTH2 has no mainstream client UI for non-Microsoft servers. JWT back on HS256 (`JWT_SECRET`). Mail clients use app passwords, MWA/BCP session JWTs. |
| **v5.5.0** | **IMAP4rev2** (RFC 9051) compliance: STARTTLS + AUTHENTICATE SASL + UNSELECT + ID. Docs updated for the MAPI removal. Decision against XOAUTH2 documented. |
| **v5.4.0** | **MAPI/HTTP removed entirely** (~12,000 LOC). Outlook 2024 LTSC enforces Microsoft-Entra-only Modern Auth, which fundamentally does not work for non-Microsoft servers. Recommendation: Outlook → "Other email accounts" → IMAP. Calendar/contacts via CalDAV/CardDAV. |
| **v5.3.5** | IMAP FETCH completely rewritten: ENVELOPE bug fixed (NIL lists, RFC 3501 §7.4.2), real BODYSTRUCTURE instead of BODY[TEXT], INTERNALDATE, BODY[]/BODY[HEADER]/BODY.PEEK[*]/RFC822 variants |
| **v5.3.1** | Complete IMAP command suite: CREATE, DELETE, RENAME, APPEND, COPY, UID COPY, MOVE, UID MOVE, SEARCH, UID SEARCH, CLOSE, CHECK. UID compound-dispatcher bug fixed. POP3 app-password + byte-stuffing fix. |
| **v5.2.19** | parseLine empty-quoted-string fix (`LIST "" "*"`) — Mac Mail/iOS Mail/Thunderbird could never fetch their folder list via LIST |
| **v5.2.18** | IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS for Mac Mail / iOS Mail |
| **v5.2.0** | (archived) MAPI/HTTP FINAL — see v5.4.0 for the removal rationale |

### v3.18.x — Feature Polish & Production Hardening

| Version | Highlights |
|---------|-----------|
| **v3.18.40** | External clients & Outlook setup page in OWA (before the MAPI/HTTP implementation: CalDav Synchronizer guide) |
| **v3.18.36** | Generic hostname auto-derive for all domains + image privacy banner hardened |
| **v3.18.30** | BigInt crash fix + audit toggle + audit translations |
| **v3.18.25** | Calendar invitations iMIP/iTIP (RFC 6047/5546) — Outlook/Gmail accept/decline buttons |
| **v3.18.18** | CalDAV URL display in the share dialog + toolbar share button |
| **v3.18.14** | Calendar sharing with READ/WRITE permission + sidebar section "Shared with me" |
| **v3.18.11** | MWA Global Address Book (GAL browser) with tabs "My/Global address book" |
| **v3.18.10** | Image privacy banner (Outlook/Gmail style) — external `<img>` blocked until confirmed |
| **v3.18.7** | Audit log v2: filters + PDF + SHA-256 + stats + anomalies + meta-logging |
| **v3.18.5** | eDiscovery & Legal Hold removed entirely |
| **v3.18.4** | Signature rich-text editor (Tiptap) with images/links/fonts (10 fonts) |
| **v3.18.0** | Outlook-style inbox rules — forward/redirect via BullMQ |

### v3.17.x — Infrastructure Consolidation

| Version | Highlights |
|---------|-----------|
| **v3.17.0** | Integrated HTTPS proxy (port 443, hot reload via Redis, BCP → SSL/TLS management) |
| **v3.16.6** | Recipient autocomplete in compose + resizable panels + view settings |
| **v3.15.0** | DNS hardening: trusted resolvers (8.8.8.8/1.1.1.1/9.9.9.9) + cross-validation |
| **v3.14.0** | Pentest fixes: SMTP brute-force protection + rate limiting + Fail2Ban + firewall |
| **v3.13.0** | SMTP audit: 5 critical bugs fixed + IANA time zones + OWA → MWA rename |
| **v3.11.0** | Retention policies Exchange 2019: DPT/RPT/personal tags + Managed Folder Assistant |
| **v3.5.5** | MWA now served directly at `/` (instead of `/owa/`) |
| **v3.2.3** | Admin panel renamed: ECP → BCP, path `/ecp/` → `/bcp/` |
| **v2.1.19** | Grafana + Prometheus removed from the stack; Synology compose extended with rspamd + clamav |

→ [Full changelog](CHANGELOG.md)

---

## Contributing

Contributions are very welcome!

```bash
git checkout -b feature/my-feature
# make your changes
pnpm -r exec tsc --noEmit
git push origin feature/my-feature
# open a pull request
```

---

## License

MIT License — see [LICENSE](LICENSE)

---

<div align="center">
  <b>CoreMail v5.9.0</b> · The open-source mail server for small and medium-sized environments<br>
  <sub>IMAP4rev2 + JMAP + SMTP + POP3 + CalDAV + CardDAV + ActiveSync</sub><br>
  <sub>Built with ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
