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

rnd() { openssl rand -hex "$1"; }
# set_env KEY VALUE — appends KEY=VALUE when .env has no (uncommented) KEY yet
set_env() {
  if grep -q "^$1=" .env; then return 1; fi
  printf '%s=%s\n' "$1" "$2" >> .env
}

if [ -f .env ]; then
  echo "✓ .env exists — will not be overwritten."
  if grep -q "^[A-Z_]*=.*CHANGE-ME" .env; then
    echo "⚠  .env still contains CHANGE-ME placeholders. Please replace them (openssl rand -hex 32)."
  fi
else
  umask 077
  cp .env.example .env
  chmod 600 .env
  sed -i.bak \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rnd 32)|" \
    -e "s|^PEPPER=.*|PEPPER=$(rnd 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 20)|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(rnd 20)|" \
    -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$(rnd 20)|" \
    .env && rm -f .env.bak
  # v8.0: new installations keep mail contents on the filesystem (volume
  # coremail-data) — .env.example already says so; enforce it for old templates.
  grep -q '^OBJECT_STORAGE=' .env || echo "OBJECT_STORAGE=filesystem" >> .env
  # Least-privilege database role — only for a FRESH database: postgres/02-app-role.sh
  # creates it on the first start of an empty data volume. If a database volume
  # already exists, the app keeps using the superuser (docs/deployment-security.md).
  if docker volume inspect coremail_pgdata >/dev/null 2>&1; then
    echo "ℹ  Volume coremail_pgdata exists — not switching the app to a separate database role."
  else
    set_env COREMAIL_DB_USER coremail_app || true
    set_env COREMAIL_DB_PASSWORD "$(rnd 20)" || true
  fi
  chmod 600 .env
  echo "✓ .env created with random keys (chmod 600), OBJECT_STORAGE=filesystem."
fi

# Secrets introduced after the first release of .env — added when missing,
# existing values are never changed (also for existing installations).
set_env RSPAMD_CONTROLLER_PASSWORD "$(rnd 20)" && echo "✓ RSPAMD_CONTROLLER_PASSWORD generated"
if set_env BACKUP_ENCRYPTION_KEY "$(rnd 32)"; then
  echo "✓ BACKUP_ENCRYPTION_KEY generated — store a copy OFF this server (password manager):"
  echo "  without it, encrypted backups cannot be restored."
fi
chmod 600 .env
if ! grep -q '^OBJECT_STORAGE=' .env; then
  # Existing installation from before 8.0: OBJECT_STORAGE unset = minio. Nothing to do.
  echo "ℹ  OBJECT_STORAGE not set in .env → mail contents stay in MinIO (unchanged)."
  echo "   Moving them to the filesystem volume is optional: docs/storage.md"
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
