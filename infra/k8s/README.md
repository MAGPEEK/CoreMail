# CoreMail Helm chart

Deploys CoreMail (default: 7.0.0) on Kubernetes the same way as the reference
Docker Compose setup (`infra/docker/docker-compose.yml`): **one app pod**
running `magpeek/coremail-app` (all services under supervisord), plus
PostgreSQL, Redis (with authentication), MinIO (`pgsty/minio`, pinned by digest),
rspamd and ClamAV. Each dependency is either bundled (a single-replica StatefulSet
with a PVC) or an external endpoint.

| | |
|---|---|
| Chart version | `1.0.0` (independent SemVer of the chart; 1.0.0 = complete rewrite) |
| App version | `7.0.0` → image `magpeek/coremail-app:7.0.0` |
| Kubernetes | ≥ 1.25 |
| Chart dependencies | none (installs without access to third-party chart repositories) |

## Install

```bash
kubectl create namespace coremail

# Secrets — recommended: your own Secret (SealedSecrets, External Secrets, SOPS …)
kubectl -n coremail create secret generic coremail-credentials \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=PEPPER="$(openssl rand -hex 32)" \
  --from-literal=MFA_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 20)" \
  --from-literal=REDIS_PASSWORD="$(openssl rand -hex 20)" \
  --from-literal=MINIO_ROOT_USER=coremail \
  --from-literal=MINIO_ROOT_PASSWORD="$(openssl rand -hex 20)"

helm install coremail infra/k8s -n coremail \
  --set secrets.existingSecret=coremail-credentials \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=mail.example.com \
  --set ingress.certManager.enabled=true \
  --set ingress.certManager.issuer=letsencrypt-prod \
  --set app.publicUrl=https://mail.example.com
```

Then:

1. `kubectl -n coremail rollout status deploy/coremail` (first start applies the schema, 1–2 min).
2. Setup token: `kubectl -n coremail logs deploy/coremail -c coremail | grep -i "setup token"`
   (or set `SETUP_TOKEN` in the Secret).
3. Open `https://mail.example.com/bcp/` → setup wizard (admin account + domain).
4. `kubectl -n coremail get svc coremail-mail` → point MX/A records at the external IP.
5. Mail-protocol certificates (SMTP/IMAP/POP3 TLS) are managed **inside CoreMail**:
   BCP → SSL/TLS, or
   `kubectl -n coremail exec -it deploy/coremail -c coremail -- coremail cert letsencrypt --domains mail.example.com --email admin@example.com --services SMTP,IMAP,POP3`.
   The HTTP-01 challenge reaches the app through the Ingress. The Ingress
   certificate (cert-manager) is separate and only covers HTTPS.

Without an Ingress: `kubectl -n coremail port-forward svc/coremail 3000:3000`, or
expose HTTP/HTTPS on the mail LoadBalancer (`mailService.ports.http/https.enabled`,
integrated TLS proxy on 443).

Instead of `existingSecret` you can pass `secrets.jwtSecret`, `secrets.pepper`, …
as values. **Quote them** (or use `--set-string`): a digits-only value would be
parsed as a number, and the chart refuses that.

## What gets deployed

