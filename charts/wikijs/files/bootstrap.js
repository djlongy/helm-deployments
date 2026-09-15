#!/usr/bin/env node
//
// Bootstraps a fresh Wiki.js 2 instance to the point where it is serving the
// content of the git repository: completes the setup wizard, configures the
// Git storage target from a read-only deploy key, and imports every page.
//
// Idempotent. Re-running against an already-seeded wiki re-applies the storage
// config and re-imports, which is a no-op for unchanged pages.

const fs = require('fs')

const BASE = process.env.WIKI_URL
const SITE_URL = process.env.SITE_URL
const REPO_URL = process.env.REPO_URL
const REPO_BRANCH = process.env.REPO_BRANCH
const SYNC_MODE = process.env.SYNC_MODE || 'pull'
const AUTH_TYPE = process.env.GIT_AUTH_TYPE || 'ssh'

const read = (f, trim = true) => {
  const v = fs.readFileSync(`/secrets/${f}`, 'utf8')
  return trim ? v.trim() : v
}

const adminEmail = read('admin_email')
const adminPassword = read('admin_password', false)

// The private key must keep its trailing newline: the storage module writes it
// out and hands the path to ssh, which rejects a key without a final newline.
const deployKey = AUTH_TYPE === 'ssh' ? read('git_deploy_key', false) : ''
const gitUsername = AUTH_TYPE === 'basic' ? read('git_username') : ''
const gitPassword = AUTH_TYPE === 'basic' ? read('git_password') : ''

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function retry (label, fn, { tries = 120, delay = 5000 } = {}) {
  let last
  for (let i = 1; i <= tries; i++) {
    try {
      const out = await fn()
      if (out !== undefined && out !== null && out !== false) return out
      last = `attempt ${i} returned nothing usable`
    } catch (err) {
      last = err.message
    }
    if (i % 6 === 0) log(`  ${label}: still waiting (${i}/${tries}) - ${last}`)
    await sleep(delay)
  }
  throw new Error(`${label}: gave up after ${tries} attempts - ${last}`)
}

async function gql (query, variables, jwt) {
  const res = await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {})
    },
    body: JSON.stringify({ query, variables })
  })
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data
}

// ---------------------------------------------------------------------------
// 1. Wait for the pod to answer at all.
// ---------------------------------------------------------------------------
async function waitForHttp () {
  await retry('http', async () => {
    const res = await fetch(`${BASE}/healthz`, { redirect: 'manual' })
    return res.status > 0
  })
  log('HTTP is answering')
}

