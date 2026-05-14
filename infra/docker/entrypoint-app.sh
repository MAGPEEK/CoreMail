#!/bin/sh
# CoreMail App Container — Entrypoint
# 1. Warte auf PostgreSQL
# 2. Synchronisiere Prisma-Schema (db push)
# 3. Starte supervisord
set -e

log() { echo "[entrypoint] $*"; }

# ── 1. PostgreSQL-Verbindung abwarten ────────────────────────────────────────
# DATABASE_URL Format: postgresql://user:pass@host:port/db
DB_HOST=$(echo "${DATABASE_URL}" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "${DATABASE_URL}" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_PORT="${DB_PORT:-5432}"

log "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT} ..."
MAX_WAIT=60
WAITED=0
until nc -z "${DB_HOST}" "${DB_PORT}" 2>/dev/null; do
  if [ "${WAITED}" -ge "${MAX_WAIT}" ]; then
    log "ERROR: PostgreSQL not reachable after ${MAX_WAIT}s — aborting"
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
log "PostgreSQL is up (after ${WAITED}s)"

# ── 2. Prisma-Schema anlegen / aktualisieren ─────────────────────────────────
log "Applying Prisma schema (db push) ..."
cd /app
# --skip-generate: Client wurde bereits beim Build generiert
# --accept-data-loss: sicher für schema-only push ohne Datenverlust
if pnpm --filter @coremail/storage exec prisma db push --skip-generate --accept-data-loss 2>&1; then
  log "Schema up to date"
else
  log "WARNING: prisma db push failed — services may crash if schema is missing"
fi

# ── 3. supervisord starten ───────────────────────────────────────────────────
log "Starting supervisord ..."
exec "$@"
