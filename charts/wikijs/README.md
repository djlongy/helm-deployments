# wikijs

Wiki.js 2, a CloudNativePG database over verified TLS, and — if you want them —
content seeded from a git repository and OIDC sign-in. One `helm install`.

## Requirements

| In the cluster | Needed for |
|---|---|
| [CloudNativePG](https://cloudnative-pg.io/) operator | the database (skip with `postgres.enabled=false`) |
| An ingress controller | reaching it |
| cert-manager | TLS (skip by leaving `ingress.clusterIssuer` empty) |
| [External Secrets](https://external-secrets.io/) | seeding and SSO credentials (or use `credentials.mode=existing`) |

## Install

```bash
helm dependency update charts/wikijs
helm upgrade --install wiki charts/wikijs \
  --namespace wiki --create-namespace \
  --set ingress.host=wiki.example.com
```

That is a working wiki with an empty page tree. Everything below is optional.

## Values

Only `ingress.host` is required.

| Value | Default | What it does |
|---|---|---|
| `ingress.host` | — | **Required.** The hostname it serves on |
| `ingress.className` | `nginx` | Ingress class |
| `ingress.clusterIssuer` | `""` | cert-manager issuer; empty means no TLS |
| `ingress.annotations` | `{}` | e.g. external-dns targets |
| `postgres.enabled` | `true` | Create a CloudNativePG Cluster |
| `postgres.instances` | `1` | Raise for HA |
| `postgres.storage.size` | `10Gi` | |
| `postgres.storage.storageClass` | `""` | Empty uses the cluster default |
| `nodeSelector` / `tolerations` | `{}` / `[]` | For the database and hook jobs |
| `wiki.nodeSelector` / `wiki.tolerations` | `{}` / `[]` | For the Wiki.js pod (see note) |
| `wiki.image.tag` | `2.5.314` | |
| `seed.*` | off | Content seeding, below |
| `sso.*` | off | OIDC sign-in, below |
| `credentials.*` | External Secrets | Where the hook jobs read credentials |

Scheduling is split in two because the Wiki.js pod comes from the upstream
subchart, and Helm cannot compute values for a subchart.

## Seed the wiki from a git repository

Wiki.js's git storage module reads markdown with front-matter. Point it at a
repository and the wiki comes up already serving those pages.

```yaml
seed:
  enabled: true
  repoUrl: git@github.com:acme/wiki-content.git
  branch: main
  mode: pull          # pull | sync | push
  authType: ssh       # ssh | basic
```

`pull` never writes to the repository, so a content backup cannot be damaged by
anything done in the wiki. `sync` commits wiki edits back.

For `ssh`, put a **read-only deploy key** in the credentials secret as
`git_deploy_key`. For `basic`, use `git_username` and `git_password`.

## OIDC sign-in

```yaml
sso:
  enabled: true
  issuer: https://idp.example.com/realms/main
  strategyKey: sso
  displayName: Company SSO
  groupMap:
    wiki-readers: viewer
    wiki-authors: editor
    wiki-owners:  admin
```

Register this redirect URI on the identity provider's client — exactly this,
where the path segment is `sso.strategyKey`:

```
https://<ingress.host>/login/<strategyKey>/callback
```

The client must emit a **`groups` claim in the UserInfo response**, not only in
the ID token: Wiki.js reads `profile._json`, which is UserInfo. A mapper that
writes only the ID token leaves group mapping silently doing nothing.

Three things worth knowing before you rely on it:

- **Group names are matched exactly, against every Wiki.js group** — not only
  the ones in `groupMap`. A Wiki.js group named after something every account
  carries hands its permissions to everyone. `sso.retiredGroups` deletes such a
  group if one already exists.
- **Membership is reconciled on every sign-in.** Groups absent from the claim
  are removed, so the identity provider owns membership and editing it in the
  Wiki.js admin UI lasts until that user's next login.
- **A membership change reaches the claim only after the provider re-reads it.**
  If the provider caches its directory, clear that cache, then sign in again.

This uses the generic `oidc` module rather than a provider-named one. Wiki.js 2
ships both, and only the generic module implements `mapGroups`/`groupsClaim` —
the provider-specific modules authenticate and stop, which would put every
federated user in the same bucket.

## Credentials

The hook jobs need an admin account, and whichever of the git key and OIDC
client your features use. Keys in the Secret:

```
admin_email  admin_password
git_deploy_key          (seed, authType ssh)
git_username  git_password   (seed, authType basic)
oidc_client_id  oidc_client_secret   (sso)
```

Either pull them from a secret manager:

```yaml
credentials:
  mode: externalSecret
  externalSecret:
    secretStoreRef: {kind: ClusterSecretStore, name: my-store}
    remoteKey: apps/wikijs/runtime
```

or create the Secret yourself and point at it:

```yaml
credentials:
  mode: existing
  existingSecret: wikijs-credentials
```

## Bring your own database

```yaml
postgres:
  enabled: false
wiki:
  externalPostgresql:
    host: my-postgres-rw
    port: 5432
    database: wiki
    username: wiki
    existingSecret: my-postgres-app
    existingSecretKey: password
    ssl: true
```

Leave `ca` unset and mount your CA at `wiki.nodeExtraCaCerts` instead — see the
next section for why.

## Two upstream traps this chart already avoids

**`externalPostgresql.ca` breaks TLS** ([requarks/wiki#7942][i]). The upstream
chart emits `DB_SSL_CA` as a file path, but `server/core/db.js` reads that
variable as raw base64 certificate *body* and rebuilds a PEM from it by
64-character chunking. Given a path it builds a broken certificate and dies in
CrashLoopBackOff. The issue's own workaround is
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables certificate verification for
the whole process. This chart leaves `ca` unset and mounts the CA into
`NODE_EXTRA_CA_CERTS`, so verification stays on and the mounted secret tracks
the CA's rotation.

**The Bitnami subchart.** Every upstream chart in the `2.2.x` line depends on
`postgresql@8.10.14` from the Bitnami repository, whose images moved. Chart
`3.0.0` dropped the dependency, which is why it is the pinned version. Do not
fall back to `2.2.x`.

[i]: https://github.com/requarks/wiki/issues/7942

## Upgrading

`wiki.image.tag` and the `wiki` dependency version in `Chart.yaml` are the two
pins. The seed and SSO jobs re-run on every upgrade and are idempotent.
