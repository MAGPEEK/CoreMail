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

log "Applying Prisma schema (db push) — with retry on slow init..."
cd /app

MAX_ATTEMPTS=60
ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if pnpm --filter @coremail/storage exec prisma db push \
       --skip-generate --accept-data-loss 2>&1; then
    log "Schema applied successfully (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
    break
  fi
  if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
    log "ERROR: Schema push failed after ${MAX_ATTEMPTS} attempts — aborting"
    exit 1
  fi
  log "Schema push not ready yet (attempt ${ATTEMPT}/${MAX_ATTEMPTS}) — retrying in 5s..."
  sleep 5
done

# ── 3. Start supervisord ─────────────────────────────────────────────────────
log "Starting supervisord..."
exec "$@"
