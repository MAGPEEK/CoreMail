{{/*
Expand the name of the chart.
*/}}
{{- define "coremail.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "coremail.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s" $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Chart label
*/}}
{{- define "coremail.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "coremail.labels" -}}
helm.sh/chart: {{ include "coremail.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels for a given component
Usage: {{ include "coremail.selectorLabels" (dict "name" "smtp-server" "root" .) }}
*/}}
{{- define "coremail.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/*
Image reference for a service
Usage: {{ include "coremail.image" (dict "svc" .Values.services.smtpServer "root" .) }}
*/}}
{{- define "coremail.image" -}}
{{ .root.Values.global.image.registry }}/{{ .svc.image }}:{{ .root.Values.global.image.tag }}
{{- end }}

{{/*
Name of the secret holding credentials
*/}}
{{- define "coremail.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "coremail.fullname" . }}-secrets
{{- end }}
{{- end }}

{{/*
PostgreSQL DSN
*/}}
{{- define "coremail.postgresUrl" -}}
postgresql://ms:$(POSTGRES_PASSWORD)@{{ include "coremail.fullname" . }}-pg-rw:5432/mailserver
{{- end }}

{{/*
Redis URL (Bitnami Redis master)
*/}}
{{- define "coremail.redisUrl" -}}
redis://{{ include "coremail.fullname" . }}-redis-master:6379
{{- end }}
