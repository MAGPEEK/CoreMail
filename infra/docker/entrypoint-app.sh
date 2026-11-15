#!/bin/sh
# CoreMail App Container — Entrypoint
# 1. Wait for PostgreSQL (unlimited, with progress log every 10 s)
# 2. Synchronize Prisma schema (db push) with retry logic
# 3. Start supervisord
set -e

log() { echo "[entrypoint] $*"; }

# ── 1. Wait for PostgreSQL connection ────────────────────────────────────────
# DATABASE_URL format: postgresql://user:pass@host:port/db
DB_HOST=$(echo "${DATABASE_URL}" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "${DATABASE_URL}" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_PORT="${DB_PORT:-5432}"

log "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT} ..."
WAITED=0
until nc -z "${DB_HOST}" "${DB_PORT}" 2>/dev/null; do
  sleep 2
  WAITED=$((WAITED + 2))
  # Report progress every 10 s so the log does not appear frozen
  if [ $((WAITED % 10)) -eq 0 ]; then
    log "Still waiting for PostgreSQL... (${WAITED}s elapsed)"
  fi
done
log "PostgreSQL TCP reachable after ${WAITED}s"

# ── 2. Create / update Prisma schema ─────────────────────────────────────────
# Important: nc -z only checks TCP connectivity.
# On Synology NAS (slow volume mount) the DB initialization keeps running
# for up to 2 minutes after nc -z reports true.
# Therefore: prisma db push with a retry loop of up to 60 attempts (5 min).
# 8.0.1: never --accept-data-loss implicitly — a destructive change stops the
# start until the operator sets COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true, and then
# a pg_dump is written to /data/backups first (schema-sync.sh).

log "Applying Prisma schema (db push) — with retry on slow init..."
MAX_ATTEMPTS="${MAX_ATTEMPTS:-60}" /usr/local/bin/coremail-schema-sync || {
  log "ERROR: schema sync failed — not starting the services (see above)"
  exit 1
}
cd /app

# ── 3. Object storage directory (v8.0) ───────────────────────────────────────
# The services run as `node`. A fresh named volume inherits the image's
# /data/objects (owned by node); a bind mount (Synology) or an old volume may
# belong to root → hand the directory to node once. Only the storage directory
# is touched, never other paths.
STORAGE_DIR="${STORAGE_PATH:-/data/objects}"
case "${STORAGE_DIR}" in
  /?*) ;;
  *) log "WARNING: STORAGE_PATH must be absolute (got '${STORAGE_DIR}') — skipped"; STORAGE_DIR="" ;;
esac
if [ -n "${STORAGE_DIR}" ] && { [ "${OBJECT_STORAGE:-minio}" = "filesystem" ] || [ -d "$(dirname "${STORAGE_DIR}")" ]; }; then
  if mkdir -p "${STORAGE_DIR}" 2>/dev/null; then
    if [ "$(stat -c %u "${STORAGE_DIR}" 2>/dev/null)" != "$(id -u node)" ]; then
      log "Handing ${STORAGE_DIR} to user node (first start or bind mount)"
      chown -R node:node "${STORAGE_DIR}" || log "WARNING: chown ${STORAGE_DIR} failed"
    fi
    chmod 750 "${STORAGE_DIR}" 2>/dev/null || true
  else
    log "WARNING: cannot create ${STORAGE_DIR}"
  fi
fi
log "Object storage: OBJECT_STORAGE=${OBJECT_STORAGE:-minio (default)}"

# ── 4. Start supervisord ─────────────────────────────────────────────────────
log "Starting supervisord..."
exec "$@"
