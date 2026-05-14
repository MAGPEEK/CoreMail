#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail DB Container — Entrypoint
#
# Startet PostgreSQL (inkl. Initialisierung bei erstem Start),
# Redis und MinIO sequenziell via supervisord.
# ─────────────────────────────────────────────────────────────────────────────
set -e

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_USER="${POSTGRES_USER:-coremail}"
export POSTGRES_DB="${POSTGRES_DB:-coremail}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# PostgreSQL initialisieren (nur beim ersten Start)
if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "[entrypoint-db] PostgreSQL-Datenverzeichnis leer — initialisiere..."

  # Nutze den offiziellen postgres-Entrypoint zum Initialisieren
  # Wir starten ihn temporär, damit er DB + User anlegt und Initscripts ausführt
  /usr/local/bin/docker-entrypoint.sh postgres --max_connections=10 &
  PG_INIT_PID=$!

  # Warten bis Postgres bereit ist
  echo "[entrypoint-db] Warte auf PostgreSQL..."
  i=0
  until pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -q 2>/dev/null; do
    i=$((i + 1))
    if [ $i -gt 60 ]; then
      echo "[entrypoint-db] FEHLER: PostgreSQL nicht bereit nach 60 Sekunden" >&2
      exit 1
    fi
    sleep 1
  done

  echo "[entrypoint-db] PostgreSQL initialisiert ✓ — fahre temporären Prozess herunter"
  kill "${PG_INIT_PID}" 2>/dev/null || true
  wait "${PG_INIT_PID}" 2>/dev/null || true
  sleep 1
else
  echo "[entrypoint-db] PostgreSQL bereits initialisiert ✓"
fi

echo "[entrypoint-db] Starte supervisord (PostgreSQL + Redis + MinIO)..."
exec /usr/bin/supervisord -c /etc/supervisord.conf -n
