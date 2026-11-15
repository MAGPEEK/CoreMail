#!/usr/bin/env bash
# CoreMail — Helm chart test on a real Kubernetes cluster (kind).
#
#   K8S_E2E_DIR=<dir outside the repo> bash scripts/k8s-e2e.sh
#
# Steps (each prints PASS/FAIL; exit code 1 when any check failed):
#   1. tools   kind / helm / kubectl — pinned versions, downloaded into
#              $K8S_E2E_DIR/bin and sha256-verified against the release checksum
#              files (Linux, macOS, Windows Git Bash; amd64/arm64)
#   2. cluster kind cluster with a pinned node image (NetworkPolicies are
#              enforced by kindnet)
#   3. image   docker build -f infra/docker/Dockerfile.app + kind load
#   4. install namespace labelled Pod Security "restricted" (enforce), generated
#              secrets, helm install --wait with infra/k8s/ci/kind-values.yaml
#              (bundled PostgreSQL/Redis/MinIO/rspamd/ClamAV, filesystem objects)
#   5. verify  pods Ready + admitted under "restricted"; schema-sync init container;
#              NetworkPolicies (app → datastores open, foreign pod blocked);
#              /healthz via port-forward; SMTP/IMAP/POP3 banners through the mail
#              Service; setup-token flow; SMTP submission → IMAP read
#   6. upgrade helm upgrade with a changed value (app.logLevel=debug): pod rolled,
#              mail still readable (object PVC survived the Recreate)
#   7. rollback helm rollback to revision 1
#   8. cleanup delete the cluster and the test image (KEEP=1 keeps both)
#
# Environment:
#   K8S_E2E_DIR     required — tools, kubeconfig, generated secrets, logs
#   IMAGE           app image to build/load (default coremail-app:k8s-test;
#                   must match app.image in ci/kind-values.yaml)
#   SKIP_BUILD=1    use an existing $IMAGE instead of building it
#   CLAMAV=0        disable the bundled ClamAV (needs ~1.5 GiB RAM)
#   KEEP=1          keep the cluster and image afterwards
#   CLUSTER         kind cluster name (default coremail-e2e)
# Requirements: docker, curl, openssl, node >= 22 (for the protocol checks).
set -uo pipefail