| Object | Purpose |
|---|---|
| Deployment `<release>` | app pod: init container `schema-sync` + container `coremail` |
| Service `<release>` (ClusterIP :3000) | HTTP backend of the Ingress |
| Service `<release>-mail` (LoadBalancer) | 25, 465, 587, 143, 993, 110, 995 (+ optional 80→3000, 443) |
| Ingress `<release>` | webmail, admin panel, REST, JMAP (incl. WebSocket), ActiveSync, CalDAV/CardDAV, Autodiscover |
| ConfigMap / Secret `<release>` | environment (non-secret / secret) |
| StatefulSets `<release>-postgresql`, `-redis`, `-minio`, `-rspamd`, `-clamav` | bundled dependencies (each optional) |
| NetworkPolicies | see [Security](#security) |
| PVC `<release>-objects` | only with `objectStorage.driver=filesystem` (kept on uninstall) |

The app itself needs **no PVC**: all state lives in PostgreSQL (metadata,
settings, certificates), MinIO (message bodies, attachments, quarantine,
backups) and Redis (sessions, queues, lockouts). Writable paths are emptyDirs:
`/tmp` (backup/export temp files, `app.tmpSizeLimit`), supervisord's log/run
directories and `$HOME` (CLI credentials).

## Values

All values are documented in [`values.yaml`](values.yaml). The important ones:

| Value | Default | Notes |
|---|---|---|
| `secrets.existingSecret` | `""` | Secret with the keys listed in `values.yaml`; otherwise `secrets.*` |
| `secrets.jwtSecret`, `.pepper` | — | required, ≥ 32 chars. **Never change `PEPPER`** after the first start |
| `secrets.postgresPassword`, `.redisPassword` | — | required, URL-safe (`[A-Za-z0-9._~-]`) — embedded in `DATABASE_URL`/`REDIS_URL` |
| `secrets.minioRootUser`, `.minioRootPassword` | `coremail`, — | required when MinIO/S3 is used |
| `secrets.mfaEncryptionKey` | `""` | 64 hex; strongly recommended (TOTP secrets survive JWT/PEPPER rotation) |
| `secrets.setupToken` | `""` | ≥ 16 chars; required for `app.replicaCount > 1` |
| `app.image.tag` / `.digest` | appVersion / `""` | digest pins the image |
| `app.replicaCount` | `1` | see [Replicas](#replicas) |
| `app.strategy.type` | `Recreate` | never two pods with schedulers during upgrades |
| `app.trustProxy` | `auto` | see [TRUST_PROXY](#trust_proxy) |
| `app.publicUrl` | `""` | `COREMAIL_PUBLIC_URL` (SSO redirect URIs) |
| `app.webauthn.*`, `app.vapid.*`, `app.jmapCorsOrigins`, `app.ldapAllowInsecure` | | map to `WEBAUTHN_*`, `VAPID_*`, `JMAP_CORS_ORIGINS`, `LDAP_ALLOW_INSECURE` |
| `app.mailAuth.*` | app defaults | `MAIL_AUTH_*` brute-force limits |
| `app.extraEnv`, `.extraVolumes`, `.extraVolumeMounts` | `[]` | e.g. a GeoIP database (`GEOIP_DB_PATH`) |
| `mailService.type` | `LoadBalancer` | or `NodePort` |
| `mailService.externalTrafficPolicy` | `Local` | keep `Local`, see [Client IPs](#client-ips) |
| `mailService.ports.<name>.enabled` | mail ports on, `http`/`https` off | e.g. disable POP3 |
| `ingress.enabled`, `.host`, `.extraHosts`, `.className` | off | `host` required when enabled |
| `ingress.certManager.enabled`, `.issuer`, `.issuerKind` | off | adds `cert-manager.io/(cluster-)issuer` |
| `networkPolicy.enabled` | `true` | |
| `networkPolicy.httpFrom` | namespace `ingress-nginx` | who may reach port 3000 — adjust to your controller |
| `objectStorage.driver` | `minio` | `minio` \| `s3` \| `filesystem` (≥ 7.1.0), see [Object storage](#object-storage) |
| `<dep>.enabled` | `true` | `postgresql`, `redis`, `minio`, `rspamd`, `clamav` |
| `<dep>.external.*` | | endpoint when `enabled: false` |
| `<dep>.persistence.*` | enabled | size / storageClass of the bundled StatefulSets |

### External dependencies

```yaml
postgresql:
  enabled: false
  external: { host: pg.internal, port: 5432, database: coremail, username: coremail, params: "sslmode=require" }
redis:
  enabled: false
  external: { host: redis.internal, port: 6379, tls: true }   # password = REDIS_PASSWORD, auth mandatory
minio:
  enabled: false
  external: { host: s3.internal, port: 9000 }                  # credentials = MINIO_ROOT_USER/PASSWORD
rspamd:
  enabled: false
  external: { host: rspamd.internal, port: 11333, controllerPort: 11334 }
clamav:
  enabled: false
  external: { host: clamav.internal, port: 3310 }
```

An external PostgreSQL should get the extensions/search configuration from
`files/postgres-init.sql` (same as `infra/docker/postgres/init.sql`). With
`rspamd`/`clamav` disabled and no external host, switch the filters off in
BCP → Security. The bundled rspamd controller accepts unauthenticated API calls
from `rspamd.secureIp` (must contain the pod network); the NetworkPolicy limits
the port to the app pod.

### Object storage

CoreMail 7.1.0 adds a storage driver abstraction; the chart passes the variables
through (7.0.0 ignores them and always uses MinIO/S3 over HTTP):

| Value | Env |
|---|---|
| `objectStorage.driver` | `OBJECT_STORAGE` (`minio` default, `s3`, `filesystem`) |
| `objectStorage.useSSL` | `MINIO_USE_SSL` (also switches `S3_ENDPOINT` to https) |
| `objectStorage.region` | `MINIO_REGION`, `S3_REGION` |
| `objectStorage.caFile.configMap` / `.secret` + `.key` | mounted at `/etc/coremail/storage-ca/<key>` → `MINIO_CA_FILE` |
| `objectStorage.filesystem.path` | `STORAGE_PATH` (default `/data/objects`) |

`filesystem` stores objects on a PVC (`<release>-objects`, or
`objectStorage.filesystem.existingClaim`) mounted into the app pod. It requires
`app.replicaCount: 1` and, for a ReadWriteOnce volume, `app.strategy.type:
Recreate` (the chart refuses other combinations). Set `minio.enabled: false` if
you do not want MinIO at all — note that backups (`BACKUP_BUCKET`) then have no
S3 target unless `minio.external` is configured.

## Security

- **Pod Security Standard `restricted`** compatible: every pod runs as non-root
  (app uid 1000, postgres 70, redis 999, minio 1000, rspamd 11333, clamav 100),
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, all
  capabilities dropped, `seccompProfile: RuntimeDefault`. The namespace can be
  labelled `pod-security.kubernetes.io/enforce=restricted`.
- **App capabilities:** only `NET_BIND_SERVICE` is added (the only addition
  `restricted` allows). The image sets the file capability `cap_net_bind_service`
  on `/usr/local/bin/node` for ports 25/110/143/443/465/587/993/995; if the
  capability is missing from the bounding set, exec of `node` fails with
  "Operation not permitted". supervisord runs directly as uid 1000 (no setuid
  needed, no `SETUID`/`SETGID` capabilities).
- **No image entrypoint:** `entrypoint-app.sh` calls `pnpm` through corepack,
  which needs a writable `$HOME` and registry access when not root. The chart runs
  the same two steps (wait for PostgreSQL, `prisma db push --accept-data-loss`
  with retries) in the `schema-sync` init container with the Prisma CLI
  directly, then starts `tini → supervisord`. Keep this in mind if
  `entrypoint-app.sh` gains new steps.
- **ClamAV** is started with the same steps as the image's `/init`, minus the
  `chown` of the database volume (fails as non-root on a PVC).
- **Redis requires a password**; it is passed on stdin (not in argv), probes use
  `REDISCLI_AUTH`.
- **Secrets** only in a Secret (or your `existingSecret`), referenced via
  `secretKeyRef`; `DATABASE_URL`/`REDIS_URL` are assembled by the kubelet
  (`$(POSTGRES_PASSWORD)`), so they never appear in the ConfigMap.
- **No Kubernetes API access:** `automountServiceAccountToken: false`,
  `enableServiceLinks: false`.
- **NetworkPolicies** (`networkPolicy.enabled`, default on):
  - app — ingress only on the enabled mail ports (any source), 443 when
    `mailService.ports.https` is on, and 3000 from `networkPolicy.httpFrom`
    (any source when `mailService.ports.http` is on). Egress open: outbound
    SMTP to any MX, DNS, ACME, DNSBL, LDAP/OIDC, external datastores.
  - postgresql / redis / minio — ingress only from the app pod on their port,
    **no egress**.
  - rspamd / clamav — ingress only from the app pod; egress DNS plus
    HTTP/HTTPS (and UDP 11335 fuzzy) to the internet with
    `networkPolicy.internetExcept` (cluster-private ranges) excluded.
  The policies need a CNI that enforces them (Calico, Cilium, …).
- **Fail-fast validation** at `helm install/upgrade/template`: missing or too short
  secrets, non-URL-safe passwords, invalid `MFA_ENCRYPTION_KEY`/`SETUP_TOKEN`,
  numeric secrets, `ingress.host`, replicas vs. setup token / filesystem storage.

### Internal services

All internal services (auth 3003, security-filter 3002, backup 3004, ActiveSync
3005, JMAP 3006, Autodiscover 8081, CalDAV 8082) run in the same container and
are reached over loopback. `INTERNAL_BIND_HOST` stays `127.0.0.1` and no
`INTERNAL_API_TOKEN` is needed; the chart publishes no internal port between
pods (even with several replicas each pod is self-contained).

### TRUST_PROXY

Port 3000 honours `X-Forwarded-For` only when `TRUST_PROXY` is set. With
`app.trustProxy: auto` (default) the chart sets `TRUST_PROXY=1` (trust exactly
the ingress controller hop) only when all of these hold — i.e. only the ingress
controller can reach port 3000:

- `ingress.enabled: true`
- `networkPolicy.enabled: true` and `networkPolicy.httpFrom` is non-empty
- `mailService.ports.http.enabled: false`

Otherwise it stays off (clients could spoof their IP via `X-Forwarded-For`).
Set an explicit value (`"1"`, a CIDR, `""`) to override. Make sure your ingress
controller itself sees real client IPs (e.g. ingress-nginx Service with
`externalTrafficPolicy: Local` or PROXY protocol) — otherwise rate limits apply
to the controller's view of the client. The integrated HTTPS proxy (443) never
honours forwarded headers.

### Client IPs

CoreMail needs the real client IP on the mail ports: SPF and DMARC evaluation,
DNSBL, GeoIP country filter, greylisting triples and the per-IP brute-force
lockout (`MAIL_AUTH_*`) all use it. `mailService.externalTrafficPolicy: Local`
preserves it (traffic goes only to nodes that run the pod; the cloud LB health
check handles that). With `Cluster`, all clients appear as node IPs — SPF fails,
DNSBL checks the wrong address, and because private addresses are exempt from
per-IP lockouts by default, brute-force protection falls back to the per-account
counter only (`app.mailAuth.limitPrivateIps: true` would instead lock out
everybody at once). CoreMail does not speak PROXY protocol on the mail ports.

### Replicas

`app.replicaCount: 1` is the supported default. What is coordinated across pods:
the outbound queue (BullMQ), per-IP/per-account lockouts, sessions, SSE fan-out,
the certificate renewal scheduler (Redis scheduler lock + per-certificate lock),
LDAP sync, auto-reply and dead-letter throttles (Redis `SET NX`). What is **not**:
the backup scheduler and the retention worker (Managed Folder Assistant) run in
every pod (duplicate backups/retention runs), the JMAP Basic-auth cache is per
pod, and without a fixed `SETUP_TOKEN` every pod prints its own token (the chart
refuses `replicaCount > 1` without `secrets.setupToken` unless `existingSecret`
is used — then set `SETUP_TOKEN` there). `filesystem` object storage is limited
to one replica.

## Upgrading

### From the old chart (0.6.0, per-service images)

The old chart cannot be upgraded in place — it deployed per-service images
(`ghcr.io/magpeek/coremail/<service>:0.6.0`, incl. the removed `ews-server`,
`storage-api`, OTEL settings), CloudNativePG, the Bitnami Redis subchart without
auth and a 4-node MinIO. Migrate like this:

1. Back up: `pg_dump` of the CNPG database and a mirror of the MinIO buckets
   (`mc mirror`).
2. `helm uninstall` the old release (the old chart also created the Namespace
   object itself — this chart does not; create the namespace yourself).
3. Install this chart (new Secret: `PEPPER` must be the **same value** as before,
   otherwise every password hash becomes invalid; add `REDIS_PASSWORD`,
   `MINIO_ROOT_USER`, `MFA_ENCRYPTION_KEY`).
4. Restore the dump into the new PostgreSQL (or point `postgresql.external` at the
   existing CNPG cluster: host `<name>-rw`, database/user from the old values,
   `postgresql.enabled=false`), mirror the buckets back into MinIO (`minio.bucket`,
   `minio.backupBucket`), then restart the app pod — the schema sync upgrades the
   schema (destructive changes are applied with `--accept-data-loss`, like in Docker).
5. Read the CoreMail 7.0.0 upgrade notes in `CHANGELOG.md` (app passwords for MFA
   users, STARTTLS-only auth, `TRUST_PROXY`, setup token, EWS removal).

Removed values: `global.*`, `services.*` (per-service deployments, HPAs),
`defaultResources`, `defaultHpa`, `cnpg.*`, the Bitnami `redis.*` subchart
values, `secrets.smtpRelayPassword` (smarthost credentials live in the BCP).

### Chart upgrades

`helm upgrade` with `strategy: Recreate` stops the old pod before the new one
starts (short downtime; sending MTAs retry). Changes to the ConfigMap or the
chart-managed Secret roll the pod automatically (checksum annotations); with
`existingSecret` restart it yourself (`kubectl rollout restart deploy/<release>`).
PVCs of the StatefulSets and the `objects` PVC are kept on `helm uninstall`.
Changing `POSTGRES_PASSWORD` later does not change the password inside an
existing database — alter it in PostgreSQL first.

## Validation

```bash
bash scripts/helm-check.sh
```

Runs, via Docker only (pinned `alpine/helm:3.16.4` and
`ghcr.io/yannh/kubeconform:v0.6.7`): `helm lint --strict` and `helm template`
for every `ci/*-values.yaml` (bundled + Ingress/cert-manager; external datastores
+ existing Secret + LB HTTP/HTTPS + S3 with TLS/CA; filesystem storage + NodePort),
kubeconform `-strict` on the rendered manifests (Kubernetes 1.30 schemas,
override with `KUBE_VERSION`), and a negative test that rendering without the
required secrets fails. Rendered output: `infra/k8s/.rendered/` (git-ignored).

The bundled files `files/postgres-init.sql` and `files/rspamd/actions.conf`
mirror `infra/docker/postgres/init.sql` and `infra/docker/rspamd/local.d/actions.conf`
(Helm cannot read files outside the chart) — keep them in sync.
