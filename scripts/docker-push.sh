#!/usr/bin/env bash
# CoreMail — Docker Hub Build & Push (2-Container-Architektur)
#
# Baut die zwei CoreMail-Images und pusht sie zu Docker Hub.
# GitHub Actions übernimmt das automatisch bei jedem Version-Tag.
#
# Verwendung:
#   bash scripts/docker-push.sh [VERSION] [--no-push]
#
# Beispiele:
#   bash scripts/docker-push.sh              # Version aus CHANGELOG
#   bash scripts/docker-push.sh 0.9.0        # explizite Version
#   bash scripts/docker-push.sh 0.9.0 --no-push  # nur bauen, nicht pushen
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Konfiguration ────────────────────────────────────────────────────────────
REGISTRY="docker.io"
ORG="magpeek"

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

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         CoreMail Docker Build & Push — v${VERSION}            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Registry  : ${REGISTRY}"
echo "  Org       : ${ORG}"
echo "  Version   : ${VERSION}"
echo "  Commit    : ${GIT_SHA}"
echo "  Push      : ${PUSH}"
echo ""

FAILED=()
BUILT=()

# ── Build-Funktion ────────────────────────────────────────────────────────────
build_image() {
  local NAME="$1"
  local DOCKERFILE="$2"
  local IMAGE="${REGISTRY}/${ORG}/${NAME}"
  local TAG_VERSIONED="${IMAGE}:${VERSION}"
  local TAG_LATEST="${IMAGE}:latest"

  echo "▶ Baue ${NAME}:${VERSION} ..."
  echo "  Dockerfile : ${DOCKERFILE}"
  echo "  Image      : ${TAG_VERSIONED}"

  local EXTRA_ARGS=()
  if [ "$PUSH" = true ]; then
    EXTRA_ARGS+=(--push)
  else
    EXTRA_ARGS+=(--load)
  fi

  if docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --file "${DOCKERFILE}" \
    --tag "${TAG_VERSIONED}" \
    --tag "${TAG_LATEST}" \
    --label "org.opencontainers.image.title=CoreMail ${NAME}" \
    --label "org.opencontainers.image.version=${VERSION}" \
    --label "org.opencontainers.image.created=${BUILD_DATE}" \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.source=https://github.com/MAGPEEK/CoreMail" \
    --label "org.opencontainers.image.licenses=MIT" \
    "${EXTRA_ARGS[@]}" \
    .; then
    BUILT+=("${NAME}:${VERSION}")
    echo "  ✓ ${NAME} erfolgreich gebaut"
  else
    FAILED+=("${NAME}")
    echo "  ✗ ${NAME} FEHLGESCHLAGEN" >&2
  fi
  echo ""
}

# ── Image 1: coremail-app ─────────────────────────────────────────────────────
# Alle Node.js-Services + nginx + OWA/ECP-Frontends

build_image "coremail-app" "infra/docker/Dockerfile.app"

# ── Image 2: coremail-db ──────────────────────────────────────────────────────
# PostgreSQL 16 + Redis 7 + MinIO

build_image "coremail-db" "infra/docker/Dockerfile.db"

# ── Zusammenfassung ──────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                     Zusammenfassung                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Erfolgreich: ${#BUILT[@]} / $((${#BUILT[@]} + ${#FAILED[@]}))"

if [ ${#BUILT[@]} -gt 0 ]; then
  echo ""
  echo "  Gepushte Images:"
  for img in "${BUILT[@]}"; do
    echo "    ✓ docker.io/${ORG}/${img}"
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
  echo "  Schnellstart:"
  echo "    docker compose up -d"
fi
echo ""
