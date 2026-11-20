<p align="center">
  <img src="packages/web-client/public/favicon.svg" width="96" alt="CoreMail logo">
</p>

<h1 align="center">CoreMail</h1>

<p align="center">
  <a href="https://github.com/MAGPEEK/CoreMail/releases"><img src="https://img.shields.io/badge/version-10.3.0-brightgreen.svg" alt="Version 10.3.0"></a>
  <a href="https://hub.docker.com/r/magpeek/coremail-app"><img src="https://img.shields.io/docker/pulls/magpeek/coremail-app.svg" alt="Docker pulls"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  Your own mail server with webmail, calendar and contacts, in one Docker image.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/version-history.md">Version history</a> ·
  <a href="https://github.com/MAGPEEK/CoreMail/releases">Releases</a> ·
  <a href="https://hub.docker.com/r/magpeek/coremail-app">Docker Hub</a>
</p>

<p align="center">
  🇬🇧 English · 🇩🇪 <a href="README.de.md">Deutsche Fassung</a>
</p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/images/webmail.png" alt="Webmail"><br><sub>Webmail</sub></td>
    <td width="50%" align="center"><img src="docs/images/admin.png" alt="Admin panel (BCP)"><br><sub>Admin panel (BCP)</sub></td>
  </tr>
</table>

## What is CoreMail?

CoreMail is a self-hosted, open-source mail server. It comes with a full webmail (mail, calendar, contacts, tasks, notes) and an admin panel (BCP) for users, domains, security and certificates. Everything runs in one Docker image next to PostgreSQL and Redis. Desktop mail clients connect via MAPI over HTTP or IMAP, phones via ActiveSync, and Apple Mail, Thunderbird and other apps via IMAP, SMTP, CalDAV/CardDAV or JMAP.

## Who is it for?

- Small and medium businesses with 10–500 mailboxes that want their mail on their own server.
- Self-hosters and home labs with their own domain.
- IT service providers that host several customer domains on one server, with admins limited to their own domains.
- Teams that use desktop clients, phones and the webmail on the same mailbox.

It is not built for large providers with thousands of mailboxes on one host.

## Features

- **Protocols:** SMTP (25, 465, 587), IMAP4rev2, POP3, JMAP, ActiveSync 12.1–14.1, CalDAV/CardDAV, Autodiscover and automatic setup for Thunderbird and Apple devices.
- **Desktop clients:** MAPI over HTTP for mail (online and cached mode; opt-in, [docs/mapi.md](docs/mapi.md)), calendar and contacts via CalDAV/CardDAV.
- **Phones:** ActiveSync syncs mail, calendar, contacts, tasks and notes both ways (iOS, Android).
- **Webmail:** mail, calendar with recurring events, contacts and contact groups, tasks with follow-up flags, notes, shared mailboxes, folder permissions, rules, out-of-office, search.
- **Mail security:** SPF, DKIM (signing and checking), DMARC, ARC, DNSBL, greylisting, attachment filter, quarantine; rspamd spam scoring and ClamAV virus scanning as optional containers.
- **Sign-in:** two-factor authentication (TOTP, WebAuthn, backup codes), app passwords for mail apps, SSO via OIDC, LDAP / Active Directory, brute-force lockout.
- **Certificates:** Let's Encrypt built in, with automatic renewal and a built-in HTTPS proxy.
- **Backups:** encrypted mailbox and database backups with restore from the admin panel.
- **Administration:** admin roles that can be limited to domains, audit log, message trace, queue management, per-domain and per-mailbox protocol switches, admin CLI `coremail`, and an MCP interface for AI assistants and MCP clients (off by default, [docs/mcp.md](docs/mcp.md)).
- **Operation:** your own branding (name, colours, logo), Docker Compose variants from minimal to full, Helm chart for Kubernetes.

## Quick start

You need Docker 24 or newer with Docker Compose 2.20 or newer. All variants use the image `magpeek/coremail-app`. Mail data lives on the volume `coremail-data`, the database on `pgdata` (Compose) or `coremail-pgdata` (`docker run`).

