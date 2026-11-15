# Mail storage (object storage drivers)

CoreMail keeps **metadata** (users, folders, flags, UIDs, settings) in PostgreSQL and
**contents** — the raw RFC 5322 message of every mail, attachments, quarantined mails,
attachments of queued outbound mails, JMAP uploads, S/MIME files — in an *object store*.
Since 8.0 the object store is a driver, selected with `OBJECT_STORAGE`:

| Driver | Where the objects live | Typical use |
|---|---|---|
| `filesystem` | Directory `STORAGE_PATH` (default `/data/objects`) on the Docker volume `coremail-data` | **Default for new installations.** Single host, NAS (Synology), simple backups |
| `minio` | Bundled MinIO container (`minio:9000`, bucket `coremail-attachments`) | **Default when `OBJECT_STORAGE` is not set** — every installation from before 8.0 |
| `s3` | Any S3 API: AWS S3, Backblaze B2, Wasabi, Hetzner Object Storage, Cloudflare R2, a remote MinIO | Off-host storage, large mailboxes, Kubernetes |

The app container itself is stateless (Docker principle): recreate or update it at will,
the state is in PostgreSQL and the object store.

## Compatibility (upgrading from 7.0 or older)

Nothing to do. An installation that runs `git pull && docker compose pull && docker compose up -d`
with its unchanged `.env` (no `OBJECT_STORAGE` line) keeps using MinIO exactly as before:

- the code default is `minio`, and `docker-compose.yml` passes `${OBJECT_STORAGE:-minio}`;
- the `minio` service stays in `docker-compose.yml` and starts by default (no Compose profile);
- the new volume `coremail-data` is mounted but stays empty;
- the bucket is still `coremail-attachments` (`MINIO_BUCKET_ATTACHMENTS`); the old, never-used
  `MINIO_BUCKET: mail-attachments` line was removed from the Compose files.

