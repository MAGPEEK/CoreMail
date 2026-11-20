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
#         @@unique([calendarId, uid]), 9.4 → 9.5 Task @@unique([userId, uid])
#         over the new optional column uid): nothing is deleted. For every new
#         constraint a duplicate check runs first (skipped for a table or an
#         optional column without default the update creates — no rows / all
#         NULL, which never conflict); without duplicates the change
#         is applied automatically (best-effort pg_dump first, skipped with a
#         warning when pg_dump/space/version do not allow it). With duplicates
#         the start stops and names the table — clean them up first.
#      b) 10.0.0: RETIRED tables of a removed feature (the room/equipment
#         mailboxes — RETIRED_TABLES in schema-sync-classify.mjs), optionally
#         next to new unique constraints: every retired table is logged, the
#         duplicate check runs, then the pre-migration dump is written FIRST
#         (mandatory, as for COREMAIL_ALLOW_SCHEMA_DATA_LOSS); after it
#         succeeded the rooms' own mailbox rows (folders, messages) are deleted
#         (retire_cleanup, one transaction) and the push drops the tables. No
#         opt-in needed.
#      c) Anything else (dropped table/column with rows, type change, removed
#         enum value, unknown warning) FAILS CLOSED with a clear message —
#         nothing is changed. The operator backs up and re-starts with
#         COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true; then a pg_dump is written to
#         $COREMAIL_SCHEMA_BACKUP_DIR/pre-migrate-<UTC timestamp>.sql.gz FIRST
#         and only after it succeeded the push runs with --accept-data-loss.
#   3. Changes Prisma cannot execute at all (e.g. a new required column without
#      default on a non-empty table) always stop the start.
#   4. 10.2: OPTIONAL EXTENSIONS (OPTIONAL_EXTENSIONS in schema-sync-classify.mjs —
#      pg_trgm, the trigram index of the mail search). A new extension + index is
#      no data loss and normally just applied. When the push fails because the
#      database cannot provide the extension (the least-privilege app role has no
#      CREATE on the database, the server lacks the module, …), the schema is
#      pushed once more WITHOUT the lines tagged "schema-sync:optional <name>"
#      (a temporary copy; nothing else differs) and a warning explains how to
#      create the extension. The search works without the index; the next start
#      tries the full schema again.
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
#   COREMAIL_PRISMA_SCHEMA_FILE        target schema read by the classifier and copied without the
#                                      optional-extension lines (default prisma/schema.prisma in the
#                                      storage package)
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
# 10.2: the schema without an optional extension (see 4. above); empty = prisma/schema.prisma
DEGRADED="${OUT}.schema.prisma"
SCHEMA_FILE=""
SCHEMA_SRC="${COREMAIL_PRISMA_SCHEMA_FILE:-prisma/schema.prisma}"
trap 'rm -f "${OUT}" "${CLS}" "${DEGRADED}" "${DEGRADED}.err"' EXIT
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
  if [ -n "${SCHEMA_FILE}" ]; then
    node "${PRISMA_CLI}" db push --skip-generate --schema "${SCHEMA_FILE}" "$@" >"${OUT}" 2>&1
  else
    node "${PRISMA_CLI}" db push --skip-generate "$@" >"${OUT}" 2>&1
  fi
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
    log "       Schema NOT changed. Back up yourself and set COREMAIL_SCHEMA_BACKUP=skip to continue"
    log "       (Helm: mount a PVC with app.schemaSync.backupClaim, or app.schemaSync.skipBackup=true"
    log "       after your own backup)."
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
  while IFS="${TAB}" read -r kind table columns guard query; do
    [ "${kind}" = "unique" ] || continue
    # The constraint may cover a table/column this update creates (classifier header).
    state="$(sql "${guard}")" || { log "duplicate check failed for ${table}(${columns}): cannot inspect the table"; dup_rc=1; continue; }
    case "${state}" in
      new-table) log "unique (${columns}) on ${table}: new table — nothing to check"; continue ;;
      new-column) log "unique (${columns}) on ${table}: covers a new optional column (NULL in every row) — no duplicates possible"; continue ;;
      check) ;;
      *) log "duplicate check for ${table}(${columns}): unexpected table state '${state}'"; dup_rc=1; continue ;;
    esac
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

