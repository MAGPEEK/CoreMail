#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — Synology NAS initial setup
#
# Run this script via SSH on the Synology (as root or with sudo):
#   NAS_HOSTNAME=192.168.1.100 bash synology-setup.sh
#
# Prerequisites on the Synology:
#   1. SSH enabled (DSM → Control Panel → Terminal & SNMP → Enable SSH)
#   2. Docker / Container Manager installed (via Package Center)
#   3. Volume "volume1" present (default Synology volume)
#
# What the script does:
#   1. Create the directory structure under /volume1/docker/coremail/
#   2. Copy docker-compose.synology.yml
#   3. Start the stack
#
# TLS/HTTPS:
#   CoreMail runs on port 8080 (HTTP).
#   For HTTPS use the DSM Application Portal:
#   DSM → Control Panel → Application Portal → Reverse Proxy
#   Source: https://<your-domain.de> → Destination: http://localhost:8080
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
COREMAIL_BASE="/volume1/docker/coremail"
NAS_HOSTNAME="${NAS_HOSTNAME:-mail.local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         CoreMail v0.9.2 — Synology initial setup            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Base directory    : ${COREMAIL_BASE}"
echo "NAS hostname      : ${NAS_HOSTNAME}"
echo ""

# ── 1. Directory structure ────────────────────────────────────────────────────
echo "[1/3] Creating directories..."
# v8.0: a fresh installation (no database yet) stores mail contents on the
# filesystem (data/objects, covered by Hyper Backup). An existing installation
# keeps its storage driver — nothing is changed for it.
FRESH_INSTALL=0
if [ ! -d "${COREMAIL_BASE}/data/postgres" ] || [ -z "$(ls -A "${COREMAIL_BASE}/data/postgres" 2>/dev/null)" ]; then
  FRESH_INSTALL=1
fi
mkdir -p \
  "${COREMAIL_BASE}/data/postgres" \
  "${COREMAIL_BASE}/data/redis" \
  "${COREMAIL_BASE}/data/minio" \
  "${COREMAIL_BASE}/data/objects"
# 10.4: secrets directory of coremail-init (docs/setup.md "Automatic secrets")
if [ ! -d "${COREMAIL_BASE}/secrets" ]; then
  mkdir -m 700 "${COREMAIL_BASE}/secrets"
fi
echo "      ✓ ${COREMAIL_BASE}/ created"
ENV_FILE="${COREMAIL_BASE}/.env"
if [ "${FRESH_INSTALL}" = "1" ] && ! grep -qs '^OBJECT_STORAGE=' "${ENV_FILE}"; then
  echo "OBJECT_STORAGE=filesystem" >> "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "      ✓ OBJECT_STORAGE=filesystem → ${ENV_FILE} (mail contents in data/objects)"
elif ! grep -qs '^OBJECT_STORAGE=' "${ENV_FILE}"; then
  echo "      ℹ Existing installation: mail contents stay in MinIO (OBJECT_STORAGE unset = minio)."
  echo "        Switching to the filesystem is optional — see docs/storage.md (coremail storage migrate)."
fi

# ── 1b. Secrets (.env, chmod 600) ─────────────────────────────────────────────
# The Compose file no longer falls back to well-known passwords — every secret
# must be in .env. Only MISSING keys are added; existing values are never touched.
rnd() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
umask 077
touch "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
set_env() {  # set_env KEY VALUE — only when KEY is not in .env yet
  if ! grep -qs "^$1=" "${ENV_FILE}"; then
    printf '%s=%s\n' "$1" "$2" >> "${ENV_FILE}"
    return 0
  fi
  return 1
}
LEGACY_SECRETS=""
if [ "${FRESH_INSTALL}" = "1" ]; then
  set_env JWT_SECRET "$(rnd 32)" || true
  set_env PEPPER "$(rnd 32)" || true
  set_env POSTGRES_PASSWORD "$(rnd 20)" || true
  set_env MINIO_ROOT_PASSWORD "$(rnd 20)" || true
  # Fresh database: the app connects as a non-superuser role (postgres/02-app-role.sh)
  set_env COREMAIL_DB_USER coremail_app || true
  set_env COREMAIL_DB_PASSWORD "$(rnd 20)" || true
