# CoreMail — Setup

This page covers what happens when a CoreMail container starts for the first
time. The browser part of the first setup is described in
[setup-wizard.md](setup-wizard.md). Deployment with Docker Compose is described in
[deployment-docker.md](deployment-docker.md), hardening in
[deployment-security.md](deployment-security.md).

## Contents

- [Automatic secrets](#automatic-secrets)
  - [Files](#files)
  - [Keys](#keys)
  - [Which value wins](#which-value-wins)
  - [Fresh or existing installation](#fresh-or-existing-installation)
  - [Database and Redis connection](#database-and-redis-connection)
  - [Docker Compose: start order](#docker-compose-start-order)
  - [Running the generator by hand](#running-the-generator-by-hand)
  - [Setup token](#setup-token)
  - [Safety rules](#safety-rules)
  - [Backing up the secrets](#backing-up-the-secrets)
  - [Environment variables](#environment-variables)

---

## Automatic secrets

Since 10.4 the app image can create every secret it needs by itself, and every
Compose variant starts without a `.env`:

```bash
docker compose -f infra/docker/docker-compose.yml up -d
# secrets: infra/docker/secrets/ (./secrets next to the Compose file)
```

In the Compose files the `coremail` container runs the generator at its start,
before anything else; the other containers wait for the files it writes
([Docker Compose: start order](#docker-compose-start-order)). Outside Compose,
mount an empty directory at `/secrets`:

```bash
mkdir -m 700 secrets
# docker run … -v ./secrets:/secrets …
```

On the first start the entrypoint runs `coremail-init-secrets`, which writes
`/secrets/coremail.env` with random values. On every later start it only
**appends keys that are missing** — a value in that file is never changed. The
entrypoint then loads the file, so the services see the values as ordinary
environment variables.

Without a `/secrets` mount nothing changes: the container takes its secrets
from the environment (`.env`, Compose, Kubernetes) exactly as before. The image
itself has no `/secrets` directory on purpose — secrets written into the
container layer would be lost when the container is recreated.

### Files

All files are created with mode `0600` and owned by root (the entrypoint runs
as root). They are written atomically: temporary file, `fsync`, `rename`.

| File | Content | Used by |
|------|---------|---------|
| `coremail.env` | `KEY=value` lines with a comment header | the CoreMail container |
| `postgres-password` | `POSTGRES_PASSWORD`, one line, no newline | the PostgreSQL container (`POSTGRES_PASSWORD_FILE`) |
| `redis-password` | `REDIS_PASSWORD`, one line, no newline | the Redis container (`--requirepass`, healthcheck) |
| `minio-root-password` | `MINIO_ROOT_PASSWORD`, one line, no newline | the MinIO container |
| `rspamd-controller-password` | `RSPAMD_CONTROLLER_PASSWORD`, one line, no newline | the rspamd container (controller password) |
| `setup-token` | the one-time setup token, only while the setup is pending | you — see [Setup token](#setup-token) |

The single-value password files are created when missing. If one of
them differs from the value in `coremail.env` later, a warning is printed and
the file is left alone.

### Keys

| Key | Format | Generated |
|-----|--------|-----------|
| `JWT_SECRET` | 64 hex characters | always |
| `PEPPER` | 64 hex characters | always |
| `POSTGRES_PASSWORD` | 48 hex characters | always |
| `COREMAIL_DB_PASSWORD` | copy of `POSTGRES_PASSWORD` (compatibility) | always |
| `REDIS_PASSWORD` | 48 hex characters | always |
| `MINIO_ROOT_PASSWORD` | 48 hex characters | always |
| `RSPAMD_CONTROLLER_PASSWORD` | 48 hex characters | always |
| `MFA_ENCRYPTION_KEY` | 64 hex characters | fresh installation only |
| `BACKUP_ENCRYPTION_KEY` | 64 hex characters | fresh installation only |
| `AUDIT_EXPORT_SIGNING_KEY` | 64 hex characters | fresh installation only |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | P-256 key pair, base64url (web-push format) | fresh installation only, always as a pair |

All values come from `crypto.randomBytes` (VAPID: a P-256 key pair from
`crypto.generateKeyPairSync`). Passwords are hex, so they are safe in URLs,
shell command lines and configuration files.

A key that the environment already provides (non-empty) is **copied** into the
file instead of being generated, so the file always holds the values that are
actually in effect. For an existing installation the database and Redis
passwords are also taken from `DATABASE_URL` / `REDIS_URL` when those are set
(a `DATABASE_URL` with a role other than `coremail` fills
`COREMAIL_DB_PASSWORD`). The generator prints only key names, never values:

```
[init-secrets] /secrets/coremail.env: created
[init-secrets]   generated: JWT_SECRET, PEPPER, POSTGRES_PASSWORD, REDIS_PASSWORD, …
[init-secrets]   copy of POSTGRES_PASSWORD: COREMAIL_DB_PASSWORD
[init-secrets]   fresh installation: database unreachable, no previous coremail.env and no JWT_SECRET/PEPPER in the environment
[init-secrets] /secrets/postgres-password: created
[init-secrets] /secrets/redis-password: created
```

Each block of appended keys is preceded by a comment such as
`# coremail-init-secrets 2026-11-20T09:00:00Z - generated: JWT_SECRET PEPPER …`.

### Which value wins

- A **non-empty** variable in the container environment always wins. An
  installation with a `.env` file keeps its values; the secrets file only fills
  gaps. When both differ, the start log names the key (never the value).
- An **empty or unset** variable is taken from `coremail.env`. Compose files
  that pass `KEY: ${KEY:-}` therefore still get the file's value.
- Only the keys in the table above plus `COREMAIL_DB_USER` and `MINIO_ROOT_USER`
  are ever taken from the file. Any other line (for example `NODE_OPTIONS`,
  `PATH`, `DATABASE_URL`) is ignored with a warning — the file is loaded by the
  root entrypoint and must not be able to change how processes run.
- Values are exported verbatim. The file is parsed, never sourced: `$`,
  backticks and quotes inside a value have no effect. One pair of surrounding
  quotes is removed; a CR at the end of a line (file edited on Windows) is
  dropped.

After loading, the start stops with a clear message if `JWT_SECRET`, `PEPPER`
or `DATABASE_URL` is still missing.

### Fresh or existing installation

`MFA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `AUDIT_EXPORT_SIGNING_KEY` and
the VAPID pair are generated **only for a fresh installation**. An existing
installation derives the first two from `JWT_SECRET` + `PEPPER` (and signs audit
exports with a derived key) — a newly generated MFA key would make every enrolled
TOTP secret and every stored certificate key unreadable, a new backup key would
not open older backups. For an existing installation these keys stay unset in
the file unless the environment provides them.

The rule:

1. **The database answers** (`DATABASE_URL`, or the URL built from the
   passwords): the installation is fresh when the `users` table is empty **and**
   the setup was never completed (`server_settings."setupCompletedAt"` is null).
2. **The database is unreachable or has no CoreMail schema yet** — the generator
   may run before PostgreSQL is up: the installation is fresh only when there
   was **no `coremail.env` before this run** and the environment has **neither
   `JWT_SECRET` nor `PEPPER`**. Anything else counts as existing.

The database is only queried when a fresh-only key is missing from both the
file and the environment. The query uses `psql` with the password in the
environment (`PGPASSWORD`), never on the command line. In the entrypoint the
generator waits up to `COREMAIL_SECRETS_DB_WAIT` seconds for the database —
default 30 when a `coremail.env` exists already, 0 on a first start without
one (the bundled PostgreSQL is then itself waiting for the password file this
step writes, and a database without the CoreMail schema changes nothing). The
standalone command does not wait.

### Database and Redis connection

When `DATABASE_URL` / `REDIS_URL` are not set (or empty), the entrypoint builds
them the way the Compose files do:

```
DATABASE_URL = postgresql://<user>:<password>@<COREMAIL_DB_HOST|postgres>:<COREMAIL_DB_PORT|5432>/<COREMAIL_DB_NAME|coremail>
REDIS_URL    = redis://:<REDIS_PASSWORD>@<COREMAIL_REDIS_HOST|redis>:<COREMAIL_REDIS_PORT|6379>
```

- `<user>` = `COREMAIL_DB_USER`, default `coremail` (the database superuser of
  the bundled PostgreSQL).
- `<password>` = `COREMAIL_DB_PASSWORD` from the environment if set; otherwise
  `POSTGRES_PASSWORD` for the superuser and `COREMAIL_DB_PASSWORD` from the file
  for another role (least-privilege role, [deployment-security.md](deployment-security.md)).
- User and password are URL-encoded.
- `postgres` and `redis` are the service names of the Compose files.

For the **bundled MinIO** the entrypoint also fills `MINIO_SECRET_KEY` /
`MINIO_ACCESS_KEY` (when `OBJECT_STORAGE` is unset or `minio` and
`MINIO_ENDPOINT` is unset or `minio`) and `S3_SECRET_KEY` / `S3_ACCESS_KEY`
(when `S3_ENDPOINT` is `http://minio:9000`) from `MINIO_ROOT_PASSWORD` /
`MINIO_ROOT_USER` (default user `minioadmin`) — only when they are empty. An
external S3 keeps its own keys.

### Docker Compose: start order

There is no separate init container (10.4.0 had the one-shot service
`coremail-init`; updating from it: `docker compose up -d --remove-orphans`
removes its stopped container once). The `coremail` container prepares the
stack at the start of its entrypoint, on every start:

1. **Configuration** (only `deploy/docker-compose.yml`, which mounts the
   `coremail-config-*` volumes below `/config`): `coremail-init-config` copies
   the configuration bundled in the image (PostgreSQL init scripts, rspamd
   `local.d`, the pg-backup script) into the volumes and then writes a ready
   marker `.ready` into each ([deploy.md → Configuration and overrides](deploy.md#configuration-and-overrides)).
   The repository Compose files bind-mount that configuration from the checkout
   instead; their `coremail` container has no `/config` and skips the step.
2. **Secrets**: `coremail-init-secrets` creates or extends `coremail.env` and the
   single-value password files (written atomically — a file that exists is complete).
3. It then waits for PostgreSQL (TCP, then the schema sync retries) and for Redis
   (at most 120 s), and starts the services.

The other containers do not depend on `coremail`. Each starts with a small
`sh -c` wrapper that waits until what it needs exists — at most 10 minutes, a
log line every 10 s (`redis: waiting for the coremail container to write
/run/coremail/redis-password (10s)`); after 10 minutes it exits with an error and
`restart: unless-stopped` starts it again. Then it runs the image's own
entrypoint with the same arguments and user switch as before. A password set in
`.env` needs no file — that container does not wait for it.

| Container | Waits for |
|-----------|-----------|
| `postgres` | `postgres-password` (unless `.env` sets `POSTGRES_PASSWORD`); in `deploy/docker-compose.yml` on an **empty** data directory (no `PG_VERSION`) also the init scripts' `.ready` marker — an existing database starts without them |
| `redis` | `redis-password` (unless `REDIS_PASSWORD`) |
| `minio` | `minio-root-password` (unless `MINIO_ROOT_PASSWORD`) |
| `rspamd` | `rspamd-controller-password` (unless `RSPAMD_CONTROLLER_PASSWORD`); in `deploy/docker-compose.yml` also the `local.d` `.ready` marker |
| `pg-backup` | `postgres-password` (unless `POSTGRES_PASSWORD`); in `deploy/docker-compose.yml` also the `.ready` marker of its script; and `postgres` healthy |
| `clamav` | nothing |

`coremail` itself lists `postgres`, `redis` (and `minio`, `rspamd`, `clamav`
where the file has them) with `condition: service_started` only, so
`docker compose up -d coremail` still starts them first. Waiting for them to be
*healthy* would deadlock: they wait for files `coremail` writes.

The generator runs only in the `coremail` container, so it never runs twice at
the same time. Its environment holds the `.env` values of all secret keys plus
`DATABASE_URL` / `REDIS_URL` (`${VAR:-}`) — a value from `.env` is **copied**
into the file, never replaced by a new one.

On a first start the database cannot answer yet (PostgreSQL waits for the
password file), so the [fresh-installation rule](#fresh-or-existing-installation)
is "no earlier `coremail.env` and no `JWT_SECRET`/`PEPPER` in `.env`". A
`.env` installation that moves to the secrets directory is treated as
existing — its PostgreSQL usually answers already (it needs no file) and has
users: `MFA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `AUDIT_EXPORT_SIGNING_KEY`
and the VAPID pair are not generated for it.

How the other containers get their password — the `.env` value when set,
otherwise the single-value file (secrets directory mounted read-only at
`/run/coremail`):

| Service | Mechanism |
|---------|-----------|
| `postgres` | `sh -c` wrapper: `POSTGRES_PASSWORD` from `.env` (then `POSTGRES_PASSWORD_FILE` is unset — the image refuses both), else `POSTGRES_PASSWORD_FILE=/run/coremail/postgres-password`; then the image entrypoint. PostgreSQL reads the password only when its data directory is created; an existing database keeps its password. |
| `redis` | `sh -c` wrapper: `REDIS_PASSWORD` or `redis-password`, then the image entrypoint (still switches to user `redis`); healthcheck with `REDISCLI_AUTH` |
| `minio` | `sh -c` wrapper: `MINIO_ROOT_PASSWORD` or `minio-root-password`, then the image entrypoint |
| `rspamd` | started as root only to read `rspamd-controller-password` when `RSPAMD_CONTROLLER_PASSWORD` is empty, then `setpriv` to `_rspamd` (11333), the image's own user |
| `pg-backup` (full, profile `backup`) | `sh -c` wrapper: `POSTGRES_PASSWORD` or `postgres-password`; read-only capability `DAC_READ_SEARCH` |
| `coremail` | mounts the directory at `/secrets`; the entrypoint loads `coremail.env` ([Which value wins](#which-value-wins)) and builds `DATABASE_URL` / `REDIS_URL` when `.env` has none |

### Running the generator by hand

The generator is part of the image and can also run on its own — for example
in a `docker run` setup, to create `postgres-password` before the PostgreSQL
container starts ([deploy.md → docker run](deploy.md#docker-run)):

```bash
mkdir -m 700 secrets
docker run --rm -v ./secrets:/secrets magpeek/coremail-app coremail-init-secrets
docker run --rm -v ./secrets:/secrets magpeek/coremail-app coremail-init-secrets   # second run: nothing to add
```

Options: `--dir <dir>` (default `$COREMAIL_SECRETS_DIR` or `/secrets`),
`--db-wait <seconds>` (default 0), `--help`. Exit codes: `0` done, `1` error
(for example a read-only directory), `2` refused because the directory or a
file is unsafe.

Without a database (as above) the rule in
[Fresh or existing installation](#fresh-or-existing-installation) decides via
"no earlier `coremail.env`, no `JWT_SECRET`/`PEPPER` in the environment" — a
first run into an empty directory is a fresh installation.

### Setup token

While the initial setup is pending, the api-gateway creates a one-time setup
token on every start (unchanged since 6.0: stored only as a hash, checked in
constant time, valid once). With a secrets directory it is **also written to
`/secrets/setup-token`** (0600) and the log shows a box instead of the token:

```
════════════════════════════════════════════════════════════════════
  CoreMail setup: open http://<server>:3000/setup — token in ./secrets/setup-token
  (one-time setup token; a new one is written on every restart
  until the setup is done, then the file is deleted)
════════════════════════════════════════════════════════════════════
```

```bash
cat ./secrets/setup-token          # on the host (owned by the container user node, uid 1000)
docker exec coremail cat /secrets/setup-token
```

The URL in the box is the one that answers on a fresh installation: plain HTTP
(the integrated HTTPS proxy starts only once a certificate exists) on the
published HTTP port `COREMAIL_PUBLIC_HTTP_PORT` (the Compose files set it:
`3000`, Synology `8080`; default `3000`), with the public host name when one is
configured, otherwise the placeholder `<server>`. Without a secrets directory the
token is logged with the same URL.

The file is replaced on every restart while the setup is pending and deleted
when the setup completes (also at the next start if the setup was completed
meanwhile, and when `SETUP_TOKEN` is set in the environment). If the directory
is not writable the token is logged as before.

To let the api-gateway (user `node`) write the file, the entrypoint gives the
directory to group `node` with mode `1770` (sticky bit) unless `node` already
owns it. The sticky bit means `node` can create and delete only its own files,
never `coremail.env` or the password files.

`GET /api/v1/setup/status` (public) reports the secrets file without revealing
anything in it:

```json
{ "setupRequired": true, "setupTokenRequired": true,
  "secretsFile": "./secrets/coremail.env", "secretsGenerated": true }
```

- `secretsFile` — host path hint of the secrets file when the container loaded
  at least one value from it, otherwise `null`. The prefix is
  `COREMAIL_SECRETS_HOST_PATH` (default `./secrets`, the bind mount of the
  Compose files).
- `secretsGenerated` — `true` when CoreMail generated (some of) the values in
  that file, `false` for a file written entirely by hand or taken from the
  environment.

### Safety rules

- The generator refuses (exit 2, the container does not start) when the secrets
  directory is a symbolic link, not a directory, or world-writable, and when
  `coremail.env` or a password file is a symbolic link, not a regular file or
  hard-linked. Existing files are opened with `O_NOFOLLOW`; new files are created
  exclusively (`O_EXCL`) and renamed into place, so a planted symlink is
  replaced, never followed.
- One exception: an **empty** world-writable directory is changed to `0700`
  first and checked again. Docker Desktop shows bind mounts from a Windows
  drive as mode `0777`; once nobody else can write and nothing is in the
  directory, nothing can have been planted. A world-writable directory that is
  not empty is always refused — fix it with
  `docker run --rm -v ./secrets:/secrets alpine chmod 700 /secrets` after
  checking its content.
- Only key names are printed. `--export-env` (used by the entrypoint) refuses
  to write to a terminal.
- The secrets directory is never created by the image. A container without the
  mount behaves as before.

### Backing up the secrets

**Back up `coremail.env` (with Compose: the whole `./secrets/` directory) off
the server** (password manager, offline copy) right after the first start. Without `PEPPER` no password works; without
`JWT_SECRET` + `PEPPER` (or `MFA_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY`)
enrolled two-factor logins, stored certificate keys and encrypted backups cannot
be read. The files belong to root, so on the host:

```bash
sudo cp ./secrets/coremail.env /path/to/safe/place/
```

Never change `PEPPER`, `JWT_SECRET` or `MFA_ENCRYPTION_KEY` of a running
installation (see [deployment-security.md](deployment-security.md) for key
rotation).

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `COREMAIL_SECRETS_DIR` | `/secrets` | secrets directory inside the container |
| `COREMAIL_SECRETS_HOST_PATH` | `./secrets` | how the directory is named in messages and in `/api/v1/setup/status` (the Compose files pass `COREMAIL_SECRETS_PATH`) |
| `COREMAIL_PUBLIC_HTTP_PORT` | `3000` | published HTTP port named in the setup URL of the log |
| `COREMAIL_SECRETS_PATH` | `./secrets` (Synology: `/volume1/docker/coremail/secrets`) | Compose only (`.env`): host directory of the secrets |
| `COREMAIL_SECRETS_DB_WAIT` | `30` (`0` while there is no `coremail.env`) | seconds the entrypoint waits for the database before applying the "unreachable" rule |
| `COREMAIL_DB_HOST` / `COREMAIL_DB_PORT` / `COREMAIL_DB_NAME` | `postgres` / `5432` / `coremail` | parts of a built `DATABASE_URL` |
| `COREMAIL_DB_USER` | `coremail` | database role of a built `DATABASE_URL` |
| `COREMAIL_REDIS_HOST` / `COREMAIL_REDIS_PORT` | `redis` / `6379` | parts of a built `REDIS_URL` |

Set by the entrypoint for the services (not meant to be set by hand):
`COREMAIL_SECRETS_FILE_IN_USE`, `COREMAIL_SECRETS_GENERATED`.

The Helm chart does not use this mechanism. Since chart 3.4 it generates empty
`secrets.*` values itself — once, kept on upgrade through `lookup`, never
regenerated for an existing release ([infra/k8s/README.md](../infra/k8s/README.md#generated-secrets)).
