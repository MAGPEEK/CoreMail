#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — database schema sync (installed as /usr/local/bin/coremail-schema-sync)
#
# Used by entrypoint-app.sh (Docker) and the Helm schema-sync init container.
#
#   1. `prisma db push` WITHOUT --accept-data-loss, retried while PostgreSQL is
#      still starting (MAX_ATTEMPTS × 5 s).
#   2. Prisma refuses some changes as "might be data loss". Its warnings are
#      classified (schema-sync-classify.mjs):
#      a) ONLY new unique constraints (e.g. 8.0.0 → 9.0 ResourceBooking
#         @@unique([calendarId, uid])): nothing is deleted. For every new
#         constraint a duplicate check runs first; without duplicates the change
#         is applied automatically (best-effort pg_dump first, skipped with a
#         warning when pg_dump/space/version do not allow it). With duplicates
#         the start stops and names the table — clean them up first.
#      b) Anything else (dropped table/column with rows, type change, removed
#         enum value, unknown warning) FAILS CLOSED with a clear message —
#         nothing is changed. The operator backs up and re-starts with
#         COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true; then a pg_dump is written to
#         $COREMAIL_SCHEMA_BACKUP_DIR/pre-migrate-<UTC timestamp>.sql.gz FIRST
#         and only after it succeeded the push runs with --accept-data-loss.
#   3. Changes Prisma cannot execute at all (e.g. a new required column without
#      default on a non-empty table) always stop the start.
#
# pg_dump in the image is PostgreSQL 16. A newer server (17+) cannot be dumped
# with it — schema-sync detects that and asks for an external dump +
# COREMAIL_SCHEMA_BACKUP=skip (required dump) or skips the dump with a warning
# (automatic safe change).
#
# Environment:
#   DATABASE_URL                       required
#   MAX_ATTEMPTS                       retries while the DB is unreachable (default 60)
#   COREMAIL_ALLOW_SCHEMA_DATA_LOSS    true = allow destructive changes (after the dump)
#   COREMAIL_SCHEMA_BACKUP_DIR         dump directory (default /data/backups — volume coremail-data)
#   COREMAIL_SCHEMA_BACKUP             skip = no dump (you made your own backup); default: required
#   COREMAIL_SCHEMA_CLASSIFIER         path of schema-sync-classify.mjs (default: image location)
# ─────────────────────────────────────────────────────────────────────────────
set -u

log() { echo "[schema-sync] $*"; }

: "${DATABASE_URL:?DATABASE_URL is not set}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-60}"
ALLOW_LOSS="$(echo "${COREMAIL_ALLOW_SCHEMA_DATA_LOSS:-false}" | tr 'A-Z' 'a-z')"
BACKUP_DIR="${COREMAIL_SCHEMA_BACKUP_DIR:-/data/backups}"
BACKUP_MODE="$(echo "${COREMAIL_SCHEMA_BACKUP:-required}" | tr 'A-Z' 'a-z')"

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo .)"
CLASSIFIER="${COREMAIL_SCHEMA_CLASSIFIER:-/usr/local/lib/coremail/schema-sync-classify.mjs}"
[ -f "${CLASSIFIER}" ] || CLASSIFIER="${SCRIPT_DIR}/schema-sync-classify.mjs"

STORAGE_DIR="${COREMAIL_STORAGE_PKG:-/app/packages/storage}"
PRISMA_CLI="${STORAGE_DIR}/node_modules/prisma/build/index.js"
cd "${STORAGE_DIR}" || { log "ERROR: ${STORAGE_DIR} not found"; exit 1; }

OUT="$(mktemp 2>/dev/null || echo /tmp/coremail-schema-sync.$$)"
CLS="${OUT}.cls"
trap 'rm -f "${OUT}" "${CLS}"' EXIT
TAB="$(printf '\t')"

