#!/bin/sh
# CoreMail App Container — Entrypoint
# The coremail container prepares what the other containers of a Compose stack
# need — there is no separate init container. They wait for the files written
# here (password files, config .ready markers), never the other way round.
# 0a. Configuration: copy the configuration bundled in the image into the
#     mounted config volumes (when /config is mounted), then a .ready marker each
# 0. Secrets: create/extend /secrets/coremail.env and the password files (when
#    /secrets is mounted) and load it — a non-empty variable from the
#    environment always wins
# 1. Wait for PostgreSQL (unlimited, with progress log every 10 s) and Redis
# 2. Synchronize Prisma schema (db push) with retry logic
# 3. Start supervisord
set -e

log() { echo "[entrypoint] $*"; }

# ── 0a. Configuration volumes (docs/deploy.md "Configuration and overrides") ─
# deploy/docker-compose.yml mounts the coremail-config-* volumes below /config
# (PostgreSQL init scripts, rspamd local.d, the pg-backup script). PostgreSQL,
# rspamd and pg-backup mount them read-only and wait for the .ready marker that
# init-config.mjs writes after the files. Without /config (the repository
# Compose files bind-mount their configuration) nothing happens.
CONFIG_DIR="${COREMAIL_CONFIG_DIR:-/config}"
INIT_CONFIG=/usr/local/lib/coremail/init-config.mjs
if [ -d "${CONFIG_DIR}" ]; then
  log "Configuration volumes at ${CONFIG_DIR} — installing the bundled configuration"
  COREMAIL_CONFIG_DIR="${CONFIG_DIR}" "${INIT_CONFIG}" || {
    log "ERROR: could not write the configuration volumes (see above) — not starting"
    exit 1
  }
fi

# ── 0. Secrets (10.4, docs/setup.md "Automatic secrets") ─────────────────────
# With a mounted secrets directory (COREMAIL_SECRETS_DIR, default /secrets) the
# image generates every secret itself: init-secrets.mjs creates
# coremail.env on the first start and only appends missing keys later (never
# overwrites). The directory is never created here — secrets in the container
# layer would be lost with the container.
SECRETS_DIR="${COREMAIL_SECRETS_DIR:-/secrets}"
# COREMAIL_INIT_SECRETS: replaces the generator in infra/docker/init-secrets.test.mjs only.
INIT_SECRETS="${COREMAIL_INIT_SECRETS:-/usr/local/lib/coremail/init-secrets.mjs}"
if [ -d "${SECRETS_DIR}" ] || [ -L "${SECRETS_DIR}" ]; then
  log "Secrets directory ${SECRETS_DIR} found — creating missing secrets"
  # The database decides "fresh installation" for keys that are still missing.
  # Without a coremail.env the bundled PostgreSQL is itself waiting for the
  # password file this step writes, so waiting for the database here would only
  # delay the start (and change nothing: it has no CoreMail schema yet).
  if [ -n "${COREMAIL_SECRETS_DB_WAIT:-}" ]; then
    SECRETS_DB_WAIT="${COREMAIL_SECRETS_DB_WAIT}"
  elif [ -e "${SECRETS_DIR}/coremail.env" ]; then
    SECRETS_DB_WAIT=30
  else
    SECRETS_DB_WAIT=0
  fi
  rc=0
  "${INIT_SECRETS}" --dir "${SECRETS_DIR}" --db-wait "${SECRETS_DB_WAIT}" || rc=$?
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

# Redis starts in parallel (it waits for its password file, written above).
# Bounded: the services reconnect on their own, so after 120 s we go on.
REDIS_HOST=$(echo "${REDIS_URL:-}" | sed -n 's|^rediss\{0,1\}://\([^@/]*@\)\{0,1\}\([^:/?]*\).*|\2|p')
REDIS_PORT=$(echo "${REDIS_URL:-}" | sed -n 's|^rediss\{0,1\}://\([^@/]*@\)\{0,1\}[^:/?]*:\([0-9][0-9]*\).*|\2|p')
REDIS_PORT="${REDIS_PORT:-6379}"
if [ -n "${REDIS_HOST}" ]; then
  WAITED=0
  until nc -z "${REDIS_HOST}" "${REDIS_PORT}" 2>/dev/null; do
    if [ "${WAITED}" -ge 120 ]; then
      log "WARNING: Redis at ${REDIS_HOST}:${REDIS_PORT} not reachable after ${WAITED}s — starting anyway (the services retry)"
      break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    if [ $((WAITED % 10)) -eq 0 ]; then
      log "Still waiting for Redis at ${REDIS_HOST}:${REDIS_PORT}... (${WAITED}s elapsed)"
    fi
  done
fi

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
