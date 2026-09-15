#!/usr/bin/env node
//
// Configures OpenID Connect sign-in on a Wiki.js 2 instance, and maps the
// identity provider's groups onto Wiki.js groups.
//
// Uses the GENERIC `oidc` authentication module, not one of the provider-named
// ones. Wiki.js 2 ships both, and only the generic module implements
// mapGroups/groupsClaim — the provider-specific modules authenticate and stop
// there, so every federated user would land with the same permissions.
//
// Idempotent.

const fs = require('fs')

const BASE = process.env.WIKI_URL
const ISSUER = process.env.OIDC_ISSUER   // e.g. https://idp.example.com/realms/main
const STRATEGY_KEY = process.env.OIDC_STRATEGY_KEY || 'sso'
const GROUPS_CLAIM = process.env.OIDC_GROUPS_CLAIM || 'groups'

const adminEmail = fs.readFileSync('/secrets/admin_email', 'utf8').trim()
const adminPassword = fs.readFileSync('/secrets/admin_password', 'utf8')
const clientId = fs.readFileSync('/secrets/oidc_client_id', 'utf8').trim()
const clientSecret = fs.readFileSync('/secrets/oidc_client_secret', 'utf8').trim()

// Group mapping, supplied by the deployer.
//
// OIDC_GROUP_MAP is a JSON object of {"<identity-provider group name>": "<tier>"},
// where tier is viewer | editor | admin. Example:
//
//   {"wiki-viewers":"viewer","wiki-authors":"editor","wiki-owners":"admin"}
//
// The names are matched EXACTLY against the groups claim, because that is what
// Wiki.js does: mapGroups compares the claim to Wiki.js group NAMES, and it
// checks every group that exists, not only the ones named here. So a Wiki.js
// group named after something every account carries hands its permissions to
// everyone — which is what OIDC_RETIRED_GROUPS is for.
const READ = ['read:pages', 'read:assets', 'read:comments']
const WRITE = [...READ, 'write:pages', 'manage:pages', 'write:assets', 'write:comments', 'read:source', 'read:history']

const TIERS = {
  viewer: { permissions: READ, roles: READ },
  editor: { permissions: WRITE, roles: WRITE },
  admin: { permissions: ['manage:system'], roles: WRITE }
}

const rawMap = JSON.parse(process.env.OIDC_GROUP_MAP || '{}')
const GROUP_MAP = {}
for (const [name, tier] of Object.entries(rawMap)) {
  const t = TIERS[tier]
  if (!t) throw new Error(`OIDC_GROUP_MAP: group "${name}" has unknown tier "${tier}" (want viewer, editor or admin)`)
  GROUP_MAP[name] = {
    permissions: t.permissions,
    pageRules: [{ id: tier, deny: false, match: 'START', path: '', locales: [], roles: t.roles }]
  }
}

// Wiki.js groups to delete before mapping — use it to remove a group an earlier
// run created under a name you no longer want granting anything.
const RETIRED_GROUPS = JSON.parse(process.env.OIDC_RETIRED_GROUPS || '[]')

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function gql (query, variables, jwt) {
  const res = await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ query, variables })
  })
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data
}

async function login () {
  for (let i = 0; i < 60; i++) {
    try {
      const d = await gql(`
        mutation ($u: String!, $p: String!) {
          authentication { login(username: $u, password: $p, strategy: "local") {
            jwt responseResult { succeeded message } } }
        }`, { u: adminEmail, p: adminPassword })
      if (d.authentication.login.jwt) return d.authentication.login.jwt
    } catch (err) { /* not up yet */ }
    await sleep(5000)
  }
  throw new Error('could not log in as the local administrator')
}

async function ensureGroups (jwt) {
  let existing = (await gql('{ groups { list { id name } } }', {}, jwt)).groups.list

  for (const name of RETIRED_GROUPS) {
    const g = existing.find(x => x.name === name)
    if (!g) continue
    const d = await gql(`
      mutation ($id: Int!) { groups { delete(id: $id) { responseResult { succeeded message } } } }`,
    { id: g.id }, jwt)
    const r = d.groups.delete.responseResult
    if (!r.succeeded) throw new Error(`retire group ${name}: ${r.message}`)
    log(`group: retired "${name}" (id ${g.id})`)
  }
  existing = (await gql('{ groups { list { id name } } }', {}, jwt)).groups.list
  const ids = {}
  for (const [name, spec] of Object.entries(GROUP_MAP)) {
    let g = existing.find(x => x.name === name)
    if (!g) {
      const d = await gql(`
        mutation ($n: String!) {
          groups { create(name: $n) { group { id name } responseResult { succeeded message } } }
        }`, { n: name }, jwt)
      const r = d.groups.create
      if (!r.responseResult.succeeded) throw new Error(`create group ${name}: ${r.responseResult.message}`)
      g = r.group
      log(`group: created "${name}" (id ${g.id})`)
    } else {
      log(`group: "${name}" already exists (id ${g.id})`)
    }
    const d = await gql(`
      mutation ($id: Int!, $n: String!, $p: [String]!, $r: [PageRuleInput]!) {
        groups { update(id: $id, name: $n, redirectOnLogin: "/", permissions: $p, pageRules: $r) {
          responseResult { succeeded message } } }
      }`, { id: g.id, n: name, p: spec.permissions, r: spec.pageRules }, jwt)
    if (!d.groups.update.responseResult.succeeded) {
      throw new Error(`update group ${name}: ${d.groups.update.responseResult.message}`)
    }
    ids[name] = g.id
  }
  return ids
}

