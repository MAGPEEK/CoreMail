#!/usr/bin/env bash
# CoreMail — initial setup: generates .env with random keys.
# Afterwards: docker compose -f infra/docker/docker-compose.yml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "══════════════════════════════════════════════════════════"
echo "  CoreMail — Setup"
echo "══════════════════════════════════════════════════════════"

for tool in docker openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ $tool not found — please install it."; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "✗ 'docker compose' (v2) not available."; exit 1; }

if [ -f .env ]; then
  echo "✓ .env exists — will not be overwritten."
  if grep -q "CHANGE-ME" .env; then
    echo "⚠  .env still contains CHANGE-ME placeholders. Please replace them (openssl rand -hex 32)."
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
  echo "✓ .env created with random keys (chmod 600)."
fi

# Compose reads .env from the directory of the Compose file or from the invocation directory.
# A symlink next to the Compose file makes both work.
if [ ! -e infra/docker/.env ]; then
  ln -s ../../.env infra/docker/.env
  echo "✓ infra/docker/.env → ../../.env linked"
fi

mkdir -p infra/docker/rspamd/local.d

cat <<MSG

Next steps:
  1. Start the stack:
       docker compose -f infra/docker/docker-compose.yml up -d
  2. After approx. 90 s open in the browser:
       http://<server-ip>:3000/bcp/      → setup wizard (admin account + domain)
  3. Set DNS (A/MX/SPF/DKIM/DMARC — template in BCP → Domains → DNS setup)
  4. Obtain a certificate (BCP → SSL/TLS or):
       docker exec -it coremail coremail cert letsencrypt --domains mail.example.de \\
         --email admin@example.de --services SMTP,IMAP,POP3
  Admin CLI: docker exec -it coremail coremail --help
MSG