log_retired_tables() {
  while IFS="${TAB}" read -r kind table rows reason; do
    [ "${kind}" = "retired" ] || continue
    log "Retiring table ${table} (${rows} rows): ${reason}. The rows are kept in the pre-migration dump."
  done < "${CLS}"
}

# Data of a retired table that lives in kept tables (10.0.0: the room mailboxes'
# own mailbox rows with their folders and messages) — deleted after the dump and
# before the push drops the table. One statement per line = one transaction; run
# again it deletes nothing. Any error stops the start (the push has not run).
retire_cleanup() {
  [ -f "${CLS}" ] && grep -q "^cleanup${TAB}" "${CLS}" || return 0
  if ! have psql; then
    log "ERROR: psql is not available — cannot remove the data of the retired tables. Schema NOT changed."
    exit 1
  fi
  while IFS="${TAB}" read -r kind table what query; do
    [ "${kind}" = "cleanup" ] || continue
    if ! result="$(psql "${DB_URL}" -tAXq -v ON_ERROR_STOP=1 -c "${query}" 2>&1)"; then
      log "ERROR: removing the ${what} (retired table ${table}) failed: ${result}"
      log "       Nothing was deleted and the schema was NOT changed."
      exit 1
    fi
    log "Removed the ${what} (retired table ${table}): ${result}. Their stored objects stay unreferenced in the object store."
  done < "${CLS}"
}

# 10.2: "<extension><TAB><what needs it>" when the failed push could not get an
# optional extension (OPTIONAL_EXTENSIONS in the classifier), else empty.
optional_failure() {
  [ -f "${CLASSIFIER}" ] || return 0
  node "${CLASSIFIER}" --optional-failure < "${OUT}" 2>/dev/null || true
}

# degrade <extension> <what> — continue with the schema copy without the lines that
# need the extension. Refuses (exit 1) when the copy cannot be made.
degrade() {
  if ! node "${CLASSIFIER}" --strip-optional "$1" "${SCHEMA_SRC}" > "${DEGRADED}" 2> "${DEGRADED}.err"; then
    log "ERROR: the database cannot provide the PostgreSQL extension $1, and the schema without it"
    log "       could not be prepared: $(cat "${DEGRADED}.err" 2>/dev/null). Schema NOT changed."
    exit 1
  fi
  log "════════════════════════════════════════════════════════════════════"
  log "WARNING: the database cannot provide the PostgreSQL extension $1"
  log "(see the Prisma output above). The schema is applied WITHOUT $2."
  log "Nothing else differs and no data is affected — the mail search works,"
  log "but without its index (slower on large mailboxes). To enable it, create"
  log "the extension once as a PostgreSQL superuser in this database, e.g.:"
  log "  docker exec coremail-postgres psql -U coremail -d coremail -c 'CREATE EXTENSION IF NOT EXISTS $1;'"
  log "and restart CoreMail (docs/search.md)."
  log "════════════════════════════════════════════════════════════════════"
  SCHEMA_FILE="${DEGRADED}"
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

  # 10.2: an optional extension the database cannot provide → once without it
  if [ -z "${SCHEMA_FILE}" ]; then
    optional="$(optional_failure)"
    if [ -n "${optional}" ]; then
      degrade "$(printf '%s' "${optional}" | cut -f1)" "$(printf '%s' "${optional}" | cut -f2)"
      continue
    fi
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
    if [ "${verdict}" = "retire" ]; then
      log "The warnings above only drop RETIRED tables of removed features (and add unique constraints)."
      log_retired_tables
      if grep -q "^unique${TAB}" "${CLS}"; then check_duplicates || refuse_duplicates; fi
      pre_migrate_dump
      retire_cleanup
      if prisma_push --accept-data-loss; then
        log "Schema applied: retired tables dropped (their rows are in the pre-migration dump)."
        exit 0
      fi
      log "ERROR: schema push dropping the retired tables failed (see the Prisma output above)"
      exit 1
    fi
    if [ "${ALLOW_LOSS}" != "true" ]; then
      refuse
    fi
    log "COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true — destructive schema change permitted"
    pre_migrate_dump
    retire_cleanup
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
