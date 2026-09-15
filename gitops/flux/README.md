# Flux

Two objects bootstrap everything: a `GitRepository` for this repo, and one
`Kustomization` per environment pointing at `environments/<env>/`.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: helm-deployments
  namespace: flux-system
spec:
  interval: 5m
  url: https://github.com/OWNER/helm-deployments.git
  ref:
    branch: main
---
apiVersion: kustomize.config.k8s.io/v1
kind: Kustomization
metadata:
  name: example
  namespace: flux-system
spec:
  interval: 10m
  prune: true
  sourceRef:
    kind: GitRepository
    name: helm-deployments
  path: ./environments/example
```

## Why the Flux glue sits in `environments/`, not here

Flux's kustomize-controller refuses to load a file outside the kustomization
root, and unlike the `kustomize` CLI it has no `--load-restrictor` override. A
`configMapGenerator` under `gitops/flux/<env>/` reaching back to
`../../../environments/<env>/wikijs.yaml` fails with:

```
security; file '.../environments/example/wikijs.yaml' is not in or
below '.../gitops/flux/example'
```

So the generator has to sit next to its input. The alternative — a second copy
of the values for Flux — is worse: the whole point is that all three consumption
modes read the same file.

`kustomization.yaml` and `*.helmrelease.yaml` are inert for the other two modes.
Delete them if you never use Flux.