# libpq rejects Prisma-only URL parameters (?schema=, ?connection_limit=, …);
# keep the ones libpq understands (TLS, timeouts).
libpq_url() {
  base="${DATABASE_URL%%\?*}"
  case "${DATABASE_URL}" in *\?*) query="${DATABASE_URL#*\?}" ;; *) query="" ;; esac
  kept=""
  old_ifs="${IFS}"; IFS='&'
  for p in ${query}; do
    case "${p%%=*}" in
      sslmode|sslrootcert|sslcert|sslkey|connect_timeout|application_name)
        kept="${kept:+${kept}&}${p}" ;;
    esac
  done
  IFS="${old_ifs}"
  if [ -n "${kept}" ]; then echo "${base}?${kept}"; else echo "${base}"; fi
}
DB_URL="$(libpq_url)"

prisma_push() {
  # stdout+stderr into $OUT and the log
  node "${PRISMA_CLI}" db push --skip-generate "$@" >"${OUT}" 2>&1
  rc=$?
  cat "${OUT}"
  return ${rc}
}

have() { command -v "$1" >/dev/null 2>&1; }

sql() {  # sql <query> — single value, empty on error
  have psql || return 1
  psql "${DB_URL}" -tAXq -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
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

# ── pg_dump ─────────────────────────────────────────────────────────────────
# dump_preflight [best-effort] — 0 when a dump can be written, otherwise 1 with
# the reason in DUMP_PROBLEM. The free-space check only applies to best-effort
# dumps (a compressed dump is usually far smaller than the database).
DUMP_PROBLEM=""
dump_preflight() {
  DUMP_PROBLEM=""
  if ! have pg_dump; then
    DUMP_PROBLEM="pg_dump is not available in this image"
    return 1
  fi
  client_major="$(pg_dump --version 2>/dev/null | awk '{print $3}' | cut -d. -f1)"
  server_num="$(sql 'SHOW server_version_num' || true)"
  case "${server_num}" in
    ''|*[!0-9]*) ;;
    *)
      server_major=$((server_num / 10000))
      case "${client_major}" in ''|*[!0-9]*) client_major=0 ;; esac
      if [ "${client_major}" -gt 0 ] && [ "${server_major}" -gt "${client_major}" ]; then
        DUMP_PROBLEM="the PostgreSQL server is version ${server_major}, but this image ships pg_dump ${client_major} — pg_dump cannot dump a newer server. Dump the database with pg_dump ${server_major} yourself and set COREMAIL_SCHEMA_BACKUP=skip (Helm: app.schemaSync.skipBackup=true)"
        return 1
      fi
      ;;
  esac
  if ! mkdir -p "${BACKUP_DIR}" 2>/dev/null || [ ! -w "${BACKUP_DIR}" ]; then
    DUMP_PROBLEM="backup directory ${BACKUP_DIR} is not writable (COREMAIL_SCHEMA_BACKUP_DIR)"
    return 1
  fi
  if [ "${1:-}" = "best-effort" ]; then
    db_bytes="$(sql 'SELECT pg_database_size(current_database())' || true)"
    free_kb="$(df -Pk "${BACKUP_DIR}" 2>/dev/null | awk 'NR==2 {print $4}')"
    case "${db_bytes}:${free_kb}" in
      *[!0-9:]*|:*|*:) ;;
      *)
        if [ $((db_bytes / 1024)) -gt "${free_kb}" ]; then
          DUMP_PROBLEM="not enough free space in ${BACKUP_DIR} ($((free_kb / 1024)) MiB free, database $((db_bytes / 1048576)) MiB)"
          return 1
        fi
        ;;
    esac
  fi
  return 0
}

write_dump() {
  chmod 700 "${BACKUP_DIR}" 2>/dev/null || true
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="${BACKUP_DIR}/pre-migrate-${ts}.sql.gz"
  log "Writing pre-migration dump to ${file} ..."
  if ( umask 077 && pg_dump --no-owner --no-privileges -Z 6 -f "${file}.partial" "${DB_URL}" ); then
    mv "${file}.partial" "${file}"
    log "Dump complete ($(wc -c < "${file}") bytes)"
    return 0
  fi
  rm -f "${file}.partial"
  return 1
}

