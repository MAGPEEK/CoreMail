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
mkdir -p \
  "${COREMAIL_BASE}/data/postgres" \
  "${COREMAIL_BASE}/data/redis" \
  "${COREMAIL_BASE}/data/minio"
echo "      ✓ ${COREMAIL_BASE}/ created"

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
echo "  │  OWA Webmail:  http://${NAS_HOSTNAME}:8080/owa/           │"
echo "  │  ECP Admin:    http://${NAS_HOSTNAME}:8080/ecp/           │"
echo "  │  MinIO:        http://${NAS_HOSTNAME}:9001                │"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  HTTPS (recommended for production):"
echo "  DSM → Control Panel → Application Portal → Reverse Proxy"
echo "  Source: https://${NAS_HOSTNAME}  →  Destination: http://localhost:8080"
echo ""
echo "  Create the first admin account:"
echo "  curl -X POST http://${NAS_HOSTNAME}:8080/api/v1/admin/setup \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"email\":\"admin@${NAS_HOSTNAME}\",\"password\":\"Test1234!\",\"displayName\":\"Admin\"}'"
echo ""
echo "  ⚠  IMPORTANT: Replace JWT_SECRET and PEPPER in ${COREMAIL_BASE}/docker-compose.yml"
echo "     with random values before production use:"
echo "     openssl rand -hex 32   # → JWT_SECRET"
echo "     openssl rand -hex 32   # → PEPPER"
echo ""
