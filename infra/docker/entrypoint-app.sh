#!/bin/sh
# CoreMail App Container — Entrypoint
# 0. Secrets: create/extend /secrets/coremail.env (when /secrets is mounted) and
#    load it — a non-empty variable from the environment always wins
# 1. Wait for PostgreSQL (unlimited, with progress log every 10 s)
# 2. Synchronize Prisma schema (db push) with retry logic
# 3. Start supervisord
set -e

log() { echo "[entrypoint] $*"; }

# ── 0. Secrets (10.4, docs/setup.md "Automatic secrets") ─────────────────────
# With a mounted secrets directory (COREMAIL_SECRETS_DIR, default /secrets) the
# image generates every secret itself: coremail-init-secrets creates
# coremail.env on the first start and only appends missing keys later (never
# overwrites). The directory is never created here — secrets in the container
# layer would be lost with the container.
SECRETS_DIR="${COREMAIL_SECRETS_DIR:-/secrets}"
INIT_SECRETS="${COREMAIL_INIT_SECRETS:-/usr/local/bin/coremail-init-secrets}"
if [ -d "${SECRETS_DIR}" ] || [ -L "${SECRETS_DIR}" ]; then
  log "Secrets directory ${SECRETS_DIR} found — creating missing secrets"
  rc=0
  "${INIT_SECRETS}" --dir "${SECRETS_DIR}" --db-wait "${COREMAIL_SECRETS_DB_WAIT:-30}" || rc=$?
  if [ "${rc}" -eq 2 ]; then
    log "ERROR: ${SECRETS_DIR} is unsafe (see above) — not starting"
    exit 1
  elif [ "${rc}" -ne 0 ]; then
    log "WARNING: could not write to ${SECRETS_DIR} (read-only?) — using what is there"
  fi
  # The api-gateway (user node) writes the one-time setup token there:
  # group node + sticky bit — node can create and delete only its own files,
  # never coremail.env or the password files (owned by root, 0600).
  if [ "$(id -u)" = "0" ] && id node >/dev/null 2>&1 \
     && [ "$(stat -c %u "${SECRETS_DIR}" 2>/dev/null)" != "$(id -u node)" ]; then
    { chgrp "$(id -g node)" "${SECRETS_DIR}" && chmod 1770 "${SECRETS_DIR}"; } 2>/dev/null \
      || log "WARNING: cannot let user node write ${SECRETS_DIR} — the setup token goes to the log instead"
  fi
fi
# Load the secrets file + build DATABASE_URL / REDIS_URL from the passwords when
# they are unset. Values are exported verbatim (never evaluated by the shell);
# only CoreMail's secret keys are taken from the file.
SECRETS_ENV=$("${INIT_SECRETS}" --export-env --dir "${SECRETS_DIR}") || {
  log "ERROR: cannot load the secrets (see above) — not starting"
  exit 1
}
while IFS= read -r SECRETS_LINE; do
  SECRETS_KEY="${SECRETS_LINE%%=*}"
  case "${SECRETS_KEY}" in
    ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;
  esac
  export "${SECRETS_LINE}"
done <<EOF
${SECRETS_ENV}
EOF
unset SECRETS_ENV SECRETS_LINE SECRETS_KEY
if [ "${COREMAIL_SECRETS_FILE_IN_USE:-false}" = "true" ]; then
  log "Secrets loaded from ${SECRETS_DIR}/coremail.env (environment values take precedence)"
fi
MISSING=""
[ -n "${JWT_SECRET:-}" ] || MISSING="${MISSING} JWT_SECRET"
[ -n "${PEPPER:-}" ] || MISSING="${MISSING} PEPPER"
[ -n "${DATABASE_URL:-}" ] || MISSING="${MISSING} DATABASE_URL(or POSTGRES_PASSWORD)"
if [ -n "${MISSING}" ]; then
  log "ERROR: missing:${MISSING}"
  log "  Either mount a secrets directory at ${SECRETS_DIR} (CoreMail generates them:"
  log "  -v ./secrets:${SECRETS_DIR}) or set them in .env (bash scripts/setup.sh)."
  exit 1
fi

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
# Never --accept-data-loss implicitly — a destructive change stops the
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