### Minimal — Docker Compose

CoreMail, PostgreSQL and Redis ([docker-compose.minimal.yml](infra/docker/docker-compose.minimal.yml)). No spam or virus scanner; SPF, DKIM, DMARC, DNSBL and greylisting still run. Good for up to about 50 users on 2 GB RAM.

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
bash scripts/setup.sh --variant minimal      # writes .env with random secrets
docker compose -f infra/docker/docker-compose.minimal.yml up -d
```

Without `setup.sh`, create `infra/docker/.env` with the four required values yourself:

```bash
cat > infra/docker/.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 20)
REDIS_PASSWORD=$(openssl rand -hex 20)
EOF
```

Keep a copy of this file. `PEPPER` must never change, otherwise no password works anymore.

### Minimal — plain `docker run`

The same stack without Compose and without cloning the repository. The secrets go into `coremail.env`; keep it.

```bash
umask 077
PG_PASS=$(openssl rand -hex 20); REDIS_PASS=$(openssl rand -hex 20)
cat > coremail.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
DATABASE_URL=postgresql://coremail:$PG_PASS@coremail-postgres:5432/coremail
REDIS_URL=redis://:$REDIS_PASS@coremail-redis:6379
OBJECT_STORAGE=filesystem
RSPAMD_ENABLED=false
CLAMAV_ENABLED=false
SECURITY_FILTER_URL=http://localhost:3002
EOF

docker network create coremail

docker run -d --name coremail-postgres --network coremail --restart unless-stopped \
  -e POSTGRES_DB=coremail -e POSTGRES_USER=coremail -e POSTGRES_PASSWORD="$PG_PASS" \
  -v coremail-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine

docker run -d --name coremail-redis --network coremail --restart unless-stopped \
  -v coremail-redisdata:/data \
  redis:7-alpine redis-server --appendonly yes --requirepass "$REDIS_PASS"

docker run -d --name coremail --network coremail --restart unless-stopped \
  --env-file coremail.env \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v coremail-data:/data \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.3.0
```

Add `-p 110:110 -p 995:995` if you want POP3.

### Maximal — Docker Compose

[docker-compose.full.yml](infra/docker/docker-compose.full.yml) adds rspamd (spam scoring, Bayes learning) and ClamAV (virus scanning), resource limits and log rotation for every container, and optional profiles: `minio` (bundled S3 storage, also the default backup target), `backup` (daily `pg_dump`) and `geoip` (country filter database). Plan 4 GB RAM; ClamAV alone needs about 1 GB.

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
bash scripts/setup.sh --variant full         # also sets RSPAMD_CONTROLLER_PASSWORD and OBJECT_STORAGE
docker compose -f infra/docker/docker-compose.full.yml up -d
# with profiles:
docker compose -f infra/docker/docker-compose.full.yml --profile minio --profile backup up -d
```

Required in `.env` besides the four values above: `RSPAMD_CONTROLLER_PASSWORD` and `OBJECT_STORAGE` (`filesystem`, `minio` or `s3`); with the `minio` profile also `MINIO_ROOT_PASSWORD`. All three variants are compared in [docs/docker-compose.md](docs/docker-compose.md).

### Maximal — plain `docker run`

<details>
<summary>rspamd and ClamAV next to the minimal stack</summary>

Start the minimal `docker run` stack above, but stop before the last command (`coremail`). rspamd trusts only the CoreMail container's address, so both get fixed addresses on a small network of their own. The rspamd configuration comes from the repository (`infra/docker/rspamd/local.d`).

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
RSPAMD_PASS=$(openssl rand -hex 20)
grep -v -e '^RSPAMD_ENABLED=' -e '^CLAMAV_ENABLED=' coremail.env > coremail.env.new && mv coremail.env.new coremail.env
cat >> coremail.env <<EOF
RSPAMD_URL=http://10.253.253.3:11334
CLAMAV_HOST=coremail-clamav
CLAMAV_PORT=3310
EOF

