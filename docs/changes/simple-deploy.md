# Deployment without a repository checkout (setup assistant, phase 3)

Changelog fragment for the next release (Keep a Changelog). Target: 10.4.0.

### Added

- **Standalone Compose file `deploy/docker-compose.yml`**, published with every release as the
  asset `docker-compose.yml`. A server needs three commands and no checkout:
  `mkdir coremail && cd coremail`,
  `curl -fsSLO https://github.com/MAGPEEK/CoreMail/releases/latest/download/docker-compose.yml`,
  `docker compose up -d` — then the setup wizard at `http://<server>:3000/setup` with the token
  from `./secrets/setup-token`. Default stack: `coremail-init`, `coremail`, `postgres`, `redis`.
  Profiles: `scanner` (rspamd + ClamAV), `backup` (pg_dump sidecar), `s3` (MinIO as the backup
  target). Project name, container names and volume names are those of the
  `infra/docker/` files. Guide: `docs/deploy.md`.
- **Configuration bundled in the app image** under `/usr/share/coremail/config/`
  (PostgreSQL `01-init.sql` + `02-app-role.sh`, rspamd `local.d`, `pg-backup.sh`). New
  `coremail-init-config` copies it into the volumes `coremail-config-postgres`,
  `coremail-config-rspamd` and `coremail-config-pg-backup` on every start, so image updates bring
  new versions; files an older image wrote and a newer one no longer carries are removed (only
  those listed in the tool's own `.coremail-config-files`). The containers mount the volumes
  read-only at the paths they used before (`/docker-entrypoint-initdb.d`, `/etc/rspamd/local.d`,
  `/pg-backup`). Optional override: files in `./config/rspamd/local.d/` next to the Compose file
  win per file name (read-only; symbolic links and files over 1 MB are skipped). `coremail-init`
  (new image command) runs `coremail-init-secrets`, then `coremail-init-config`.
- **`RSPAMD_ENABLED=auto` / `CLAMAV_ENABLED=auto`** (set by `deploy/docker-compose.yml`): a scanner
  whose host name does not resolve when CoreMail starts — its Compose profile is not active —
  counts as not deployed (`absent`: skipped, settings hidden in the BCP; reason `host-not-found`,
  `dns-error` or `timeout`, because Docker hands unknown names to the host's resolvers). A scanner
  that appears later is picked up at the next check (`SCANNER_CHECK_INTERVAL_SEC`, 300 s). Once
  seen, an outage stays `unavailable` with the configured failure policy, as before. Without
  `auto` nothing changes: only `false` makes a scanner absent.
- `scripts/release-assets.sh [VERSION] [--dry-run]`: pins the image default of the standalone
  file to the release version, checks it (`docker compose config` for every profile, no
  repository bind mounts) and uploads it with `gh release upload v<VERSION> docker-compose.yml --clobber`.

### Changed

- The image defaults of `infra/docker/docker-compose.yml`, `.minimal.yml`, `.full.yml` are
  `${COREMAIL_VERSION:-10.4.0}`, the Synology file pins `magpeek/coremail-app:10.4.0` (the 10.3.0
  image has no `coremail-init-secrets`). These files keep bind-mounting the configuration from
  the checkout and stay the files for existing installations ("advanced" in the docs).
- README / README.de quick start: the three commands, the setup URL and token, "back up
  `./secrets`", a profile table and links to the other variants, `docker run` and Helm. The
  `docker run` instructions moved to `docs/deploy.md` and use the bundled configuration instead
  of a checkout for rspamd.

### Upgrade note

Nothing to do for existing installations: the `infra/docker/` files work as before. Moving to
the standalone file: copy `infra/docker/secrets/` (and `.env`) next to it, and with the standard
file's MinIO storage set `OBJECT_STORAGE=minio` and use `--profile s3` (`docs/deploy.md →
Other Compose variants`).