const kv = (key, v) => ({ key, value: JSON.stringify({ v }) })

async function configureOidc (jwt) {
  // updateStrategies DELETES any strategy left out of the list, so every
  // existing one is read back and resubmitted alongside the new one.
  const current = (await gql(`{
    authentication {
      activeStrategies {
        key displayName order isEnabled selfRegistration domainWhitelist autoEnrollGroups
        strategy { key }
        config { key value }
      }
    }
  }`, {}, jwt)).authentication.activeStrategies

  const keep = current
    .filter(s => s.key !== STRATEGY_KEY)
    .map(s => ({
      key: s.key,
      strategyKey: s.strategy.key,
      displayName: s.displayName,
      order: s.order,
      isEnabled: s.isEnabled,
      selfRegistration: s.selfRegistration,
      domainWhitelist: s.domainWhitelist,
      autoEnrollGroups: s.autoEnrollGroups,
      config: s.config.map(c => ({ key: c.key, value: c.value }))
    }))
  log(`auth: preserving ${keep.length} existing strateg${keep.length === 1 ? 'y' : 'ies'}: ${keep.map(k => k.key).join(', ')}`)

  const oidc = {
    key: STRATEGY_KEY,
    strategyKey: 'oidc',
    displayName: process.env.OIDC_DISPLAY_NAME || 'Single Sign-On',
    order: keep.length,
    isEnabled: true,
    selfRegistration: true,   // create the Wiki.js user on first sign-in
    domainWhitelist: [],
    autoEnrollGroups: [],     // membership comes from the groups claim instead
    config: [
      kv('clientId', clientId),
      kv('clientSecret', clientSecret),
      kv('authorizationURL', `${ISSUER}/protocol/openid-connect/auth`),
      kv('tokenURL', `${ISSUER}/protocol/openid-connect/token`),
      kv('userInfoURL', `${ISSUER}/protocol/openid-connect/userinfo`),
      kv('issuer', ISSUER),
      kv('logoutURL', `${ISSUER}/protocol/openid-connect/logout`),
      kv('skipUserProfile', false),
      kv('emailClaim', 'email'),
      kv('displayNameClaim', 'name'),
      kv('pictureClaim', 'picture'),
      kv('mapGroups', true),
      kv('groupsClaim', GROUPS_CLAIM),
      kv('acrValues', '')
    ]
  }

  const d = await gql(`
    mutation ($s: [AuthenticationStrategyInput]!) {
      authentication { updateStrategies(strategies: $s) { responseResult { succeeded message } } }
    }`, { s: [...keep, oidc] }, jwt)
  const r = d.authentication.updateStrategies.responseResult
  if (!r.succeeded) throw new Error(`updateStrategies: ${r.message}`)
  log(`auth: "${oidc.displayName}" enabled, callback ${process.env.SITE_URL}/login/${STRATEGY_KEY}/callback`)
}

async function main () {
  const jwt = await login()
  log('auth: logged in as', adminEmail)

  const ids = await ensureGroups(jwt)
  log('groups mapped from the claim:', Object.entries(ids).map(([n, i]) => `${n}=${i}`).join(' '))

  await configureOidc(jwt)

  // Read back rather than trust the mutation's own success flag.
  const after = (await gql('{ authentication { activeStrategies(enabledOnly: true) { key displayName strategy { key } } } }', {}, jwt))
    .authentication.activeStrategies
  const mine = after.find(s => s.key === STRATEGY_KEY)
  if (!mine) throw new Error('strategy is not present after the update')
  log(`VERIFIED: ${after.length} enabled strategies -> ${after.map(s => `${s.key}(${s.strategy.key})`).join(', ')}`)
}

main().catch(err => { console.error('SSO CONFIG FAILED:', err.message); process.exit(1) })
