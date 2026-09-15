{{- define "wikijs.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
The database Cluster name is a fixed literal rather than release-derived,
because the Wiki.js pod is rendered by the upstream subchart and Helm cannot
compute values for a subchart — so wiki.externalPostgresql.host has to be a
literal in values.yaml, and it can only stay correct if this name is stable.
*/}}
{{- define "wikijs.pgName" -}}wikijs-pg{{- end -}}

{{- define "wikijs.secretName" -}}
{{- if eq .Values.credentials.mode "existing" -}}
{{- required "credentials.existingSecret is required when credentials.mode is existing" .Values.credentials.existingSecret -}}
{{- else -}}
{{ .Release.Name }}-credentials
{{- end -}}
{{- end -}}

{{- define "wikijs.serviceUrl" -}}
http://{{ .Values.wiki.fullnameOverride }}.{{ .Release.Namespace }}.svc.cluster.local
{{- end -}}

{{- define "wikijs.siteUrl" -}}
{{ if .Values.ingress.clusterIssuer }}https{{ else }}http{{ end }}://{{ .Values.ingress.host }}
{{- end -}}
