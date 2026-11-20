# No init container — the coremail container prepares the Compose stack

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead.

### Changed

- **The one-shot service `coremail-init` is gone from every Compose file** (`deploy/docker-compose.yml`,
  `infra/docker/docker-compose.yml`, `.minimal.yml`, `.full.yml`, `.synology.yml`, the e2e
  overlays). The `coremail` container prepares the stack at the start of its entrypoint, on
  every start: it copies the configuration bundled in the image into the `coremail-config-*`
  volumes (standalone file only; a `.ready` marker per volume afterwards) and creates or
  extends `./secrets/` (`coremail.env` + the password files) exactly as before — `.env`
  values still win and are copied, nothing is ever overwritten.
- **PostgreSQL, Redis, MinIO, rspamd and pg-backup wait for their files.** A small `sh -c`
  wrapper waits until the password file (and, in the standalone file, the configuration's
  `.ready` marker — for PostgreSQL only on an empty data directory) exists, at most
  10 minutes with a log line every 10 s, then runs the image's own entrypoint with the same
  arguments and user switch as before. A password set in `.env` needs no file, so such a
  container starts at once; PostgreSQL then gets `POSTGRES_PASSWORD` instead of
  `POSTGRES_PASSWORD_FILE`. Healthchecks are unchanged.
- **`coremail` no longer waits for PostgreSQL/Redis/MinIO to be healthy** (`depends_on` with
  `condition: service_started` only — waiting for *healthy* would deadlock). The entrypoint
  waits for PostgreSQL as before and now also for Redis (at most 120 s).
- On a first start without `coremail.env` the entrypoint no longer waits up to 30 s for the
  database before deciding "fresh installation" (`COREMAIL_SECRETS_DB_WAIT` still overrides);
  the decision is the same as before.
- The `coremail` container now also receives `MINIO_ROOT_PASSWORD` (and, where missing,
  `RSPAMD_CONTROLLER_PASSWORD` / `MFA_ENCRYPTION_KEY`) from `.env`, so the generator copies
  them as the init service did.
- `docker run` (docs/deploy.md): the two standalone commands `coremail-init-secrets` and
  `coremail-init-config` stay for the first start; the `coremail` container mounts the
  configuration volumes too and refreshes them on every later start. `coremail-init`
  (both steps) also stays in the image.
- `scripts/release-assets.sh` refuses a standalone file with an init service.

### Upgrade

- **From 10.4.0:** download the new Compose file, then
  `docker compose pull && docker compose up -d --remove-orphans`. `--remove-orphans` removes
  the stopped `coremail-init` container once; without it Compose only warns about an orphan
  container. `./secrets/` and all volumes stay as they are.
- **From an installation with secrets in `.env` (before 10.4):** unchanged — the values in
  `.env` win, are copied into `./secrets/`, and the containers whose password is in `.env`
  do not wait for a file.
- Helm: not affected (the chart never had the init service).
