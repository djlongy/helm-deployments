# Adding an app

Four files. Copy `charts/wikijs` if you want a worked example that uses all of
them.

```
charts/<app>/
├── Chart.yaml        # the upstream chart as a dependency
├── values.yaml       # generic defaults — NO environment values
├── README.md         # what it needs, what the values do
└── templates/        # only what the upstream chart does not give you
```

## 1. Declare the upstream chart as a dependency

```yaml
# charts/<app>/Chart.yaml
apiVersion: v2
name: <app>
version: 0.1.0
appVersion: "1.2.3"
dependencies:
  - name: <upstream-chart>
    version: "4.5.6"
    repository: https://charts.example.org
```

This is a wrapper, not a fork. You add the pieces the upstream chart lacks — a
database CR, an ExternalSecret, a post-install job — and pass everything else
straight through under the dependency's name.

Pin the version. It is one of the two things Renovate bumps; the other is the
image tag in `values.yaml`.

## 2. Keep environment values OUT of values.yaml

`charts/<app>/values.yaml` holds defaults that are true everywhere. If a value
can only be right in one cluster — a hostname, a storage class, a LoadBalancer
IP, a Vault path — it does not belong there. Give it an empty default and
`required` it in the template if there is no safe fallback:

```yaml
{{- $host := required "ingress.host is required (e.g. wiki.example.com)" .Values.ingress.host }}
```

An empty default that fails loudly beats a plausible default that deploys into
the wrong place.

## 3. Add an environment file

```
environments/<env>/<app>.yaml
```

This is the only file a new environment writes. Nothing under `charts/` is
edited to adopt the app.

## 4. Deploy

```bash
scripts/deploy.sh <env> <app>
```

Then register it with whichever controller you use — see [gitops/](../gitops/).
Both read the same chart and the same values file.

## Things that bite

**Helm cannot compute values for a subchart.** Anything the upstream chart's
own templates read must be a literal in `values.yaml`; your templates cannot
fill it in. That is why `wikijs` has both a top-level `tolerations` (for pods
this chart owns) and `wiki.tolerations` (for the upstream Deployment), rather
than one setting feeding both. Where the split would be confusing, render the
resource yourself and disable the upstream one — `wikijs` does that for the
Ingress so a single `ingress.host` drives everything.

**Ordering belongs in Helm hooks, not in a controller.** A `post-install`
hook Job runs under `helm install`, is mapped to a sync phase by ArgoCD, and is
executed by Flux, which drives Helm itself. Sync-waves and `dependsOn` are each
specific to one controller; a hook works in all three.

**Hook jobs must be idempotent.** They re-run on every upgrade.
