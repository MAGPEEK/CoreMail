# CoreMail — Deployment with one Compose file

Since 10.4 a CoreMail server needs no repository checkout and no configuration file.
Every release carries one standalone Compose file as a release asset; the app image
generates the secrets and brings the configuration files of the other containers.

```bash
mkdir coremail && cd coremail
curl -fsSLO https://github.com/MAGPEEK/CoreMail/releases/latest/download/docker-compose.yml
docker compose up -d
```

Then open `http://<server-ip>:3000/setup`; the one-time setup token is in
`./secrets/setup-token`. **Back up `./secrets/` off the server.**

- [Requirements](#requirements)
- [Ports](#ports)
- [First start](#first-start)
- [Setup wizard](#setup-wizard)
- [DNS](#dns)
- [Profiles](#profiles)
- [Configuration and overrides](#configuration-and-overrides)
- [Backup](#backup)
- [Update](#update)
- [Uninstall](#uninstall)
- [Advanced](#advanced)

The file lives in the repository as [`deploy/docker-compose.yml`](../deploy/docker-compose.yml);
the release asset is the same file with the image tag of that release
(`scripts/release-assets.sh`, see [Release asset](#release-asset)).

---

## Requirements

- A Linux server (x86-64 or arm64) with a public IPv4 address. Port 25 must be open in both
  directions — many cloud providers block outgoing port 25 until you ask them.
- Docker Engine 24 or newer with the Compose plugin 2.20 or newer (`docker compose version`).
  The convenience script `curl -fsSL https://get.docker.com | sh` installs both.
- RAM: 2 GB for the default stack (1–50 users), 4 GB with the `scanner` profile (ClamAV alone
  holds about 1 GB of signatures). Disk: mail volume plus about 3 GB for images.
- A domain whose DNS you control.

## Ports

| Host port | Use |
|-----------|-----|
| 25 | SMTP from other mail servers (required for incoming mail) |
| 465 / 587 | SMTP submission for mail apps (implicit TLS / STARTTLS) |
| 993 / 143 | IMAP (implicit TLS / STARTTLS) |
| 995 / 110 | POP3, optional (implicit TLS / STLS) — remove the two lines if not wanted |
| 80 → 3000 | HTTP: Let's Encrypt (HTTP-01) and redirect to HTTPS |
| 443 | HTTPS: webmail, admin panel, ActiveSync, MAPI, CalDAV/CardDAV, JMAP, Autodiscover |
| 3000 | HTTP without TLS: first setup, or the only port behind your own reverse proxy |
| 127.0.0.1:9001 | MinIO console, local only (profile `s3`) |

Behind your own reverse proxy (Traefik, Caddy, nginx) keep only `3000:3000`, remove
`80:3000` and `443:443`, and set `TRUST_PROXY` in a `.env` next to the Compose file
([deployment-security.md](deployment-security.md)).

## First start

`docker compose up -d` starts all containers at once; the **coremail** container prepares
everything the others need, and they wait for it:

1. **coremail**, first thing on every start —
   - copies the configuration bundled in the image into the `coremail-config-*` volumes and
     marks each volume ready ([below](#configuration-and-overrides));
   - writes every secret into `./secrets/` next to the Compose file: `coremail.env`
     (`JWT_SECRET`, `PEPPER`, database/Redis/MinIO/rspamd passwords, encryption keys) and the
     single-value password files the other containers read. Existing values are never
     overwritten; later starts only add missing keys ([setup.md → Automatic secrets](setup.md#automatic-secrets)).
2. **postgres** and **redis** (and the profile services) wait until their password file (and
   configuration) is there — a few seconds on a first start, a log line every 10 s, at most
   10 minutes — then start as usual. PostgreSQL runs the bundled init scripts on its first
   start (empty data directory only). A password set in `.env` needs no file.
3. **coremail** waits for PostgreSQL and Redis, creates the database schema and starts all
   services (`healthy` in `docker compose ps` about 30 s after `up` on a first start).

Details and the exact wait conditions: [setup.md → Docker Compose: start order](setup.md#docker-compose-start-order).

No `.env` is needed. A `.env` next to the Compose file stays optional and always wins: the
variable names are those of [`.env.example`](../.env.example) (for example `TZ`, `LOG_LEVEL`,
`TRUST_PROXY`, `COMPOSE_PROFILES`). `COREMAIL_SECRETS_PATH` moves the secrets directory.

```bash
docker compose ps                 # coremail: healthy
docker compose logs -f coremail   # first start: schema, then "CoreMail setup: open http://<server>:3000/setup — token in ./secrets/setup-token"
```

## Setup wizard

1. Read the token: `cat ./secrets/setup-token` (the files belong to root:
   `sudo cat ./secrets/setup-token` when needed, or `docker exec coremail cat /secrets/setup-token`).
2. Open `http://<server-ip>:3000/setup` and enter the token. The wizard starts with a **local
   domain** (`example.local`, host name `mail.example.local`) and a self-signed certificate, so it
   needs no DNS yet — keep it, or type your real domain if its DNS is ready. Then the first admin
   address (`admin@example.local`) and its password. The token is deleted once the setup is complete.
3. **Secrets sichern**: download the secrets file with **Secrets herunterladen**
   (`coremail-secrets-<host>-<date>.env`, possible only while the wizard runs and at most 24 h
   after the setup) and keep it off the server. Over plain HTTP the wizard warns to download it
   only on a local network; you can also copy `./secrets/coremail.env` yourself.
4. The wizard has no DNS or certificate step: sign in to the admin panel
   `http://<server-ip>:3000/bcp/` (after enrolling the second factor in the webmail). With the
   local domain the dashboard shows **Eigene Domain hinzufügen**:
   1. **Domains** → add your real domain (e.g. `example.com`) and enter the DNS records shown there;
   2. **Als primär festlegen** — the public host name moves from `mail.example.local` to
      `mail.example.com` and the client URLs follow;
   3. request the Let's Encrypt certificate with the dashboard card **Zertifikat einrichten**
      (or under **Certificates**; DNS must point at the server first).

   Then create the mailboxes. From then on the webmail is at `https://<your-host>/`, the admin
   panel at `https://<your-host>/bcp/`. The `example.local` domain can stay (mail from outside
   never reaches it) or be deleted once no mailbox uses it.

Details of every step: [setup-wizard.md](setup-wizard.md).

## DNS

Per mail domain (the admin panel shows the exact values under **Domains → DNS** and checks
them live):

| Record | Name | Value |
|--------|------|-------|
| A (and AAAA) | `mail.example.com` | the server's address |
| MX | `example.com` | `mail.example.com` (priority 10) |
| TXT (SPF) | `example.com` | the record the admin panel shows (includes the server) |
| TXT (DKIM) | `<selector>._domainkey.example.com` | the key the admin panel shows |
| TXT (DMARC) | `_dmarc.example.com` | the policy the admin panel suggests |
| CNAME / A | `autodiscover.example.com`, `autoconfig.example.com` | `mail.example.com` (client setup) |
| PTR | the server's address | `mail.example.com` — set at your hosting provider |

## Profiles

The default stack is CoreMail, PostgreSQL and Redis. SPF, DKIM, DMARC, ARC, DNSBL,
greylisting, the attachment filter and the sender lists always run inside the `coremail`
container. Optional services are Compose profiles:

| Profile | Adds | Notes |
|---------|------|-------|
| `scanner` | rspamd (spam scoring, Bayes) + ClamAV (virus scanning) | +1.5 GB RAM; ClamAV downloads ~300 MB of signatures on its first start |
| `backup` | `pg-backup`: a `pg_dump` every 24 h into the volume `pg-backups`, kept 14 days | `PG_BACKUP_INTERVAL_HOURS`, `PG_BACKUP_KEEP_DAYS`, `PG_BACKUP_DIR` (host path) in `.env` |
| `s3` | MinIO, an S3-compatible store | target of the built-in backup service (admin panel → Backup & Restore). Mail stays on `coremail-data` |

Give the profiles on every `docker compose` command, or once in a `.env` next to the
Compose file:

```bash
docker compose --profile scanner --profile backup up -d
# or permanently:
echo "COMPOSE_PROFILES=scanner,backup" >> .env
docker compose up -d
```

**Scanners need no further setting.** The file sets `RSPAMD_ENABLED=auto` and
`CLAMAV_ENABLED=auto`: when CoreMail starts and the host name `rspamd` / `clamav` does not
resolve (the profile is not active), the scanner counts as *not deployed* — it is skipped
and the admin panel hides its settings. When the profile is added later, CoreMail picks the
scanner up within five minutes (`SCANNER_CHECK_INTERVAL_SEC`), no restart needed. Once a
scanner was seen, an outage is *unavailable*: the failure policy of **Protection → Antivirus**
applies, it never silently switches scanning off. `RSPAMD_ENABLED=false` /
`CLAMAV_ENABLED=false` in `.env` switch a scanner off for good. After a profile change,
`docker compose ps` and **Protection** in the admin panel show the state
([antivirus.md](antivirus.md)). To remove the scanners again: `docker compose --profile scanner
stop rspamd clamav && docker compose --profile scanner rm -f rspamd clamav`, then
`docker compose up -d --force-recreate coremail`.

**The storage driver never changes by itself.** `OBJECT_STORAGE` defaults to `filesystem`
(the `coremail-data` volume) — also with the `s3` profile. To keep mail in MinIO set
`OBJECT_STORAGE=minio` in `.env` *before the first start*, or migrate existing mail with
`docker exec -it coremail coremail storage migrate --from filesystem --to minio`
([storage.md](storage.md)). External S3 for backups: `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY` in `.env` (no `s3` profile needed). Without either, the
backup service logs that its target is unreachable; mail is unaffected. Adding the `s3`
profile to a running installation: `docker compose --profile s3 up -d`, then
`docker compose restart coremail` so the backup service creates its bucket.

## Configuration and overrides

The image carries the configuration of the other containers under
`/usr/share/coremail/config/`:

| File | Volume | Mounted (read-only) in |
|------|--------|------------------------|
| `postgres/01-init.sql`, `postgres/02-app-role.sh` | `coremail-config-postgres` | postgres `/docker-entrypoint-initdb.d` |
| `rspamd/local.d/actions.conf`, `worker-controller.inc` | `coremail-config-rspamd` | rspamd `/etc/rspamd/local.d` |
| `pg-backup/pg-backup.sh` | `coremail-config-pg-backup` | pg-backup `/pg-backup` |

The `coremail` container copies them on **every** start (the volumes are mounted read-write
into it below `/config`), so an image update brings new versions; a
file a newer image no longer carries is removed (only files the tool wrote itself — a hidden
`.coremail-config-files` list per volume). After the files it writes a ready marker `.ready`
per volume: rspamd and pg-backup wait for it, PostgreSQL only on an empty data directory.
PostgreSQL runs its init scripts only on an empty data directory; an existing database is
never touched by them. rspamd and pg-backup read their files when they start — after an
update whose release notes mention a change of their configuration, run
`docker compose restart rspamd pg-backup` once. The `coremail-config-*` volumes hold nothing
else and can be deleted at any time (stop the stack first; the next start recreates them).

**rspamd overrides:** files in `./config/rspamd/local.d/` next to the Compose file win over
the bundled file of the same name; other names are added (any rspamd `local.d` snippet, for
example `multimap.conf`). The `coremail` container only reads that directory (the Compose
directory is mounted read-only into it at `/compose-dir`); symbolic links and files over 1 MB
are skipped. Apply a change with `docker compose restart coremail && docker compose restart rspamd`. Removing an override file
restores the bundled one on the next `up`. Keep `worker-controller.inc` as bundled unless you
know the rspamd controller: it restricts password-less access to the CoreMail container.

## Restarting CoreMail from the BCP

BCP → **Server → Health & Status → CoreMail neu starten** restarts the `coremail` container
(10.4.2): every CoreMail service stops gracefully, the container exits and its **restart
policy** starts it again. Webmail, BCP and the mail protocols are unavailable for about
20–30 seconds (the start runs the usual entrypoint steps, including the schema sync).
PostgreSQL, Redis, rspamd, ClamAV and the other containers are not touched — there is no
Docker socket in the container and no control of other containers.

- **Who:** ORGANIZATION_MANAGEMENT and SERVER_MANAGEMENT (area `servers`, write), organisation-wide
  only; an MFA-verified session when "MFA for admins" is on. The confirmation dialog needs the
  word `NEUSTART` (English UI: `RESTART`) or the public host name. API:
  `POST /api/v1/admin/servers/restart` → `202 { restarting: true, expectedDowntimeSeconds }`;
  one restart per 2 minutes server-wide (`429` + `Retry-After` otherwise). The audit entry
  `server.restart` is written before anything stops — if it cannot be written, nothing
  restarts (`503`).
- **After confirming** the BCP shows an overlay that polls `GET /healthz` every 2 seconds and
  reloads the page once CoreMail answers again; the session survives (the refresh cookie and
  the session live in PostgreSQL). After 3 minutes without an answer it points to
  `docker compose ps` / `docker compose logs coremail`.
- **Restart policy required:** every bundled Compose file (`deploy/docker-compose.yml`,
  `infra/docker/docker-compose*.yml` except the e2e file) sets `restart: unless-stopped` on
  `coremail`, and the [`docker run`](#docker-run) commands below use
  `--restart unless-stopped`. **Without a restart policy the container stays stopped** — start
  it again with `docker start coremail`. On Kubernetes the kubelet restarts the exited container
  (`restartPolicy: Always`, the restart count of the pod goes up).
- **How it works:** the api-gateway (user `node`) cannot signal supervisord (root). The root
  event listener `restart-watch` (`/usr/local/lib/coremail/restart-watch.py`,
  `[eventlistener:restart-watch]` in `supervisord-app.conf`) writes a new random secret
  (32 bytes, hex) to `/var/run/supervisor/restart.token` (root:node 0440) at every container
  start. The api-gateway writes that secret into `/var/run/supervisor/restart.request`; every
  5 seconds (`TICK_5`) the listener reads and deletes the request (regular files only, no
  symlinks, at most 256 bytes), compares it in constant time and on a match sends SIGTERM to
  supervisord — at most once per 2 minutes. supervisord stops all programs and exits with
  status 0, tini exits, Docker restarts the container. Rejected requests are logged as
  `restart-watch: REJECTED a restart request: …` without their content; the secret is never
  logged. The api-gateway's log output is not a channel: no program runs in supervisor's
  stdout capture mode, so text in a log line (a login e-mail, a path) cannot trigger anything.
  A gateway started outside the container (development) answers `409 RESTART_UNAVAILABLE`
  (`reason: not-supervised`, or `no-listener` when the secret is missing).

## Backup

Back up three things:

1. **`./secrets/`** — right after the first start, off the server (password manager, offline
   copy). The setup wizard offers `coremail.env` as a download. Without `PEPPER` no password
   works; without `JWT_SECRET` + `PEPPER` enrolled two-factor logins and encrypted backups cannot
   be read. The files belong to root: `sudo tar czf coremail-secrets.tar.gz secrets`.
2. **The database** (`pgdata`): profile `backup`, or by hand
   `docker exec coremail-postgres pg_dump -U coremail -Fc coremail > coremail-$(date +%F).dump`.
3. **The mail contents** (`coremail-data`, plus `miniodata` with `OBJECT_STORAGE=minio`):
   `docker run --rm -v coremail_coremail-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/coremail-data-$(date +%F).tar.gz -C /data .`

Database first, then the mail contents. Restore, the remaining volumes and the encrypted
built-in backups: [docker-compose.md → Backup and restore](docker-compose.md#backup-and-restore)
and [backup.md](backup.md).

## Update

```bash
docker compose pull && docker compose up -d --remove-orphans
```

The file names the image of its release (`magpeek/coremail-app:<version>`), so `pull` fetches
that version again — to move to a new release, download the new file first (back up the old
one, keep your `.env`):

```bash
cp docker-compose.yml docker-compose.yml.bak
curl -fsSLO https://github.com/MAGPEEK/CoreMail/releases/latest/download/docker-compose.yml
docker compose pull && docker compose up -d --remove-orphans
```

**Updating from 10.4.0:** that release had a one-shot init service; its stopped container
is left over. `--remove-orphans` removes it once (without the flag Compose only
warns about an orphan container — nothing breaks). The secrets in `./secrets/` stay exactly
as they are.

`COREMAIL_VERSION=<version>` in `.env` pins a different image tag (for example to go back to the
previous release). The `coremail` container refreshes the configuration volumes at its start,
`./secrets/` stays as it is, the database schema is updated at start. Read the
[version history](version-history.md) and the [release notes](releases/) before a major update.

## Uninstall

```bash
docker compose --profile scanner --profile backup --profile s3 down          # containers + networks, data kept
docker compose --profile scanner --profile backup --profile s3 down --volumes # ALSO deletes every volume: all mail and the database
```

Remove `./secrets/` only after the volumes are gone — the database cannot be opened without it.

## Advanced

### Other Compose variants

The repository's [`infra/docker/`](../infra/docker/) files (minimal, standard, full, Synology)
remain for existing installations and for setups that edit the files in a checkout
([docker-compose.md](docker-compose.md)). They bind-mount the configuration from the
checkout instead of the `coremail-config-*` volumes. All use the project name `coremail` and
the same volume names as this file. Moving an existing installation to the standalone file:

- copy its secrets directory (`infra/docker/secrets/`) next to the new file as `./secrets/`,
  and its `.env` (if any) as well;
- the standard `docker-compose.yml` keeps mail in MinIO unless `OBJECT_STORAGE` says
  otherwise — put `OBJECT_STORAGE=minio` into `.env` and use the `s3` profile (otherwise the
  startup check blocks with `missing-objects`; nothing is lost) and `scanner` for rspamd/ClamAV;
- stop the old stack (`docker compose -f infra/docker/docker-compose.yml down`, without
  `--volumes`), then `docker compose up -d` in the new directory.

### `docker run`

The default stack without Compose, in the same order as Compose: the `coremail` container
starts first. At its start it writes the secrets into `./secrets` and the bundled
configuration into the `coremail-config-*` volumes, then waits for the database (it
refreshes both on every later start). PostgreSQL and Redis wait in a small `sh -c` loop
until the files they need exist, then run their image's own entrypoint. Keep the `secrets`
directory.

```bash
mkdir -m 700 secrets
docker network create coremail

docker run -d --name coremail --network coremail --restart unless-stopped \
  -e COREMAIL_DB_HOST=coremail-postgres -e COREMAIL_REDIS_HOST=coremail-redis \
  -e OBJECT_STORAGE=filesystem -e RSPAMD_ENABLED=false -e CLAMAV_ENABLED=false \
  -e SECURITY_FILTER_URL=http://localhost:3002 \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v "$PWD/secrets:/secrets" -v coremail-data:/data \
  -v coremail-config-postgres:/config/postgres -v coremail-config-rspamd:/config/rspamd/local.d \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.5.0

docker run -d --name coremail-postgres --network coremail --restart unless-stopped \
  -e POSTGRES_DB=coremail -e POSTGRES_USER=coremail \
  -e POSTGRES_PASSWORD_FILE=/run/coremail/postgres-password \
  -v "$PWD/secrets:/run/coremail:ro" \
  -v coremail-config-postgres:/docker-entrypoint-initdb.d:ro \
  -v coremail-pgdata:/var/lib/postgresql/data \
  --entrypoint sh postgres:16-alpine \
  -c 'until [ -s /run/coremail/postgres-password ] && [ -f /docker-entrypoint-initdb.d/.ready ]; do sleep 2; done
      exec docker-entrypoint.sh postgres'

docker run -d --name coremail-redis --network coremail --restart unless-stopped \
  -v "$PWD/secrets:/run/coremail:ro" -v coremail-redisdata:/data \
  --entrypoint sh redis:7-alpine \
  -c 'until [ -s /run/coremail/redis-password ]; do sleep 2; done
      exec docker-entrypoint.sh redis-server --appendonly yes --requirepass "$(cat /run/coremail/redis-password)"'
```

`docker logs -f coremail` shows the start (the services come up once PostgreSQL answers).
Add `-p 110:110 -p 995:995` if you want POP3. The setup token is in `./secrets/setup-token`.
Update: pull the new tag, remove the `coremail` container and start it again with the same
command (new tag) — it refreshes the configuration volumes and adds missing secrets itself.

<details>
<summary>rspamd and ClamAV next to it</summary>

rspamd trusts only the CoreMail container's address, so both get fixed addresses on a small
network of their own. Replace the `coremail` command above with the three commands below
(`docker create` → attach the second network → `docker start`), then run the PostgreSQL and
Redis commands above and the two scanner containers. rspamd waits for its configuration
(`coremail-config-rspamd` volume) and its controller password (`./secrets`), then runs as
its own user.

```bash
docker network create --subnet 10.253.253.0/29 coremail-rspamd

docker create --name coremail --network coremail --restart unless-stopped \
  -e COREMAIL_DB_HOST=coremail-postgres -e COREMAIL_REDIS_HOST=coremail-redis \
  -e OBJECT_STORAGE=filesystem -e SECURITY_FILTER_URL=http://localhost:3002 \
  -e RSPAMD_URL=http://10.253.253.3:11334 -e CLAMAV_HOST=coremail-clamav -e CLAMAV_PORT=3310 \
  -p 25:25 -p 465:465 -p 587:587 -p 143:143 -p 993:993 \
  -p 80:3000 -p 443:443 -p 3000:3000 \
  -v "$PWD/secrets:/secrets" -v coremail-data:/data \
  -v coremail-config-postgres:/config/postgres -v coremail-config-rspamd:/config/rspamd/local.d \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  magpeek/coremail-app:10.5.0
docker network connect --ip 10.253.253.2 coremail-rspamd coremail
docker start coremail

# … the PostgreSQL and Redis commands above, then:
docker run -d --name coremail-rspamd --network coremail-rspamd --ip 10.253.253.3 --restart unless-stopped \
  -e RSPAMD_CONTROLLER_SECURE_IP=10.253.253.2 \
  -v "$PWD/secrets:/run/coremail:ro" \
  -v coremail-config-rspamd:/etc/rspamd/local.d:ro \
  -v coremail-rspamd-data:/var/lib/rspamd \
  --user 0:0 --entrypoint sh rspamd/rspamd:4.0.0 \
  -c 'until [ -s /run/coremail/rspamd-controller-password ] && [ -f /etc/rspamd/local.d/.ready ]; do sleep 2; done
      RSPAMD_CONTROLLER_PASSWORD="$(cat /run/coremail/rspamd-controller-password)" && export RSPAMD_CONTROLLER_PASSWORD
      exec setpriv --reuid=11333 --regid=11333 --clear-groups /usr/bin/rspamd -f'

docker run -d --name coremail-clamav --network coremail --restart unless-stopped \
  -v coremail-clamav-data:/var/lib/clamav \
  clamav/clamav:stable
```

ClamAV downloads about 300 MB of signatures on its first start; scanning begins once that is
done.

</details>

### Kubernetes

Helm chart: [infra/k8s/README.md](../infra/k8s/README.md).

### Release asset

`bash scripts/release-assets.sh <version>` copies `deploy/docker-compose.yml`, sets the image
default to `${COREMAIL_VERSION:-<version>}`, checks the file (`docker compose config` for every
profile, no repository bind mounts) and uploads it to the GitHub release `v<version>` as
`docker-compose.yml` (`gh release upload … --clobber`). `--dry-run` builds and checks without
uploading. Run it after the image is on Docker Hub and the release exists; the
`releases/latest/download/docker-compose.yml` URL then serves the new file.
