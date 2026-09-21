# Make a directory group a Wiki.js administrator, with no scripts

**Goal.** People in your directory group `g_Wiki_Admins` sign in with SSO and are
full Wiki.js administrators. Nothing to click afterwards, nothing to run.

**The problem.** Wiki.js has no "admin" flag. Administrator means one permission,
`manage:system`, and its checkbox is **hardcoded disabled in the admin UI** — no
one can tick it, on any group, ever. So you cannot make your own group an admin
group by clicking.

**The trick.** Wiki.js ships a group that already holds `manage:system`:
`Administrators`. Group mapping matches the claim against group **names**, and it
does not skip the built-in ones. So if the claim says `Administrators`, the user
lands in it.

**Keeping your naming.** You do not have to rename anything in the directory. A
Keycloak **client role** is the translation layer: the group stays
`g_Wiki_Admins`, the role is called `Administrators`, and the claim carries the
role name.

```
AD group  g_Wiki_Admins
   └─ Keycloak group  g_Wiki_Admins
        └─ client role  Administrators      <- the rename happens here
             └─ groups claim: ["Administrators"]
                  └─ Wiki.js group id 1 Administrators (manage:system)
```

---

## Part 1 — Keycloak

**1. Client role.**
Clients → *your wiki client* → Roles → Create role.
Name: `Administrators` — exactly, capital A, plural.

**2. Attach it to the group.**
Groups → `g_Wiki_Admins` → Role mapping → Assign role → filter by **clients** →
select `Administrators`.

Everyone in the group now inherits the role. Membership stays in the directory.

**3. One protocol mapper.**
Clients → *your wiki client* → Client scopes → *client*-dedicated → Add mapper →
By configuration → **User Client Role**.

| Field | Value |
|---|---|
| Name | `wiki-groups` |
| Client ID | *your wiki client* |
| Client Role prefix | *(empty)* |
| Token Claim Name | `groups` |
| Claim JSON Type | `String` |
| Multivalued | **On** |
| Add to ID token | On |
| Add to access token | On |
| Add to userinfo | **On** |

**Add to userinfo must be on.** Wiki.js reads the UserInfo response, not the ID
token. A mapper that writes only to the ID token gives you a working login and no
groups, with nothing in any log to say why.

**4. Delete any other mapper writing to `groups`.**
A Group Membership mapper on the same claim name fights this one and the winner is
undefined. One claim, one mapper.

**5. Redirect URI.**
Set it to `https://<your wiki host>/login/<key>/callback`, where `<key>` is the
strategy key you will type in Part 2. Wiki.js builds the callback from that key,
so the two cannot differ.

**6. A sentinel role, so revocation works.**
Create a second client role named something that matches **no** Wiki.js group —
`wiki-authenticated` — and add it under Realm settings → User registration →
Default roles so every account carries it.

Skip this and removing someone from their last wiki group leaves their access
intact for ever. The reason is in *Three things that will confuse you later*,
item 1. It is one role and it is not optional.

### Check it before touching Wiki.js

Sign in as a member and read the UserInfo document. The claim must say:

```json
"groups": ["Administrators"]
```

If it does not, stop here. Nothing in Part 2 can fix a claim that is wrong.

---

## Part 2 — Wiki.js

Administration → Auth → **+ Add Strategy**.

**Pick `Generic OpenID Connect / OAuth2`. Not the Keycloak one.**
Both exist. The Keycloak-named module authenticates and stops — it has no group
mapping at all. Only the generic module implements it.

| Field | Value |
|---|---|
| Client ID | from the identity provider |
| Client Secret | from the identity provider |
| Authorization Endpoint URL | `<issuer>/protocol/openid-connect/auth` |
| Token Endpoint URL | `<issuer>/protocol/openid-connect/token` |
| User Info Endpoint URL | `<issuer>/protocol/openid-connect/userinfo` |
| Issuer | `https://<idp>/realms/<realm>` |
| Logout URL | `<issuer>/protocol/openid-connect/logout` |
| Email Claim | `email` |
| Display Name Claim | `name` |
| **Map Groups** | **On** |
| **Groups Claim** | `groups` |
| Allow self-registration | On |
| Assign to group | *(leave empty — the claim decides)* |

Two of those are easy to get wrong:

- **Display Name Claim** defaults to `displayName`. Keycloak sends `name`. Left at
  the default, every user gets a blank display name.
