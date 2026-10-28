#!/usr/bin/env bash
# CoreMail — Ersteinrichtung: erzeugt .env mit zufälligen Schlüsseln.
# Danach: docker compose -f infra/docker/docker-compose.yml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "══════════════════════════════════════════════════════════"
echo "  CoreMail — Setup"
echo "══════════════════════════════════════════════════════════"

for tool in docker openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ $tool nicht gefunden — bitte installieren."; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "✗ 'docker compose' (v2) nicht verfügbar."; exit 1; }

if [ -f .env ]; then
  echo "✓ .env vorhanden — wird nicht überschrieben."
  if grep -q "CHANGE-ME" .env; then
    echo "⚠  .env enthält noch CHANGE-ME-Platzhalter. Bitte ersetzen (openssl rand -hex 32)."
  fi
else
  cp .env.example .env
  rnd() { openssl rand -hex "$1"; }
  sed -i.bak \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rnd 32)|" \
    -e "s|^PEPPER=.*|PEPPER=$(rnd 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 20)|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(rnd 20)|" \
    -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$(rnd 20)|" \
    .env && rm -f .env.bak
  chmod 600 .env
  echo "✓ .env mit zufälligen Schlüsseln erzeugt (chmod 600)."
fi

# Compose liest .env aus dem Verzeichnis der Compose-Datei bzw. dem Aufrufverzeichnis.
# Ein Symlink neben die Compose-Datei macht beides möglich.
if [ ! -e infra/docker/.env ]; then
  ln -s ../../.env infra/docker/.env
  echo "✓ infra/docker/.env → ../../.env verknüpft"
fi

mkdir -p infra/docker/rspamd/local.d

cat <<MSG

Nächste Schritte:
  1. Stack starten:
       docker compose -f infra/docker/docker-compose.yml up -d
  2. Nach ca. 90 s im Browser öffnen:
       http://<server-ip>:3000/bcp/      → Setup-Assistent (Admin-Konto + Domain)
  3. DNS setzen (A/MX/SPF/DKIM/DMARC — Vorlage im BCP → Domains → DNS-Einrichtung)
  4. Zertifikat holen (BCP → SSL/TLS oder):
       docker exec -it coremail coremail cert letsencrypt --domains mail.example.de \\
         --email admin@example.de --services SMTP,IMAP,POP3
  Admin-CLI: docker exec -it coremail coremail --help
MSG
