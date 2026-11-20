{{/* ───────────────────────── Names and labels ───────────────────────── */}}

{{- define "coremail.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "coremail.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Name of a dependency component: <fullname>-<component> */}}
{{- define "coremail.componentName" -}}
{{- printf "%s-%s" (include "coremail.fullname" .root | trunc 50 | trimSuffix "-") .component }}
{{- end }}

{{- define "coremail.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Usage: include "coremail.labels" (dict "root" . "component" "app") */}}
{{- define "coremail.labels" -}}
helm.sh/chart: {{ include "coremail.chart" .root }}
{{ include "coremail.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: coremail
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "coremail.selectorLabels" -}}
app.kubernetes.io/name: {{ include "coremail.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Image reference. Usage: include "coremail.image" (dict "image" .Values.app.image "default" .Chart.AppVersion) */}}
{{- define "coremail.image" -}}
{{- $tag := .image.tag | default .default | toString -}}
{{- if .image.digest -}}
{{- if .image.tag -}}
{{ printf "%s:%s@%s" .image.repository $tag .image.digest }}
{{- else -}}
{{ printf "%s@%s" .image.repository .image.digest }}
{{- end -}}
{{- else -}}
{{ printf "%s:%s" .image.repository $tag }}
{{- end -}}
{{- end }}

{{- define "coremail.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "coremail.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "coremail.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "coremail.fullname" . }}
{{- end }}
{{- end }}

{{/* ───────────────────────── Endpoints ───────────────────────── */}}

{{- define "coremail.postgresql.host" -}}
{{- if .Values.postgresql.enabled }}
{{- include "coremail.componentName" (dict "root" . "component" "postgresql") }}
{{- else }}
{{- required "postgresql.external.host is required when postgresql.enabled=false" .Values.postgresql.external.host }}
{{- end }}
{{- end }}

{{- define "coremail.postgresql.port" -}}
{{- if .Values.postgresql.enabled }}5432{{ else }}{{ .Values.postgresql.external.port }}{{ end }}
{{- end }}

{{- define "coremail.postgresql.database" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.database }}{{ else }}{{ .Values.postgresql.external.database }}{{ end }}
{{- end }}

{{- define "coremail.postgresql.username" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.username }}{{ else }}{{ .Values.postgresql.external.username }}{{ end }}
{{- end }}

{{/* DATABASE_URL with $(POSTGRES_PASSWORD) expanded by the kubelet */}}
{{- define "coremail.databaseUrl" -}}
{{- $params := "" }}
{{- if and (not .Values.postgresql.enabled) .Values.postgresql.external.params }}
{{- $params = printf "?%s" .Values.postgresql.external.params }}
{{- end }}
{{- printf "postgresql://%s:$(POSTGRES_PASSWORD)@%s:%s/%s%s" (include "coremail.postgresql.username" .) (include "coremail.postgresql.host" .) (include "coremail.postgresql.port" .) (include "coremail.postgresql.database" .) $params }}
{{- end }}

{{- define "coremail.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://:$(REDIS_PASSWORD)@%s:6379" (include "coremail.componentName" (dict "root" . "component" "redis")) }}
{{- else }}
{{- $host := required "redis.external.host is required when redis.enabled=false" .Values.redis.external.host }}
{{- printf "%s://:$(REDIS_PASSWORD)@%s:%v" (ternary "rediss" "redis" .Values.redis.external.tls) $host .Values.redis.external.port }}
{{- end }}
{{- end }}

{{/* Empty only with objectStorage.driver=filesystem and no MinIO/S3 configured */}}
{{- define "coremail.minio.host" -}}
{{- if .Values.minio.enabled }}
{{- include "coremail.componentName" (dict "root" . "component" "minio") }}
{{- else if .Values.minio.external.host }}
{{- .Values.minio.external.host }}
{{- else if ne .Values.objectStorage.driver "filesystem" }}
{{- fail "minio.external.host is required when minio.enabled=false (unless objectStorage.driver=filesystem)" }}
{{- end }}
{{- end }}

{{- define "coremail.minio.port" -}}
{{- if .Values.minio.enabled }}9000{{ else }}{{ .Values.minio.external.port }}{{ end }}
{{- end }}

{{- define "coremail.rspamd.host" -}}
{{- if .Values.rspamd.enabled }}
{{- include "coremail.componentName" (dict "root" . "component" "rspamd") }}
{{- else }}
{{- .Values.rspamd.external.host }}
{{- end }}
{{- end }}

{{- define "coremail.clamav.host" -}}
{{- if .Values.clamav.enabled }}
{{- include "coremail.componentName" (dict "root" . "component" "clamav") }}
{{- else }}
{{- .Values.clamav.external.host }}
{{- end }}
{{- end }}

{{/* ───────────────────────── Behaviour ───────────────────────── */}}

{{/* Effective TRUST_PROXY (see values.yaml app.trustProxy) */}}
{{- define "coremail.trustProxy" -}}
{{- $v := .Values.app.trustProxy | toString }}
{{- if eq $v "auto" }}
{{- if and .Values.ingress.enabled .Values.networkPolicy.enabled (gt (len .Values.networkPolicy.httpFrom) 0) (not .Values.mailService.ports.http.enabled) }}1{{ end }}
{{- else }}
{{- $v }}
{{- end }}
{{- end }}

{{/* Mail ports that are enabled: list of dicts name/port/targetPort/nodePort */}}
{{- define "coremail.enabledMailPorts" -}}
{{- $out := list }}
{{- range $name := list "smtp" "smtps" "submission" "imap" "imaps" "pop3" "pop3s" "http" "https" }}
{{- $p := index $.Values.mailService.ports $name }}
{{- if $p.enabled }}
{{- $out = append $out (dict "name" $name "port" $p.port "targetPort" $p.targetPort "nodePort" $p.nodePort) }}
{{- end }}
{{- end }}
{{- toJson $out }}
{{- end }}

{{/*
Chart 3.4: generated secrets. Without secrets.existingSecret every empty
secrets.* value is filled ONCE per render, in this order of precedence:
  1. the value itself (values file / --set) — always wins
  2. the key in the release's existing Secret (lookup) — upgrades keep it
  3. a new random value — only when there is nothing to keep:
       always       jwtSecret, pepper, postgresPassword, redisPassword,
                    minioRootPassword (bundled/external MinIO only),
                    rspamdControllerPassword
       fresh only   mfaEncryptionKey, backupEncryptionKey — only on a first
                    install (no existing Secret). An existing release derives
                    them from JWT_SECRET + PEPPER; a new MFA key would make every
                    enrolled TOTP secret unreadable.
On `helm upgrade` an empty required value that is NOT in the existing Secret
(or the Secret cannot be read: --dry-run=client, missing RBAC) fails instead of
being generated — a new PEPPER would lock every user out.
The values are written back into .Values.secrets so every template of this
render (Secret, checksums, NOTES) sees the same ones.
*/}}
{{- define "coremail.secrets.fill" -}}
{{- if and (not .Values.secrets.existingSecret) (not (hasKey .Values "__coremailSecretsFilled")) }}
{{- $_ := set .Values "__coremailSecretsFilled" true }}
{{- $s := .Values.secrets }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "coremail.secretName" .) | default dict }}
{{- $data := get $existing "data" | default dict }}
{{- $fresh := and .Release.IsInstall (not $data) }}
{{- $minio := include "coremail.minio.host" . }}
{{- /* value key, Secret key, generator (key|password), mode, needed
       mode: data = tied to stored data (never generated on upgrade),
             any  = may be generated whenever it is missing,
             fresh = first install only */}}
{{- $specs := list
  (list "jwtSecret" "JWT_SECRET" "key" "data" true)
  (list "pepper" "PEPPER" "key" "data" true)
  (list "postgresPassword" "POSTGRES_PASSWORD" "password" "data" true)
  (list "redisPassword" "REDIS_PASSWORD" "password" "data" true)
  (list "minioRootPassword" "MINIO_ROOT_PASSWORD" "password" "data" (not (empty $minio)))
  (list "rspamdControllerPassword" "RSPAMD_CONTROLLER_PASSWORD" "password" "any" true)
  (list "mfaEncryptionKey" "MFA_ENCRYPTION_KEY" "key" "fresh" true)
  (list "backupEncryptionKey" "BACKUP_ENCRYPTION_KEY" "key" "fresh" true) }}
{{- range $spec := $specs }}
{{- $k := index $spec 0 }}{{- $sk := index $spec 1 }}{{- $mode := index $spec 3 }}
{{- if and (index $spec 4) (empty (get $s $k)) }}
{{- $old := get $data $sk }}
{{- /* key: 64 hex characters (sha256 of 64 random alphanumerics); password: 40 alphanumerics (URL-safe) */}}
{{- $new := ternary (sha256sum (randAlphaNum 64)) (randAlphaNum 40) (eq (index $spec 2) "key") }}
{{- if $old }}
{{- $_ := set $s $k (b64dec $old) }}
{{- else if or $fresh (eq $mode "any") }}
{{- $_ := set $s $k $new }}
{{- $_ := set $.Values "__coremailSecretsGenerated" true }}
{{- else if eq $mode "data" }}
{{- if $.Release.IsUpgrade }}
{{- fail (printf "secrets.%s is empty and the existing Secret %s has no %s (or it cannot be read, e.g. --dry-run=client) — refusing to generate a new value on upgrade. Set secrets.%s (or secrets.existingSecret) to the value in use." $k (include "coremail.secretName" $) $sk $k) }}
{{- end }}
{{- $_ := set $s $k $new }}
{{- $_ := set $.Values "__coremailSecretsGenerated" true }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/* Fail-fast validation of values that the app or the datastores need */}}
{{- define "coremail.validate" -}}
{{- include "coremail.secrets.fill" . }}
{{- $s := .Values.secrets }}
{{- range $k, $v := $s }}
{{- if and $v (not (kindIs "string" $v)) }}{{ fail (printf "secrets.%s must be a string — quote it in YAML or use --set-string (a digits-only value is parsed as a number and would be corrupted)" $k) }}{{ end }}
{{- end }}
{{- if not $s.existingSecret }}
{{- $jwt := required "secrets.jwtSecret is required (openssl rand -hex 32) — or set secrets.existingSecret" $s.jwtSecret }}
{{- if lt (len $jwt) 32 }}{{ fail "secrets.jwtSecret must be at least 32 characters" }}{{ end }}
{{- $pep := required "secrets.pepper is required (openssl rand -hex 32) — or set secrets.existingSecret. NEVER change it after the first start." $s.pepper }}
{{- if lt (len $pep) 32 }}{{ fail "secrets.pepper must be at least 32 characters" }}{{ end }}
{{- $pg := required "secrets.postgresPassword is required (openssl rand -hex 20)" $s.postgresPassword }}
{{- if not (regexMatch "^[A-Za-z0-9._~-]+$" $pg) }}{{ fail "secrets.postgresPassword must be URL-safe ([A-Za-z0-9._~-]) — it is embedded in DATABASE_URL" }}{{ end }}
{{- $rd := required "secrets.redisPassword is required (openssl rand -hex 20) — Redis always runs with authentication" $s.redisPassword }}
{{- if not (regexMatch "^[A-Za-z0-9._~-]+$" $rd) }}{{ fail "secrets.redisPassword must be URL-safe ([A-Za-z0-9._~-]) — it is embedded in REDIS_URL" }}{{ end }}
{{- if include "coremail.minio.host" . }}
{{- $_ := required "secrets.minioRootUser is required" $s.minioRootUser }}
{{- $mp := required "secrets.minioRootPassword is required (openssl rand -hex 20)" $s.minioRootPassword }}
{{- if lt (len $mp) 8 }}{{ fail "secrets.minioRootPassword must be at least 8 characters" }}{{ end }}
{{- end }}
{{- if and $s.mfaEncryptionKey (not (regexMatch "^[0-9a-fA-F]{64}$" $s.mfaEncryptionKey)) }}{{ fail "secrets.mfaEncryptionKey must be 64 hex characters (openssl rand -hex 32)" }}{{ end }}
{{- if and $s.setupToken (lt (len $s.setupToken) 16) }}{{ fail "secrets.setupToken must be at least 16 characters" }}{{ end }}
{{- if and (gt (int .Values.app.replicaCount) 1) (not $s.setupToken) }}{{ fail "app.replicaCount > 1 requires secrets.setupToken (each pod would otherwise print its own random setup token)" }}{{ end }}
{{- end }}
{{- if and $s.backupEncryptionKey (not (regexMatch "^([0-9a-fA-F]{64}|[A-Za-z0-9+/_-]{43}=?)$" $s.backupEncryptionKey)) }}{{ fail "secrets.backupEncryptionKey must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64 (openssl rand -base64 32)" }}{{ end }}
{{- if and $s.rspamdControllerPassword (not (regexMatch "^[A-Za-z0-9._~+/=-]{12,}$" $s.rspamdControllerPassword)) }}{{ fail "secrets.rspamdControllerPassword must be at least 12 characters of [A-Za-z0-9._~+/=-] (openssl rand -hex 20) — it is embedded in the rspamd configuration" }}{{ end }}
{{- /* Chart 2.0: removed values must not be silently ignored */}}
{{- $m := .Values.app.mailAuth | default dict }}
{{- if and (hasKey $m "limitPrivateIps") (not (kindIs "invalid" (index $m "limitPrivateIps"))) }}
{{- fail "app.mailAuth.limitPrivateIps was removed in chart 2.0 (CoreMail 9.0: MAIL_AUTH_LIMIT_PRIVATE_IPS no longer exists — only loopback is exempt from per-IP limits by default). Remove it and use app.mailAuth.exemptCidrs instead: limitPrivateIps: true → leave exemptCidrs empty; limitPrivateIps: false (old default) → exemptCidrs: \"10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7\" keeps the old behaviour (not recommended). See infra/k8s/README.md → Upgrading to chart 2.0" }}
{{- end }}
{{- $os := .Values.objectStorage }}
{{- if not (has $os.driver (list "minio" "s3" "filesystem")) }}{{ fail "objectStorage.driver must be minio, s3 or filesystem" }}{{ end }}
{{- if and (eq $os.driver "filesystem") (gt (int .Values.app.replicaCount) 1) }}{{ fail "objectStorage.driver=filesystem requires app.replicaCount: 1 (the object volume is ReadWriteOnce and not shared between pods)" }}{{ end }}
{{- if and (eq $os.driver "filesystem") (ne (toString .Values.app.strategy.type) "Recreate") (not (has "ReadWriteMany" $os.filesystem.accessModes)) }}{{ fail "objectStorage.driver=filesystem with a ReadWriteOnce volume requires app.strategy.type: Recreate" }}{{ end }}
{{- if and $os.caFile.configMap $os.caFile.secret }}{{ fail "objectStorage.caFile: set either configMap or secret, not both" }}{{ end }}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}{{ fail "ingress.host is required when ingress.enabled=true" }}{{ end }}
{{- if and .Values.ingress.certManager.enabled (not .Values.ingress.certManager.issuer) }}{{ fail "ingress.certManager.issuer is required when ingress.certManager.enabled=true" }}{{ end }}
{{- if not (has .Values.mailService.externalTrafficPolicy (list "Local" "Cluster")) }}{{ fail "mailService.externalTrafficPolicy must be Local or Cluster" }}{{ end }}
{{- if not (has .Values.mailService.type (list "LoadBalancer" "NodePort")) }}{{ fail "mailService.type must be LoadBalancer or NodePort" }}{{ end }}
{{- end }}