KIND_VERSION=v0.33.0
HELM_VERSION=v3.22.1
KUBECTL_VERSION=v1.37.0
# Default node image of kind v0.33.0
KIND_NODE_IMAGE="kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${K8S_E2E_DIR:?K8S_E2E_DIR is required (directory outside the repository)}"
case "$(cd "$K8S_E2E_DIR" 2>/dev/null && pwd || echo "$K8S_E2E_DIR")/" in "$ROOT"/*) echo "K8S_E2E_DIR must be outside the repository"; exit 2 ;; esac
mkdir -p "$K8S_E2E_DIR/bin" "$K8S_E2E_DIR/logs"
DIR="$(cd "$K8S_E2E_DIR" && pwd)"
BIN="$DIR/bin"; LOGS="$DIR/logs"
IMAGE="${IMAGE:-coremail-app:k8s-test}"
CLUSTER="${CLUSTER:-coremail-e2e}"
NS=coremail
REL=coremail
export KUBECONFIG="$DIR/kubeconfig"
# Git Bash: MSYS converts /c/... paths for the native tools (keep that on).

fails=0; passes=0
pass() { passes=$((passes + 1)); echo "[PASS] $*"; }
fail() { fails=$((fails + 1)); echo "[FAIL] $*"; }
step() { echo; echo "══ $* ══"; }
die() { echo "ERROR: $*"; exit 1; }

# ── 1. Tools ──────────────────────────────────────────────────────────────────
step "tools"
case "$(uname -s)" in
  Linux*) OS=linux; EXE="" ;;
  Darwin*) OS=darwin; EXE="" ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows; EXE=".exe" ;;
  *) die "unsupported OS $(uname -s)" ;;
esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch_verified() { # fetch_verified <url> <checksum-url> <dest>
  local tmp="$3.download"
  curl -fsSL -o "$tmp" "$1" || die "download $1"
  local want; want="$(curl -fsSL "$2" | awk '{print $1; exit}')" || die "download $2"
  local got; got="$(sha256 "$tmp")"
  [ -n "$want" ] && [ "$got" = "$want" ] || { rm -f "$tmp"; die "checksum mismatch for $1 ($got != $want)"; }
  mv "$tmp" "$3"; echo "  verified $(basename "$1") sha256=$got"
}
KIND="$BIN/kind-$KIND_VERSION$EXE"; HELM="$BIN/helm-$HELM_VERSION$EXE"; KUBECTL="$BIN/kubectl-$KUBECTL_VERSION$EXE"
if [ ! -x "$KIND" ]; then
  fetch_verified "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$OS-$ARCH" \
                 "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$OS-$ARCH.sha256sum" "$KIND"
  chmod +x "$KIND"
fi
if [ ! -x "$HELM" ]; then
  ext=tar.gz; [ "$OS" = windows ] && ext=zip
  fetch_verified "https://get.helm.sh/helm-$HELM_VERSION-$OS-$ARCH.$ext" "https://get.helm.sh/helm-$HELM_VERSION-$OS-$ARCH.$ext.sha256sum" "$BIN/helm.$ext"
  rm -rf "$BIN/helm-unpack"; mkdir -p "$BIN/helm-unpack"
  if [ "$ext" = zip ]; then unzip -q -o "$BIN/helm.$ext" -d "$BIN/helm-unpack"; else tar -xzf "$BIN/helm.$ext" -C "$BIN/helm-unpack"; fi
  mv "$BIN/helm-unpack/$OS-$ARCH/helm$EXE" "$HELM"; rm -rf "$BIN/helm-unpack" "$BIN/helm.$ext"; chmod +x "$HELM"
fi
if [ ! -x "$KUBECTL" ]; then
  fetch_verified "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$OS/$ARCH/kubectl$EXE" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$OS/$ARCH/kubectl$EXE.sha256" "$KUBECTL"
  chmod +x "$KUBECTL"
fi
kind() { "$KIND" "$@"; }; helm() { "$HELM" "$@"; }; kubectl() { "$KUBECTL" "$@"; }
echo "  kind $KIND_VERSION, helm $HELM_VERSION, kubectl $KUBECTL_VERSION, node image $KIND_NODE_IMAGE"
command -v node >/dev/null || die "node (>= 22) is required for the protocol checks"

PF_PIDS=()
# Stops the port-forwards. Git Bash: `kill` only ends the MSYS stub of a native
# kubectl.exe, so the Windows process is ended via its winpid as well.
stop_port_forwards() {
  local p w
  for p in "${PF_PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    w="$(cat "/proc/$p/winpid" 2>/dev/null || true)"
    kill "$p" 2>/dev/null
    [ -n "$w" ] && command -v taskkill >/dev/null && taskkill //F //PID "$w" >/dev/null 2>&1
  done
  PF_PIDS=()
}
cleanup() {
  stop_port_forwards
  if [ "${KEEP:-0}" = 1 ]; then echo "KEEP=1: cluster $CLUSTER and image $IMAGE kept (KUBECONFIG=$KUBECONFIG)"; return; fi
  step "cleanup"
  kind delete cluster --name "$CLUSTER" 2>&1 | tail -1
  if [ "${SKIP_BUILD:-0}" != 1 ] && docker image rm "$IMAGE" >/dev/null 2>&1; then echo "  removed image $IMAGE"; fi
}
trap cleanup EXIT

# ── 2. Cluster ────────────────────────────────────────────────────────────────
step "cluster"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "  reusing existing cluster $CLUSTER"; kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null
else
  kind create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$KUBECONFIG" --wait 180s || die "kind create cluster"
fi
kubectl get nodes -o wide

# ── 3. Image ──────────────────────────────────────────────────────────────────
step "image"
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  docker build -f infra/docker/Dockerfile.app -t "$IMAGE" . > "$LOGS/build.log" 2>&1 || { tail -30 "$LOGS/build.log"; die "docker build (log: $LOGS/build.log)"; }
  echo "  built $IMAGE"
fi
kind load docker-image "$IMAGE" --name "$CLUSTER" >/dev/null || die "kind load docker-image"
echo "  loaded $IMAGE into $CLUSTER"

# ── 4. Install ────────────────────────────────────────────────────────────────
step "install"
kubectl delete namespace "$NS" --ignore-not-found --wait >/dev/null
kubectl create namespace "$NS" >/dev/null
kubectl label namespace "$NS" pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted pod-security.kubernetes.io/audit=restricted >/dev/null
SECRETS="$DIR/secrets.yaml"
( umask 077; cat > "$SECRETS" <<EOF
secrets:
  jwtSecret: "$(openssl rand -hex 32)"
  pepper: "$(openssl rand -hex 32)"
  mfaEncryptionKey: "$(openssl rand -hex 32)"
  backupEncryptionKey: "$(openssl rand -hex 32)"
  rspamdControllerPassword: "$(openssl rand -hex 20)"
  postgresPassword: "$(openssl rand -hex 20)"
  redisPassword: "$(openssl rand -hex 20)"
  minioRootPassword: "$(openssl rand -hex 20)"
EOF
)
VALUES=(-f infra/k8s/ci/kind-values.yaml -f "$SECRETS" --set "app.image.repository=${IMAGE%:*}" --set "app.image.tag=${IMAGE##*:}")
[ "${CLAMAV:-1}" = 0 ] && VALUES+=(--set clamav.enabled=false)
if helm install "$REL" infra/k8s -n "$NS" "${VALUES[@]}" --wait --timeout 20m > "$LOGS/install.log" 2>&1; then
  pass "helm install --wait"
else
  fail "helm install --wait (log: $LOGS/install.log)"; tail -20 "$LOGS/install.log"
  kubectl -n "$NS" get pods; kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -30
  exit 1
fi
if grep -qi "violate PodSecurity" "$LOGS/install.log"; then fail "PodSecurity warnings during install"; grep -i "PodSecurity" "$LOGS/install.log"; fi

# ── 5. Verify ─────────────────────────────────────────────────────────────────
step "verify"
app_pod() { kubectl -n "$NS" get pod -l app.kubernetes.io/instance=$REL,app.kubernetes.io/component=app -o jsonpath='{.items[0].metadata.name}'; }

check_pods() {
  if kubectl -n "$NS" wait pod --all --for=condition=Ready --timeout=300s >/dev/null; then
    pass "all pods Ready: $(kubectl -n "$NS" get pods --no-headers | awk '{printf "%s(%s) ", $1, $2}')"
  else fail "pods not Ready"; kubectl -n "$NS" get pods; fi
}
check_pods

# Pod Security "restricted": every pod was admitted under enforce=restricted. In
# addition, a server-side dry-run that pins enforce-version to the server version
# re-evaluates all running pods (an unchanged label would not) and reports
# violations as warnings.
minor="$(kubectl version -o json | tr -d ' \n' | grep -o '"serverVersion":{[^}]*' | grep -o '"minor":"[0-9]*' | grep -o '[0-9]*$')"
[ -n "$minor" ] || minor=0
warn="$(kubectl label --dry-run=server --overwrite namespace "$NS" "pod-security.kubernetes.io/enforce-version=v1.$minor" 2>&1 >/dev/null)"
if [ -z "$warn" ] && [ "$(kubectl get ns "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')" = restricted ]; then
  pass "Pod Security restricted: all pods admitted under enforce, re-evaluation against restricted:v1.$minor clean"
else fail "Pod Security restricted: $warn"; fi

POD="$(app_pod)"
sync_log="$(kubectl -n "$NS" logs "$POD" -c schema-sync 2>&1)"
sync_exit="$(kubectl -n "$NS" get pod "$POD" -o jsonpath='{.status.initContainerStatuses[?(@.name=="schema-sync")].state.terminated.exitCode}')"
if [ "$sync_exit" = 0 ] && grep -q "Schema applied" <<<"$sync_log"; then
  pass "schema-sync init container: $(grep 'Schema applied' <<<"$sync_log" | tail -1)"
else fail "schema-sync init container (exit ${sync_exit:-?}): $(tail -5 <<<"$sync_log")"; fi

# NetworkPolicies: the app reaches its datastores …
targets="${REL}-postgresql:5432 ${REL}-redis:6379 ${REL}-minio:9000 ${REL}-rspamd:11334"
[ "${CLAMAV:-1}" = 0 ] || targets="$targets ${REL}-clamav:3310"
out="$(kubectl -n "$NS" exec "$POD" -c coremail -- sh -c "for hp in $targets; do nc -z -w3 \${hp%:*} \${hp#*:} >/dev/null 2>&1 && echo OPEN \$hp || echo BLOCKED \$hp; done; curl -s -m5 http://${REL}-rspamd:11334/ping" 2>&1)"
if ! grep -q BLOCKED <<<"$out" && grep -q pong <<<"$out"; then pass "NetworkPolicy: app → $(grep -c OPEN <<<"$out") datastores open, rspamd /ping = pong"
else fail "NetworkPolicy: app → datastores: $(tr '\n' ' ' <<<"$out")"; fi
# … a foreign pod (restricted-compliant, not labelled as the app) does not, but sees the mail ports.
probe_targets="$targets ${REL}:3000 ${REL}-mail:25 ${REL}-mail:587 ${REL}-mail:143"
probe_cmd="for hp in $probe_targets; do nc -z -w3 \${hp%:*} \${hp#*:} >/dev/null 2>&1 && echo OPEN \$hp || echo BLOCKED \$hp; done"
overrides=$(cat <<EOF
{"apiVersion":"v1","spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},
 "containers":[{"name":"np-probe","image":"$IMAGE","imagePullPolicy":"Never","command":["sh","-c","$probe_cmd"],
 "securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}}]}}
EOF
)
out="$(kubectl -n "$NS" run np-probe --rm -i --restart=Never --quiet --image="$IMAGE" --overrides="$overrides" 2>/dev/null)"
want_blocked="$(wc -w <<<"$targets ${REL}:3000")"
if [ "$(grep -c '^BLOCKED' <<<"$out")" -eq "$want_blocked" ] && [ "$(grep -c "^OPEN ${REL}-mail" <<<"$out")" -eq 3 ]; then
  pass "NetworkPolicy: foreign pod blocked from datastores + :3000, mail ports open"
else fail "NetworkPolicy: foreign pod: $(tr '\n' ' ' <<<"$out")"; fi

# Port-forwards (port-forward bypasses NetworkPolicies). A Service port-forward
# sticks to the pod it picked, so it is restarted after every rollout — on fresh
# local ports (offset 0/100/200), so a forward to the old pod can never answer.
PF_ROUND=0
start_port_forwards() {
  stop_port_forwards
  local o=$((PF_ROUND * 100)); PF_ROUND=$((PF_ROUND + 1))
  HTTP_PORT=$((18080 + o)); P_SMTP=$((12525 + o)); P_SUB=$((12587 + o)); P_SMTPS=$((12465 + o))
  P_IMAP=$((12143 + o)); P_IMAPS=$((12993 + o)); P_POP3=$((12110 + o)); P_POP3S=$((12995 + o))
  kubectl -n "$NS" port-forward "svc/$REL" "$HTTP_PORT:3000" > "$LOGS/pf-http.log" 2>&1 & PF_PIDS+=($!)
  kubectl -n "$NS" port-forward "svc/$REL-mail" "$P_SMTP:25" "$P_SUB:587" "$P_SMTPS:465" "$P_IMAP:143" "$P_IMAPS:993" \
    "$P_POP3:110" "$P_POP3S:995" > "$LOGS/pf-mail.log" 2>&1 & PF_PIDS+=($!)
  for _ in $(seq 1 30); do
    curl -fsS -m 3 "http://127.0.0.1:$HTTP_PORT/livez" >/dev/null 2>&1 && grep -q "$P_POP3S" "$LOGS/pf-mail.log" && return 0
    sleep 1
  done
  echo "  port-forward did not come up"; cat "$LOGS"/pf-*.log
}
check_healthz() {
  local h; h="$(curl -sS -m 10 "http://127.0.0.1:$HTTP_PORT/healthz")"
  if grep -q '"ok":true' <<<"$h" && grep -q '"status":"ok"' <<<"$h"; then pass "/healthz $1: $h"; else fail "/healthz $1: $h"; fi
}
start_port_forwards
check_healthz "(install)"

# Protocol checks (setup token flow, banners, SMTP submission → IMAP) with the
# helpers of scripts/e2e/lib.mjs pointed at the port-forwards.
SMOKE="$DIR/k8s-smoke.mjs"
cat > "$SMOKE" <<'EOF'
import { pathToFileURL } from 'node:url';
const lib = await import(pathToFileURL(process.env.E2E_LIB).href);
const { check, assert, http, creds, DOMAIN, PORTS, smtpOpen, smtpStartTls, smtpAuthPlain, smtpSend, imapOpen, imapCmd, imapQuote, popCmd, LineClient, buildMime, flushResults, loadState, saveState } = lib;
const mode = process.argv[2];
const state = loadState();
const c = creds();

async function login(email, password) {
  const r = await http('POST', '/auth/login', { body: { email, password } });
  assert(r.status === 200 && r.json?.accessToken, `login ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.accessToken;
}
async function imapFind(user, pass, subject) {
  const s = await imapOpen(PORTS.imap);
  try {
    const st = await imapCmd(s, 'STARTTLS'); assert(st.status === 'OK', `STARTTLS ${st.text}`);
    await s.startTls();
    const l = await imapCmd(s, `LOGIN ${imapQuote(user)} ${imapQuote(pass)}`); assert(l.status === 'OK', `LOGIN ${l.text}`);
    await imapCmd(s, 'SELECT INBOX');
    const x = await imapCmd(s, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
    const uids = (x.lines.find((ln) => ln.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
    assert(uids.length === 1, `UID SEARCH found ${uids.length} messages`);
    const f = await imapCmd(s, `UID FETCH ${uids[0]} (BODY.PEEK[])`);
    const body = f.literals[0]?.toString('latin1') ?? '';
    assert(body.includes(state.marker), 'body marker missing');
    return `UID ${uids[0]}, ${body.length} bytes`;
  } finally { s.close(); }
}

if (mode === 'install') {
  await check('banners: SMTP 25/587/465, IMAP 143/993, POP3 110/995 through the mail Service', async () => {
    const out = [];
    for (const [name, port, tlsOn] of [['smtp', PORTS.smtp], ['submission', PORTS.submission], ['smtps', PORTS.smtps, true]]) {
      const s = await smtpOpen(port, { implicitTls: !!tlsOn }); out.push(`${name}=220`); s.close();
    }
    for (const [name, port, tlsOn] of [['imap', PORTS.imap], ['imaps', PORTS.imaps, true]]) {
      const s = await imapOpen(port, { implicitTls: !!tlsOn }); assert(s.greeting.startsWith('* OK'), `${name}: ${s.greeting}`); out.push(`${name}=OK`); s.close();
    }
    for (const [name, port, tlsOn] of [['pop3', PORTS.pop3], ['pop3s', PORTS.pop3s, true]]) {
      const s = await LineClient.connect(port, { implicitTls: !!tlsOn }); const g = await popCmd(s, null); assert(g.ok, `${name}: ${g.text}`); out.push(`${name}=+OK`); s.close();
    }
    return out.join(' ');
  });

  state.adminEmail = `admin@${DOMAIN}`;
  const body = { domain: DOMAIN, email: state.adminEmail, password: c.admin };
  await check('setup: status requires a token', async () => {
    const r = await http('GET', '/api/v1/setup/status');
    assert(r.json?.setupRequired === true && r.json?.setupTokenRequired === true, JSON.stringify(r.json));
  });
  await check('setup: refused without token (403)', async () => {
    const r = await http('POST', '/api/v1/setup/complete', { body, retry429: false });
    assert(r.status === 403, `${r.status} ${r.text}`); return `403 ${r.json?.code ?? ''}`;
  });
  await check('setup: completes with the token from the pod log', async () => {
    assert(process.env.SETUP_TOKEN, 'no setup token in the pod log');
    const r = await http('POST', '/api/v1/setup/complete', { body: { ...body, setupToken: process.env.SETUP_TOKEN }, retry429: false });
    assert(r.status === 200 || r.status === 201, `${r.status} ${r.text}`); return `${r.status}`;
  });
  await check('setup: cannot be repeated', async () => {
    const r = await http('POST', '/api/v1/setup/complete', { body: { ...body, setupToken: process.env.SETUP_TOKEN }, retry429: false });
    assert(r.status === 409 || r.status === 403, `${r.status}`); return `${r.status}`;
  });

  const admin = await login(state.adminEmail, c.admin);
  const doms = await http('GET', '/api/v1/admin/domains', { token: admin });
  const domainId = doms.json?.domains?.find((d) => d.name === DOMAIN)?.id;
  for (const [key, local, pw] of [['a', 'alice', c.userA], ['b', 'bob', c.userB]]) {
    await check(`users: create ${local}@${DOMAIN}`, async () => {
      const r = await http('POST', '/api/v1/admin/mailboxes', { token: admin, body: { email: `${local}@${DOMAIN}`, displayName: local, password: pw, role: 'USER', domainId } });
      assert(r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
      state[key] = `${local}@${DOMAIN}`;
    });
  }

  state.subject = `k8s-e2e ${Date.now()}`;
  state.marker = `marker-${Math.random().toString(36).slice(2)}`;
  await check('smtp587: STARTTLS + AUTH, send alice → bob', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      await smtpStartTls(s);
      const a = await smtpAuthPlain(s, state.a, c.userA); assert(a.code === 235, `AUTH ${a.text}`);
      const r = await smtpSend(s, state.a, [state.b], buildMime({ from: state.a, to: state.b, subject: state.subject, text: `Hello from Kubernetes\r\n${state.marker}\r\n` }));
      assert(r.code === 250, `${r.stage}: ${r.text}`); return r.text.split('\n').at(-1);
    } finally { s.close(); }
  });
  await check('imap143: STARTTLS + LOGIN as bob, message delivered', async () => {
    let last;
    for (let i = 0; i < 30; i++) {
      try { return await imapFind(state.b, c.userB, state.subject); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    throw last;
  });
} else {
  await check(`imap after ${mode}: message still readable (object PVC + database kept)`, async () => imapFind(state.b, c.userB, state.subject));
  await check(`login after ${mode}: admin session`, async () => { await login(state.adminEmail, c.admin); return 'ok'; });
}
saveState(state);
process.exit(flushResults(`k8s-${mode}`) ? 1 : 0);
EOF
smoke() {
  local out rc
  out="$(E2E_LIB="$ROOT/scripts/e2e/lib.mjs" E2E_STATE_DIR="$DIR/state" E2E_HOST=127.0.0.1 E2E_HTTP_PORT=$HTTP_PORT \
    E2E_SMTP_PORT=$P_SMTP E2E_SUBMISSION_PORT=$P_SUB E2E_SMTPS_PORT=$P_SMTPS E2E_IMAP_PORT=$P_IMAP E2E_IMAPS_PORT=$P_IMAPS \
    E2E_POP3_PORT=$P_POP3 E2E_POP3S_PORT=$P_POP3S E2E_DOMAIN=k8s-e2e.test SETUP_TOKEN="${SETUP_TOKEN:-}" node "$SMOKE" "$1" 2>&1)"; rc=$?
  echo "$out" | grep -E '^\[(PASS|FAIL)\]' | sed 's/^/  /'
  passes=$((passes + $(grep -c '^\[PASS\]' <<<"$out"))); fails=$((fails + $(grep -c '^\[FAIL\]' <<<"$out")))
  [ "$rc" -eq 0 ] || { [ "$(grep -c '^\[FAIL\]' <<<"$out")" -gt 0 ] || { fail "smoke $1 aborted"; echo "$out" | tail -20; }; }
}
rm -rf "$DIR/state"
SETUP_TOKEN="$(kubectl -n "$NS" logs "$POD" -c coremail | grep -o '"setupToken":"[A-Za-z0-9_-]*"' | tail -1 | cut -d'"' -f4)"
smoke install

# ── 6. Upgrade with a changed value ───────────────────────────────────────────
step "upgrade"
if helm upgrade "$REL" infra/k8s -n "$NS" "${VALUES[@]}" --set app.logLevel=debug --wait --timeout 15m > "$LOGS/upgrade.log" 2>&1; then
  NEW_POD="$(app_pod)"
  lvl="$(kubectl -n "$NS" get cm "$REL" -o jsonpath='{.data.LOG_LEVEL}')"
  if [ "$lvl" = debug ] && [ "$NEW_POD" != "$POD" ]; then pass "helm upgrade: LOG_LEVEL=debug, pod rolled ($POD → $NEW_POD)"
  else fail "helm upgrade: LOG_LEVEL=$lvl, pod $POD → $NEW_POD"; fi
else fail "helm upgrade (log: $LOGS/upgrade.log)"; tail -20 "$LOGS/upgrade.log"; fi
check_pods
start_port_forwards
check_healthz "(after upgrade)"
smoke upgrade

# ── 7. Rollback ───────────────────────────────────────────────────────────────
step "rollback"
if helm rollback "$REL" 1 -n "$NS" --wait --timeout 15m > "$LOGS/rollback.log" 2>&1; then
  lvl="$(kubectl -n "$NS" get cm "$REL" -o jsonpath='{.data.LOG_LEVEL}')"
  rev="$(helm history "$REL" -n "$NS" --max 1 -o json | grep -o '"revision":[0-9]*' | cut -d: -f2)"
  if [ "$lvl" = info ] && [ "$rev" = 3 ]; then pass "helm rollback: revision 3 = revision 1, LOG_LEVEL=info"
  else fail "helm rollback: revision $rev, LOG_LEVEL=$lvl"; fi
else fail "helm rollback (log: $LOGS/rollback.log)"; tail -20 "$LOGS/rollback.log"; fi
check_pods
start_port_forwards
check_healthz "(after rollback)"
smoke rollback

kubectl -n "$NS" logs "$(app_pod)" -c coremail > "$LOGS/app.log" 2>&1
echo
echo "k8s-e2e: $passes passed, $fails failed (logs: $LOGS)"
[ "$fails" -eq 0 ]