// ---------------------------------------------------------------------------
// 2. Setup wizard.
//
// /finalize has three possible outcomes and all three are handled:
//   - 2.5.314 answers {ok:true, redirectPath:"/"} and THEN tears the HTTP
//     server down to reboot into normal mode (observed).
//   - the teardown can also win the race and drop the socket before the
//     response is flushed, so a fetch rejection is a success signal too.
//   - {ok:false, error} means it stayed up to report a real failure, and 404
//     means the setup routes are already gone from an earlier run.
// ---------------------------------------------------------------------------
async function finalize () {
  let res
  try {
    res = await fetch(`${BASE}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        adminEmail,
        adminPassword,
        siteUrl: SITE_URL,
        telemetry: false
      })
    })
  } catch (err) {
    log('setup: connection dropped during /finalize - the reboot won the race, treating as success')
    return 'finalized'
  }

  if (res.status === 404) {
    log('setup: /finalize is 404, wiki was already set up')
    return 'already'
  }

  let body
  try {
    body = await res.json()
  } catch {
    log('setup: no parseable body, treating as the reboot path')
    return 'finalized'
  }
  if (body && body.ok === false) {
    throw new Error(`setup failed: ${body.error}`)
  }
  log('setup: /finalize returned', JSON.stringify(body))
  return 'finalized'
}

// ---------------------------------------------------------------------------
// 3. Log in. Doubles as the readiness check for normal mode, since /graphql
//    only exists once the setup server has been replaced by the real one.
// ---------------------------------------------------------------------------
async function login () {
  return retry('login', async () => {
    const data = await gql(`
      mutation ($u: String!, $p: String!) {
        authentication {
          login(username: $u, password: $p, strategy: "local") {
            jwt
            responseResult { succeeded errorCode message }
          }
        }
      }`, { u: adminEmail, p: adminPassword })
    const r = data.authentication.login
    if (!r.jwt) throw new Error(r.responseResult?.message || 'no jwt returned')
    return r.jwt
  })
}

// ---------------------------------------------------------------------------
// 4. Configure the Git storage target.
//
// updateTargets replaces `config` wholesale with what is sent, so every prop
// the module declares is supplied. Each value is a JSON document {"v": ...}.
// ---------------------------------------------------------------------------
const kv = (key, v) => ({ key, value: JSON.stringify({ v }) })

async function configureGit (jwt) {
  const config = [
    kv('authType', AUTH_TYPE),
    kv('repoUrl', REPO_URL),
    kv('branch', REPO_BRANCH),
    kv('sshPrivateKeyMode', 'contents'),
    kv('sshPrivateKeyPath', ''),
    kv('sshPrivateKeyContent', deployKey),
    kv('verifySSL', true),
    kv('basicUsername', gitUsername),
    kv('basicPassword', gitPassword),
    kv('defaultEmail', adminEmail),
    kv('defaultName', 'Wiki.js'),
    kv('localRepoPath', './data/repo'),
    kv('alwaysNamespace', false),
    kv('gitBinaryPath', '')
  ]

  const data = await gql(`
    mutation ($targets: [StorageTargetInput]!) {
      storage {
        updateTargets(targets: $targets) {
          responseResult { succeeded errorCode message }
        }
      }
    }`, {
    targets: [{
      isEnabled: true,
      key: 'git',
      mode: SYNC_MODE,
      syncInterval: 'PT5M',
      config
    }]
  }, jwt)

  const r = data.storage.updateTargets.responseResult
  if (!r.succeeded) throw new Error(`updateTargets: ${r.message}`)
  log(`storage: git target enabled in "${SYNC_MODE}" mode (${AUTH_TYPE} auth) against ${REPO_URL}#${REPO_BRANCH}`)
}

// ---------------------------------------------------------------------------
// 5. Wait for the target to finish cloning before asking it to import.
// ---------------------------------------------------------------------------
async function waitForTarget (jwt) {
  const status = await retry('git target', async () => {
    const data = await gql('{ storage { status { key status message } } }', {}, jwt)
    const git = data.storage.status.find(s => s.key === 'git')
    if (!git) throw new Error('git target missing from status')
    if (git.status === 'pending') throw new Error(`pending - ${git.message}`)
    return git
  }, { tries: 60, delay: 5000 })

  if (status.status === 'error') {
    throw new Error(`git target failed: ${status.message}`)
  }
  log(`storage: git target is "${status.status}" - ${status.message}`)
}

// ---------------------------------------------------------------------------
// 6. Import every page already in the repository.
// ---------------------------------------------------------------------------
async function importAll (jwt) {
  const data = await gql(`
    mutation {
      storage {
        executeAction(targetKey: "git", handler: "importAll") {
          responseResult { succeeded errorCode message }
        }
      }
    }`, {}, jwt)
  const r = data.storage.executeAction.responseResult
  if (!r.succeeded) throw new Error(`importAll: ${r.message}`)
  log('storage: importAll dispatched')
}

async function countPages (jwt) {
  const data = await gql('{ pages { list(orderBy: PATH) { id path title } } }', {}, jwt)
  return data.pages.list
}

// ---------------------------------------------------------------------------

async function main () {
  log(`bootstrapping ${BASE} (site url ${SITE_URL})`)
  await waitForHttp()

  const state = await finalize()
  if (state === 'finalized') {
    log('setup: waiting for the wiki to come back in normal mode')
  }

  const jwt = await login()
  log('auth: logged in as', adminEmail)

  await configureGit(jwt)
  await waitForTarget(jwt)
  await importAll(jwt)

  // importAll runs in the background; wait for the page count to settle.
  let last = -1
  let stable = 0
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const pages = await countPages(jwt)
    if (pages.length === last && pages.length > 0) {
      if (++stable >= 3) break
    } else {
      stable = 0
      log(`import: ${pages.length} pages so far`)
    }
    last = pages.length
  }

  const pages = await countPages(jwt)
  if (pages.length === 0) {
    throw new Error('import finished with zero pages - seeding did not work')
  }
  log(`DONE: ${pages.length} pages imported`)
  for (const p of pages.slice(0, 10)) log(`  /${p.path}  -  ${p.title}`)
  if (pages.length > 10) log(`  ... and ${pages.length - 10} more`)
}

main().catch(err => {
  console.error('BOOTSTRAP FAILED:', err.message)
  process.exit(1)
})
