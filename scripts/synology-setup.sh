#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — Synology NAS Ersteinrichtung
#
# Dieses Skript per SSH auf der Synology ausführen (als root oder sudo):
#   NAS_HOSTNAME=192.168.1.100 bash synology-setup.sh
#
# Voraussetzungen auf der Synology:
#   1. SSH aktiviert (DSM → Systemsteuerung → Terminal & SNMP → SSH aktivieren)
#   2. Docker / Container Manager installiert (via Package Center)
#   3. Volume "volume1" vorhanden (Standard-Synology-Volume)
#
# Was das Skript tut:
#   1. Verzeichnisstruktur unter /volume1/docker/coremail/ anlegen
#   2. docker-compose.synology.yml kopieren
#   3. Stack starten
#
# TLS/HTTPS:
#   CoreMail läuft auf Port 8080 (HTTP).
#   Für HTTPS DSM Application Portal nutzen:
#   DSM → Systemsteuerung → Application Portal → Reverseproxy
#   Quelle: https://<deine-domain.de> → Ziel: http://localhost:8080
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Konfiguration ─────────────────────────────────────────────────────────────
COREMAIL_BASE="/volume1/docker/coremail"
NAS_HOSTNAME="${NAS_HOSTNAME:-mail.local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         CoreMail v0.9.2 — Synology Ersteinrichtung          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Basis-Verzeichnis : ${COREMAIL_BASE}"
echo "NAS Hostname      : ${NAS_HOSTNAME}"
echo ""

# ── 1. Verzeichnisstruktur ────────────────────────────────────────────────────
echo "[1/3] Verzeichnisse anlegen..."
mkdir -p \
  "${COREMAIL_BASE}/data/postgres" \
  "${COREMAIL_BASE}/data/redis" \
  "${COREMAIL_BASE}/data/minio"
echo "      ✓ ${COREMAIL_BASE}/ angelegt"

# ── 2. docker-compose.yml kopieren ───────────────────────────────────────────
echo "[2/3] docker-compose.synology.yml kopieren..."
COMPOSE_SRC="${REPO_ROOT}/infra/docker/docker-compose.synology.yml"
if [ -f "${COMPOSE_SRC}" ]; then
  cp "${COMPOSE_SRC}" "${COREMAIL_BASE}/docker-compose.yml"
  echo "      ✓ docker-compose.yml → ${COREMAIL_BASE}/docker-compose.yml"

  # Hostname einsetzen
  if [ "${NAS_HOSTNAME}" != "mail.local" ]; then
    sed -i "s/mail\.local/${NAS_HOSTNAME}/g" "${COREMAIL_BASE}/docker-compose.yml"
    echo "      ✓ Hostname '${NAS_HOSTNAME}' eingetragen"
  fi
else
  echo "      ⚠  ${COMPOSE_SRC} nicht gefunden — bitte manuell kopieren"
fi

# ── 3. Stack starten ──────────────────────────────────────────────────────────
echo "[3/3] Docker Stack starten..."
cd "${COREMAIL_BASE}"

if ! command -v docker &>/dev/null; then
  echo "      ⚠  'docker' nicht im PATH — Container Manager nicht installiert?"
  echo "      Manuell starten: cd ${COREMAIL_BASE} && docker compose up -d"
  exit 0
fi

docker compose up -d --pull always

# ── Ergebnis ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                     Setup abgeschlossen!                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Alle Services sind nach ca. 60–90 Sekunden bereit."
echo ""
echo "  Status:  docker compose -f ${COREMAIL_BASE}/docker-compose.yml ps"
echo "  Logs:    docker compose -f ${COREMAIL_BASE}/docker-compose.yml logs -f"
echo ""
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │  Zugriff                                                 │"
echo "  ├──────────────────────────────────────────────────────────┤"
echo "  │  OWA Webmail:  http://${NAS_HOSTNAME}:8080/owa/           │"
echo "  │  ECP Admin:    http://${NAS_HOSTNAME}:8080/ecp/           │"
echo "  │  MinIO:        http://${NAS_HOSTNAME}:9001                │"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  HTTPS (empfohlen für Produktion):"
echo "  DSM → Systemsteuerung → Application Portal → Reverseproxy"
echo "  Quelle: https://${NAS_HOSTNAME}  →  Ziel: http://localhost:8080"
echo ""
echo "  Erster Admin-Account anlegen:"
echo "  curl -X POST http://${NAS_HOSTNAME}:8080/api/v1/admin/setup \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"email\":\"admin@${NAS_HOSTNAME}\",\"password\":\"Test1234!\",\"displayName\":\"Admin\"}'"
echo ""
echo "  ⚠  WICHTIG: JWT_SECRET und PEPPER in ${COREMAIL_BASE}/docker-compose.yml"
echo "     vor dem Produktiveinsatz durch Zufallswerte ersetzen:"
echo "     openssl rand -hex 32   # → JWT_SECRET"
echo "     openssl rand -hex 32   # → PEPPER"
echo ""
