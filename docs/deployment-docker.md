# CoreMail — Docker Deployment

> **6-container architecture** — all CoreMail services run in a single app container (`magpeek/coremail-app`), managed by `supervisord`. Rspamd, ClamAV, PostgreSQL, Redis and MinIO run in separate standard images.

> **Compose variants:** besides the standard `docker-compose.yml` described here there are
> `docker-compose.minimal.yml` (coremail + postgres + redis, 1–50 users) and
> `docker-compose.full.yml` (everything, resource limits, log rotation, optional
> `minio`/`backup`/`geoip` profiles). Comparison, quick start per variant, storage on a separate
> disk / NAS, backups and switching variants: **[docker-compose.md](docker-compose.md)**.

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
| `minio` | `pgsty/minio` (pinned by digest; official images discontinued) | S3-compatible object storage: backups; mail contents with `OBJECT_STORAGE=minio` (installations from before 8.0) |

**Mail storage (v8.0):** new installations keep mail contents, attachments and quarantine on the Docker volume `coremail-data` (`OBJECT_STORAGE=filesystem`, written by `scripts/setup.sh`); installations without that setting keep using MinIO unchanged. Drivers, external S3 (AWS, B2, Wasabi, Hetzner, R2) with TLS, migration and backups: [storage.md](storage.md).

### What is inside the `coremail` container?

The app container contains **all CoreMail services**, managed by `supervisord`:

| Service | Internal port | Description |
|--------|--------------|-------------|
| api-gateway | 3000 | REST API + SSE + HTTP routing (main entry point) |
| auth-service | 3003 | Authentication (local / LDAP / OIDC / MFA) |
| security-filter | 3002 | SPF/DKIM/DMARC/ARC + anti-spam pipeline |
| smtp-server | 25 / 465 / 587 | SMTP inbound + outbound |
| imap-server | 143 / 993 | IMAP4rev1 + IDLE + CONDSTORE |
| pop3-server | 110 / 995 | POP3 |
| autodiscover | 8081 | Autodiscover v1 + v2 |
| caldav-server | 8082 | CalDAV + CardDAV |
| backup-service | 3004 | MBOX/EML export + S3 backup |
| activesync | 3005 | ActiveSync EAS 14.1 |

The `api-gateway` handles all HTTP routing without nginx:
- `/` and `/bcp/` → static frontend bundles (MWA/BCP from `/app/www/`)
- `/auth/` → auth-service (localhost:3003)
- `/EWS`, `/OAB` → 404 (EWS removed in v7.0.0)
- `/mapi/*` → mapi-server (localhost:3007, MAPI over HTTP since 9.4, off per account by default — see [mapi.md](mapi.md))
- `/Microsoft-Server-ActiveSync` → activesync (localhost:3005)
- `/dav/`, `/.well-known/caldav`, `/.well-known/carddav` → caldav-server (localhost:8082);
  clients only need the server name — the well-known URIs lead to `/dav/`, which names the
  user's principal with the calendar and address book homes (RFC 6764). An external reverse
  proxy must forward the two well-known paths as well.
- `/api/v1/` → direct handlers

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

Without a checkout (recommended for new installations, 10.4): one Compose file from the
release and `docker compose up -d` — see [deploy.md](deploy.md). The steps below use the
Compose files of a repository checkout ([docker-compose.md](docker-compose.md)).

### 1. Clone the repository

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Configuration (optional)

