#!/usr/bin/env bash
# CoreMail — Ersteinrichtung für Docker Compose
# Führt alle notwendigen Schritte aus, bevor docker compose up ausgeführt wird.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "══════════════════════════════════════════════════════════"
echo "  CoreMail — Setup"
echo "══════════════════════════════════════════════════════════"

# 1. .env erstellen
if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ .env aus .env.example erstellt — bitte anpassen!"
else
  echo "✓ .env vorhanden"
fi

# 2. TLS-Zertifikate (Entwicklung)
if [ ! -f infra/docker/nginx/certs/fullchain.pem ]; then
  echo "→ Erstelle Entwicklungs-TLS-Zertifikate..."
  bash scripts/gen-dev-certs.sh
else
  echo "✓ TLS-Zertifikate vorhanden"
fi

# 3. rspamd local.d Verzeichnis
mkdir -p infra/docker/rspamd/local.d
echo "✓ rspamd/local.d vorhanden"

# 4. Prüfen ob pnpm-lock.yaml vorhanden ist
if [ ! -f pnpm-lock.yaml ]; then
  echo "→ pnpm-lock.yaml fehlt — führe pnpm install aus..."
  if command -v pnpm &>/dev/null; then
    pnpm install
    echo "✓ pnpm install abgeschlossen"
  else
    echo "⚠  pnpm nicht installiert. Installiere es mit:"
    echo "   npm install -g pnpm"
    echo "   Dann: pnpm install"
  fi
else
  echo "✓ pnpm-lock.yaml vorhanden"
fi

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Nächste Schritte:"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "  1. .env anpassen (MAIL_HOSTNAME, Passwörter, etc.)"
echo ""
echo "  2. Stack starten:"
echo "     docker compose -f infra/docker/docker-compose.yml up -d --build"
echo ""
echo "  3. Vollständig (inkl. POP3 + CalDAV):"
echo "     docker compose -f infra/docker/docker-compose.yml \\"
echo "       --profile full up -d --build"
echo ""
echo "  Webmail:    https://\${MAIL_HOSTNAME}/owa/"
echo "  Admin-ECP:  https://\${MAIL_HOSTNAME}/ecp/"
echo ""
