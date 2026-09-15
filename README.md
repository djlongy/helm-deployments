# helm-deployments

Third-party applications deployed to Kubernetes with Helm. One chart per app,
one values file per environment, and the same two files consumed three ways —
by the Helm CLI, by ArgoCD, or by Flux.

Clone it, write one values file, deploy. No tracked file is edited to adopt an
app or to move it to a new cluster.

## Deploy something

```bash
git clone https://github.com/OWNER/helm-deployments.git
cd helm-deployments

cp -r environments/example environments/prod
$EDITOR environments/prod/wikijs.yaml      # set ingress.host, storage class, …

./scripts/deploy.sh prod wikijs
```

That is the whole workflow. `--dry-run` works as an extra argument.

## Layout

```
charts/<app>/                 the chart: upstream as a dependency, plus what it lacks
environments/<env>/<app>.yaml the ONLY file an environment writes
gitops/argocd/                ArgoCD entrypoints  — same chart, same values file
gitops/flux/                  Flux entrypoints    — same chart, same values file
scripts/deploy.sh             the no-controller path
docs/adding-an-app.md         how to add the next app
```

## Apps

| App | What you get |
|---|---|
| [`wikijs`](charts/wikijs/) | Wiki.js 2, a CloudNativePG database over verified TLS, optional content seeding from a git repository, optional OIDC sign-in with group mapping |

## Adopting a GitOps controller later

Nothing moves. Both controllers point at the same `charts/<app>` directory and
the same `environments/<env>/<app>.yaml`.

**ArgoCD** — apply [`gitops/argocd/applicationset.yaml`](gitops/argocd/applicationset.yaml).
A git files generator walks `environments/*/*.yaml`, so adding a values file
adds an Application. Values live outside the chart directory, which works
because a `valueFiles` entry beginning with `/` is resolved from the repository
root.

**Flux** — apply the `GitRepository` and one `Kustomization` per environment,
as in [`gitops/flux/README.md`](gitops/flux/README.md).

Flux needs one thing the other two do not: a `kustomization.yaml` and a
`*.helmrelease.yaml` inside `environments/<env>/`, because Flux reads values
from a ConfigMap rather than from a git path, and its kustomize-controller
refuses to load a file outside the kustomization root — with no override. So
the generator has to sit beside its input. Those two files are inert for the
Helm CLI and for ArgoCD; delete them if you never use Flux.

## Conventions

**The chart holds no environment values.** A value that can only be correct in
one cluster gets an empty default and fails loudly:

```
Error: ingress.host is required (e.g. wiki.example.com)
```

An empty default that stops beats a plausible default that deploys into the
wrong place.

**Charts wrap upstream, they do not fork it.** `Chart.yaml` declares the
upstream chart as a dependency; local templates add only what it lacks. Pin the
version — that and the image tag in `values.yaml` are what a bot bumps.

**Ordering is Helm hooks.** A `post-install` hook runs under `helm install`, is
mapped to a sync phase by ArgoCD, and is executed by Flux, which drives Helm
itself. Sync-waves and `dependsOn` each work in only one of the three.

**Secrets are never in git.** Charts take either an External Secrets reference
or the name of a Secret you made yourself. The secret backend is a value, not an
assumption.

See [docs/adding-an-app.md](docs/adding-an-app.md) to add the next one.
