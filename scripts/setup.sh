#!/usr/bin/env bash
# CoreMail — initial setup: generates .env with random keys.
#
#   bash scripts/setup.sh [--variant minimal|standard|full]
#
#   minimal   coremail + postgres + redis           infra/docker/docker-compose.minimal.yml
#   standard  + minio, rspamd, clamav (default)     infra/docker/docker-compose.yml
#   full      + limits, log rotation, profiles      infra/docker/docker-compose.full.yml
#
# The variants are compared in docs/docker-compose.md. Afterwards the script
# prints the matching `docker compose` command.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VARIANT=standard
usage() { sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --variant)   [ $# -ge 2 ] || { echo "✗ --variant needs a value (minimal|standard|full)"; exit 1; }
                 VARIANT="$2"; shift 2 ;;
    --variant=*) VARIANT="${1#--variant=}"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "✗ unknown option: $1"; usage; exit 1 ;;
  esac
done
case "$VARIANT" in
  minimal)  COMPOSE_FILE_REL=infra/docker/docker-compose.minimal.yml ;;
  standard) COMPOSE_FILE_REL=infra/docker/docker-compose.yml ;;
  full)     COMPOSE_FILE_REL=infra/docker/docker-compose.full.yml ;;
  *) echo "✗ unknown variant '$VARIANT' — use minimal, standard or full"; exit 1 ;;
esac

echo "══════════════════════════════════════════════════════════"
echo "  CoreMail — Setup (variant: $VARIANT)"
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
# rspamd runs in the standard and full variants only.
if [ "$VARIANT" != minimal ]; then
  set_env RSPAMD_CONTROLLER_PASSWORD "$(rnd 20)" && echo "✓ RSPAMD_CONTROLLER_PASSWORD generated"
fi
if set_env BACKUP_ENCRYPTION_KEY "$(rnd 32)"; then
  echo "✓ BACKUP_ENCRYPTION_KEY generated — store a copy OFF this server (password manager):"
  echo "  without it, encrypted backups cannot be restored."
fi
chmod 600 .env
STORAGE="$(sed -n 's/^OBJECT_STORAGE=\([a-z0-9]*\).*/\1/p' .env | tail -n 1)"
if [ -z "$STORAGE" ]; then
  # Existing installation from before 8.0: OBJECT_STORAGE unset = minio.
  case "$VARIANT" in
    standard)
      echo "ℹ  OBJECT_STORAGE not set in .env → mail contents stay in MinIO (unchanged)."
      echo "   Moving them to the filesystem volume is optional: docs/storage.md" ;;
    full)
      echo "⚠  The full variant needs OBJECT_STORAGE in .env. Your mail is in MinIO (pre-8.0):"
      echo "   add OBJECT_STORAGE=minio to .env and start with --profile minio (shown below)."
      STORAGE=minio ;;
    minimal)
      echo "⚠  The minimal variant stores mail on the filesystem only. Your mail is in MinIO"
      echo "   (pre-8.0): migrate on the standard stack first —"
      echo "     docker exec -it coremail coremail storage migrate --from minio --to filesystem"
      echo "   then set OBJECT_STORAGE=filesystem (docs/storage.md, docs/docker-compose.md)." ;;
  esac
elif [ "$VARIANT" = minimal ] && [ "$STORAGE" != filesystem ]; then
  echo "⚠  OBJECT_STORAGE=$STORAGE, but the minimal variant always uses the filesystem driver."
  echo "   Migrate first (coremail storage migrate --from $STORAGE --to filesystem) — docs/storage.md."
fi

# Compose reads .env from the directory of the Compose file or from the invocation directory.
# A symlink next to the Compose file makes both work.
if [ ! -e infra/docker/.env ]; then
  ln -s ../../.env infra/docker/.env
  echo "✓ infra/docker/.env → ../../.env linked"
fi

mkdir -p infra/docker/rspamd/local.d

PROFILES=""
EXTRA=""
case "$VARIANT" in
  minimal)
    EXTRA="
  This variant has no rspamd/ClamAV: after the setup wizard switch both OFF in
  BCP → Protection. Backups without MinIO: docs/docker-compose.md." ;;
  full)
    # MinIO is a profile here: needed for OBJECT_STORAGE=minio and as the default
    # target of the built-in backup service. backup = daily pg_dump sidecar.
    [ "$STORAGE" = minio ] && PROFILES=" --profile minio"
    PROFILES="$PROFILES --profile backup"
    EXTRA="
  Profiles: minio (bundled MinIO — OBJECT_STORAGE=minio or built-in backups without
  external S3), backup (daily pg_dump), geoip (GEOIPUPDATE_ACCOUNT_ID/_LICENSE_KEY)." ;;
esac

cat <<MSG

Next steps (variant $VARIANT — docs/docker-compose.md):
  1. Start the stack:
       docker compose -f $COMPOSE_FILE_REL$PROFILES up -d
  2. After approx. 90 s open in the browser:
       http://<server-ip>:3000/bcp/      → setup wizard (admin account + domain)
  3. Set DNS (A/MX/SPF/DKIM/DMARC — template in BCP → Domains → DNS setup)
  4. Obtain a certificate (BCP → SSL/TLS or):
       docker exec -it coremail coremail cert letsencrypt --domains mail.example.de \\
         --email admin@example.de --services SMTP,IMAP,POP3
  Admin CLI: docker exec -it coremail coremail --help$EXTRA
MSG
