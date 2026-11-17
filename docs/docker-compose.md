# CoreMail — Docker Compose variants and storage

CoreMail ships three ready-made Compose stacks in `infra/docker/`. All three run the
same app image, use the same project name (`coremail`), the same container names and
the same volume names — you can switch between them without moving data.

- [Variants](#variants)
- [Quick start](#quick-start)
- [Minimal: spam and virus scanning off](#minimal-spam-and-virus-scanning-off)
- [Full: profiles, limits, logs](#full-profiles-limits-logs)
- [Storage](#storage)
  - [What lives where](#what-lives-where)
  - [Named volumes vs. bind mounts](#named-volumes-vs-bind-mounts)
  - [Owners and permissions](#owners-and-permissions)
  - [Separate disk](#separate-disk)
  - [NAS: NFS](#nas-nfs)
  - [NAS: SMB/CIFS](#nas-smbcifs)
  - [Docker volume driver (NFS/CIFS)](#docker-volume-driver-nfscifs)
  - [External S3 instead of local storage](#external-s3-instead-of-local-storage)
  - [Moving data to a new disk](#moving-data-to-a-new-disk)
  - [Backup and restore](#backup-and-restore)
  - [Disk sizing](#disk-sizing)
- [Switching variants](#switching-variants)

Related: [deployment-docker.md](deployment-docker.md) (general Docker operation),
[storage.md](storage.md) (object storage drivers, migration),
[deployment-security.md](deployment-security.md) (hardening, encrypted backups).

---

## Variants

| | **Minimal** | **Standard** | **Full (maximal)** |
|---|---|---|---|
| File | `docker-compose.minimal.yml` | `docker-compose.yml` | `docker-compose.full.yml` |
| Services | coremail, postgres, redis | + minio, rspamd, clamav | coremail, postgres, redis, rspamd, clamav; profiles `minio`, `backup`, `geoip` |
| Mail storage | filesystem (`coremail-data`) only | filesystem, MinIO or S3 (`OBJECT_STORAGE`, unset = minio) | filesystem, MinIO (profile) or S3 — must be set |
| SPF / DKIM / DMARC / ARC, DNSBL, greylisting, attachment filter | yes | yes | yes |
| Spam scoring (rspamd, Bayes) | — | yes | yes |
| Virus scanning (ClamAV) | — | yes | yes |
| Built-in backups (BCP → Backup) | only with an external S3 target (`S3_*`) | bundled MinIO | bundled MinIO (profile) or external S3 |
| Daily `pg_dump` sidecar | — | — | profile `backup` |
| GeoIP country filter database | — | — | profile `geoip` |
| Resource limits | coremail only | coremail only | every service (limits + reservations) |
| Log rotation (json-file) | 10 MB × 3 per container | Docker daemon default (no rotation unless set in `daemon.json`) | 20 MB × 5 per container (`LOG_MAX_SIZE`, `LOG_MAX_FILE`) |
| RAM measured idle (empty install) | ~0.8–1 GB | ~2 GB | ~2 GB (+0.1 GB with minio) |
| Plan for | 2 GB RAM, 1–2 vCPU | 4 GB RAM, 2 vCPU | 4 GB RAM, 2–4 vCPU; 8 GB from ~200 users |
| Users | 1–50 | 10–200 | 50–500 |
| Use it when | small VPS, family/club/small office, spam filtering upstream (or acceptable without) | existing installations; the default | business use, many users, you want limits, log rotation and dumps out of the box |

Measured with 8.0.0 directly after start: coremail 630–850 MB (12 Node.js services), clamav
~950 MB, rspamd ~230 MB, postgres ~105–120 MB, minio ~90 MB, redis ~10 MB. ClamAV briefly
needs about twice its memory while it reloads signatures; PostgreSQL grows with the number
of mailboxes and messages.

**Same everywhere:** the app container hardening (`no-new-privileges`, `cap_drop: ALL` with
the few capabilities the entrypoint and supervisord need,
[deployment-security.md §5](deployment-security.md#5-container-hardening-docker-composeyml)),
`${VAR:?}` checks for required secrets, healthchecks on the app/postgres/redis, the dedicated
app ↔ rspamd network `10.253.253.0/29` (standard/full), and the ports (25, 465, 587, 143,
993, 110, 995, 80→3000, 443, 3000). Minimal and full additionally set `no-new-privileges` on
the infrastructure containers.

---

## Quick start

All commands run in the repository root. `scripts/setup.sh` creates `.env` with random
secrets (never overwrites an existing one) and prints the matching command.

```bash
# Minimal
bash scripts/setup.sh --variant minimal
docker compose -f infra/docker/docker-compose.minimal.yml up -d

# Standard (default — same as running setup.sh without a flag)
bash scripts/setup.sh --variant standard
docker compose -f infra/docker/docker-compose.yml up -d

# Full
bash scripts/setup.sh --variant full
docker compose -f infra/docker/docker-compose.full.yml --profile backup up -d
#   + --profile minio   bundled MinIO (OBJECT_STORAGE=minio, or built-in backups without external S3)
#   + --profile geoip   GeoLite2 updates (GEOIPUPDATE_ACCOUNT_ID / GEOIPUPDATE_LICENSE_KEY in .env)
#   or put COMPOSE_PROFILES=backup,minio into .env
```

Without `setup.sh`: `cp .env.example .env`, replace the `CHANGE-ME` values
(`openssl rand -hex 32` for `JWT_SECRET`/`PEPPER`, `openssl rand -hex 20` for passwords),
keep `OBJECT_STORAGE=filesystem`, and for standard/full add
`RSPAMD_CONTROLLER_PASSWORD=$(openssl rand -hex 20)` (required by the full variant).

Then, for every variant:

```bash
docker logs coremail 2>&1 | grep -i "setup token"     # one-time token for the wizard
# browser: http://<server-ip>:3000/bcp/  → admin account + first domain
curl -s http://localhost:3000/healthz                 # {"ok":true,…,"storage":{"driver":"filesystem","status":"ok"}}
```

Required `.env` values per variant:

| Variable | Minimal | Standard | Full |
|---|---|---|---|
| `JWT_SECRET`, `PEPPER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | required | required | required |
| `MINIO_ROOT_PASSWORD` | not used | required | profile `minio` only |
| `RSPAMD_CONTROLLER_PASSWORD` | not used | recommended | required |
| `OBJECT_STORAGE` | ignored (always `filesystem`) | optional (unset = `minio`) | required |
| `BACKUP_ENCRYPTION_KEY`, `COREMAIL_DB_USER`/`_PASSWORD` | recommended (setup.sh) | recommended | recommended |

---

## Minimal: spam and virus scanning off

The minimal stack has no rspamd and no ClamAV containers. The checks that run inside the
`coremail` container stay active: SPF, DKIM, DMARC, ARC, DNSBL, greylisting, the attachment
filter (blocked extensions, size) and the black lists.

The security filter treats both scanners as not deployed because of the environment switches
below (only these switches do that — a missing `rspamd` / `clamav` host name in the compose
network counts as "unavailable / host not found", and the failure policy applies) and skips
them without tagging mail as unscanned. BCP → Protection hides the Rspamd and Antivirus tabs and shows the line
"… ist in dieser Installation nicht bereitgestellt" instead
([antivirus.md](antivirus.md#installations-without-clamav-or-rspamd)).

The minimal compose file sets `RSPAMD_ENABLED=false` and `CLAMAV_ENABLED=false`. These
environment switches override the BCP → Protection settings (which default to on), so
nothing has to be done after the setup wizard. `true` never forces a scanner on — then the
BCP setting decides. A custom compose file without the scanner containers must set the env
switches too — otherwise the BCP shows "Host nicht gefunden" and ClamAV's failure policy
(unscanned header, or `451` with "block on failure") applies to every message. Alternatively
switch both off in BCP → **Protection**, or via the admin API:

  ```bash
  TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","password":"…"}' | jq -r .accessToken)
  curl -s -X PUT http://localhost:3000/api/v1/admin/security/settings \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"rspamdEnabled":false,"clamavEnabled":false}'
  ```

  (An admin with MFA gets a `challengeToken` first — use the BCP then.) The security filter
  reloads the settings immediately.

What happens if you forget it (verified on 8.0.0): inbound mail is **still delivered** —
rspamd failures fail open (score 0) and ClamAV failures accept the message unscanned — but
every inbound message waits for the failing name lookups of the missing hosts (about 10 s
measured) and logs two errors. **Exception:** if "ClamAV: block on failure"
(`clamavBlockOnFailure`) is on, every inbound mail is deferred with `451` until ClamAV is
switched off. With both scanners off, a message is accepted in well under a second and
nothing is logged.

ClamAV policy, the EICAR test and recommended `clamd.conf` limits (mounted config,
`FRESHCLAM_CHECKS`): [antivirus.md](antivirus.md).

`SECURITY_FILTER_FAIL_OPEN` is unrelated: it only decides what happens when the content
pipeline crashes internally (default: defer). Leave it unset.

The "Mark as spam / not spam" buttons in webmail try to train rspamd; without rspamd that
call fails quietly (logged). Sender block lists still work.

---

## Full: profiles, limits, logs

**Profiles** (combine freely; the stack works without any of them):

| Profile | Service | What it does |
|---|---|---|
| `minio` | `minio` | Bundled MinIO, console on `127.0.0.1:9001`. Needed for `OBJECT_STORAGE=minio` (mail from before 8.0) and as the default target of the built-in backup service. `coremail` waits for it only when the profile is active. |
| `backup` | `pg-backup` | `postgres:16-alpine` running `infra/docker/pg-backup/pg-backup.sh`: a `pg_dump` (custom format) every `PG_BACKUP_INTERVAL_HOURS` (24) into `PG_BACKUP_DIR` (default: volume `pg-backups`), first one `PG_BACKUP_START_DELAY_MIN` (10) minutes after start, keeps `PG_BACKUP_KEEP_DAYS` (14). Runs as root without capabilities, read-only root file system. Healthy = a dump younger than two intervals exists. |
| `geoip` | `geoip` | `ghcr.io/maxmind/geoipupdate` refreshes `GeoLite2-Country.mmdb` every 72 h into the volume `geoip-data`, mounted read-only into `coremail` at `/usr/share/GeoIP`. Needs a free MaxMind account (`GEOIPUPDATE_ACCOUNT_ID`, `GEOIPUPDATE_LICENSE_KEY`). The filter loads the file on first use — after an update run `docker exec coremail supervisorctl restart security-filter`. |

**Resource limits** (all overridable in `.env`):

| Service | Limit | Reservation | `.env` |
|---|---|---|---|
| coremail | 2 CPU, 2 GB | 768 MB | `COREMAIL_CPU_LIMIT`, `COREMAIL_MEM_LIMIT`, `COREMAIL_MEM_RESERVATION` |
| postgres | 2 CPU, 1 GB | 256 MB | `POSTGRES_CPU_LIMIT`, `POSTGRES_MEM_LIMIT` |
| clamav | 1 CPU, 2.5 GB | 1 GB | `CLAMAV_MEM_LIMIT` |
| rspamd | 1 CPU, 512 MB | 128 MB | `RSPAMD_MEM_LIMIT` |
| redis | 1 CPU, 512 MB | 64 MB | `REDIS_MEM_LIMIT` |
| minio | 1 CPU, 1 GB | 128 MB | `MINIO_MEM_LIMIT` |
| pg-backup / geoip | 1 CPU 256 MB / 0.5 CPU 128 MB | — | — |

Limits are ceilings, not allocations. For more than ~200 users raise coremail to 3–4 GB and
postgres to 2 GB. Redis has no `maxmemory` on purpose — BullMQ queues must never be evicted.

**Logs:** json-file, `LOG_MAX_SIZE` (20m) × `LOG_MAX_FILE` (5) per container — at most
~100 MB per container. `docker logs` keeps working.

---

## Storage

### What lives where

| Data | Container path | Volume (project prefix `coremail_`) | Back up? |
|---|---|---|---|
| Mail contents (raw messages), attachments, quarantine, outbound queue attachments, JMAP uploads, S/MIME files — `OBJECT_STORAGE=filesystem` | coremail `/data/objects` | `coremail-data` | **yes** |
| Pre-migration database dumps (`pre-migrate-<ts>.sql.gz`, written before a destructive schema update) | coremail `/data/backups` | `coremail-data` | yes |
| Users, folders, mail metadata, calendars, contacts, settings, certificates, DKIM keys | postgres `/var/lib/postgresql/data` | `pgdata` | **yes (dump)** |
| Sessions, BullMQ queues (outbound mail in flight), greylisting, caches | redis `/data` | `redisdata` | optional |
| Mail contents with `OBJECT_STORAGE=minio`; built-in backups (bucket `coremail-backups`) | minio `/data` | `miniodata` | yes, if used |
| Bayes statistics, fuzzy hashes | rspamd `/var/lib/rspamd` | `rspamd-data` | optional |
| Virus signatures (re-downloaded) | clamav `/var/lib/clamav` | `clamav-data` | no |
| `pg_dump` files (full, profile `backup`) | pg-backup `/backups` | `pg-backups` or `PG_BACKUP_DIR` | copy off-host |
| GeoLite2 database (full, profile `geoip`) | `/usr/share/GeoIP` | `geoip-data` | no |

The `coremail` container itself is stateless — recreate it at will.

### Named volumes vs. bind mounts

**Named volumes** (the default in all three files) live under
`/var/lib/docker/volumes/coremail_<name>/_data`. Docker creates them with the right owner
from the image; nothing to prepare. Downside: they sit on the disk that holds
`/var/lib/docker`.

**Bind mounts** map a host directory. Use them to put data on a specific disk, to back up with
host tools, or on a NAS. Example override that works with all three variants:
`infra/docker/docker-compose.bind-mounts.example.yml`.

```bash
sudo install -d -m 750 -o 1000 -g 1000 /srv/coremail/data        # coremail (node)
sudo install -d -m 700 -o 70   -g 70   /srv/coremail/postgres    # postgres:16-alpine
sudo install -d -m 700 -o 999  -g 1000 /srv/coremail/redis       # redis:7-alpine
cp infra/docker/docker-compose.bind-mounts.example.yml infra/docker/docker-compose.bind-mounts.yml
docker compose -f infra/docker/docker-compose.minimal.yml \
               -f infra/docker/docker-compose.bind-mounts.yml up -d
```

The override contains, for example:

```yaml
services:
  coremail:
    volumes:
      - /srv/coremail/data:/data
  postgres:
    volumes:
      - /srv/coremail/postgres:/var/lib/postgresql/data
```

An entry with the same container path replaces the named volume of the base file. Always
pass both `-f` files (every `up`, `down`, `pull`) — or set
`COMPOSE_FILE=infra/docker/docker-compose.minimal.yml:infra/docker/docker-compose.bind-mounts.yml`
in your shell.

### Owners and permissions

| Container | User (UID:GID) | Directory | What the image does by itself |
|---|---|---|---|
| coremail | `node` 1000:1000 | `/data` → `/data/objects` 0750, files 0640 | The entrypoint (root) creates `STORAGE_PATH`, `chown -R node:node` it when its owner is not `node`, and `chmod 750`. `/data/backups` is created by root, 0700/0600 files. `/data` itself is left as it is (root-owned is fine). |
| postgres | `postgres` 70:70 (alpine! The Debian image uses 999) | `/var/lib/postgresql/data` 0700 | The entrypoint chowns the data directory to `postgres` and sets 0700. |
| redis | `redis` 999:1000 | `/data` | The entrypoint chowns `/data` to `redis`. |
| rspamd | `_rspamd` 11333:11333 | `/var/lib/rspamd` | Runs as `_rspamd` directly — a bind mount must belong to 11333. |
| clamav | `clamav` 100:101 | `/var/lib/clamav` | The init script chowns it. |
| minio | root | `/data` | — |
| pg-backup | root (no capabilities) | `/backups` | Must be writable by root **without** `DAC_OVERRIDE`: owner root, 0700. |

On a local file system the images fix ownership themselves, so a root-owned empty directory
works — creating them with the owners above just avoids the chown on the first start. On
NFS with `root_squash` and on SMB the containers **cannot** chown; there the owners must be
right from the start (next sections).

### Separate disk

Put the mail store (and optionally the database) on its own disk:

```bash
sudo mkfs.ext4 -L coremail /dev/sdb1          # or xfs
sudo mkdir -p /srv/coremail
echo 'LABEL=coremail /srv/coremail ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount /srv/coremail
sudo install -d -m 750 -o 1000 -g 1000 /srv/coremail/data
sudo install -d -m 700 -o 70   -g 70   /srv/coremail/postgres
```

Then use the bind-mount override above. Make sure the disk is mounted before Docker starts
(`systemctl edit docker` → `[Unit]` `RequiresMountsFor=/srv/coremail`) — otherwise Docker
would create empty directories on the root disk. CoreMail's startup check refuses to start
the mail services when objects referenced by the database are missing (`/healthz` 503,
`missing-objects`), so an unmounted disk does not silently lose mail.

### NAS: NFS

**Mail objects (`/data`) on NFS: fine.** The filesystem driver writes each object to a temp
file, `fsync`s it and `rename`s it into place (atomic within one directory on NFS), and
objects are write-once — it needs no file locks. **PostgreSQL must not be on NFS** (see below).

NAS export (`/etc/exports` on a Linux NAS):

```
/export/coremail  10.0.0.10(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

- `all_squash,anonuid=1000,anongid=1000` maps every access (including the entrypoint's
  root) to UID 1000 = `node`. This is the simplest and safest choice.
- With the default `root_squash`, root in the container becomes `nobody` — create the
  directory on the NAS owned by 1000:1000 and mode 0750 beforehand; the entrypoint then sees
  the right owner and skips the chown (a failing `chmod` is ignored). But the pre-migration
  dump (`/data/backups`, written as root) would fail — set
  `COREMAIL_SCHEMA_BACKUP_DIR` to a local path or prefer `all_squash`.
- `no_root_squash` also works but gives the container's root full root rights on the
  export — avoid it.
- Use `sync` exports and `hard` mounts. Never `async` / `soft`: they can acknowledge an
  `fsync` that never reached the disk.

Client side (`/etc/fstab` on the Docker host):

```
nas.lan:/export/coremail  /srv/coremail/data  nfs4  rw,hard,noatime,nfsvers=4.1,proto=tcp,_netdev  0 0
```

Caveats: a NAS outage blocks the mail services (hard mount) instead of failing — mail queues
up at the senders (SMTP retries for days). Latency adds to every message delivery; keep the
NAS on the same LAN.

### NAS: SMB/CIFS

Possible for `/data`, but second choice after NFS: SMB ignores `chown`/`chmod`, so ownership
comes from mount options.

```
//nas/coremail  /srv/coremail/data  cifs  credentials=/root/.smb-coremail,uid=1000,gid=1000,file_mode=0640,dir_mode=0750,vers=3.1.1,serverino,nobrl,_netdev  0 0
```

`/root/.smb-coremail` (mode 0600): `username=…`, `password=…`. With `uid=1000` every file
appears owned by `node` and the entrypoint skips the chown. Use SMB 3.x (`vers=3.1.1`).

**Never put PostgreSQL (`pgdata`) on NFS or SMB.** PostgreSQL relies on POSIX `fsync`,
`rename` and file-locking semantics that network file systems do not guarantee (or only with
careful tuning); a network hiccup can corrupt the database, and SMB additionally breaks
permissions (PostgreSQL refuses a data directory that is not owned by its user with mode 0700 or 0750). Keep
`pgdata` on a local disk and back it up with `pg_dump` (profile `backup` or the commands
below) to the NAS instead. The same applies to Redis (AOF, small — keep it local).

### Docker volume driver (NFS/CIFS)

Instead of mounting on the host, let Docker mount the share as a named volume (Docker's
built-in `local` driver):

```yaml
# second -f file, e.g. infra/docker/docker-compose.nfs.yml
volumes:
  coremail-data:
    driver: local
    driver_opts:
      type: nfs
      o: "addr=10.0.0.5,nfsvers=4.1,rw,hard,noatime"
      device: ":/export/coremail"
```

CIFS:

```yaml
volumes:
  coremail-data:
    driver: local
    driver_opts:
      type: cifs
      o: "addr=10.0.0.5,username=coremail,password=${SMB_PASSWORD},uid=1000,gid=1000,file_mode=0640,dir_mode=0750,vers=3.1.1"
      device: "//10.0.0.5/coremail"
```

Docker never changes an **existing** volume's options: copy the data off (see
[Moving data](#moving-data-to-a-new-disk)), `docker volume rm coremail_coremail-data`, then
`up -d` with the override. The share must be reachable when the container starts.

### External S3 instead of local storage

For object storage at AWS, Backblaze B2, Wasabi, Hetzner or Cloudflare R2, use the
**standard** or **full** variant with `OBJECT_STORAGE=s3` and `MINIO_ENDPOINT`,
`MINIO_USE_SSL=true`, `MINIO_REGION`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` in `.env`
(examples per provider: [storage.md → minio / s3](storage.md#minio--s3)). Mail contents then
never touch the local disk; PostgreSQL stays local. Built-in backups can go to S3 too
(`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — use a separate bucket/key
with lifecycle rules). The minimal variant accepts the `S3_*` backup target, but always stores
mail on the filesystem.

Moving existing mail between drivers: `coremail storage migrate --from X --to Y`
([storage.md → Migration](storage.md#migration)).

### Moving data to a new disk

Example: named volumes → `/srv/coremail` (new disk mounted there).

```bash
cd /path/to/coremail
F=infra/docker/docker-compose.yml           # the variant you run

# 1. Backup first (database dump, see below), then stop everything
docker exec coremail-postgres pg_dump -U coremail -Fc coremail > ~/coremail-before-move.dump
docker compose -f $F down                   # NO -v — that would delete the volumes

# 2. Copy (preserves owners, hard links, ACLs, xattrs; numeric IDs)
sudo rsync -aHAX --numeric-ids /var/lib/docker/volumes/coremail_coremail-data/_data/ /srv/coremail/data/
sudo rsync -aHAX --numeric-ids /var/lib/docker/volumes/coremail_pgdata/_data/        /srv/coremail/postgres/
sudo rsync -aHAX --numeric-ids /var/lib/docker/volumes/coremail_redisdata/_data/     /srv/coremail/redis/

# 3. Point Compose at the new paths and start
cp infra/docker/docker-compose.bind-mounts.example.yml infra/docker/docker-compose.bind-mounts.yml
docker compose -f $F -f infra/docker/docker-compose.bind-mounts.yml up -d

# 4. Verify, then (days later) remove the old volumes
curl -s http://localhost:3000/healthz                 # storage status "ok"
docker exec -it coremail coremail storage check
docker volume rm coremail_coremail-data coremail_pgdata coremail_redisdata
```

The PostgreSQL files can only be copied while PostgreSQL is stopped and only to the same
major version (16). Large mail stores: run step 2 once while the stack is up (bulk copy), then
again after `down` (only the difference) to keep the downtime short.

### Backup and restore

Order: **database first, then the objects** (objects are only ever added, so a slightly newer
object store is harmless). Volume names carry the prefix `coremail_` (`docker volume ls`).

| Volume | Backup | Restore |
|---|---|---|
| `pgdata` | `docker exec coremail-postgres pg_dump -U coremail -Fc coremail > coremail-$(date +%F).dump` (online, consistent) — or the `pg-backup` profile | `docker compose … stop coremail`, then `docker exec -i coremail-postgres pg_restore -U coremail -d coremail --clean --if-exists < coremail-<date>.dump`, `up -d` |
| `coremail-data` | `docker run --rm -v coremail_coremail-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/coremail-data-$(date +%F).tar.gz -C /data --exclude='.tmp-*' .` (online is fine) — bind mount: any file backup of `/srv/coremail/data` | `docker run --rm -v coremail_coremail-data:/data -v "$PWD":/backup alpine sh -c 'cd /data && tar xzf /backup/coremail-data-<date>.tar.gz && chown -R 1000:1000 /data/objects'`, then `coremail storage check` |
| `miniodata` | same `tar` pattern with `coremail_miniodata` (stop `minio` for a consistent copy), or `mc mirror` | same pattern |
| `redisdata` | optional: `docker exec coremail-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE`, then copy the volume | losing it costs sessions (users log in again), greylisting state and mail still in the outbound queue |
| `rspamd-data` | optional `tar` of the volume (Bayes training) | `tar` back, owner 11333 |
| `clamav-data`, `geoip-data` | not needed (downloaded again) | — |

Do not copy `pgdata` file by file while PostgreSQL runs — use the dump. Restore the dump with
the superuser `coremail` and keep the owners (as above, without `--no-owner`): with the
least-privilege role `coremail_app` the tables belong to that role.

**pg-backup profile (full):** `ls` the dumps with
`docker run --rm -v coremail_pg-backups:/b alpine ls -l /b` (or `PG_BACKUP_DIR` on the host);
restore one with the `pg_restore` line above. The dumps are plaintext (password hashes, mail
metadata) — keep the directory 0700 and encrypt off-site copies (`restic`, `borg`, `age`).

**Built-in backups (BCP → Backup & Restore):** full and mailbox backups are encrypted with
AES-256-GCM (`BACKUP_ENCRYPTION_KEY`) and stored as `*.zip.enc` / `*.mbox.enc` in the bucket
`coremail-backups` (bundled MinIO or `S3_*`). Store `BACKUP_ENCRYPTION_KEY` off the server.
Without CoreMail: download the object and run
`BACKUP_ENCRYPTION_KEY=<64 hex> node scripts/decrypt-backup.mjs in.zip.enc out.zip`
([deployment-security.md §4](deployment-security.md#4-encrypted-backups)). The minimal variant
has no bucket — set the `S3_*` variables or rely on the dump + `coremail-data` backup.
Schedules („Empfohlene Sicherung einrichten"), the database backup scope, restoring stored
archives and what the built-in backups do not cover: [backup.md](backup.md).

**Pre-migration dumps:** before a destructive schema update (only with
`COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true`) CoreMail writes
`/data/backups/pre-migrate-<ts>.sql.gz` (plain SQL, gzip, 0600) on `coremail-data`:

```bash
docker run --rm -v coremail_coremail-data:/data alpine ls -l /data/backups
docker run --rm -v coremail_coremail-data:/data alpine cat /data/backups/pre-migrate-<ts>.sql.gz \
  | gunzip | docker exec -i coremail-postgres psql -U coremail -d coremail   # stack stopped except postgres
```

Details: [deployment-security.md §2](deployment-security.md#2-database-schema-updates-fail-closed).
These dumps are not deleted automatically — remove old ones by hand.

### Disk sizing

| What | Rule of thumb |
|---|---|
| `coremail-data` (objects) | ≈ 1.2 × the raw mail volume without attachments; up to **2 ×** for attachment-heavy mail (the raw message and the decoded attachments are both stored). Budget `users × quota × 2` when quotas will fill. Add 20 % free space. |
| `pgdata` | 5–10 % of the mail volume (metadata, search columns, calendars, contacts), at least 2 GB. Grows with message count more than with size. |
| `pg-backups` | one compressed dump ≈ 20–40 % of the database size × `PG_BACKUP_KEEP_DAYS`. |
| `miniodata` | as `coremail-data` when `OBJECT_STORAGE=minio`, plus built-in backups (retention `BACKUP_RETENTION_DAYS`). |
| `redisdata` | < 1 GB; spikes with large outbound queues. |
| `clamav-data` | ~1 GB. `rspamd-data` < 500 MB. `geoip-data` < 10 MB. |
| Images + logs | ~2.5 GB of images (app 1.4 GB, clamav 0.4 GB, postgres 0.4 GB, rspamd 0.3 GB); logs ≤ 30 MB (minimal) / 100 MB (full) per container. |

Example: 50 users with 5 GB quota, half used → 125 GB of mail → plan ~250 GB for objects,
~15 GB for PostgreSQL, a few GB for the rest. Monitor with `docker system df -v` and
`du -sh /srv/coremail/*`.

---

## Switching variants

All three files use the project name `coremail`, the same container names and the same volume
names, so the data stays where it is. Always stop with the **old** file and **without `-v`**.

**Minimal → standard or full** (add spam/virus scanning):

```bash
bash scripts/setup.sh --variant full        # adds RSPAMD_CONTROLLER_PASSWORD to .env, keeps the rest
docker compose -f infra/docker/docker-compose.minimal.yml down
docker compose -f infra/docker/docker-compose.full.yml --profile backup up -d
```

The full stack does not set `RSPAMD_ENABLED`/`CLAMAV_ENABLED`, so the BCP → Protection
settings apply again (on by default; turn them on if you had switched them off there).
ClamAV needs a few minutes for its first signature download; mail is accepted meanwhile.
The Rspamd and Antivirus tabs in BCP → Protection come back by themselves (the deployment check
runs every 5 minutes); while ClamAV loads its signatures the Antivirus tab shows a warning.

**Standard → full:** `.env` needs `OBJECT_STORAGE` (setup.sh tells you) and
`RSPAMD_CONTROLLER_PASSWORD`. If your mail is in MinIO (`OBJECT_STORAGE` unset or `minio`)
or you use the built-in backups, start with `--profile minio` — the `miniodata` volume is
reused.

**Standard or full → minimal:** the minimal stack only knows the filesystem driver. If mail
is in MinIO, migrate first on the running stack:
`docker exec -it coremail coremail storage migrate --from minio --to filesystem`
([storage.md](storage.md#minio--filesystem-existing-installation)), set
`OBJECT_STORAGE=filesystem`, then switch and remove the orphaned containers:

```bash
docker compose -f infra/docker/docker-compose.yml down
docker compose -f infra/docker/docker-compose.minimal.yml up -d --remove-orphans
```

The minimal file switches rspamd/ClamAV off by itself (`RSPAMD_ENABLED=false`,
`CLAMAV_ENABLED=false`). The volumes `miniodata`, `rspamd-data` and
`clamav-data` stay until you delete them (`docker volume rm coremail_miniodata …`) — keep
`miniodata` until you are sure nothing (old backups) is needed from it.

Switching never touches the database schema or `.env` secrets; `JWT_SECRET` and `PEPPER`
must stay the same.