docker network create --subnet 10.253.253.0/29 coremail-rspamd

docker run -d --name coremail-rspamd --network coremail-rspamd --ip 10.253.253.3 --restart unless-stopped \
  -e RSPAMD_CONTROLLER_SECURE_IP=10.253.253.2 -e RSPAMD_CONTROLLER_PASSWORD="$RSPAMD_PASS" \
  -v "$PWD/CoreMail/infra/docker/rspamd/local.d:/etc/rspamd/local.d:ro" \
  -v coremail-rspamd-data:/var/lib/rspamd \
  rspamd/rspamd:4.0.0

docker run -d --name coremail-clamav --network coremail --restart unless-stopped \
  -v coremail-clamav-data:/var/lib/clamav \
  clamav/clamav:stable

docker create --name coremail --network coremail --restart unless-stopped \
  --env-file coremail.env \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v coremail-data:/data \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.3.0
docker network connect --ip 10.253.253.2 coremail-rspamd coremail
docker start coremail
```

ClamAV downloads about 300 MB of signatures on its first start; scanning begins once that is done. For MinIO, the `pg_dump` sidecar and GeoIP, see the profiles in [docker-compose.full.yml](infra/docker/docker-compose.full.yml).

</details>

### First login

1. Wait about a minute until the container is healthy (`docker ps` shows `healthy`).
2. Read the one-time setup token: `docker logs coremail 2>&1 | grep -i "setup token"`
3. Open `http://<server-ip>:3000/bcp/`, enter the token, your mail domain, the first admin address and a password.
4. In the admin panel, issue a Let's Encrypt certificate under **Certificates** and create the mailboxes. The webmail is at `https://<your-host>/`, the admin panel at `https://<your-host>/bcp/`.

| Port | Use |
|------|-----|
| 80 → 3000 | HTTP: Let's Encrypt and redirect to HTTPS |
| 443 | HTTPS: webmail, admin panel, ActiveSync, MAPI, CalDAV/CardDAV, JMAP |
| 3000 | HTTP without TLS: first setup, or behind your own reverse proxy |
| 25 | SMTP from other mail servers |
| 465 / 587 | SMTP submission for mail apps (implicit TLS / STARTTLS) |
| 993 / 143 | IMAP (implicit TLS / STARTTLS) |
| 995 / 110 | POP3, optional (implicit TLS / STLS) |

**DNS:** point an A record and the MX record at the server and add SPF, DKIM and DMARC; the admin panel shows the exact records for each domain under **Domains** and checks them live.

## Update

```bash
docker compose -f infra/docker/docker-compose.minimal.yml pull && docker compose -f infra/docker/docker-compose.minimal.yml up -d
```

Use the Compose file of your variant. With `docker run`, pull the new tag, remove the `coremail` container and start it again with the same command. The database schema is updated at start.

Upgrading from an older version: read the [version history](docs/version-history.md) and the [release notes](docs/releases/) first.

## Documentation

- [Docker Compose variants, storage and backups](docs/docker-compose.md)
- [Docker operation](docs/deployment-docker.md) and [security hardening](docs/deployment-security.md)
- [Client setup](docs/clients.md): desktop clients ([MAPI over HTTP](docs/mapi.md)), phones ([ActiveSync](docs/activesync.md)), Thunderbird and Apple
- [Certificates and Let's Encrypt](docs/certificates.md)
- [Backup and restore](docs/backup.md)
- [Admin roles](docs/rbac.md), [branding](docs/branding.md), [admin CLI](docs/cli.md)
- [MCP interface for administrators](docs/mcp.md): manage the server with an MCP client
- [Kubernetes Helm chart](infra/k8s/README.md)
- [Version history](docs/version-history.md) and [changelog](CHANGELOG.md)
- All documents: [docs/](docs/)

## Support

Found a bug or missing a feature? Open an issue on [GitHub](https://github.com/MAGPEEK/CoreMail/issues).

## License

MIT — see [LICENSE](LICENSE).