# Destructive change (COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true): the dump is mandatory.
pre_migrate_dump() {
  if [ "${BACKUP_MODE}" = "skip" ]; then
    log "WARNING: COREMAIL_SCHEMA_BACKUP=skip — no pre-migration dump is written (you are responsible for a backup)"
    return 0
  fi
  if ! dump_preflight; then
    log "ERROR: cannot write the pre-migration dump: ${DUMP_PROBLEM}."
    log "       Schema NOT changed. Back up yourself and set COREMAIL_SCHEMA_BACKUP=skip to continue."
    exit 1
  fi
  if ! write_dump; then
    log "ERROR: pg_dump failed — schema NOT changed. (pg_dump must be at least the server version.)"
    exit 1
  fi
}

# Safe change (only new unique constraints): dump when possible, never blocks.
best_effort_dump() {
  if [ "${BACKUP_MODE}" = "skip" ]; then
    log "COREMAIL_SCHEMA_BACKUP=skip — no pre-migration dump"
    return 0
  fi
  if ! dump_preflight best-effort; then
    log "WARNING: skipping the pre-migration dump: ${DUMP_PROBLEM}. (Nothing is deleted by this change.)"
    return 0
  fi
  write_dump || log "WARNING: pg_dump failed — continuing without a dump (nothing is deleted by this change)."
  return 0
}

# ── classification ──────────────────────────────────────────────────────────
# Prints the verdict (safe | unsafe | none); the details are in $CLS.
classify_output() {
  if [ ! -f "${CLASSIFIER}" ]; then
    log "WARNING: ${CLASSIFIER} not found — every data-loss warning is treated as destructive"
    echo unsafe
    return
  fi
  if ! node "${CLASSIFIER}" < "${OUT}" > "${CLS}" 2>/dev/null; then
    echo unsafe
    return
  fi
  awk -F "${TAB}" '$1 == "verdict" {print $2; exit}' "${CLS}"
}

# 0 = no new unique constraint has duplicates; 1 = duplicates or check impossible.
check_duplicates() {
  if ! have psql; then
    log "psql is not available — cannot verify the new unique constraints"
    return 1
  fi
  dup_rc=0
  while IFS="${TAB}" read -r kind table columns query; do
    [ "${kind}" = "unique" ] || continue
    n="$(sql "${query}")" || { log "duplicate check failed for ${table}(${columns})"; dup_rc=1; continue; }
    case "${n}" in
      0) log "unique (${columns}) on ${table}: no duplicates" ;;
      ''|*[!0-9]*) log "duplicate check for ${table}(${columns}) returned '${n}'"; dup_rc=1 ;;
      *)
        log "ERROR: ${n} duplicate value group(s) in ${table} for the new UNIQUE (${columns})."
        qcols="\"$(echo "${columns}" | sed 's/,/","/g')\""
        log "       Find them with:  SELECT ${qcols}, count(*) FROM \"${table}\" GROUP BY ${qcols} HAVING count(*) > 1;"
        dup_rc=1
        ;;
    esac
  done < "${CLS}"
  return ${dup_rc}
}

refuse_duplicates() {
  log "════════════════════════════════════════════════════════════════════"
  log "ERROR: the schema update adds UNIQUE constraints, but the table holds"
  log "duplicate values (or they could not be checked — see above). CoreMail"
  log "did NOT change the database and stops here. Remove or merge the"
  log "duplicate rows (back up first), then start again."
  log "════════════════════════════════════════════════════════════════════"
  exit 1
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
    verdict="$(classify_output)"
    if [ "${verdict}" = "safe" ]; then
      log "The warnings above only ADD unique constraints — no data is deleted. Checking for duplicates ..."
      if check_duplicates; then
        best_effort_dump
        if prisma_push --accept-data-loss; then
          log "Schema applied (new unique constraints, no duplicates)."
          exit 0
        fi
        log "ERROR: schema push with the new unique constraints failed (see the Prisma output above)"
        exit 1
      fi
      refuse_duplicates
    fi
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
