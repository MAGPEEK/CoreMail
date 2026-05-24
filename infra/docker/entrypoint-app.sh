#!/bin/sh
# CoreMail App Container — Entrypoint
# 1. Warte auf PostgreSQL (unbegrenzt, mit Progress-Log alle 10 s)
# 2. Synchronisiere Prisma-Schema (db push) mit Retry-Logik
# 3. Starte supervisord
set -e

log() { echo "[entrypoint] $*"; }

# ── 1. PostgreSQL-Verbindung abwarten ────────────────────────────────────────
# DATABASE_URL Format: postgresql://user:pass@host:port/db
DB_HOST=$(echo "${DATABASE_URL}" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "${DATABASE_URL}" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_PORT="${DB_PORT:-5432}"

log "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT} ..."
WAITED=0
until nc -z "${DB_HOST}" "${DB_PORT}" 2>/dev/null; do
  sleep 2
  WAITED=$((WAITED + 2))
  # Alle 10 s Progress melden damit der Log nicht einfriert
  if [ $((WAITED % 10)) -eq 0 ]; then
    log "Still waiting for PostgreSQL... (${WAITED}s elapsed)"
  fi
done
log "PostgreSQL TCP reachable after ${WAITED}s"

# ── 2. Prisma-Schema anlegen / aktualisieren ──────────────────────────────────
# Wichtig: nc -z prüft nur TCP-Konnektivität.
# Auf Synology NAS (langsamer Volume-Mount) läuft die DB-Initialisierung
# noch bis zu 2 Minuten, nachdem nc -z true meldet.
# Daher: prisma db push mit Retry-Schleife bis zu 60 Versuchen (5 min).

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

# ── 3. supervisord starten ───────────────────────────────────────────────────
log "Starting supervisord..."
exec "$@"
