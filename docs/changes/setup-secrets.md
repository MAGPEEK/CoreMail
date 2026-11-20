# Automatic secrets (setup assistant, phase 1)

Changelog fragment for the next release (Keep a Changelog).

### Added

- **The app image generates its secrets itself.** With a directory mounted at `/secrets`
  (`COREMAIL_SECRETS_DIR`), the entrypoint runs the new command `coremail-init-secrets` on every
  start: the first start writes `/secrets/coremail.env` (0600, atomic) with `JWT_SECRET`, `PEPPER`,
  `POSTGRES_PASSWORD` (also as `COREMAIL_DB_PASSWORD`), `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD` and
  `RSPAMD_CONTROLLER_PASSWORD`, plus `/secrets/postgres-password` and `/secrets/redis-password`
  (single line, for `POSTGRES_PASSWORD_FILE` and the Redis command). Later starts only append missing
  keys — no value is ever overwritten. `MFA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`,
  `AUDIT_EXPORT_SIGNING_KEY` and a VAPID key pair are generated for fresh installations only (empty
  `users` table and setup never completed; with the database unreachable or uninitialised: no earlier
  `coremail.env` and no `JWT_SECRET`/`PEPPER` in the environment) — existing installations keep
  deriving them from `JWT_SECRET` + `PEPPER`, so enrolled TOTP logins stay valid. Values the
  environment already provides (also the passwords inside `DATABASE_URL` / `REDIS_URL`) are copied
  into the file instead of being generated. Only key names are printed. Runnable on its own:
  `docker run --rm -v ./secrets:/secrets magpeek/coremail-app coremail-init-secrets`.
- The entrypoint loads `coremail.env` (parsed, never sourced; only CoreMail's secret keys) with
  **non-empty environment values taking precedence**, so `.env` installations keep their values. When
  `DATABASE_URL` / `REDIS_URL` are unset it builds them from the passwords
  (`COREMAIL_DB_HOST`/`_PORT`/`_NAME`/`_USER`, `COREMAIL_REDIS_HOST`/`_PORT`, defaults = the Compose
  service names `postgres` / `redis`) and fills the bundled MinIO credentials when they are empty. The
  start stops with a clear message when `JWT_SECRET`, `PEPPER` or `DATABASE_URL` is still missing.
- With a secrets directory the one-time **setup token is written to `/secrets/setup-token`** (0600)
  while the setup is pending and the log shows a framed hint instead of the token; the file is deleted
  when the setup completes. Token checks are unchanged.
- `GET /api/v1/setup/status` additionally returns `secretsFile` (host path hint
  `./secrets/coremail.env` when the container loaded the file, else `null`;
  `COREMAIL_SECRETS_HOST_PATH` changes the prefix) and `secretsGenerated`. No secret value is ever
  returned.
- Docs: `docs/setup.md` ("Automatic secrets").

### Security

- `coremail-init-secrets` refuses to run (exit 2, the container does not start) when the secrets
  directory is a symlink, not a directory or world-writable, or when a secrets file is a symlink,
  not a regular file or hard-linked (an empty world-writable directory, as Docker Desktop shows
  Windows bind mounts, is changed to 0700 first). The entrypoint gives the directory to group `node`
  with the sticky bit (mode 1770) so the api-gateway can write the setup token but cannot replace
  root's files. Only CoreMail's secret keys are ever loaded from the file, which is parsed, never
  sourced.
