#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — database schema sync (installed as /usr/local/bin/coremail-schema-sync)
#
# Used by entrypoint-app.sh (Docker) and the Helm schema-sync init container.
#
#   1. `prisma db push` WITHOUT --accept-data-loss, retried while PostgreSQL is
#      still starting (MAX_ATTEMPTS × 5 s).
#   2. If Prisma refuses because the change would DELETE data (dropped
#      table/column with rows, narrowed type, …) the start FAILS CLOSED with a
#      clear message — nothing is changed. The operator backs up and re-starts
#      with COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true; then a pg_dump is written to
#      $COREMAIL_SCHEMA_BACKUP_DIR/pre-migrate-<UTC timestamp>.sql.gz FIRST and
#      only after it succeeded the push runs with --accept-data-loss.
#   3. Changes Prisma cannot execute at all (e.g. a new required column without
#      default on a non-empty table) always stop the start.
#
# Environment:
#   DATABASE_URL                       required
#   MAX_ATTEMPTS                       retries while the DB is unreachable (default 60)
#   COREMAIL_ALLOW_SCHEMA_DATA_LOSS    true = allow destructive changes (after the dump)
#   COREMAIL_SCHEMA_BACKUP_DIR         dump directory (default /data/backups — volume coremail-data)
#   COREMAIL_SCHEMA_BACKUP             skip = no dump (you made your own backup); default: required
# ─────────────────────────────────────────────────────────────────────────────
set -u

log() { echo "[schema-sync] $*"; }

: "${DATABASE_URL:?DATABASE_URL is not set}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-60}"
ALLOW_LOSS="$(echo "${COREMAIL_ALLOW_SCHEMA_DATA_LOSS:-false}" | tr 'A-Z' 'a-z')"
BACKUP_DIR="${COREMAIL_SCHEMA_BACKUP_DIR:-/data/backups}"
BACKUP_MODE="$(echo "${COREMAIL_SCHEMA_BACKUP:-required}" | tr 'A-Z' 'a-z')"

STORAGE_DIR="${COREMAIL_STORAGE_PKG:-/app/packages/storage}"
PRISMA_CLI="${STORAGE_DIR}/node_modules/prisma/build/index.js"
cd "${STORAGE_DIR}" || { log "ERROR: ${STORAGE_DIR} not found"; exit 1; }

OUT="$(mktemp 2>/dev/null || echo /tmp/coremail-schema-sync.$$)"
trap 'rm -f "${OUT}"' EXIT

prisma_push() {
  # stdout+stderr into $OUT and the log
  node "${PRISMA_CLI}" db push --skip-generate "$@" >"${OUT}" 2>&1
  rc=$?
  cat "${OUT}"
  return ${rc}
}

refuse() {
  log "════════════════════════════════════════════════════════════════════"
  log "ERROR: the database schema update would DELETE DATA (see the Prisma"
  log "warnings above). CoreMail did NOT change the database and stops here."
  log ""
  log "  1. Back up the database first, e.g.:"
  log "       docker exec coremail-postgres pg_dump -U coremail coremail | gzip > coremail-\$(date +%F).sql.gz"
  log "  2. Read the upgrade notes (CHANGELOG.md) for this version."
  log "  3. Start once with COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true (.env / Helm"
  log "     app.schemaSync.allowDataLoss). CoreMail then writes its own dump to"
  log "     ${BACKUP_DIR}/pre-migrate-<timestamp>.sql.gz before applying the change."
  log "  4. Remove the setting again afterwards."
  log "════════════════════════════════════════════════════════════════════"
  exit 1
}

pre_migrate_dump() {
  if [ "${BACKUP_MODE}" = "skip" ]; then
    log "WARNING: COREMAIL_SCHEMA_BACKUP=skip — no pre-migration dump is written (you are responsible for a backup)"
    return 0
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    log "ERROR: pg_dump is not available in this image — cannot write the pre-migration dump."
    log "       Back up yourself and set COREMAIL_SCHEMA_BACKUP=skip to continue."
    exit 1
  fi
  if ! mkdir -p "${BACKUP_DIR}" 2>/dev/null || [ ! -w "${BACKUP_DIR}" ]; then
    log "ERROR: backup directory ${BACKUP_DIR} is not writable (COREMAIL_SCHEMA_BACKUP_DIR)."
    exit 1
  fi
  chmod 700 "${BACKUP_DIR}" 2>/dev/null || true
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="${BACKUP_DIR}/pre-migrate-${ts}.sql.gz"
  # libpq rejects Prisma-only URL parameters (?schema=, ?connection_limit=, …).
  dump_url="${DATABASE_URL%%\?*}"
  log "Writing pre-migration dump to ${file} ..."
  if ( umask 077 && pg_dump --no-owner --no-privileges -Z 6 -f "${file}.partial" "${dump_url}" ); then
    mv "${file}.partial" "${file}"
    log "Dump complete ($(wc -c < "${file}") bytes)"
  else
    rm -f "${file}.partial"
    log "ERROR: pg_dump failed — schema NOT changed. (pg_dump must be at least the server version.)"
    exit 1
  fi
}

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if prisma_push; then
    log "Schema applied (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
    exit 0
  fi

  if grep -qi "cannot be executed" "${OUT}"; then
    log "ERROR: Prisma reports schema changes that cannot be executed on the existing data"
    log "       (see above). Manual migration needed — the database was NOT changed."
    exit 1
  fi

  if grep -qiE "data loss|accept-data-loss" "${OUT}"; then
    if [ "${ALLOW_LOSS}" != "true" ]; then
      refuse
    fi
    log "COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true — destructive schema change permitted"
    pre_migrate_dump
    if prisma_push --accept-data-loss; then
      log "Schema applied with --accept-data-loss. Remove COREMAIL_ALLOW_SCHEMA_DATA_LOSS again."
      exit 0
    fi
    log "ERROR: schema push with --accept-data-loss failed"
    exit 1
  fi

  if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
    log "ERROR: schema push failed after ${MAX_ATTEMPTS} attempts — aborting"
    exit 1
  fi
  log "Schema push not ready yet (attempt ${ATTEMPT}/${MAX_ATTEMPTS}) — retrying in 5s..."
  sleep 5
done