Nothing is required: without a `.env` the `coremail` container generates `JWT_SECRET`,
`PEPPER` and every database password into `infra/docker/secrets/` on its first start (the
other containers wait for their password file) ([setup.md → Automatic secrets](setup.md#automatic-secrets)). **Back that directory up
off the server.**

To choose values yourself (they always win and are copied into `./secrets/`):

```bash
bash scripts/setup.sh                      # standard; --variant minimal|full: docs/docker-compose.md
# or by hand:
cp .env.example .env
```

and set, for example:

```bash
# Generate strong passwords
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 20)

# Generate security keys
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
```

PostgreSQL takes `POSTGRES_PASSWORD` only when its volume is created — set it before the first
start or leave it empty.

### 3. Configure TLS

**Option A — Integrated HTTPS proxy (recommended for VPS/dedicated servers):**

CoreMail terminates TLS itself on port 443. Port `"443:443"` is already mapped in `docker-compose.yml`. After startup, upload and activate a certificate in the BCP under **Server → SSL/TLS**. Hot reload without restart.

**Mail ports (SMTP/IMAP/POP3):** assigning the services SMTP/IMAP/POP3 to a certificate in BCP → SSL/TLS applies it to 25/465/587/993/143/995/110 immediately (9.3); the SSL/TLS page shows per service whether the certificate is really served. A Let's Encrypt certificate for the public host name is assigned automatically while the mail ports still use the self-signed default. Details: [certificates.md](certificates.md).

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

### 5. Run the setup wizard

The setup wizard appears on the first visit to `http://<server>:3000/` (or `/bcp/`, which
forwards to it). It asks for the one-time setup token (10.4: `infra/docker/secrets/setup-token`, also
`docker exec coremail cat /secrets/setup-token`; without a secrets directory the container
log: `docker logs coremail 2>&1 | grep -i "setup token"`; or `SETUP_TOKEN` from the environment),
then walks through mail domain and host name, the first administrator account, the backup of
generated secrets, the DNS records with a live check, and the TLS certificate (Let's Encrypt,
a reverse proxy, or later). Details: [setup-wizard.md](setup-wizard.md).

Alternatively via API (domain + admin only; DNS and certificate then in the BCP):

```bash
curl -X POST http://<server>:3000/api/v1/setup/complete \
  -H 'Content-Type: application/json' \
  -H 'X-Setup-Token: <token from the log>' \
  -d '{
    "domain": "your-domain.com",
    "hostname": "mail.your-domain.com",
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

Since 10.4 the `.env` file is optional: every Compose variant starts without it and the
`coremail` container generates the secrets into `./secrets/` next to the Compose file
([setup.md](setup.md#docker-compose-start-order)). A value set in `.env` always wins and
is copied into `./secrets/`. Leave a secret empty to have it generated. The available
variables (placeholders shown — never use them as they are):

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

# ─── MinIO (S3-compatible object storage: backups; mail with OBJECT_STORAGE=minio)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=CHANGE-ME-openssl-rand-hex-20

# ─── Mail storage (v8.0, docs/storage.md) ────────────────────────────────────
OBJECT_STORAGE=filesystem       # filesystem | minio | s3 — unset = minio (pre-8.0 installs)
# External S3 / MinIO with TLS (OBJECT_STORAGE=s3):
# MINIO_ENDPOINT=s3.eu-central-1.amazonaws.com
# MINIO_USE_SSL=true
# MINIO_REGION=eu-central-1
# MINIO_PATH_STYLE=false
# MINIO_CA_FILE=/etc/coremail/s3-ca.pem
# MINIO_ACCESS_KEY= / MINIO_SECRET_KEY= / MINIO_BUCKET_ATTACHMENTS=coremail-attachments

# ─── Operation ───────────────────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info                  # error | warn | info | debug

# ─── Backup ──────────────────────────────────────────────────────────────────
BACKUP_SCHEDULE=0 2 * * *       # daily at 02:00 UTC
BACKUP_RETENTION_DAYS=30
RETENTION_SCHEDULE=0 3 * * *    # retention worker, daily at 03:00 UTC
BACKUP_ENCRYPTION_KEY=<openssl rand -hex 32>   # backups are AES-256-GCM encrypted — keep a copy OFF the server

# ─── Security (docs/deployment-security.md) ─────────────────────────────────
RSPAMD_CONTROLLER_PASSWORD=<openssl rand -hex 20>
# COREMAIL_DB_USER=coremail_app            # non-superuser DB role — fresh databases only (setup.sh)
# COREMAIL_DB_PASSWORD=<openssl rand -hex 20>
# COREMAIL_ALLOW_SCHEMA_DATA_LOSS=false    # true for ONE start: destructive schema update after a pg_dump
# RSPAMD_NET_PREFIX=10.253.253             # app <-> rspamd /29 network

# ─── VAPID Web Push — optional ───────────────────────────────────────────────
# Generate keys: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com

# ─── SMTP gateway mode — optional ────────────────────────────────────────────
# Relay to an upstream MTA (on-premises or hosted mail server, Postfix …)
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
| `JWT_SECRET` | JWT signing key (min. 32 characters) | No (generated into `./secrets/`) |
| `PEPPER` | bcrypt pepper for password hashes (min. 32 characters) | No (generated) |
| `POSTGRES_PASSWORD` | PostgreSQL database password | No (generated) |
| `REDIS_PASSWORD` | Redis authentication password | No (generated) |
| `MINIO_ROOT_PASSWORD` | MinIO administrator password (min. 8 characters) | No (generated) |
| `COREMAIL_SECRETS_PATH` | Host directory of the generated secrets | No (`./secrets` next to the Compose file) |
| `OBJECT_STORAGE` | Mail storage driver `filesystem` / `minio` / `s3` ([storage.md](storage.md)) | No (`minio`; setup.sh writes `filesystem`) |
| `LOG_LEVEL` | `error` / `warn` / `info` / `debug` | No (`info`) |
| `HTTPS_PROXY_ENABLED` | Enable the integrated TLS proxy | No (`true`) |
| `GATEWAY_MODE` | SMTP gateway/relay mode | No (`false`) |
| `RSPAMD_URL` | rspamd **controller** URL, used for scanning (`/checkv2`), Bayes learning and stats; `http`/`https`, optional path prefix. Set in `docker-compose.yml` | No (`http://rspamd:11334`) |
| `RSPAMD_HOST` / `RSPAMD_PORT` | Legacy (before 8.0): scan host/port of the rspamd normal worker; only used when `RSPAMD_URL` is not set | No (`rspamd` / `11333`) |

---

## Data management

Bind mounts, a separate disk, NFS/SMB, ownership, moving data and sizing:
[docker-compose.md → Storage](docker-compose.md#storage).

### Docker volumes

| Volume | Contents | Container |
|--------|--------|----------|
| `pgdata` | PostgreSQL database files | postgres |
| `redisdata` | Redis AOF persistence | redis |
| `coremail-data` | Mail contents, attachments, quarantine with `OBJECT_STORAGE=filesystem` (`/data/objects`) | coremail |
| `miniodata` | Backups; mail contents with `OBJECT_STORAGE=minio` | minio |
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

Online variant (database dump first, then the objects), Synology Hyper Backup and restore:
[storage.md → Backup and restore](storage.md#backup-and-restore).

```bash
# Stop the containers
docker compose -f infra/docker/docker-compose.yml stop

# Back up the volumes
docker run --rm -v pgdata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz /data

docker run --rm -v coremail_coremail-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/coremail-data-$(date +%Y%m%d).tar.gz /data

docker run --rm -v miniodata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/miniodata-$(date +%Y%m%d).tar.gz /data

# Start the containers again
docker compose -f infra/docker/docker-compose.yml start
```

### Automatic backup (via the CoreMail backup service)

- **Nothing is backed up automatically until a schedule exists**: BCP → Backup & Restore →
  Zeitpläne → **Empfohlene Sicherung einrichten** creates a nightly system backup (database dump)
  and a nightly full backup of every mailbox (`BACKUP_SCHEDULE` / `BACKUP_RETENTION_DAYS` are
  the defaults of that button, they never start a backup by themselves)
- Encrypted (`BACKUP_ENCRYPTION_KEY`) into MinIO (bundled) or an external S3 bucket
- Restore of stored archives and uploaded files: BCP → Backup & Restore → Wiederherstellen
- What is covered and what is not (object store, `.env` secrets), restore procedures:
  **[backup.md](backup.md)**
- Trigger manually: `curl -X POST http://localhost:3000/api/v1/admin/backups/full -H "Authorization: Bearer $TOKEN"`

---

## Updates

```bash
# 1. Pull new images
docker compose -f infra/docker/docker-compose.yml pull

# 2. Restart the stack (downtime < 30 seconds, Prisma migration runs automatically;
#    --remove-orphans removes the coremail-init container a 10.4.0 installation still has)
docker compose -f infra/docker/docker-compose.yml up -d --remove-orphans

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

Mail storage: `scripts/synology-setup.sh` sets `OBJECT_STORAGE=filesystem` for a fresh
installation — mail contents are then plain files in `/volume1/docker/coremail/data/objects`
(include it in Hyper Backup together with a database dump, see [storage.md](storage.md#synology-hyper-backup)).
Existing installations keep MinIO.

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

# Configuration (optional — secrets are generated into /volume1/docker/coremail/secrets)
# NAS_HOSTNAME=<NAS-IP> bash scripts/synology-setup.sh   (writes .env, creates the directories)

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
| Desktop client / iPhone: "certificate unknown" on IMAP/SMTP | A mail port serves the self-signed default or a certificate for another name | BCP → SSL/TLS → the status chips SMTP/IMAP/POP3 in the certificate list show (tooltip) which ports serve another certificate; assign SMTP/IMAP/POP3 to the trusted certificate for the public host name (**Jetzt zuweisen**). The client IP and the hint `client does not trust the served certificate` appear in the IMAP/SMTP/POP3 logs. See [certificates.md](certificates.md) |
| Let's Encrypt certificate ends in "Error" | DNS, port 80, CAA or a rate limit — the message in BCP → SSL/TLS (expand the row) is what Let's Encrypt reported | BCP → SSL/TLS → Let's Encrypt → **Check prerequisites** (DNS, CAA, local token check and a real validation by the Let's Encrypt staging environment), fix the cause, then **Retry**. Host port 80 must be forwarded to the container's HTTP port (3000). The server does not need to reach its own public address. Use the staging switch for tests — production allows only 5 failed validations per host name and hour |

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

- [Kubernetes deployment](../infra/k8s/README.md) — Helm chart 1.0.0 for the same `coremail-app`
  image: one app pod (single replica, `Recreate`), Ingress for HTTP, a LoadBalancer/NodePort
  Service for the mail ports, optional bundled PostgreSQL/Redis/MinIO/rspamd/ClamAV or external
  services, NetworkPolicies and the same environment variables as this compose file (incl.
  `OBJECT_STORAGE`, `RSPAMD_URL`). One replica is the supported default (no HPA); see the
  chart README for what is coordinated across replicas. Check the chart with
  `bash scripts/helm-check.sh`.
- [COMMANDS.md](../COMMANDS.md) — CLI command reference (queues, users, backup, diagnostics)
- [CHANGELOG.md](../CHANGELOG.md) — Complete version history
