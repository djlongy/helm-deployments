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

For single sign-on with group mapping, start from `environments/example-sso`
instead. It deploys a wiki where the identity provider's groups decide who is a
reader, who is an editor and who is an administrator, with nothing to configure
afterwards — including the one permission Wiki.js will not let you grant through
its own admin UI.

Already have a wiki, or want to do it by hand? See
[docs/oidc-admin-without-scripts.md](docs/oidc-admin-without-scripts.md): a
directory group becomes a Wiki.js administrator using only Keycloak client roles
and the Wiki.js admin UI, with nothing to run.

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
| [`wikijs`](charts/wikijs/) | Wiki.js 2, a CloudNativePG database over verified TLS, the setup wizard completed for you, optional content seeding from a git repository, optional OIDC sign-in with group mapping |

## Adopting a GitOps controller later

Nothing moves. Both controllers point at the same `charts/<app>` directory and
the same `environments/<env>/<app>.yaml`.

**ArgoCD** — apply [`gitops/argocd/applicationset.yaml`](gitops/argocd/applicationset.yaml).
A git files generator walks `environments/*/*.yaml`, so adding a values file
adds an Application. Values live outside the chart directory, which works
because a `valueFiles` entry beginning with `/` is resolved from the repository
root.

**Flux** — apply [`gitops/flux/source.yaml`](gitops/flux/source.yaml), then add
one `HelmRelease` per app under `gitops/flux/releases/`. Its `valuesFiles` paths
are relative to the source, which for a `GitRepository` is the repository root,
so Flux reads the same files. See [`gitops/flux/README.md`](gitops/flux/README.md)
for the two settings that are not optional.

Both of those work only because the charts wrap upstream as a **dependency**
rather than referencing an upstream chart directly. Point Flux at a
`HelmRepository` and the "source" becomes the upstream tarball, putting your
values file out of reach; ArgoCD would likewise need a second source. Wrapping
keeps one chart path and one values path for all three modes.

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

**The install finishes what the product leaves half-done.** Wiki.js serves a
setup screen and no API until its wizard has run, so the chart runs it as the
first hook and the later ones depend on the administrator it creates. The same
reasoning covers group permissions: `manage:system` is the permission that makes
a Wiki.js group an administrator, and its checkbox is hardcoded disabled in the
admin UI, so a deployment is the only place it can be assigned.

**Ordering inside one release is a Helm hook.** A `post-install` hook runs under
`helm install`, is mapped to a sync phase by ArgoCD, and is executed by Flux,
which drives Helm itself.

Ordering *across* releases is not — use ArgoCD sync-waves or Flux `dependsOn`,
whichever you run. The two have genuinely different primitives (a number versus
an edge list) and trying to unify them produces something neither tool reads.

**Secrets are never in git.** Charts take either an External Secrets reference
or the name of a Secret you made yourself. The secret backend is a value, not an
assumption.

See [docs/adding-an-app.md](docs/adding-an-app.md) to add the next one.
