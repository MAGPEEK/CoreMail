# Restart CoreMail from the BCP

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead (target 10.4.2).

### Added

- **Restart CoreMail from the BCP** (Server → Health & Status → "CoreMail neu starten"):
  restarts the `coremail` container — every CoreMail service stops gracefully, the container
  exits and its restart policy starts it again (about 20–30 seconds without webmail, BCP and
  mail protocols; PostgreSQL, Redis and the scanners keep running). No Docker socket, no
  control of other containers. The confirmation needs the word `NEUSTART` / `RESTART` or the
  public host name; an overlay polls `/healthz` every 2 seconds and reloads the page once
  CoreMail is back (the session survives), with a hint to `docker compose ps` after 3 minutes.
  API `POST /api/v1/admin/servers/restart` (ORGANIZATION_MANAGEMENT / SERVER_MANAGEMENT,
  organisation-wide only, admin MFA as configured) answers `202 { restarting: true,
  expectedDowntimeSeconds }`; the audit entry `server.restart` (always logged) is written
  before the shutdown, one restart per 2 minutes server-wide (`429` + `Retry-After`);
  `GET /api/v1/admin/servers/restart` reports whether the gateway can restart its container.
  Mechanism: the api-gateway writes a supervisor capture-mode token to its stdout; the new
  root event listener `restart-watch` (`infra/docker/restart-watch.py`) accepts it only from
  the program `api-gateway` and stops supervisord. Requires a restart policy
  (`restart: unless-stopped` in every bundled Compose file and the documented `docker run`
  commands; Kubernetes restarts the container) — docs/deploy.md, docs/rbac.md.
