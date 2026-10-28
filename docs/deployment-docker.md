# CoreMail — Docker Deployment

> **6-container architecture** — all CoreMail services run in a single app container (`magpeek/coremail-app`), managed by `supervisord`. Rspamd, ClamAV, PostgreSQL, Redis and MinIO run in separate standard images.

---

## Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick start](#quick-start)
4. [Access](#access)
5. [Configuration reference (.env)](#configuration-reference-env)
6. [Data management](#data-management)
7. [Updates](#updates)
8. [Synology NAS](#synology-nas)
9. [Troubleshooting](#troubleshooting)
10. [Production — checklist](#production--checklist)

---

## Overview

CoreMail uses a **6-container architecture**:

| Container | Image | Purpose |
|-----------|-------|---------|
| `coremail` | `magpeek/coremail-app:3.17.8` | All mail services + webmail (MWA) + admin panel (BCP) |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-spam engine (Bayes, DKIM/SPF/DMARC, fuzzy, URL) |
| `clamav` | `clamav/clamav:stable` | Open-source antivirus (GPL), freshclam updates |
| `postgres` | `postgres:16-alpine` | Primary database (mails, users, calendars, contacts) |
| `redis` | `redis:7-alpine` | Sessions, SMTP queue (BullMQ), live events via SSE, greylisting |
| `minio` | `minio/minio` | S3-compatible object storage (attachments, quarantine, backups) |

### What is inside the `coremail` container?

The app container contains **all CoreMail services**, managed by `supervisord`:

| Service | Internal port | Description |
|--------|--------------|-------------|
| api-gateway | 3000 | REST API + SSE + HTTP routing (main entry point) |
| auth-service | 3003 | Authentication (local / LDAP / OIDC / MFA) |
| storage-api | 3001 | Database abstraction (PostgreSQL + MinIO) |
| security-filter | 3002 | SPF/DKIM/DMARC/ARC + anti-spam pipeline |
| smtp-server | 25 / 465 / 587 | SMTP inbound + outbound |
| imap-server | 143 / 993 | IMAP4rev1 + IDLE + CONDSTORE |
| pop3-server | 110 / 995 | POP3 |
| ews-server | 8080 | MAPI over HTTP + EWS (optional, off by default — BCP → Server) |
| autodiscover | 8081 | Autodiscover v1 + v2 |
| caldav-server | 8082 | CalDAV + CardDAV |
| backup-service | 3004 | MBOX/EML export + S3 backup |
| activesync | 3005 | Exchange ActiveSync EAS 14.1 |

The `api-gateway` handles all HTTP routing without nginx:
- `/` and `/bcp/` → static frontend bundles (MWA/BCP from `/app/www/`)
- `/auth/` → auth-service (localhost:3003)
- `/EWS/`, `/mapi/`, `/OAB/` → ews-server (localhost:8080) — 404 while "MAPI over HTTP + EWS" is off
- `/Microsoft-Server-ActiveSync` → activesync (localhost:3005)
- `/dav/` → caldav-server (localhost:8082)
- `/api/v1/`, `/PowerShell/` → direct handlers

**TLS** is handled either by the integrated HTTPS proxy (port 443, default) or by an external reverse proxy.

---

## Prerequisites

- Docker Engine ≥ 24.0 with Docker Compose v2
- Free ports: `443` (or `3000` with an external proxy), `25`, `465`, `587`, `143`, `993`, `110`, `995`
- Min. 2 GB RAM (recommended: 4 GB for comfortable operation with all services)
- Min. 10 GB free disk space + storage for emails/attachments
- On Linux: port 25 must be unblocked by the hosting provider

---

## Quick start

### 1. Clone the repository

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Configuration

```bash
cp .env.example .env
```

Set the required fields in `.env`:

```bash
# Generate strong passwords
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 20)

# Generate security keys
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
```

### 3. Configure TLS

**Option A — Integrated HTTPS proxy (recommended for VPS/dedicated servers):**

CoreMail terminates TLS itself on port 443. Port `"443:443"` is already mapped in `docker-compose.yml`. After startup, upload and activate a certificate in the BCP under **Server → SSL/TLS**. Hot reload without restart.

```env
# .env — default, can be omitted
HTTPS_PROXY_ENABLED=true
```

**Option B — External reverse proxy (Traefik, Caddy, nginx, DSM):**

```env
# .env
HTTPS_PROXY_ENABLED=false
```

Comment out the line `"443:443"` in `infra/docker/docker-compose.yml`. CoreMail is then reachable only on port 3000 (HTTP) — the reverse proxy handles TLS.

**Self-signed certificate for development:**

```bash
bash scripts/gen-dev-certs.sh
```

### 4. Start the stack

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Images are pulled automatically from Docker Hub. All services are ready after about 60–90 seconds.

```bash
# Check status
docker compose -f infra/docker/docker-compose.yml ps

# Follow logs
docker compose -f infra/docker/docker-compose.yml logs -f
```

### 5. Create the first admin account

The setup wizard appears on the first visit to `https://<hostname>/bcp/`.

Alternatively via API:

```bash
curl -k -X POST https://<hostname>/api/v1/admin/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@your-domain.com",
    "password": "SecurePassword123!",
    "displayName": "Administrator"
  }'
```

---

## Access

| Interface | URL |
|-----------|-----|
| MWA webmail | `https://<hostname>/` |
| BCP admin panel | `https://<hostname>/bcp/` |
| MinIO web console | `http://localhost:9001` (local only!) |
| JMAP | `https://<hostname>/.well-known/jmap` |
| EWS (only with MAPI over HTTP enabled, Outlook 2013–2021) | `https://<hostname>/EWS/Exchange.asmx` |
| ActiveSync (mobile) | `https://<hostname>/Microsoft-Server-ActiveSync` |
| Autodiscover | `https://<hostname>/Autodiscover/Autodiscover.xml` |

**Mail ports:**

| Port | Protocol | Encryption |
|------|-----------|----------------|
| 25 | SMTP (inbound, MTA-to-MTA) | STARTTLS |
| 465 | SMTPS submission | Implicit TLS |
| 587 | SMTP submission | STARTTLS |
| 143 | IMAP | STARTTLS |
| 993 | IMAPS | Implicit TLS |
| 110 | POP3 | STARTTLS |
| 995 | POP3S | Implicit TLS |

---

## Configuration reference (.env)

The complete `.env` file with all available variables:

```bash
# ─── Security ────────────────────────────────────────────────────────────────
# JWT signing key — at least 32 characters
# Generate: openssl rand -hex 32
JWT_SECRET=CHANGE-ME-openssl-rand-hex-32

# bcrypt pepper for password hashes — at least 32 characters
# WARNING: changing it invalidates all existing passwords!
PEPPER=CHANGE-ME-openssl-rand-hex-32

# ─── Database ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── Redis ───────────────────────────────────────────────────────────────────
REDIS_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── MinIO (S3-compatible object storage) ─────────────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── Operation ───────────────────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info                  # error | warn | info | debug

# ─── Backup ──────────────────────────────────────────────────────────────────
BACKUP_SCHEDULE=0 2 * * *       # daily at 02:00 UTC
BACKUP_RETENTION_DAYS=30
RETENTION_SCHEDULE=0 3 * * *    # Managed Folder Assistant, daily at 03:00 UTC

# ─── VAPID Web Push — optional ───────────────────────────────────────────────
# Generate keys: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

# ─── SMTP gateway mode — optional ────────────────────────────────────────────
# Relay to an upstream MTA (Exchange on-prem, Postfix, Office 365 …)
GATEWAY_MODE=false
# GATEWAY_UPSTREAM_HOST=smtp.intern.example.com
# GATEWAY_UPSTREAM_PORT=25
# GATEWAY_UPSTREAM_TLS=false
# GATEWAY_UPSTREAM_USER=
# GATEWAY_UPSTREAM_PASS=
# GATEWAY_DOMAINS=example.com,corp.internal
GATEWAY_FILTER=true

# ─── GeoIP / country filtering — optional ────────────────────────────────────
# Free MaxMind account: https://www.maxmind.com/en/geolite2/signup
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=

# ─── S/MIME — optional ───────────────────────────────────────────────────────
# SMIME_P12_PASSWORD=

# ─── Integrated HTTPS proxy — optional ───────────────────────────────────────
# true  (default) — CoreMail terminates TLS on port 443
# false — use an external reverse proxy; comment out port 443:443 in docker-compose
# HTTPS_PROXY_ENABLED=false
# HTTPS_PORT=443

# ─── Hostname — optional ─────────────────────────────────────────────────────
# Migration note: imported into the database once; afterwards the
# hostname is managed via BCP → Server settings.
# MAIL_HOSTNAME=mail.example.com
```

**Key variables at a glance:**

| Variable | Description | Required |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing key (min. 32 characters) | Yes |
| `PEPPER` | bcrypt pepper for password hashes (min. 32 characters) | Yes |
| `POSTGRES_PASSWORD` | PostgreSQL database password | Yes |
| `REDIS_PASSWORD` | Redis authentication password | Yes |
| `MINIO_ROOT_PASSWORD` | MinIO administrator password (min. 8 characters) | Yes |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | No (`info`) |
| `HTTPS_PROXY_ENABLED` | Enable the integrated TLS proxy | No (`true`) |
| `GATEWAY_MODE` | SMTP gateway/relay mode | No (`false`) |

---

## Data management

### Docker volumes

| Volume | Contents | Container |
|--------|--------|----------|
| `pgdata` | PostgreSQL database files | postgres |
| `redisdata` | Redis AOF persistence | redis |
| `miniodata` | Email attachments, quarantine, backups | minio |
| `rspamd-data` | Rspamd data, Bayes database | rspamd |

### Database backup (manual)

```bash
# Create a PostgreSQL dump
docker exec coremail-postgres pg_dump -U coremail coremail | gzip \
  > coremail-db-$(date +%Y%m%d-%H%M).sql.gz

echo "Backup: coremail-db-$(date +%Y%m%d-%H%M).sql.gz"
```

### Database restore

```bash
# Stop the stack
docker compose -f infra/docker/docker-compose.yml stop

# Restore the backup
gunzip -c coremail-db-20260516-0200.sql.gz \
  | docker exec -i coremail-postgres psql -U coremail -d coremail

# Start the stack again
docker compose -f infra/docker/docker-compose.yml start
```

### Volume backup (complete)

```bash
# Stop the containers
docker compose -f infra/docker/docker-compose.yml stop

# Back up the volumes
docker run --rm -v pgdata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz /data

docker run --rm -v miniodata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/miniodata-$(date +%Y%m%d).tar.gz /data

# Start the containers again
docker compose -f infra/docker/docker-compose.yml start
```

### Automatic backup (via the CoreMail backup service)

- Configurable via **BCP → Server → Backup**
- Stores to MinIO (local) or an external S3 bucket
- Point-in-time recovery with configurable retention (`BACKUP_RETENTION_DAYS`)
- Trigger manually: `curl -X POST http://localhost:3000/api/v1/admin/backup/trigger -H "Authorization: Bearer $TOKEN"`

---

## Updates

```bash
# 1. Pull new images
docker compose -f infra/docker/docker-compose.yml pull

# 2. Restart the stack (downtime < 30 seconds, Prisma migration runs automatically)
docker compose -f infra/docker/docker-compose.yml up -d

# 3. Check status
docker compose -f infra/docker/docker-compose.yml ps
curl -s http://localhost:3000/healthz | jq
docker images | grep magpeek
```

**Deploy a specific version:**

Adjust the image line in `infra/docker/docker-compose.yml`:
```yaml
image: magpeek/coremail-app:3.17.8
```
Then run `docker compose up -d`.

**Roll back to the previous version:**

```bash
# Set the image tag in docker-compose.yml to the old version and restart
docker compose -f infra/docker/docker-compose.yml up -d
```

---

## Synology NAS

For Synology NAS and other home servers there is a dedicated Compose file (`docker-compose.synology.yml`) that avoids port conflicts with the DSM web interface (ports 80/443).

### Prerequisites (Synology)

- Synology NAS with DSM 7.x and the Docker package (or Container Manager)
- SSH access enabled

### Setup

```bash
# Via SSH on the NAS
ssh admin@<NAS-IP>

# Clone the repository (e.g. to /volume1/docker/coremail)
git clone https://github.com/MAGPEEK/CoreMail.git /volume1/docker/coremail
cd /volume1/docker/coremail

# Configuration
cp .env.example .env
# Adjust .env (passwords, HTTPS_PROXY_ENABLED=false if needed)

# Start the Synology stack
docker compose -f infra/docker/docker-compose.synology.yml up -d
```

### Ports (Synology)

| Port | Service |
|------|--------|
| 8080 | HTTP (CoreMail API + web interface) |
| 25 | SMTP |
| 465 / 587 | SMTPS / submission |
| 143 / 993 | IMAP / IMAPS |
| 110 / 995 | POP3 / POP3S |
| 9001 | MinIO web console |

> Ports 80 and 443 are not mapped because they are used by DSM.

### TLS via DSM Application Portal

1. Open **Synology DSM → Control Panel → Application Portal → Reverse Proxy**
2. Add a new rule:
   - Protocol: HTTPS (443)
   - Destination: `http://localhost:8080`
3. In the same dialog, issue a Let's Encrypt certificate for the hostname
4. CoreMail is then reachable at `https://<NAS-FQDN>/`

### Access (Synology)

```
MWA webmail:   https://<NAS-FQDN>/        (via DSM reverse proxy)
BCP admin:     https://<NAS-FQDN>/bcp/    (via DSM reverse proxy)
MinIO console: http://<NAS-IP>:9001       (local network only)
```

---

## Troubleshooting

### Viewing logs

```bash
# All containers live
docker compose -f infra/docker/docker-compose.yml logs -f

# coremail container only
docker logs -f coremail

# Last 100 lines
docker logs --tail 100 coremail

# Errors only
docker logs coremail 2>&1 | grep -i "error\|fatal\|ERR"
```

### Debugging individual services (supervisord)

```bash
# Status of all processes in the container
docker exec coremail supervisorctl status

# Live logs of a specific service
docker exec coremail supervisorctl tail -f smtp-server
docker exec coremail supervisorctl tail -f api-gateway

# Restart a service
docker exec coremail supervisorctl restart api-gateway
docker exec coremail supervisorctl restart smtp-server
docker exec coremail supervisorctl restart imap-server

# Restart all services (container keeps running)
docker exec coremail supervisorctl restart all
```

### Health checks

```bash
# CoreMail API
curl -s http://localhost:3000/healthz | jq

# PostgreSQL
docker exec coremail-postgres pg_isready -U coremail -d coremail

# Redis
docker exec coremail-redis redis-cli -a "${REDIS_PASSWORD}" ping

# Check ports inside the container
docker exec coremail ss -tlnp
```

### Common problems

| Problem | Cause | Solution |
|---------|---------|--------|
| `coremail` does not start immediately | Dependent containers not ready yet | `depends_on: service_healthy` delays the start — wait until postgres/minio are healthy |
| Port 25 in use | Local MTA (Postfix/Sendmail running on the host) | `systemctl stop postfix && systemctl disable postfix` |
| Port 443 in use | Another service uses port 443 | Set `HTTPS_PROXY_ENABLED=false` + use an external proxy |
| Slow first start | Prisma migrations + freshclam download (ClamAV) | Normal — ready after 60–120 seconds |
| BCP not reachable | Frontend bundle not built yet | Check container logs: `docker logs coremail` |
| `supervisorctl status` shows FATAL | Process crashed | Read the logs: `docker exec coremail supervisorctl tail smtp-server` |
| SMTP: "Connection refused" on port 25 | Port blocked by the provider | Contact the hosting provider and have port 25 unblocked |
| Redis connection error | Wrong `REDIS_PASSWORD` | Check `.env`, restart the stack |

---

## Production — checklist

- [ ] Strong random passwords set in `.env` (`openssl rand -hex 32`)
- [ ] `JWT_SECRET` and `PEPPER` set to at least 32 characters (recommended: 64)
- [ ] TLS configured: integrated proxy (certificate uploaded in the BCP) or external reverse proxy
- [ ] DNS records set: A/AAAA, MX, SPF, DKIM, DMARC — run the DNS check in the BCP under SMTP → DNS
- [ ] Port 25 not blocked by the hosting provider (have it unblocked if necessary)
- [ ] Firewall: only required ports open (25, 465, 587, 143, 993, 110, 995, 443)
- [ ] MinIO console (port 9001) not exposed externally (localhost-only or firewall rule)
- [ ] DKIM key generated in the BCP and DNS record set
- [ ] Automatic backup configured and restore tested
- [ ] Log level set to `warn` or `error` for production
- [ ] VAPID keys generated (for browser push notifications, optional)
- [ ] GeoIP filter configured (MaxMind account, optional)

---

## Further documentation

- [Kubernetes deployment](../infra/k8s/) — Helm chart for cluster operation (HPA, PDB, Redis Cluster, CloudNativePG)
- [COMMANDS.md](../COMMANDS.md) — CLI command reference (queues, users, backup, diagnostics)
- [CHANGELOG.md](../CHANGELOG.md) — Complete version history
