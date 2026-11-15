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

{{/* Fail-fast validation of values that the app or the datastores need */}}
{{- define "coremail.validate" -}}
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
