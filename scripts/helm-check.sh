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
    if ! grep -q '^  RSPAMD_URL: "https\?://' "$OUT/$name.yaml" && ! grep -q '^  RSPAMD_ENABLED: "false"' "$OUT/$name.yaml"; then
      echo "ERROR: $name: neither RSPAMD_URL nor RSPAMD_ENABLED=false"; fail=1
    fi
    if ! grep -q '^  CLAMAV_HOST: ' "$OUT/$name.yaml" && ! grep -q '^  CLAMAV_ENABLED: "false"' "$OUT/$name.yaml"; then
      echo "ERROR: $name: neither CLAMAV_HOST nor CLAMAV_ENABLED=false"; fail=1
    fi
    # optional secrets are wired into the app container (and the bundled rspamd)
    for key in BACKUP_ENCRYPTION_KEY RSPAMD_CONTROLLER_PASSWORD MFA_ENCRYPTION_KEY; do
      if ! grep -q "key: $key, optional: true" "$OUT/$name.yaml"; then echo "ERROR: $name: $key secretKeyRef missing"; fail=1; fi
    done
    # images <= 8.0.0 have no coremail-schema-sync → the init container must fall back
    if ! grep -q 'if \[ -x /usr/local/bin/coremail-schema-sync \]' "$OUT/$name.yaml"; then echo "ERROR: $name: schema-sync fallback missing"; fail=1; fi
    if grep -q '^  RSPAMD_\(HOST\|PORT\):' "$OUT/$name.yaml"; then echo "ERROR: $name: legacy RSPAMD_HOST/RSPAMD_PORT rendered"; fail=1; fi
    # the object store reads MINIO_BUCKET_ATTACHMENTS (MINIO_BUCKET is ignored by the app)
    if grep -q '^  MINIO_BUCKET:' "$OUT/$name.yaml"; then echo "ERROR: $name: MINIO_BUCKET is not read by the app"; fail=1; fi
    if grep -q '^  MINIO_ENDPOINT:' "$OUT/$name.yaml" && ! grep -q '^  MINIO_BUCKET_ATTACHMENTS:' "$OUT/$name.yaml"; then
      echo "ERROR: $name: MINIO_BUCKET_ATTACHMENTS missing"; fail=1
    fi
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

# Values that must be refused (chart 2.0 removals, malformed secrets)
must_fail() {  # must_fail <label> <expected message part> <helm --set args...>
  label="$1"; expect="$2"; shift 2
  if helm template coremail /chart -f /chart/ci/default-values.yaml "$@" >/dev/null 2>"$OUT/must-fail.err"; then
    echo "ERROR: rendered although $label"; fail=1
  elif grep -q "$expect" "$OUT/must-fail.err"; then
    echo "ok (refused: $label)"
  else
    echo "ERROR: $label refused with an unexpected message:"; cat "$OUT/must-fail.err"; fail=1
  fi
}
echo "── fail-fast: removed / invalid values ────────────────"
must_fail "app.mailAuth.limitPrivateIps=true" "limitPrivateIps was removed" --set app.mailAuth.limitPrivateIps=true
must_fail "app.mailAuth.limitPrivateIps=false" "limitPrivateIps was removed" --set app.mailAuth.limitPrivateIps=false
must_fail "invalid secrets.backupEncryptionKey" "backupEncryptionKey must be 32 bytes" --set secrets.backupEncryptionKey=short
must_fail "invalid secrets.rspamdControllerPassword" "rspamdControllerPassword must be" --set-string 'secrets.rspamdControllerPassword=has"quote-and-more'

if [ "$fail" -ne 0 ]; then echo "helm-check: FAILED"; exit 1; fi
echo "helm-check: OK"