Moving an existing installation to the filesystem is optional — see [Migration](#migration).

**Why MinIO stays in the Compose file**: the backup service writes its exports to the bucket
`coremail-backups` on the bundled MinIO (`S3_ENDPOINT=http://minio:9000`) with every driver, and
keeping the service enabled is the only way an unchanged `.env` keeps working. A filesystem
installation that sends backups elsewhere (`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) or does
not use them may delete the `minio` service and its `depends_on` entry from its copy of the Compose
file; `MINIO_ROOT_PASSWORD` is then still required by the `${…:?}` check (any value).

## Configuration

```bash
# .env
OBJECT_STORAGE=filesystem          # filesystem | minio | s3   (unset = minio)
```

### filesystem

| Variable | Default | |
|---|---|---|
| `STORAGE_PATH` | `/data/objects` | Absolute path inside the container; Compose mounts the volume `coremail-data` on `/data` (Synology: `/volume1/docker/coremail/data/objects`) |
| `STORAGE_ALLOW_EPHEMERAL` | `false` | The startup check refuses a `STORAGE_PATH` that is not on a mounted volume (the data would vanish with the container). `true` only for throw-away tests |

Layout: object keys map 1:1 to files — `raw/<aa>/<sha256>.eml` (content-addressed raw
messages, sharded by the first two hex digits), `attachments/<messageId>/<n>-<sha16>`,
`quarantine/<id>.eml`, `outbound-queue/<jobId>/<n>`, `jmap-upload/<account>/<blob>`,
`smime/<userId>/<fingerprint>.p12`.

Guarantees:
- **Atomic writes** — temp file `.tmp-*` in the target directory, `fsync`, `rename`, `fsync` of the
  directory. A crash leaves at most a temp file (removed by the cleaner after 6 h), never a
  truncated mail. Content-addressed raw messages are written once.
- **Safe keys** — absolute keys, `..`, NUL, backslashes are rejected, and every resolved path is
  checked to stay inside `STORAGE_PATH`. User-supplied file names never become paths.
- Files `0640`, directories `0750`, owner `node` (uid 1000). The entrypoint hands a root-owned
  bind mount to `node` on the first start.
- Large messages are streamed (never held in memory as a whole).
- **Expiry** — a cleaner in the api-gateway (every 6 h, Redis lock `storage:cleaner:lock`, one run
  per installation) deletes `outbound-queue/` after 7 days, `jmap-upload/` after 7 days,
  `quarantine/` after 90 days — the same rules as the S3 lifecycle policy.

### minio / s3

Both use the same client and the same variables; defaults point at the bundled MinIO.

| Variable | Default | |
|---|---|---|
| `MINIO_ENDPOINT` | `minio` | Host name, or a URL `https://host[:port]` (sets TLS + port) |
| `MINIO_PORT` | `9000`, `443` with TLS | |
| `MINIO_USE_SSL` | `false` | `true` for TLS (every public provider) |
| `MINIO_REGION` | auto-detected | e.g. `eu-central-1`; Cloudflare R2: `auto` |
| `MINIO_PATH_STYLE` | client decides (path style, AWS: virtual host) | `true` = `https://host/bucket/key`, `false` = `https://bucket.host/key` |
| `MINIO_CA_FILE` | — | PEM bundle of a private CA; requires `MINIO_USE_SSL=true`; mount the file read-only into the container |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | MinIO root user / password | Compose falls back to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` |
| `MINIO_BUCKET_ATTACHMENTS` | `coremail-attachments` | |

`minio` creates a missing bucket (region `eu-central-1` unless `MINIO_REGION`); `s3` expects the
bucket to exist and only tries to create it when it is missing. Lifecycle rules for the temporary
prefixes are set on every start; providers that refuse lifecycle configuration get the periodic
cleaner instead (`coremail storage status` shows which one is active).

Examples:

```bash
# AWS S3
OBJECT_STORAGE=s3
MINIO_ENDPOINT=s3.eu-central-1.amazonaws.com
MINIO_USE_SSL=true
MINIO_REGION=eu-central-1
MINIO_ACCESS_KEY=AKIA…   MINIO_SECRET_KEY=…   MINIO_BUCKET_ATTACHMENTS=acme-coremail

# Backblaze B2 / Wasabi / Hetzner — same pattern with the provider's S3 endpoint:
#   s3.eu-central-003.backblazeb2.com · s3.eu-central-2.wasabisys.com · fsn1.your-objectstorage.com
# Cloudflare R2
MINIO_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
MINIO_REGION=auto

# MinIO on another host with a private CA
MINIO_ENDPOINT=minio.internal   MINIO_USE_SSL=true   MINIO_PORT=9000
MINIO_CA_FILE=/etc/coremail/s3-ca.pem
# docker-compose.yml → coremail: volumes: - ./s3-ca.pem:/etc/coremail/s3-ca.pem:ro
```

## Startup safety check

Every mail service (SMTP, IMAP, POP3, JMAP, ActiveSync) checks the object store before it opens
its ports:

1. the store is usable (directory writable / bucket reachable) and — filesystem — on a mounted volume;
2. a sample of the most recent objects the database references (`Message.storagePath`,
   `Attachment.storagePath`) exists.

When most of the sample is missing — typically `OBJECT_STORAGE` was changed without migrating —
the services **do not start** and log an ERROR with the migration command, instead of serving
mails whose contents cannot be read. They re-check every minute and start by themselves as soon
as the objects are there. A single lost object only logs a warning (`degraded`).
The api-gateway stays up (admin panel, admin API, migration) and reports the result:

```bash
curl -s http://localhost:3000/healthz
# {"ok":true,"service":"api-gateway","version":"…","storage":{"driver":"filesystem","status":"ok"}}
# 503 + "status":"missing-objects" | "unavailable" | "ephemeral" while the check blocks
docker exec -it coremail coremail storage status     # details, sampled/missing keys, hint
```

`/healthz` is a readiness signal. For liveness (restart decisions) use `/livez`, which answers
200 while the api-gateway serves HTTP, independent of the storage check — the Helm chart's
startup and liveness probes do, so a blocking check never causes a restart loop.

`STORAGE_STARTUP_CHECK=off` disables the check (emergencies only).

## Migration

`coremail storage migrate` copies every object from one driver to another. It runs as a background
job in the api-gateway (admin API `/api/v1/admin/storage/migrate`, role ORGANIZATION_MANAGEMENT,
audit-logged) and the CLI shows the progress. It

- streams each object and verifies it: sha256 and size of what was read must match a re-read of the
  target, and content-addressed raw messages must match the hash in their name;
- is **resumable**: objects already in the target with the same size are skipped
  (`--verify-existing` re-hashes them instead) — after an interruption simply run it again;
- has a `--dry-run` that only counts;
- **never deletes anything from the source**.

Both stores must be reachable from the app container: for `minio → filesystem` keep the `minio`
service running and the `MINIO_*` settings in place; the target directory is the mounted volume.

### MinIO → filesystem (existing installation)

```bash
# 0. Back up first (database dump + miniodata volume, see below)
# 1. Copy while the server keeps running
docker exec -it coremail coremail storage migrate --from minio --to filesystem --dry-run
docker exec -it coremail coremail storage migrate --from minio --to filesystem
# 2. Switch
echo "OBJECT_STORAGE=filesystem" >> .env
docker compose -f infra/docker/docker-compose.yml up -d coremail
# 3. Copy what arrived between step 1 and 2 (a few seconds of mail) — skips everything else
docker exec -it coremail coremail storage migrate --from minio --to filesystem
docker exec -it coremail coremail storage status
```

Between 2 and 3 the startup check may hold the mail services back for a moment (the newest mails
are still only in MinIO); they start by themselves after step 3. Inbound mail waits in the
sending servers' queues meanwhile (SMTP retries). For zero queueing, stop inbound mail before
step 1 (`docker exec coremail supervisorctl -c /etc/supervisord.conf stop protocols:smtp-server`)
— the migration does not need it. Keep MinIO and the `miniodata` volume until you have verified
the result; the objects stay there untouched.

**Rollback**: remove the `OBJECT_STORAGE=filesystem` line and `docker compose up -d coremail`
— mails received after the switch are only on the filesystem; copy them back first with
`coremail storage migrate --from filesystem --to minio`.

### Other directions

`--from filesystem --to minio`, `--from minio --to s3`, `--from filesystem --to s3` work the same.
`minio` and `s3` read the same `MINIO_*` variables, so `minio ↔ s3` with one configuration is
refused as "same store"; to move from the bundled MinIO to an external S3, go through the
filesystem (`minio → filesystem`, change `MINIO_*`, `filesystem → s3`) or use `mc mirror` /
`rclone sync` and then `coremail storage check`.

## Backup and restore

Back up **the database first, then the objects** — objects are only ever added under new
content-addressed or unique keys, so a slightly newer object store is harmless, while an older
one could miss objects the dump references.

```bash
cd /path/to/coremail
# 1. Database dump (consistent, online)
docker exec coremail-postgres pg_dump -U coremail -Fc coremail > coremail-$(date +%F).dump
# 2. Object volume (filesystem driver) — online is fine (atomic renames; temp files are skipped on restore)
docker run --rm -v coremail_coremail-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/coremail-data-$(date +%F).tar.gz -C /data --exclude='.tmp-*' .
#    minio driver: the same with the volume coremail_miniodata
```

(The volume names carry the Compose project prefix, `coremail_` with the shipped files —
`docker volume ls` shows them.)

### Synology (Hyper Backup)

With `OBJECT_STORAGE=filesystem` the objects are plain files in
`/volume1/docker/coremail/data/objects` — include that folder in a Hyper Backup task. For a
consistent set, schedule a task script (DSM → Control Panel → Task Scheduler) a few minutes
earlier that writes the database dump into a folder of the same backup task:

```bash
docker exec coremail-postgres pg_dump -U coremail -Fc coremail > /volume1/docker/coremail/backup/coremail.dump
```

Do not back up `data/postgres` file-by-file while PostgreSQL runs — use the dump.

### Restore

```bash
docker compose -f infra/docker/docker-compose.yml stop coremail
# objects
docker run --rm -v coremail_coremail-data:/data -v "$PWD":/backup alpine \
  sh -c 'cd /data && tar xzf /backup/coremail-data-2026-11-15.tar.gz && chown -R 1000:1000 /data/objects'
# database
docker exec -i coremail-postgres pg_restore -U coremail -d coremail --clean --if-exists < coremail-2026-11-15.dump
docker compose -f infra/docker/docker-compose.yml up -d coremail
docker exec -it coremail coremail storage check
```

Restoring the volume and the dump of the same backup run gives a consistent state; the startup
check confirms that the objects referenced by the database are present.
