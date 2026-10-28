#!/usr/bin/env bash
# CoreMail — Docker Hub build & push (2-container architecture)
#
# Builds the CoreMail images and pushes them to Docker Hub.
# GitHub Actions does this automatically on every version tag.
#
# Usage:
#   bash scripts/docker-push.sh [VERSION] [--no-push]
#
# Examples:
#   bash scripts/docker-push.sh              # version from CHANGELOG
#   bash scripts/docker-push.sh 0.9.0        # explicit version
#   bash scripts/docker-push.sh 0.9.0 --no-push  # build only, do not push
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Configuration ────────────────────────────────────────────────────────────
REGISTRY="docker.io"
ORG="magpeek"

# Extract version from CHANGELOG if not specified
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
echo "  1 Image: magpeek/coremail-app"
echo "  (Database: standard images postgres/redis/minio — no custom image)"
echo ""

FAILED=()
BUILT=()

# ── Build function ────────────────────────────────────────────────────────────
build_image() {
  local NAME="$1"
  local DOCKERFILE="$2"
  local IMAGE="${REGISTRY}/${ORG}/${NAME}"
  local TAG_VERSIONED="${IMAGE}:${VERSION}"
  local TAG_LATEST="${IMAGE}:latest"

  echo "▶ Building ${NAME}:${VERSION} ..."
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
    --label "org.opencontainers.image.title=CoreMail" \
    --label "org.opencontainers.image.version=${VERSION}" \
    --label "org.opencontainers.image.created=${BUILD_DATE}" \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.source=https://github.com/MAGPEEK/CoreMail" \
    --label "org.opencontainers.image.licenses=MIT" \
    "${EXTRA_ARGS[@]}" \
    .; then
    BUILT+=("${NAME}:${VERSION}")
    echo "  ✓ ${NAME} built successfully"
  else
    FAILED+=("${NAME}")
    echo "  ✗ ${NAME} FAILED" >&2
  fi
  echo ""
}

# ── The only CoreMail image ───────────────────────────────────────────────────
# All Node.js services + OWA/ECP frontends (no nginx — api-gateway takes over)

build_image "coremail-app" "infra/docker/Dockerfile.app"

# ── Summary ──────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                        Summary                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Successful: ${#BUILT[@]} / $((${#BUILT[@]} + ${#FAILED[@]}))"

if [ ${#BUILT[@]} -gt 0 ]; then
  echo ""
  echo "  Pushed images:"
  for img in "${BUILT[@]}"; do
    echo "    ✓ docker.io/${ORG}/${img}"
  done
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "  Failed:"
  for svc in "${FAILED[@]}"; do
    echo "    ✗ ${svc}"
  done
  exit 1
fi

if [ "$PUSH" = true ]; then
  echo ""
  echo "  Docker Hub: https://hub.docker.com/r/${ORG}/coremail-app"
  echo ""
  echo "  Quick start:"
  echo "    docker compose -f infra/docker/docker-compose.yml up -d"
  echo ""
  echo "  Synology NAS:"
  echo "    NAS_HOSTNAME=<IP> bash scripts/synology-setup.sh"
fi
echo ""
