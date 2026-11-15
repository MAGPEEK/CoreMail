#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail PostgreSQL init — least-privilege application role
#
# Runs ONCE, on a fresh data directory (docker-entrypoint-initdb.d), as the
# superuser POSTGRES_USER, after 01-init.sql (extensions).
#
# With COREMAIL_DB_USER + COREMAIL_DB_PASSWORD set (scripts/setup.sh does this
# for new installations) it creates a LOGIN role that is NOT a superuser and
# cannot create databases/roles, and makes it the owner of the `public` schema
# (Prisma creates and alters the tables as that role). The app then connects
# as COREMAIL_DB_USER; POSTGRES_USER stays for administration (pg_dump, psql).
#
# Without COREMAIL_DB_USER nothing happens (the app keeps using POSTGRES_USER,
# as installations before this change do). Existing databases: see
# docs/deployment-security.md ("Database role").
#
# The postgres entrypoint SOURCES this file when it is not executable (bind
# mounts from Windows/NAS shares) — so no `exit`, no `set -u` here.
# ─────────────────────────────────────────────────────────────────────────────

coremail_app_user="${COREMAIL_DB_USER:-}"
coremail_app_password="${COREMAIL_DB_PASSWORD:-}"

if [ -z "${coremail_app_user}" ] || [ "${coremail_app_user}" = "${POSTGRES_USER}" ]; then
  echo "[coremail-init] COREMAIL_DB_USER not set — the app connects as ${POSTGRES_USER}"
elif [ -z "${coremail_app_password}" ]; then
  echo "[coremail-init] ERROR: COREMAIL_DB_USER is set but COREMAIL_DB_PASSWORD is empty" >&2
  coremail_init_failed=1
else
  echo "[coremail-init] creating application role ${coremail_app_user} (no superuser, owns schema public)"
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
    -v app_user="${coremail_app_user}" -v app_password="${coremail_app_password}" -v db_name="${POSTGRES_DB}" <<'EOSQL' || coremail_init_failed=1
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
EOSQL
fi
unset coremail_app_user coremail_app_password
[ -z "${coremail_init_failed:-}" ]
