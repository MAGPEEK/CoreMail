#!/usr/bin/env bash
# CoreMail — Helm chart check (lint + template + kubeconform), via Docker only.
#
# No local helm/kubeconform needed; the tool images are pinned:
#   alpine/helm:3.16.4                   helm lint / helm template
#   ghcr.io/yannh/kubeconform:v0.6.7     schema validation of the rendered manifests
#
# Usage:
#   bash scripts/helm-check.sh                 # all ci/*-values.yaml
#   KUBE_VERSION=1.30.0 bash scripts/helm-check.sh
#
# For every infra/k8s/ci/*-values.yaml: helm lint --strict, helm template,
# kubeconform -strict. Additionally checks that rendering WITHOUT the required
# secrets fails (fail-fast `required` checks). Rendered manifests are kept in
# infra/k8s/.rendered/ (git-ignored) for inspection.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HELM_IMAGE="alpine/helm:3.16.4"
KUBECONFORM_IMAGE="ghcr.io/yannh/kubeconform:v0.6.7"
KUBE_VERSION="${KUBE_VERSION:-1.30.0}"

# Git Bash on Windows: keep container paths unmangled, use a Windows host path.
export MSYS_NO_PATHCONV=1
CHART_HOST="$ROOT/infra/k8s"
if command -v cygpath >/dev/null 2>&1; then CHART_HOST="$(cygpath -w "$CHART_HOST")"; fi

helm() { docker run --rm -v "$CHART_HOST:/chart" -w /chart "$HELM_IMAGE" "$@"; }

OUT="$ROOT/infra/k8s/.rendered"
rm -rf "$OUT"; mkdir -p "$OUT"
fail=0

for values in infra/k8s/ci/*-values.yaml; do
  name="$(basename "$values" .yaml)"
  echo "── $name ─────────────────────────────────────────────"
  helm lint --strict /chart -f "/chart/ci/$name.yaml" || fail=1
  if helm template coremail /chart -n coremail --kube-version "$KUBE_VERSION" \
       -f "/chart/ci/$name.yaml" > "$OUT/$name.yaml"; then
    echo "rendered $(grep -c '^kind:' "$OUT/$name.yaml") objects → infra/k8s/.rendered/$name.yaml"
    # env names the app actually reads (regressions: RSPAMD_HOST/PORT instead of RSPAMD_URL)
    if ! grep -q '^  RSPAMD_URL: "https\?://' "$OUT/$name.yaml"; then echo "ERROR: $name: RSPAMD_URL missing"; fail=1; fi
    if grep -q '^  RSPAMD_\(HOST\|PORT\):' "$OUT/$name.yaml"; then echo "ERROR: $name: legacy RSPAMD_HOST/RSPAMD_PORT rendered"; fail=1; fi
    docker run --rm -v "$CHART_HOST:/chart" "$KUBECONFORM_IMAGE" \
      -strict -ignore-missing-schemas -summary \
      -kubernetes-version "$KUBE_VERSION" "/chart/.rendered/$name.yaml" || fail=1
  else
    fail=1
  fi
done

echo "── fail-fast: rendering without secrets must fail ───────"
if helm template coremail /chart >/dev/null 2>"$OUT/missing-secrets.err"; then
  echo "ERROR: chart rendered without required secrets"; fail=1
else
  grep -o 'secrets\.[a-zA-Z]* is required[^"]*' "$OUT/missing-secrets.err" | head -1 || cat "$OUT/missing-secrets.err"
  echo "ok (refused)"
fi

if [ "$fail" -ne 0 ]; then echo "helm-check: FAILED"; exit 1; fi
echo "helm-check: OK"
