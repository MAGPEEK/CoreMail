# CoreMail Helm chart

Deploys CoreMail (default: 10.6.1) on Kubernetes the same way as the reference
Docker Compose setup (`infra/docker/docker-compose.yml`): **one app pod**
running `magpeek/coremail-app` (all services under supervisord), plus
PostgreSQL, Redis (with authentication), MinIO (`pgsty/minio`, pinned by digest),
rspamd and ClamAV. Each dependency is either bundled (a single-replica StatefulSet
with a PVC) or an external endpoint.

| | |
|---|---|
| Chart version | `3.6.1` (independent SemVer of the chart; 3.x = CoreMail 10.x, see "Upgrading to chart 3.0"; 2.x = 9.x values) |
| App version | `10.6.1` → image `magpeek/coremail-app:10.6.1` |
| Kubernetes | ≥ 1.25 |
| Chart dependencies | none (installs without access to third-party chart repositories) |

## Install

Quickest (chart 3.4): no secrets at all — the chart generates every empty
`secrets.*` value once and keeps it on upgrade
([Generated secrets](#generated-secrets)):

```bash
helm install coremail infra/k8s -n coremail --create-namespace \
  --set mailService.type=NodePort        # on clusters without a load balancer
# back up the generated Secret right away (the NOTES print the command):
kubectl -n coremail get secret coremail -o yaml > coremail-secrets.yaml
```

With your own Secret and an Ingress:

```bash
kubectl create namespace coremail

# Secrets — recommended: your own Secret (SealedSecrets, External Secrets, SOPS …)
kubectl -n coremail create secret generic coremail-credentials \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=PEPPER="$(openssl rand -hex 32)" \
  --from-literal=MFA_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=RSPAMD_CONTROLLER_PASSWORD="$(openssl rand -hex 20)" \
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

The mail Service defaults to `type: LoadBalancer`. On a cluster without a
load-balancer controller (kind, minikube without `tunnel`, bare metal without
MetalLB) its EXTERNAL-IP stays `<pending>` — and `helm install/upgrade --wait`
then waits for it until the timeout (`context deadline exceeded`). Use
`--set mailService.type=NodePort` there.

Without an Ingress: `kubectl -n coremail port-forward svc/coremail 3000:3000`, or
expose HTTP/HTTPS on the mail LoadBalancer (`mailService.ports.http/https.enabled`,
integrated TLS proxy on 443).

Instead of `existingSecret` you can pass `secrets.jwtSecret`, `secrets.pepper`, …
as values. **Quote them** (or use `--set-string`): a digits-only value would be
parsed as a number, and the chart refuses that.

### Generated secrets

Since chart 3.4 every `secrets.*` value is optional when no `existingSecret` is
set. For each empty value the chart takes, in this order:

1. the value itself (values file, `--set`) — always wins;
2. the key in the release's existing Secret (`lookup`) — every upgrade keeps it;
3. a new random value, only when there is nothing to keep:
   - always: `JWT_SECRET`, `PEPPER` (64 hex), `POSTGRES_PASSWORD`,
     `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD` (when MinIO/S3 is used),
     `RSPAMD_CONTROLLER_PASSWORD` (40 alphanumerics, URL-safe);
   - first install only: `MFA_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` (64 hex). An
     existing release keeps deriving them from `JWT_SECRET` + `PEPPER` — a new MFA
     key would make every enrolled TOTP secret unreadable.

Safety rules:

- **Never regenerated on upgrade.** On `helm upgrade`, an empty `JWT_SECRET`,
  `PEPPER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` or `MINIO_ROOT_PASSWORD` that is
  not in the existing Secret — or a Secret that cannot be read (`--dry-run=client`,
  missing RBAC for `get secrets`) — fails the render instead of producing a new
  value. Use `--dry-run=server` for upgrade previews.
- The generated Secret carries `helm.sh/resource-policy: keep`: `helm uninstall`
  leaves it (like the PVCs it belongs to), and a reinstall with the same release
  name reuses it. Delete it by hand together with the PVCs.
- **GitOps** tools that render with `helm template` (Argo CD, Flux with
  post-renderers, …) cannot look the Secret up and would generate new values on
  every sync. Set the values (or `existingSecret`) there.
- Back the Secret up off the cluster after the first install (the NOTES print
  `kubectl get secret … -o yaml`). Without `PEPPER` no password works.

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
| `secrets.jwtSecret`, `.pepper` | generated | ≥ 32 chars. **Never change `PEPPER`** after the first start ([Generated secrets](#generated-secrets)) |
| `secrets.postgresPassword`, `.redisPassword` | generated | URL-safe (`[A-Za-z0-9._~-]`) — embedded in `DATABASE_URL`/`REDIS_URL` |
| `secrets.minioRootUser`, `.minioRootPassword` | `coremail`, generated | used when MinIO/S3 is used |
| `secrets.mfaEncryptionKey` | generated on install | 64 hex (TOTP secrets survive JWT/PEPPER rotation); an existing release without it keeps deriving it |
| `secrets.backupEncryptionKey` | generated on install | `BACKUP_ENCRYPTION_KEY`: 64 hex or base64 of 32 bytes (unset = derived from `JWT_SECRET` + `PEPPER`). **Keep a copy off the cluster** |
| `secrets.rspamdControllerPassword` | generated | `RSPAMD_CONTROLLER_PASSWORD`: ≥ 12 chars `[A-Za-z0-9._~+/=-]`; set on the bundled rspamd controller and sent by the app |
| `secrets.setupToken` | `""` | ≥ 16 chars; required for `app.replicaCount > 1` |
| `app.image.tag` / `.digest` | appVersion / `""` | digest pins the image |
| `app.replicaCount` | `1` | see [Replicas](#replicas) |
| `app.strategy.type` | `Recreate` | never two pods with schedulers during upgrades |
| `app.trustProxy` | `auto` | see [TRUST_PROXY](#trust_proxy) |
| `app.publicUrl` | `""` | `COREMAIL_PUBLIC_URL` (SSO redirect URIs) |
| `app.branding.name`, `app.branding.color` | `""` ("CoreMail" / `#006d77`) | `BRANDING_NAME`, `BRANDING_COLOR` — defaults until BCP → Organisation → Branding sets values (CoreMail >= 9.3, `docs/branding.md`) |
| `app.webauthn.*`, `app.vapid.*`, `app.jmapCorsOrigins`, `app.ldapAllowInsecure` | | map to `WEBAUTHN_*`, `VAPID_*`, `JMAP_CORS_ORIGINS`, `LDAP_ALLOW_INSECURE` |
| `app.mailAuth.*` | app defaults | `MAIL_AUTH_*` brute-force limits; `exemptCidrs` → `MAIL_AUTH_EXEMPT_CIDRS`/`MAIL_CONN_EXEMPT_CIDRS` (`limitPrivateIps` was removed in chart 2.0) |
| `app.deletedItemRetentionDays`, `app.quotaFullPermanent`, `app.httpRedirectHttps` | `""` (app defaults) | `DELETED_ITEM_RETENTION_DAYS`, `QUOTA_FULL_PERMANENT`, `HTTP_REDIRECT_HTTPS` (CoreMail >= 9.0) |
| `app.securityFilter.failOpen`, `app.localSpoof.action`/`.allow`, `app.arcTrustedSealers` | `false` / `""` | `SECURITY_FILTER_FAIL_OPEN`, `LOCAL_SPOOF_ACTION`/`LOCAL_SPOOF_ALLOW`, `ARC_TRUSTED_SEALERS` (CoreMail >= 9.0, `docs/mail-security.md`) |
| `app.extraEnv`, `.extraVolumes`, `.extraVolumeMounts` | `[]` | e.g. a GeoIP database (`GEOIP_DB_PATH`) or any other variable from `.env.example` |
| `mailService.type` | `LoadBalancer` | or `NodePort` |
| `mailService.externalTrafficPolicy` | `Local` | keep `Local`, see [Client IPs](#client-ips) |
| `mailService.ports.<name>.enabled` | mail ports on, `http`/`https` off | e.g. disable POP3 |
| `ingress.enabled`, `.host`, `.extraHosts`, `.className` | off | `host` required when enabled |
| `ingress.certManager.enabled`, `.issuer`, `.issuerKind` | off | adds `cert-manager.io/(cluster-)issuer` |
| `networkPolicy.enabled` | `true` | |
| `networkPolicy.httpFrom` | namespace `ingress-nginx` | who may reach port 3000 — adjust to your controller |
| `objectStorage.driver` | `minio` | `minio` \| `s3` \| `filesystem` (≥ 8.0.0), see [Object storage](#object-storage) |
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
  external: { host: rspamd.internal, controllerPort: 11334 }    # → RSPAMD_URL (controller: scan + learn), or set external.url
clamav:
  enabled: false
  external: { host: clamav.internal, port: 3310 }
```

An external PostgreSQL should get the extensions/search configuration from
`files/postgres-init.sql` (same as `infra/docker/postgres/init.sql`). With
`rspamd`/`clamav` disabled and no external host the chart sets
`RSPAMD_ENABLED=false` / `CLAMAV_ENABLED=false`, which switches the scanner off
regardless of the BCP setting. The bundled rspamd controller accepts
unauthenticated API calls from `rspamd.secureIp` (must contain the pod network);
the NetworkPolicy limits the port to the app pod. With
`secrets.rspamdControllerPassword` (`RSPAMD_CONTROLLER_PASSWORD`) the controller
requires that password from every other address and the app sends it, so
`rspamd.secureIp` can be reduced to `[127.0.0.1, "::1"]`. For an external rspamd,
set the same value as its controller `password`/`enable_password`.

**External PostgreSQL ≥ 17:** the image ships `pg_dump` 16, which cannot dump a
newer server. Automatic schema changes that only add unique constraints still
run (the optional pre-migration dump is skipped with a warning), but a
destructive change with `app.schemaSync.allowDataLoss` needs
`app.schemaSync.skipBackup=true` after you dumped the database yourself with a
matching `pg_dump` (or a managed snapshot) — the init container says so.

### Object storage

CoreMail 8.0.0 adds a storage driver abstraction; the chart passes the variables
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
Recreate` (the chart refuses other combinations). Keep `minio.enabled: true`
with `filesystem`: MinIO then only holds the backups (`BACKUP_BUCKET`) — the
same layout as a new Docker install. With `minio.enabled: false` and no
`minio.external`, backups have no target: the backup service logs
`Backup storage needs S3_ACCESS_KEY and S3_SECRET_KEY` at start and the chart
NOTES print a warning.

The `objects` PVC is not `chown`ed (the image entrypoint, which does that in
Docker, is skipped and the pod runs as non-root): it must be writable by uid
1000. Volume types that support `fsGroup` (most CSI/block volumes) get that from
the pod's `fsGroup: 1000`; host-path style provisioners ignore `fsGroup` — kind's
`local-path` hands out a `0777` directory, which works (the driver creates its
own subdirectories `0750`). With a provisioner that creates root-owned `0755`
directories, the app cannot write objects — pre-create the volume with
the right owner or use `objectStorage.filesystem.existingClaim`.

## Security

- **Pod Security Standard `restricted`** compatible: every pod runs as non-root
  (app uid 1000, postgres 70, redis 999, minio 1000, rspamd 11333, clamav 100),
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, all
  capabilities dropped, `seccompProfile: RuntimeDefault`. The namespace can be
  labelled `pod-security.kubernetes.io/enforce=restricted` (verified on a real
  cluster by `scripts/k8s-e2e.sh`).
- **App capabilities:** only `NET_BIND_SERVICE` is added (the only addition
  `restricted` allows). The image sets the file capability `cap_net_bind_service`
  on `/usr/local/bin/node` for ports 25/110/143/443/465/587/993/995; if the
  capability is missing from the bounding set, exec of `node` fails with
  "Operation not permitted". supervisord runs directly as uid 1000 (no setuid
  needed, no `SETUID`/`SETGID` capabilities).
- **No image entrypoint:** the entrypoint also prepares directories as root.
  The chart runs the same schema step (wait for PostgreSQL, then the image's
  `coremail-schema-sync`) in the `schema-sync` init container, then starts
  `tini → supervisord`. Keep this in mind if `entrypoint-app.sh` gains new steps.
- **Destructive schema changes fail closed:** `coremail-schema-sync` runs
  `prisma db push` without `--accept-data-loss`. Prisma's data-loss warnings
  are classified: a change that only **adds unique constraints** (e.g. 8.0.0 →
  9.0, `resource_bookings (calendarId, uid)`) is applied automatically after a
  duplicate check per constraint (best-effort dump to `backupClaim` first);
  duplicates stop the rollout with the table and the query to find them. The
  10.0.0 room/equipment tables (`resource_mailboxes`, `resource_calendars`,
  `resource_bookings`) are **retired**: dropped without `allowDataLoss`, but only
  after the mandatory pre-migration dump (the rooms' own mailboxes with their
  folders and messages are deleted with them) — set `app.schemaSync.backupClaim`
  (or `app.schemaSync.skipBackup=true` after your own backup) for the 9.5 → 10.0
  rollout when rooms exist, otherwise the init container stops without changes
  and its log names these two values. Any
  other warning (dropped table/column with data, type change, removed enum
  value) fails the init container and nothing is changed. After a backup, set
  `app.schemaSync.allowDataLoss=true` plus either `app.schemaSync.backupClaim`
  (an existing PVC; a `pre-migrate-<timestamp>.sql.gz` pg_dump is written there
  first) or `app.schemaSync.skipBackup=true`, roll out once, then unset it again.
  Images ≤ 8.0.0 contain no `coremail-schema-sync`; the init container then logs a
  warning and falls back to a plain `prisma db push` without `--accept-data-loss`.
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
  The policies need a CNI that enforces them (Calico, Cilium, kindnet in
  kind ≥ 0.24, …). Kubelet probes come from the node and are not affected.
  `kubectl port-forward` bypasses NetworkPolicies (handy for the setup wizard).
- **Fail-fast validation** at `helm install/upgrade/template`: too short
  secrets, secrets that would be regenerated on upgrade, non-URL-safe passwords, invalid `MFA_ENCRYPTION_KEY`/`SETUP_TOKEN`/
  `BACKUP_ENCRYPTION_KEY`/`RSPAMD_CONTROLLER_PASSWORD`, numeric secrets,
  `ingress.host`, replicas vs. setup token / filesystem storage, removed values
  (`app.mailAuth.limitPrivateIps`).

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
DNSBL checks the wrong address, and the per-IP lockout and connection caps count
all clients as a few node IPs (set `app.mailAuth.exemptCidrs` to the node CIDR so
only the per-account counter applies, or better keep `Local`). CoreMail does not speak PROXY protocol on the mail ports.

### Replicas

`app.replicaCount: 1` is the supported default. What is coordinated across pods:
the outbound queue (BullMQ), per-IP/per-account lockouts, sessions, SSE fan-out,
the certificate renewal scheduler (Redis scheduler lock + per-certificate lock),
LDAP sync, auto-reply and dead-letter throttles (Redis `SET NX`), and since
CoreMail 8.0.0 the backup scheduler and the retention worker (one run per cron
fire, Redis run lock) and credential invalidation (JMAP Basic-auth cache, live
connections, via the Redis auth bus). What is **not**: a starting pod marks
backup jobs that are still `RUNNING` elsewhere as failed (startup orphan cleanup),
and without a fixed `SETUP_TOKEN` every pod prints its own token (the chart
refuses `replicaCount > 1` without `secrets.setupToken` unless `existingSecret`
is used — then set `SETUP_TOKEN` there). `filesystem` object storage is limited
to one replica.

### Restart from the BCP

BCP → Server → Health & Status → "CoreMail neu starten" (CoreMail 10.4.2) stops supervisord
in the `coremail` container of the pod that serves the request; the container exits and the
kubelet starts it again (`restartPolicy: Always`, the pod's restart count goes up, the pod and
its volumes stay). The bundled PostgreSQL / Redis / scanner pods are not touched. With more
than one replica only the pod that answered the request restarts. Details:
[docs/deploy.md → Restarting CoreMail from the BCP](../../docs/deploy.md#restarting-coremail-from-the-bcp).

## Upgrading

### Upgrading to chart 3.4

Nothing to do. Values you pass keep winning; an existing release that passes all
secrets as values or uses `existingSecret` renders exactly as before. New:
empty values are taken from the release's Secret or generated
([Generated secrets](#generated-secrets)); `RSPAMD_CONTROLLER_PASSWORD` is
generated when it was unset (the bundled rspamd and the app get the same value),
`MFA_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY` are never added to an existing
release. The chart's Secret is now kept on `helm uninstall`.

### Upgrading to chart 3.0 (CoreMail 10.0)

Chart 3.0.0 ships with app 10.0.0 (`appVersion`). No value was added or removed,
but the rollout can need one: CoreMail 10.0 removes room and equipment resources,
and schema-sync drops their tables (`resource_mailboxes`, `resource_calendars`,
`resource_bookings`, together with the rooms' own mailboxes) only after a
**mandatory** pre-migration dump.

- **Room rows exist:** set `app.schemaSync.backupClaim` to an existing PVC (a
  `pre-migrate-<timestamp>.sql.gz` dump is written there first), or dump the
  database yourself and set `app.schemaSync.skipBackup=true` for this rollout.
  Without either, the init container stops before changing anything and its log
  names these two values. `app.schemaSync.allowDataLoss` is not needed; any other
  data loss is still refused.
- Read the 10.0.0 upgrade notes in `CHANGELOG.md` (mail to former room addresses
  is refused with `550 5.1.1`, removed APIs).

### Upgrading to chart 2.0 (CoreMail 9.0)

Chart 2.0.0 ships with app 9.0.0 (`appVersion`).

- **`app.mailAuth.limitPrivateIps` was removed** (the app no longer reads
  `MAIL_AUTH_LIMIT_PRIVATE_IPS`). CoreMail 9.0 exempts only loopback from the
  per-IP lockout and the IMAP/POP3 per-IP connection caps; further exemptions go
  into `app.mailAuth.exemptCidrs` (→ `MAIL_AUTH_EXEMPT_CIDRS` and
  `MAIL_CONN_EXEMPT_CIDRS`, comma-separated IPs/CIDRs). The chart **refuses to
  render** while `limitPrivateIps` is still in your values (even `false`):
  - `limitPrivateIps: true` → delete it, leave `exemptCidrs` empty (same effect).
  - `limitPrivateIps: false` (the old default) → delete it. The old behaviour
    (all private ranges exempt) would be
    `exemptCidrs: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7"`
    — not recommended; with `externalTrafficPolicy: Local` leave it empty, with
    `Cluster` set only the node CIDR.
- **New optional secrets** `secrets.backupEncryptionKey` (`BACKUP_ENCRYPTION_KEY`)
  and `secrets.rspamdControllerPassword` (`RSPAMD_CONTROLLER_PASSWORD`), also as
  keys of `existingSecret`. Setting `BACKUP_ENCRYPTION_KEY` on an existing
  installation is safe: the backup service keeps accepting the key derived from
  `JWT_SECRET` + `PEPPER` for older backups. The bundled rspamd now reads its
  controller password from the Secret (empty = as before).
- **Scanners without a backend are switched off:** `rspamd.enabled=false` /
  `clamav.enabled=false` without an external endpoint now set
  `RSPAMD_ENABLED=false` / `CLAMAV_ENABLED=false` (before, the BCP switch had to
  be turned off by hand).
- **New optional values** for the 9.0 escape hatches: `app.deletedItemRetentionDays`,
  `app.quotaFullPermanent`, `app.httpRedirectHttps`, `app.securityFilter.failOpen`,
  `app.localSpoof.action`/`.allow` and `app.arcTrustedSealers` (empty = app
  default). Further 9.0 variables (connection limits, send rate limits, …) go
  into `app.extraEnv`.
- **Schema sync:** unique-constraint-only changes are applied automatically
  (see [Security](#security)); images ≤ 8.0.0 fall back to a plain `prisma db push`.

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
   schema (a change that would delete data stops the rollout until
   `app.schemaSync.allowDataLoss` is set — see "Destructive schema changes" above).
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
+ existing Secret + LB HTTP/HTTPS + S3 with TLS/CA; filesystem storage + NodePort; the kind profile of `scripts/k8s-e2e.sh`),
kubeconform `-strict` on the rendered manifests (Kubernetes 1.30 schemas,
override with `KUBE_VERSION`), a test that rendering without secrets generates
them (64 hex keys, `resource-policy: keep`) and that `--is-upgrade` without a
readable Secret refuses to generate. Rendered output: `infra/k8s/.rendered/` (git-ignored).
It also checks statically that every rendered container and pod keeps the
Pod Security `restricted` fields (`allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true`, `runAsNonRoot: true`, `seccompProfile:
RuntimeDefault`, no privileged/host settings).

### Real-cluster test (kind)

```bash
K8S_E2E_DIR=/path/outside/the/repo bash scripts/k8s-e2e.sh
```

Needs Docker, `curl`, `openssl` and Node ≥ 22 (Linux, macOS or Windows Git
Bash). The script downloads pinned `kind` v0.33.0, `helm` v3.22.1 and `kubectl`
v1.37.0 into `$K8S_E2E_DIR/bin` (each verified against the release's sha256
file), creates a kind cluster (`kindest/node:v1.37.0`, pinned by digest), builds
`infra/docker/Dockerfile.app` as `coremail-app:k8s-test`, loads it into the
cluster and installs the chart with [`ci/kind-values.yaml`](ci/kind-values.yaml)
(bundled PostgreSQL/Redis/MinIO/rspamd/ClamAV, filesystem object storage on a
PVC, NetworkPolicies on, NodePort mail Service) and freshly generated secrets
into a namespace labelled `pod-security.kubernetes.io/enforce=restricted`. It
then checks:

- `helm install --wait`; all pods Ready; no PodSecurity warnings, and a
  server-side dry-run re-evaluation of the running pods against `restricted`
- the `schema-sync` init container applied the schema (exit code 0)
- NetworkPolicies: the app reaches PostgreSQL, Redis, MinIO, rspamd (`/ping`)
  and ClamAV; a foreign pod is blocked from all of them and from port 3000 but
  reaches the mail ports
- `/healthz` (incl. `storage: filesystem ok`) through `kubectl port-forward`
- SMTP 25/465/587, IMAP 143/993, POP3 110/995 banners through the mail Service
- setup token flow: status, `403` without token, setup with the token from the
  pod log, `409` on repeat
- admin login, two users via the admin API, SMTP submission (STARTTLS + AUTH)
  from one to the other and IMAP (STARTTLS + LOGIN) retrieval of the message
- `helm upgrade` with a changed value (`app.logLevel=debug`): ConfigMap
  changed, pod rolled (Recreate), message still readable afterwards
- `helm rollback` to revision 1: `LOG_LEVEL=info` again, message still readable

Finally it deletes the cluster and the image (`KEEP=1` keeps both,
`SKIP_BUILD=1` reuses an existing image, `CLAMAV=0` saves ~1.5 GiB RAM).
Logs and the generated secrets (mode 0600) stay in `$K8S_E2E_DIR`.

Status: chart 2.0.x with app 9.0.0 passed all checks on kind v0.33.0 /
Kubernetes 1.37 (Docker Desktop, WSL2). Not covered: Ingress controllers and
cert-manager, cloud load balancers (`externalTrafficPolicy: Local` with real
client IPs), external datastores (`ci/external-values.yaml` is only rendered),
`app.replicaCount > 1`, other CNIs (Calico, Cilium) and storage provisioners.

The bundled files `files/postgres-init.sql` and `files/rspamd/actions.conf`
mirror `infra/docker/postgres/init.sql` and `infra/docker/rspamd/local.d/actions.conf`
(Helm cannot read files outside the chart) — keep them in sync.