else
  # Existing installation: data was created with the old Compose fallbacks.
  # Changing them here would lock CoreMail out of its own database (Postgres
  # stores the password; PEPPER is part of every password hash). Write them
  # explicitly and warn.
  set_env POSTGRES_PASSWORD 'CoreMail2024!' && LEGACY_SECRETS="${LEGACY_SECRETS} POSTGRES_PASSWORD"
  set_env MINIO_ROOT_PASSWORD 'MinioSecret2024!' && LEGACY_SECRETS="${LEGACY_SECRETS} MINIO_ROOT_PASSWORD"
  set_env PEPPER 'CHANGE-ME-openssl-rand-hex-32' && LEGACY_SECRETS="${LEGACY_SECRETS} PEPPER"
  # A publicly known JWT_SECRET lets anyone forge login tokens → rotate it now.
  # Two keys are derived from it as long as they are not set explicitly, so both
  # are pinned FIRST with exactly the derived bytes:
  #   MFA_ENCRYPTION_KEY    = HKDF(JWT\0PEPPER, "coremail-mfa", "totp-secret-v1")
  #                           → existing 2FA keeps working
  #   BACKUP_ENCRYPTION_KEY = HKDF(JWT\0PEPPER, "coremail-backup-key",
  #                           "coremail backup encryption key v1")
  #                           (packages/backup-service/src/crypto/backup-crypto.ts)
  #                           → existing encrypted backups stay restorable
  # Rotating only logs every user out once. If a key cannot be computed, the
  # old JWT_SECRET is kept (and reported) rather than losing 2FA or backups.
  LEGACY_JWT_DEFAULT='CHANGE-ME-openssl-rand-hex-32'
  LEGACY_PEPPER="$(grep '^PEPPER=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  CURRENT_JWT="$(grep '^JWT_SECRET=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  APP_IMAGE="$(grep -m1 'image: magpeek/coremail-app' "${REPO_ROOT}/infra/docker/docker-compose.synology.yml" | awk '{print $2}')"
  # legacy_key SALT INFO → 64 hex chars of HKDF-SHA256(<default JWT>\0<PEPPER>, SALT, INFO, 32)
  legacy_key() {
    LEGACY_JWT="${LEGACY_JWT_DEFAULT}" LEGACY_PEPPER="${LEGACY_PEPPER}" HKDF_SALT="$1" HKDF_INFO="$2" \
      docker run --rm -e LEGACY_JWT -e LEGACY_PEPPER -e HKDF_SALT -e HKDF_INFO \
      --entrypoint node "${APP_IMAGE:-magpeek/coremail-app:8.0.0}" -e \
      "process.stdout.write(Buffer.from(require('crypto').hkdfSync('sha256', process.env.LEGACY_JWT + '\0' + process.env.LEGACY_PEPPER, process.env.HKDF_SALT, process.env.HKDF_INFO, 32)).toString('hex'))" \
      2>/dev/null || true
  }
  is_hex64() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
  if [ -z "${CURRENT_JWT}" ] || [ "${CURRENT_JWT}" = "${LEGACY_JWT_DEFAULT}" ]; then
    PINNED_OK=1
    if ! grep -qs '^MFA_ENCRYPTION_KEY=' "${ENV_FILE}"; then
      MFA_KEY="$(legacy_key 'coremail-mfa' 'totp-secret-v1')"
      if is_hex64 "${MFA_KEY}"; then
        set_env MFA_ENCRYPTION_KEY "${MFA_KEY}" || true
        echo "      ✓ 2FA key pinned as MFA_ENCRYPTION_KEY"
      else
        PINNED_OK=0
      fi
    fi
    if ! grep -qs '^BACKUP_ENCRYPTION_KEY=' "${ENV_FILE}"; then
      BACKUP_KEY="$(legacy_key 'coremail-backup-key' 'coremail backup encryption key v1')"
      if is_hex64 "${BACKUP_KEY}"; then
        set_env BACKUP_ENCRYPTION_KEY "${BACKUP_KEY}" || true
        echo "      ✓ backup key pinned as BACKUP_ENCRYPTION_KEY (existing backups stay restorable)"
        echo "        Copy it from ${ENV_FILE} to a safe place OFF the NAS."
      else
        PINNED_OK=0
      fi
    fi
    if [ -z "${CURRENT_JWT}" ]; then
      if [ "${PINNED_OK}" = "1" ]; then
        set_env JWT_SECRET "$(rnd 32)" || true
        echo "      ✓ JWT_SECRET rotated (was the public default)"
      else
        set_env JWT_SECRET "${LEGACY_JWT_DEFAULT}" || true
        LEGACY_SECRETS="${LEGACY_SECRETS} JWT_SECRET(!)"
      fi
    else
      # JWT_SECRET is still the public default from an earlier run: keys are now
      # pinned, rotate it by hand (docs/deployment-security.md).
      LEGACY_SECRETS="${LEGACY_SECRETS} JWT_SECRET(!)"
    fi
  fi
fi
# Safe to (re)generate on every installation: only used at runtime
set_env REDIS_PASSWORD "$(rnd 20)" || true
set_env RSPAMD_CONTROLLER_PASSWORD "$(rnd 20)" || true
if set_env BACKUP_ENCRYPTION_KEY "$(rnd 32)"; then
  echo "      ✓ BACKUP_ENCRYPTION_KEY generated — copy it from ${ENV_FILE} to a safe place OFF the NAS"
fi
echo "      ✓ secrets in ${ENV_FILE} (chmod 600)"
if [ -n "${LEGACY_SECRETS}" ]; then
  echo "      ⚠  This installation used the well-known default value(s) of the old Compose file:"
  echo "        ${LEGACY_SECRETS}"
  echo "        They are now written to ${ENV_FILE} so nothing breaks. Rotate them:"
  echo "        docs/deployment-security.md → \"Rotating the old Synology default passwords\""
fi

# ── 1c. Configuration files (bind-mounted read-only) ──────────────────────────
mkdir -p "${COREMAIL_BASE}/config/postgres" "${COREMAIL_BASE}/config/rspamd/local.d"
cp "${REPO_ROOT}/infra/docker/postgres/init.sql" "${COREMAIL_BASE}/config/postgres/01-init.sql"
cp "${REPO_ROOT}/infra/docker/postgres/02-app-role.sh" "${COREMAIL_BASE}/config/postgres/02-app-role.sh"
cp "${REPO_ROOT}/infra/docker/rspamd/local.d/"* "${COREMAIL_BASE}/config/rspamd/local.d/"
chmod 755 "${COREMAIL_BASE}/config/postgres/02-app-role.sh"
chmod -R a+rX "${COREMAIL_BASE}/config"
echo "      ✓ config/postgres + config/rspamd/local.d updated"

# ── 2. Copy docker-compose.yml ───────────────────────────────────────────────
echo "[2/3] Copying docker-compose.synology.yml..."
COMPOSE_SRC="${REPO_ROOT}/infra/docker/docker-compose.synology.yml"
if [ -f "${COMPOSE_SRC}" ]; then
  cp "${COMPOSE_SRC}" "${COREMAIL_BASE}/docker-compose.yml"
  echo "      ✓ docker-compose.yml → ${COREMAIL_BASE}/docker-compose.yml"

  # Insert hostname
  if [ "${NAS_HOSTNAME}" != "mail.local" ]; then
    sed -i "s/mail\.local/${NAS_HOSTNAME}/g" "${COREMAIL_BASE}/docker-compose.yml"
    echo "      ✓ Hostname '${NAS_HOSTNAME}' inserted"
  fi
else
  echo "      ⚠  ${COMPOSE_SRC} not found — please copy manually"
fi

# ── 3. Start the stack ────────────────────────────────────────────────────────
echo "[3/3] Starting Docker stack..."
cd "${COREMAIL_BASE}"

if ! command -v docker &>/dev/null; then
  echo "      ⚠  'docker' not in PATH — Container Manager not installed?"
  echo "      Start manually: cd ${COREMAIL_BASE} && docker compose up -d"
  exit 0
fi

docker compose up -d --pull always

# ── Result ────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                       Setup complete!                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  All services are ready after approx. 60–90 seconds."
echo ""
echo "  Status:  docker compose -f ${COREMAIL_BASE}/docker-compose.yml ps"
echo "  Logs:    docker compose -f ${COREMAIL_BASE}/docker-compose.yml logs -f"
echo ""
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │  Access                                                  │"
echo "  ├──────────────────────────────────────────────────────────┤"
echo "  │  MWA Webmail:  http://${NAS_HOSTNAME}:8080/owa/           │"
echo "  │  BCP Admin:    http://${NAS_HOSTNAME}:8080/bcp/           │"
echo "  │  MinIO:        http://${NAS_HOSTNAME}:9001                │"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  HTTPS (recommended for production):"
echo "  DSM → Control Panel → Application Portal → Reverse Proxy"
echo "  Source: https://${NAS_HOSTNAME}  →  Destination: http://localhost:8080"
echo ""
echo "  Create the first admin account in the setup wizard:"
echo "    http://${NAS_HOSTNAME}:8080/bcp/"
echo "  It asks for the one-time setup token from the log:"
echo "    docker logs coremail 2>&1 | grep -i 'setup token'"
echo ""
echo "  Secrets live in ${COREMAIL_BASE}/.env (chmod 600)."
echo "  ⚠  Keep a copy of BACKUP_ENCRYPTION_KEY and PEPPER OFF the NAS —"
echo "     without them backups cannot be restored / passwords verified."
echo ""
