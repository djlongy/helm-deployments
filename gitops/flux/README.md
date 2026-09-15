# Flux

Two objects, then one file per app.

```bash
kubectl apply -f gitops/flux/source.yaml
```

That creates a `GitRepository` for this repo and a `Kustomization` over
`gitops/flux/releases/`. There is deliberately no `kustomization.yaml` in that
directory — kustomize-controller generates one over whatever manifests it
finds, so adding `releases/<app>.yaml` deploys the app.

## How the values are shared

The `HelmRelease` takes the chart from this repository rather than from a chart
registry:

```yaml
chart:
  spec:
    chart: ./charts/wikijs
    sourceRef: {kind: GitRepository, name: helm-deployments}
    valuesFiles:
      - ./charts/wikijs/values.yaml
      - ./environments/example/wikijs.yaml
```

`valuesFiles` paths are relative to the **source**, which for a `GitRepository`
is the repository root — so Flux reads exactly the files the Helm CLI and
ArgoCD read. No ConfigMap, no `configMapGenerator`, no second copy.

This only works because the chart source is a `GitRepository`. Point a
`HelmRelease` at a `HelmRepository` instead and the "source" becomes the
upstream chart tarball, your values file is unreachable, and you are pushed into
`valuesFrom` with a ConfigMap — which is why the charts here wrap upstream as a
dependency rather than referencing it directly.

## Two settings that are not optional

`reconcileStrategy: Revision` — the default, `ChartVersion`, only builds a new
artefact when the version in `Chart.yaml` changes. Leave it at the default and a
commit that edits only a values file never reconciles.

The chart's own `values.yaml` is listed explicitly in `valuesFiles`. It is the
base of the merge, and listing it is correct regardless of whether Flux would
otherwise include it.

## Ordering across apps

Flux has no sync-wave. Where one release must exist before another — an
operator before a CR that uses it — use `dependsOn` on the dependent release:

```yaml
spec:
  dependsOn:
    - name: cloudnative-pg
      namespace: flux-system
```

Ordering *within* one release is a Helm hook and needs nothing here.

For an operator chart, set `install.crds: CreateReplace` and
`upgrade.crds: CreateReplace`.
