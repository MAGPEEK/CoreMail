#!/usr/bin/env bash
# CoreMail — Docker Hub Build & Push
#
# Baut alle Service-Images lokal und pusht sie zu Docker Hub.
# Alternativ: der GitHub Actions Workflow übernimmt das automatisch bei jedem Tag.
#
# Verwendung:
#   bash scripts/docker-push.sh [VERSION]
#
# Beispiele:
#   bash scripts/docker-push.sh          # Version aus CHANGELOG (0.6.0)
#   bash scripts/docker-push.sh 0.6.0    # explizite Version
#   bash scripts/docker-push.sh 0.6.0 --no-push  # nur bauen, nicht pushen
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Konfiguration ────────────────────────────────────────────────────────────
REGISTRY="docker.io"
ORG="magpeek"
PREFIX="${REGISTRY}/${ORG}/coremail"

# Version aus CHANGELOG extrahieren falls nicht angegeben
if [ -z "${1:-}" ] || [[ "$1" == --* ]]; then
  VERSION=$(grep -m1 '^\## \[[0-9]' CHANGELOG.md | sed 's/.*\[\([0-9][^]]*\)\].*/\1/')
else
  VERSION="$1"
  shift
fi

PUSH=true
if [[ "${1:-}" == "--no-push" ]]; then
  PUSH=false
fi

echo "══════════════════════════════════════════════════════════════════"
echo "  CoreMail Docker Build & Push — v${VERSION}"
echo "  Registry: ${REGISTRY}  |  Org: ${ORG}"
echo "  Push: ${PUSH}"
echo "══════════════════════════════════════════════════════════════════"

# ── Service-Definitionen ─────────────────────────────────────────────────────
declare -A SERVICES=(
  [storage-api]="packages/storage/Dockerfile"
  [auth-service]="packages/auth-service/Dockerfile"
  [security-filter]="packages/security-filter/Dockerfile"
  [smtp-server]="packages/smtp-server/Dockerfile"
  [imap-server]="packages/imap-server/Dockerfile"
  [pop3-server]="packages/pop3-server/Dockerfile"
  [ews-server]="packages/ews-server/Dockerfile"
  [autodiscover]="packages/autodiscover/Dockerfile"
  [caldav-server]="packages/caldav-server/Dockerfile"
  [api-gateway]="packages/api-gateway/Dockerfile"
  [backup-service]="packages/backup-service/Dockerfile"
  [web-client]="packages/web-client/Dockerfile"
  [admin-panel]="packages/admin-panel/Dockerfile"
)

FAILED=()
BUILT=()

# ── Build ────────────────────────────────────────────────────────────────────
for SERVICE in "${!SERVICES[@]}"; do
  DOCKERFILE="${SERVICES[$SERVICE]}"
  IMAGE="${PREFIX}-${SERVICE}"
  TAG_VERSIONED="${IMAGE}:${VERSION}"
  TAG_LATEST="${IMAGE}:latest"

  echo ""
  echo "▶ Building ${SERVICE} → ${TAG_VERSIONED}"

  if docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --file "$DOCKERFILE" \
    --tag "$TAG_VERSIONED" \
    --tag "$TAG_LATEST" \
    --label "org.opencontainers.image.version=${VERSION}" \
    --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --label "org.opencontainers.image.revision=$(git rev-parse --short HEAD)" \
    --label "org.opencontainers.image.source=https://github.com/MAGPEEK/CoreMail" \
    $([ "$PUSH" = true ] && echo "--push" || echo "--load") \
    .; then
    BUILT+=("$SERVICE")
    echo "  ✓ ${SERVICE}"
  else
    FAILED+=("$SERVICE")
    echo "  ✗ ${SERVICE} FEHLGESCHLAGEN"
  fi
done

# ── Zusammenfassung ──────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "  Zusammenfassung"
echo "══════════════════════════════════════════════════════════════════"
echo "  Erfolgreich: ${#BUILT[@]} / $((${#BUILT[@]} + ${#FAILED[@]}))"

if [ ${#BUILT[@]} -gt 0 ]; then
  echo ""
  echo "  Gepushte Images:"
  for svc in "${BUILT[@]}"; do
    echo "    ${PREFIX}-${svc}:${VERSION}"
  done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "  Fehlgeschlagen:"
  for svc in "${FAILED[@]}"; do
    echo "    ✗ ${svc}"
  done
  exit 1
fi

if [ "$PUSH" = true ]; then
  echo ""
  echo "  Docker Hub: https://hub.docker.com/u/${ORG}"
  echo ""
  echo "  Verwendung in docker-compose.yml:"
  echo "    image: ${PREFIX}-smtp-server:${VERSION}"
fi
