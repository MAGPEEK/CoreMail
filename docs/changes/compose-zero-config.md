# Compose without .env (setup assistant, phase 2)

Changelog fragment for the next release (Keep a Changelog). Target: 10.4.0.

### Changed

- **Every Compose variant starts without a `.env`.** `docker-compose.yml`, `docker-compose.minimal.yml`,
  `docker-compose.full.yml` and `docker-compose.synology.yml` have a new one-shot service
  `coremail-init` (same image, `coremail-init-secrets`, no network, read-only root file system,
  `no-new-privileges`, only `DAC_OVERRIDE`/`FOWNER` plus the `NET_BIND_SERVICE` file capability of the
  node binary). It writes `./secrets/` next to the Compose file (Synology:
  `/volume1/docker/coremail/secrets`; `COREMAIL_SECRETS_PATH` moves it) before anything else starts:
  postgres, redis, minio, rspamd, pg-backup and coremail wait for it
  (`service_completed_successfully`). Quick start is now
  `docker compose -f infra/docker/docker-compose.yml up -d`, then the setup wizard at
  `http://<server>:3000/setup` with the token from `./secrets/setup-token`.
- The `${VAR:?…}` checks are gone: every secret is passed as `${VAR:-}`, so a `.env` value still
  wins and an empty one comes from `./secrets/coremail.env`. `DATABASE_URL` / `REDIS_URL` are passed
  through (`${DATABASE_URL:-}`); when empty the entrypoint builds them exactly as the Compose files did
  (`postgresql://<COREMAIL_DB_USER|coremail>:<COREMAIL_DB_PASSWORD|POSTGRES_PASSWORD>@postgres:5432/coremail`,
  `redis://:<REDIS_PASSWORD>@redis:6379`).
- The infrastructure containers read their password from `.env` when set, else from a single-value
  file of the secrets directory (mounted read-only at `/run/coremail`): PostgreSQL via
  `POSTGRES_PASSWORD_FILE`, Redis, MinIO, rspamd and the pg-backup sidecar through small `sh -c`
  wrappers. Redis still drops to user `redis`, rspamd still runs as `_rspamd` (11333, started as root
  only to read the file, then `setpriv`); pg-backup gains the read-only `DAC_READ_SEARCH` capability.
  The Redis healthcheck uses `REDISCLI_AUTH`.
- `coremail-init-secrets` additionally writes `minio-root-password` and `rspamd-controller-password`
  (same rules as `postgres-password` / `redis-password`: created when missing, never overwritten).
- `docker-compose.full.yml`: `OBJECT_STORAGE` defaults to `filesystem` (was required) and
  `RSPAMD_CONTROLLER_PASSWORD` is no longer required in `.env`.
- The setup log box names the URL that answers on a fresh installation —
  `http://<server>:3000/setup` (the public host name when one is configured; port from the new
  `COREMAIL_PUBLIC_HTTP_PORT`, which the Compose files set to their published HTTP port, Synology
  8080) — instead of a hard-coded `https://<host>/setup`. The log fallback without a secrets
  directory points at `/setup` instead of `/bcp/`.
- Helm chart 3.4.0: every `secrets.*` value is optional without `existingSecret`. An empty value is
  taken from the release's existing Secret (`lookup`) or generated once — `JWT_SECRET`, `PEPPER`,
  database/Redis/MinIO/rspamd passwords always, `MFA_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY` on a
  first install only. An upgrade never generates a value tied to stored data: when the Secret has no
  such key or cannot be read (`--dry-run=client`), the render fails. The chart's Secret carries
  `helm.sh/resource-policy: keep`. NOTES print a backup command when something was generated.
- e2e: the setup step reads the token from `/secrets/setup-token` (log fallback); the e2e overlays
  wait for `coremail-init` (`coremail-e2e-init`).
- Docs: README quick start, `docs/setup.md`, `docs/docker-compose.md`, `docs/deployment-docker.md`,
  `docs/e2e.md`, `infra/k8s/README.md`, `.env.example` (every secret optional).

### Upgrade note

Existing installations with a `.env` need to do **nothing**: every value in `.env` keeps winning.
On the first `docker compose up -d` with the new Compose file, `coremail-init` copies the `.env`
secrets into `./secrets/` (`coremail.env` plus the password files — the values from `.env`, not new
ones) and generates only what is missing. An existing installation never gets a new
`MFA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `AUDIT_EXPORT_SIGNING_KEY` or VAPID key pair (they stay
derived from `JWT_SECRET` + `PEPPER`). Visible differences:

- `RSPAMD_CONTROLLER_PASSWORD` is generated when `.env` had none: the rspamd web UI then needs that
  password (it was closed to everyone but the app before); the app sends the same value.
- A `DATABASE_URL` or `REDIS_URL` in `.env` (or in the shell) now takes effect — the Compose files
  used to ignore it. `.env.example` and `scripts/setup.sh` never wrote these lines.
- PostgreSQL reads its password only when its data directory is created. If you set
  `POSTGRES_PASSWORD` in `.env` for a NEW installation, do it before the first start (or delete
  `./secrets/postgres-password` together with the empty volume).
- Back up `./secrets/` (or `/volume1/docker/coremail/secrets`) off the server.
