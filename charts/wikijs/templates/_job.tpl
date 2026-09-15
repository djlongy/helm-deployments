{{/*
Common pod spec for the post-install hook jobs. Both run the Wiki.js image
itself: it already carries the Node runtime the scripts need, so nothing extra
is pulled onto the node.
*/}}
{{- define "wikijs.hookPodSpec" -}}
restartPolicy: Never
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
volumes:
  - name: scripts
    configMap:
      name: {{ .Release.Name }}-scripts
  - name: secrets
    secret:
      secretName: {{ include "wikijs.secretName" . }}
      defaultMode: 0400
{{- end -}}

{{- define "wikijs.hookContainerCommon" -}}
image: "{{ .Values.wiki.image.repository }}:{{ .Values.wiki.image.tag }}"
volumeMounts:
  - name: scripts
    mountPath: /scripts
    readOnly: true
  - name: secrets
    mountPath: /secrets
    readOnly: true
resources:
  requests: {cpu: 50m, memory: 128Mi}
  limits: {memory: 256Mi}
securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
{{- end -}}