- **Assign to group** must stay empty. Anything set here is granted to everyone who
  signs in, regardless of their groups.

Save. Done — `Administrators` already exists and already holds `manage:system`.

---

## Verify

Sign in as a member of `g_Wiki_Admins`. You should reach Administration.

If you want to be sure the claim did it rather than something set earlier, check
the user record: Administration → Users → *the user*. Groups should list
`Administrators`, and the provider should be your strategy, not Local.

---

## Other tiers

Repeat the pattern, one client role per Wiki.js group name:

| Directory group | Client role | Wiki.js group |
|---|---|---|
| `g_Wiki_Admins` | `Administrators` | built in, nothing to create |
| `g_Wiki_Editors` | `Wiki Editors` | create it, tick what you want |
| `g_Wiki_Readers` | `Wiki Readers` | create it, tick the read permissions |

For the non-admin tiers, create the group in Administration → Groups and tick its
permissions. **Every permission except `manage:system` is tickable**, so only the
admin tier needs the built-in group. Use Page Rules to scope a group to paths.

Granularity exists only *below* `manage:system`. That permission short-circuits
every other check **and every page rule**, so an admin group cannot be narrowed.

---

## Three things that will confuse you later

**1. Group mapping is not additive — except when it silently is.** On each sign-in
it adds the groups in the claim and **removes every group that is not**.
Assignments you make by hand in the Wiki.js UI survive until that user's next
login, then vanish. The directory owns membership.

**But removal stops working when the claim goes empty**, and that is a
deprovisioning hole rather than an inconvenience. The module guards the whole
reconcile:

```js
const groups = _.get(profile, '_json.' + conf.groupsClaim)
if (groups && _.isArray(groups)) {
  // add missing, remove extra
}
```

Keycloak omits a multivalued claim entirely when it has no values. So taking
someone out of their **last** mapped group produces a UserInfo document with no
`groups` key at all, the guard fails, and the reconcile never runs — including the
half that removes. Their existing Wiki.js groups survive untouched, through every
later login.

If administrator comes from one group, as it does above, this is the whole
problem: remove the last group and the person stays an administrator.

**Fix it with a sentinel role**, so the claim is never empty:

1. On the wiki client, create a role whose name matches **no** Wiki.js group —
   `wiki-authenticated` does.
2. Realm settings → User registration → Default roles → add that client role, so
   every account carries it.
3. Do **not** create a Wiki.js group of that name. It grants nothing. It exists
   only to keep the array non-empty.

Removal then works: the claim reads `["wiki-authenticated"]`, the guard passes,
the reconcile runs, and the admin group is stripped on next login.

Prefer a floor of read access to a pure sentinel? Use a real `Wiki Readers` role
the same way and create that group in Wiki.js. Same effect on the claim.

Check it the way it was found: remove the role, read UserInfo, and confirm
`groups` is **present** rather than absent. A membership listing looks correct
either way — only the removal path shows the difference.

**2. The claim is matched against every group, not just the ones you meant.** A
Wiki.js group named after something everyone carries — `domain-users`, say —
grants its permissions to everyone who signs in. Check your group list for names
that could collide with a claim value, and delete the ones that can.

**3. Permissions travel inside the session token.** Changing a group or a
membership does nothing to a session already open. The user signs out and back in.
If your directory reaches the identity provider through an LDAP federation, the
provider also caches the user entry, so clear that cache first or the claim will
still carry yesterday's groups.

---

## Doing it without the UI

Everything in Part 2 is stored in the database and reachable over GraphQL, which
is what [`charts/wikijs`](../charts/wikijs/) does at install time so a fresh
deployment comes up already configured. Use that if you deploy wikis repeatedly.
For a single wiki, the UI steps above are quicker and there is nothing to
maintain.

The one thing GraphQL can do that the UI cannot is grant `manage:system` to a
group of your own — useful if you would rather keep the name `g_Wiki_Admins` on
both sides than use the built-in `Administrators` group. It refuses unless the
caller already holds `manage:system`, so run it as the local administrator the
setup wizard created:

```graphql
mutation ($id: Int!, $name: String!, $p: [String]!, $r: [PageRuleInput]!) {
  groups {
    update(id: $id, name: $name, redirectOnLogin: "/",
           permissions: $p, pageRules: $r) {
      responseResult { succeeded message }
    }
  }
}
```

with `permissions: ["manage:system"]`.
