#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CoreMail — release assets
#
# Uploads the standalone Compose file deploy/docker-compose.yml to a GitHub
# release as the asset "docker-compose.yml", with the image tag pinned to the
# release version, so that
#   curl -fsSLO https://github.com/MAGPEEK/CoreMail/releases/latest/download/docker-compose.yml
# always fetches the file that belongs to the newest release (docs/deploy.md).
#
# Usage:
#   bash scripts/release-assets.sh [VERSION] [--dry-run] [--out <dir>]
#
#   VERSION     e.g. 10.4.0 (default: package.json "version"); the release tag is v<VERSION>
#   --dry-run   build and check the asset, print where it is, upload nothing
#   --out DIR   keep the built asset in DIR (default: a temporary directory)
#
# Requires: gh (authenticated, or GITHUB_TOKEN set) for the upload; docker
# compose (optional) validates the file first. The release v<VERSION> must
# exist already (gh release create …); an existing asset is replaced (--clobber).
# Run it after the image magpeek/coremail-app:<VERSION> is on Docker Hub
# (scripts/docker-push.sh or the GitHub Actions workflow).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/deploy/docker-compose.yml"
REPO="${COREMAIL_RELEASE_REPO:-MAGPEEK/CoreMail}"

VERSION=""
DRY_RUN=false
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --out) [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 1; }; OUT="$2"; shift ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) VERSION="$1" ;;
  esac
  shift
done
if [ -z "${VERSION}" ]; then
  VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "${ROOT}/package.json" | head -n1)
fi
if ! printf '%s' "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "invalid version: '${VERSION}' (expected MAJOR.MINOR.PATCH)" >&2
  exit 1
fi
TAG="v${VERSION}"

if [ -z "${OUT}" ]; then
  OUT="$(mktemp -d)"
  ${DRY_RUN} || trap 'rm -rf "${OUT}"' EXIT
fi
mkdir -p "${OUT}"
ASSET="${OUT}/docker-compose.yml"

# Pin the image tag: every `magpeek/coremail-app:${COREMAIL_VERSION:-X}` gets the
# release version as its default (COREMAIL_VERSION stays an override for tests
# and rollbacks), and the header line names the release. CRs are stripped: the
# file's `sh -c` blocks run in Linux containers (a Windows checkout may add them).
tr -d '\r' < "${SRC}" | sed -E \
  -e "s#(magpeek/coremail-app:\\\$\\{COREMAIL_VERSION:-)[^}]*\\}#\\1${VERSION}}#g" \
  -e "s#^(\\#  CoreMail )[0-9][^ ]* (— Docker Compose, standalone deployment file)#\\1${VERSION} \\2#" \
  > "${ASSET}"

# Checks: every app image carries the release version, nothing else is pinned to
# another CoreMail version, and the file needs no other repository file.
images=$(grep -E '^\s*image: magpeek/coremail-app:' "${ASSET}" || true)
[ -n "${images}" ] || { echo "no magpeek/coremail-app image in ${SRC}" >&2; exit 1; }
if printf '%s\n' "${images}" | grep -vqF "magpeek/coremail-app:\${COREMAIL_VERSION:-${VERSION}}"; then
  echo "image tags not pinned to ${VERSION}:" >&2
  printf '%s\n' "${images}" >&2
  exit 1
fi
if grep -nE '^\s*-\s*\./' "${ASSET}" | grep -vE '\./secrets|\./config' >/dev/null; then
  echo "the standalone file must not bind-mount repository files:" >&2
  grep -nE '^\s*-\s*\./' "${ASSET}" >&2
  exit 1
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  for profiles in "" "--profile scanner" "--profile backup" "--profile s3" "--profile scanner --profile backup --profile s3"; do
    # shellcheck disable=SC2086
    (cd "${OUT}" && docker compose -f docker-compose.yml ${profiles} config -q) \
      || { echo "docker compose config failed (${profiles:-no profile})" >&2; exit 1; }
  done
  echo "docker compose config: OK (all profiles)"
else
  echo "docker compose not found — skipping the config check"
fi

echo "asset: ${ASSET} (image magpeek/coremail-app:${VERSION})"
if ${DRY_RUN}; then
  echo "dry run — nothing uploaded (release ${TAG} on ${REPO})"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) is required for the upload" >&2; exit 1; }
gh release view "${TAG}" --repo "${REPO}" >/dev/null \
  || { echo "release ${TAG} does not exist on ${REPO} — create it first (gh release create ${TAG} …)" >&2; exit 1; }
gh release upload "${TAG}" "${ASSET}" --clobber --repo "${REPO}"
echo "uploaded docker-compose.yml to ${REPO} release ${TAG}"
echo "  https://github.com/${REPO}/releases/download/${TAG}/docker-compose.yml"
