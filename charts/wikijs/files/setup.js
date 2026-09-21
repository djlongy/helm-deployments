#!/usr/bin/env node
//
// Completes the Wiki.js 2 setup wizard and nothing else, so that a release
// which enables neither seeding nor SSO still comes up with a usable local
// administrator instead of an unconfigured setup screen.
//
// This step used to live inside bootstrap.js, which runs only when seeding is
// enabled. A release with SSO on and seeding off therefore never left setup
// mode: /graphql does not exist until the wizard has run, so the SSO job had
// nothing to log in to. Splitting it out is what makes SSO-without-seeding
// work, and it is why this runs at a lower hook weight than either.
//
// Idempotent. /finalize answers 404 once the wiki is already set up.

const fs = require('fs')

const BASE = process.env.WIKI_URL
const SITE_URL = process.env.SITE_URL

const read = (f, trim = true) => {
  const v = fs.readFileSync(`/secrets/${f}`, 'utf8')
  return trim ? v.trim() : v
}

const adminEmail = read('admin_email')
const adminPassword = read('admin_password', false)

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

// Wait for the pod to answer at all.
async function waitForHttp () {
  await retry('http', async () => {
    const res = await fetch(`${BASE}/healthz`, { redirect: 'manual' })
    return res.status > 0
  })
  log('HTTP is answering')
}

// The setup wizard.
//
// /finalize has three possible outcomes and all three are handled:
//   - 2.5.314 answers {ok:true, redirectPath:"/"} and THEN tears the HTTP
//     server down to reboot into normal mode (observed).
//   - the teardown can also win the race and drop the socket before the
//     response is flushed, so a fetch rejection is a success signal too.
//   - {ok:false, error} means it stayed up to report a real failure, and 404
//     means the setup routes are already gone from an earlier run.
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

// Log in. This is the real verification: /graphql only exists once the setup
// server has been replaced by the running wiki, so a successful login proves
// both that the wizard completed and that the administrator it created works.
// The later hooks depend on exactly that account.
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

async function main () {
  await waitForHttp()
  const outcome = await finalize()
  await login()
  log(`VERIFIED: wiki is set up (${outcome}) and the local administrator can sign in`)
}

main().catch(err => { console.error('SETUP FAILED:', err.message); process.exit(1) })
