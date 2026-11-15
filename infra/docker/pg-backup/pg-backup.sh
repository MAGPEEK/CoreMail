#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — PostgreSQL dump sidecar (docker-compose.full.yml, profile "backup")
#
# Runs in the official postgres image (same pg_dump version as the server).
# Every PG_BACKUP_INTERVAL_HOURS (default 24) it writes
#   /backups/coremail-<UTC timestamp>.dump      (pg_dump custom format, compressed)
# atomically (.partial → rename, mode 0600) and deletes dumps older than
# PG_BACKUP_KEEP_DAYS (default 14). The first dump is taken PG_BACKUP_START_DELAY_MIN
# (default 10) minutes after start — CoreMail has created its schema by then, and
# a restart loop does not produce a dump per restart.
#
# Restore:  docker exec -i coremail-postgres pg_restore -U coremail -d coremail \
#             --clean --if-exists < coremail-<timestamp>.dump
# (docs/docker-compose.md → Backup and restore)
#
# The dumps are NOT encrypted: they contain password hashes and all mail
# metadata. Keep the target directory 0700 and copy it off the host encrypted.
#
# Started as `sh /pg-backup.sh` (works on bind mounts without the x bit).
# Env: PGHOST, PGUSER, PGDATABASE, PGPASSWORD (from compose).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

DIR="${PG_BACKUP_DIR_IN_CONTAINER:-/backups}"
INTERVAL_H="${PG_BACKUP_INTERVAL_HOURS:-24}"
DELAY_MIN="${PG_BACKUP_START_DELAY_MIN:-10}"
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-14}"

case "${INTERVAL_H}" in ''|*[!0-9]*|0) echo "[pg-backup] PG_BACKUP_INTERVAL_HOURS must be a positive integer" >&2; exit 1 ;; esac
case "${DELAY_MIN}"  in ''|*[!0-9]*)   echo "[pg-backup] PG_BACKUP_START_DELAY_MIN must be an integer" >&2; exit 1 ;; esac
case "${KEEP_DAYS}"  in ''|*[!0-9]*)   echo "[pg-backup] PG_BACKUP_KEEP_DAYS must be an integer" >&2; exit 1 ;; esac

umask 077
mkdir -p "${DIR}"

log() { echo "[pg-backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

dump_once() {
  ts="$(date -u +%Y%m%d-%H%M%S)"
  file="${DIR}/coremail-${ts}.dump"
  if pg_dump --format=custom --compress=6 --file="${file}.partial"; then
    mv "${file}.partial" "${file}"
    log "wrote ${file} ($(du -h "${file}" | cut -f1))"
  else
    rm -f "${file}.partial"
    log "ERROR: pg_dump failed — will retry at the next interval"
    return 1
  fi
  # Retention: only our own files, never anything else in the directory
  find "${DIR}" -maxdepth 1 -type f -name 'coremail-*.dump' -mtime +"${KEEP_DAYS}" -print -delete \
    | sed 's/^/[pg-backup] deleted old dump /' || true
  find "${DIR}" -maxdepth 1 -type f -name 'coremail-*.dump.partial' -mmin +60 -delete 2>/dev/null || true
}

trap 'log "stopping"; exit 0' TERM INT   # PID 1: SIGTERM is ignored without a trap

log "started: every ${INTERVAL_H} h into ${DIR}, keeping ${KEEP_DAYS} days"
sleep "$((DELAY_MIN * 60))" &
wait $!
until pg_isready -q; do sleep 5; done

while :; do
  dump_once || true
  sleep "$((INTERVAL_H * 3600))" &
  wait $!   # interruptible by SIGTERM (docker stop)
done
