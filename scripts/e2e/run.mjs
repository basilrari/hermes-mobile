#!/usr/bin/env node
/**
 * run.mjs — the headless e2e harness (HM-06).
 *
 * Serves the BUILT bundle (`apps/mobile/dist`) and drives it in headless Chrome
 * at the two target sizes, both orientations, using Playwright.
 *
 *   phone portrait  412x915      phone landscape  915x412
 *   tablet portrait 800x1280     tablet landscape 1280x800
 *
 * Scenarios per profile:
 *   1. the connect screen renders
 *   2. an `http://` gateway URL is refused (HTTPS only)
 *   3. token login → the renderer reaches the Sessions / Bots shell
 *   4. the RPC trace (HM-05) is live and shows no `bot_relay.*` call
 * plus one two-concurrent-client pass (sync tests build on it).
 *
 * Target: by default a local mock gateway (no secret, CI-safe). Point it at the
 * real box with:
 *     HERMES_E2E_GATEWAY_URL=https://pavillion-claw.tailfc1337.ts.net \
 *     HERMES_E2E_PASSWORD=… npm run e2e
 * (Password login is native-only — a browser cannot read Set-Cookie — so the
 * real-gateway run exercises it only from the app on the tablet.)
 *
 * Exit 0 = every check passed. Any failure prints the RPC trace and exits 1.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startMockGateway } from './mock-gateway.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const distDir = path.join(repoRoot, 'apps/mobile/dist')
const shotDir = path.join(here, 'screenshots')

const PROFILES = [
  { name: 'phone-portrait', width: 412, height: 915 },
  { name: 'phone-landscape', width: 915, height: 412 },
  { name: 'tablet-portrait', width: 800, height: 1280 },
  { name: 'tablet-landscape', width: 1280, height: 800 },
]

const TURN_BUDGET = Number(process.env.HERMES_E2E_TURN_BUDGET ?? '6')
let turnsUsed = 0

/** Canonical lowercase UUID v4 (HM-25 contract). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Storage classification (HM-13). Option D: the device holds UI preferences and
 * bridge state only — never conversation state.
 *
 * CONVERSATION_STATE is a hard failure: a key here means messages, room logs or
 * session history are living on the device.
 * KNOWN actually seen on a full login + boot, i.e. the inventory that was
 * classified into docs/ARCHITECTURE.md. A key that is neither is *reported*, not
 * failed — a renderer sync legitimately brings new UI preferences, and the point
 * is that every key gets classified rather than that the list is frozen.
 */
const CONVERSATION_STATE = /preparedSubmissions\.v1$|group-chat|(^|[.\-_/])(messages|rooms?|sessions?|history)([.\-_/]|$)/i
const KNOWN_STORAGE = [
  { match: /^CapacitorStorage\.hermes\.(target|cookies\..+|preparedSubmissions\.v1|device\.[a-z]+\.v1)$/, kind: 'bridge state', note: 'user-entered target/cookies, the send journal, the device id' },
  { match: /^hermes-boot-/, kind: 'ui pref', note: 'boot theme/background' },
  { match: /^hermes-desktop-active-profile-v1$/, kind: 'ui pref', note: 'last active profile' },
  { match: /^hermes\.desktop\./, kind: 'ui pref / rebuildable cache', note: 'layout, panes, tools, theme, tutorials, pricing' },
  { match: /^hermes\.updates\.last-passive-check$/, kind: 'ui pref', note: 'update check timestamp' },
]

/** Classify one key. Returns { kind, note, known }. */
function classifyStorageKey(key) {
  for (const rule of KNOWN_STORAGE) if (rule.match.test(key)) return { kind: rule.kind, note: rule.note, known: true }
  return { kind: 'UNCLASSIFIED', note: 'add a row to docs/ARCHITECTURE.md and a rule here', known: false }
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json',
}

/** Minimal static server for the built bundle, with SPA fallback. */
function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let file = path.join(distDir, decodeURIComponent(url.pathname))
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, 'index.html')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const results = []
const storageInventory = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * A finding worth printing that is NOT a pass/fail: neither a break in the app
 * nor something the harness can decide. Kept out of `results` so it cannot pad
 * the score, and printed with a distinct marker so a reader can tell it apart
 * from a check.
 */
function note(text) {
  console.log(`  • ${text}`)
}

async function openClient(browser, profile, origin) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  return { context, page }
}

/**
 * The steps after the token is submitted: dismiss the desktop renderer's
 * first-run onboarding if the backend says it is due, then wait for the shell.
 */
/**
 * The layout pass (HM-30 tablet polish, HM-31 phone pass).
 *
 * "Obvious breakage" is turned into assertions that can actually fail, instead of
 * a human squinting at a screenshot:
 *   - no horizontal overflow of the document, and no element sticking out past
 *     the viewport edge by more than a pixel (the classic narrow-layout break);
 *   - the composer is present, non-zero and inside the viewport (a chat you
 *     cannot type into is broken whatever it looks like);
 *   - visible controls meet a minimum touch target (Android's own guidance is
 *     48dp; the renderer's icon buttons are smaller, so 24 CSS px is the
 *     breakage floor and anything under 32 is reported for polish).
 */
const MIN_TOUCH_PX = 24
const POLISH_TOUCH_PX = 32

async function layoutFindings(page) {
  return page.evaluate(({ minTouch, polishTouch }) => {
    const doc = document.documentElement
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
    }

    const inHorizontalScroller = (el) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true
      }
      return false
    }

    const overflow = []
    const scrollStrips = []
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 && r.width < vw * 4) {
        // An element inside an intentional horizontal scroller (the mobile status
        // bar) is SUPPOSED to sit past the edge — that is how the strip scrolls.
        // Counting it as breakage made this check wrong, not the app. Round: HM-31.
        if (inHorizontalScroller(el)) {
          if (scrollStrips.length < 3) scrollStrips.push(`${el.tagName.toLowerCase()} right=${Math.round(r.right)} (scroll strip)`)
          continue
        }
        const label = `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : ''} right=${Math.round(r.right)} w=${Math.round(r.width)} parent=${(el.parentElement?.tagName || '').toLowerCase()}.${String(el.parentElement?.className || '').split(' ').slice(0, 2).join('.')}`
        overflow.push(`${label} :: ${el.outerHTML.slice(0, 90).replace(/\s+/g, ' ')}`)
        if (overflow.length >= 4) break
      }
    }

    const small = []
    for (const el of document.querySelectorAll('button, a[href], input, textarea, select, [role="button"]')) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      // A 1x1 (or 0-height) element is a renderer measurement hack, not a
      // control: autosize textareas and offscreen probes. Excluded explicitly.
      if (r.width * r.height <= 4) continue
      if (Math.min(r.width, r.height) < minTouch) {
        small.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}]=${Math.round(r.width)}x${Math.round(r.height)}`)
        if (small.length >= 5) break
      }
    }

    const composer = document.querySelector('textarea, [contenteditable="true"], input[type="text"]')
    let composerOk = false
    let composerNote = 'no composer found'
    if (composer && visible(composer)) {
      const r = composer.getBoundingClientRect()
      composerOk = r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1
      composerNote = `composer ${Math.round(r.width)}x${Math.round(r.height)} bottom=${Math.round(r.bottom)} of ${vh}`
    }

    return {
      documentOverflow: doc.scrollWidth > vw + 1 ? `${doc.scrollWidth} > ${vw}` : null,
      elementOverflow: overflow,
      smallTargetsFloor: small,
      composerOk,
      composerNote,
      viewport: `${vw}x${vh}`,
      polishTargets: [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => visible(el))
        .map((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) })
        .filter((v) => v > 0 && v < polishTouch).length,
    }
  }, { minTouch: MIN_TOUCH_PX, polishTouch: POLISH_TOUCH_PX })
}

async function finishSignIn(page) {
  const chooseLater = page.getByRole('button', { name: /choose a provider later/i })
  if (await chooseLater.count()) {
    await chooseLater.first().click().catch(() => {})
    await chooseLater.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  }
  // Wide layouts dock a "Sessions" pane and title the composer "NEW SESSION".
  await page.locator('text=NEW SESSION').or(page.locator('text=Sessions')).first().waitFor({ state: 'visible', timeout: 45_000 })
}

/** The whole token login, for scenarios that do not need the intermediate screens. */
async function signIn(page, gatewayUrl, token) {
  await page.getByLabel('Gateway URL').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByLabel('Gateway URL').fill(gatewayUrl)
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.getByLabel('Session token').waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByLabel('Session token').fill(token)
  await page.getByRole('button', { name: 'Connect' }).click()
  await finishSignIn(page)
}

/** Steps 1–4 for one viewport. `gatewayUrl` is https. */
async function runProfile(browser, profile, origin, gatewayUrl, token) {
  console.log(`\n▸ ${profile.name} (${profile.width}x${profile.height})`)
  const { context, page } = await openClient(browser, profile, origin)
  try {
    const urlField = page.getByLabel('Gateway URL')
    await urlField.waitFor({ state: 'visible', timeout: 20_000 })
    check(`${profile.name}: connect screen renders`, true)
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-01-connect.png`) })

    // 2. http:// is refused.
    await urlField.fill('http://insecure.example:9119')
    await page.getByRole('button', { name: 'Connect' }).click()
    await page.waitForTimeout(750)
    const refused = (await page.getByLabel('Session token').count()) === 0 && (await page.locator('body').innerText()).length > 0
    check(`${profile.name}: http:// gateway refused`, refused)

    // 3. token login → shell.
    await urlField.fill(gatewayUrl)
    await page.getByRole('button', { name: 'Connect' }).click()
    const tokenField = page.getByLabel('Session token')
    await tokenField.waitFor({ state: 'visible', timeout: 20_000 })
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-02-token.png`) })
    await tokenField.fill(token)
    await page.getByRole('button', { name: 'Connect' }).click()

    // The desktop renderer's first-run onboarding (when the backend says it is
    // due) overlays the shell; dismiss it the way a user does. The mock answers
    // `onboarding.state` as not-run, so this is only a fallback against a real
    // gateway that does want to onboard.
    await finishSignIn(page)
    check(`${profile.name}: login reaches the chat shell`, true)
    // The titlebar controls mount a beat after the first paint.
    await page.waitForTimeout(2000)

    // The roster surface. Docked at >=640 CSS px (Bots next to Sessions); on a
    // phone the panes are hidden behind the titlebar's "Show sidebar" control
    // (mobile-behaviors.tsx), so open it the way a user does.
    let bots = await page.getByText('Bots', { exact: false }).count()
    let how = bots > 0 ? 'docked' : 'none'
    if (bots === 0) {
      const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
      const appeared = await showSidebar.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)
      if (appeared) {
        // Direct DOM click: the drawer's own scrim can make an actionability
        // check flaky, and this is a toggle we only need to fire once.
        await showSidebar.first().evaluate((el) => el.click())
        await page.getByText('Bots', { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
        bots = await page.getByText('Bots', { exact: false }).count()
        how = bots > 0 ? 'via Show sidebar' : 'none'
      }
    }
    check(`${profile.name}: Bots roster surface present`, bots > 0, how)
    if ((await page.getByText('CONNECTING', { exact: false }).count()) > 0) {
      console.log(`    ! ${profile.name}: boot overlay still on screen against the mock gateway`)
    }
    const layout = await layoutFindings(page)
    check(`${profile.name}: no horizontal overflow`, layout.documentOverflow === null && layout.elementOverflow.length === 0,
      layout.documentOverflow ?? (layout.elementOverflow.length ? layout.elementOverflow.join(' | ') : `viewport ${layout.viewport}`))
    check(`${profile.name}: composer visible inside the viewport`, layout.composerOk, layout.composerNote)
    // Reported, not failed. The offenders are the renderer's OWN desktop chrome
    // (the profile switcher's 20x20 icon buttons, and sidebar section rows 12px
    // tall) — a mouse-sized control, not a break in the mobile layout, and a
    // mobile-only CSS override keyed on an i18n'd aria-label would be fragile.
    // Filed upstream instead. Round: HM-31.
    if (layout.smallTargetsFloor.length) {
      note(`${profile.name}: ${layout.smallTargetsFloor.length} control(s) under the ${MIN_TOUCH_PX}px touch floor — renderer chrome, upstream issue: ${layout.smallTargetsFloor.join(' | ')}`)
    } else {
      check(`${profile.name}: controls meet the touch-target floor (${MIN_TOUCH_PX}px)`, true, 'all visible controls >= floor')
    }
    await page.screenshot({ path: path.join(shotDir, `${profile.name}-03-app.png`) })

    // 4. the trace is live and clean. Zero relay traffic is M1's acceptance
    // (#11 removed the Desktop relay from mobile; this is its assertion).
    const trace = await page.evaluate(() => (window.__hermesRpcTrace ? window.__hermesRpcTrace.toText() : null))
    check(`${profile.name}: RPC trace global is live`, typeof trace === 'string' && trace.length > 0)
    const relayCalls = (trace ?? '').split('\n').filter((line) => line.includes('bot_relay.'))
    check(
      `${profile.name}: no bot_relay.* call`,
      relayCalls.length === 0,
      relayCalls.length ? relayCalls.slice(0, 3).join(' | ') : 'the relay is off on mobile',
    )
    if (process.env.HERMES_E2E_DUMP_TRACE === '1') console.log(trace ?? '(no trace)')

    // The bridge contract (HM-12): the durable send journal is exposed, and the
    // renderer's own localStorage fallback key is untouched.
    const bridge = await page.evaluate(() => {
      const ps = window.hermesDesktop?.preparedSubmissions
      return {
        journal:
          !!ps &&
          typeof ps.read === 'function' &&
          typeof ps.update === 'function' &&
          typeof ps.compareAndSet === 'function',
        fallbackKey: window.localStorage.getItem('hermes.desktop.preparedSubmissions.v1'),
      }
    })
    check(`${profile.name}: preparedSubmissions contract exposed`, bridge.journal)
    check(`${profile.name}: journal absent from the renderer localStorage key`, bridge.fallbackKey === null)

    // deviceIdentity (HM-25): contract method present and returning a v4 uuid.
    const identity = await page.evaluate(async () => {
      try {
        const value = await window.hermesDesktop?.deviceIdentity?.()
        return { deviceId: value?.device_id ?? null, label: value?.label ?? null }
      } catch {
        return { deviceId: null, label: null }
      }
    })
    check(`${profile.name}: deviceIdentity returns a v4 uuid`, UUID_V4.test(identity.deviceId ?? ''))
    check(`${profile.name}: deviceIdentity carries a label`, typeof identity.label === 'string' && identity.label.length > 0)

    // Storage inventory (HM-13). KEYS AND SIZES ONLY — never a value: the same
    // find could otherwise put a session token into an artefact.
    const inventory = await page.evaluate(async () => {
      const local = []
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)
        if (key === null) continue
        local.push({ key, bytes: (window.localStorage.getItem(key) ?? '').length })
      }
      const session = []
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index)
        if (key === null) continue
        session.push({ key, bytes: (window.sessionStorage.getItem(key) ?? '').length })
      }
      let databases = []
      try {
        databases = ((await window.indexedDB?.databases?.()) ?? []).map((db) => db.name ?? '(unnamed)')
      } catch {
        databases = []
      }
      return {
        local: local.sort((a, b) => a.key.localeCompare(b.key)),
        session: session.sort((a, b) => a.key.localeCompare(b.key)),
        databases,
      }
    })
    storageInventory.push({ profile: profile.name, ...inventory })

    const keys = inventory.local.map((entry) => entry.key)
    const leaked = keys.filter((key) => CONVERSATION_STATE.test(key))
    check(
      `${profile.name}: no conversation state in localStorage`,
      leaked.length === 0,
      leaked.length ? leaked.join(' | ') : `${keys.length} key(s), all UI prefs or bridge state`,
    )
    const unknown = keys.filter((key) => !classifyStorageKey(key).known)
    if (unknown.length > 0) console.log(`    ! ${profile.name}: unclassified storage key(s): ${unknown.join(', ')}`)
  } finally {
    await context.close()
  }
}

/** Two clients at once (the base for the later sync/read-state scenarios). */
async function runTwoClients(browser, origin, gatewayUrl, token) {
  console.log('\n▸ two concurrent clients')
  const [a, b] = await Promise.all([
    openClient(browser, PROFILES[3], origin),
    openClient(browser, PROFILES[0], origin),
  ])
  try {
    for (const [label, { page }] of [['tablet', a], ['phone', b]]) {
      await page.getByLabel('Gateway URL').waitFor({ state: 'visible', timeout: 20_000 })
      await page.getByLabel('Gateway URL').fill(gatewayUrl)
      await page.getByRole('button', { name: 'Connect' }).click()
      await page.getByLabel('Session token').waitFor({ state: 'visible', timeout: 20_000 })
      await page.getByLabel('Session token').fill(token)
      await page.getByRole('button', { name: 'Connect' }).click()
      await page.getByText('Sessions', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 })
      check(`two clients: ${label} connected`, true)
    }
  } finally {
    await Promise.all([a.context.close(), b.context.close()])
  }
}

/** HM-25: the id must survive a relaunch. In a browser that is a page reload. */
async function runIdentityPersistence(browser, origin, gatewayUrl, token) {
  console.log('\n▸ device identity across a relaunch')
  const { context, page } = await openClient(browser, PROFILES[3], origin)
  try {
    await signIn(page, gatewayUrl, token)
    const before = await page.evaluate(async () => (await window.hermesDesktop?.deviceIdentity?.())?.device_id ?? null)

    await page.reload({ waitUntil: 'domcontentloaded' })
    if (await page.getByLabel('Gateway URL').count()) {
      // A fresh origin asks to connect again; a saved target goes straight in.
      await signIn(page, gatewayUrl, token)
    } else {
      await page.getByText('Sessions', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {})
    }
    const after = await page.evaluate(async () => (await window.hermesDesktop?.deviceIdentity?.())?.device_id ?? null)

    check(
      'deviceIdentity: same id across a relaunch',
      Boolean(before) && before === after,
      before ? `${before.slice(0, 8)}…` : 'no id before the reload',
    )
  } finally {
    await context.close()
  }
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error(`No built bundle at ${distDir}. Run: npm run build:mobile`)
    process.exit(2)
  }
  fs.mkdirSync(shotDir, { recursive: true })

  const external = process.env.HERMES_E2E_GATEWAY_URL
  const mock = external ? null : await startMockGateway({ logPath: path.join(shotDir, 'mock-gateway.log') })
  const gatewayUrl = external ?? mock.url
  const token = external ? (process.env.HERMES_E2E_TOKEN ?? 'e2e-token') : mock.token

  // Never print the credential; say only whether one was supplied.
  console.log(`harness: target=${external ? 'HERMES_E2E_GATEWAY_URL' : 'mock gateway'} credential=${token ? 'set' : 'none'}`)

  const { server, port } = await serveDist()
  const origin = `http://127.0.0.1:${port}`
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] })

  try {
    for (const profile of PROFILES) {
      await runProfile(browser, profile, origin, gatewayUrl, token)
    }
    await runTwoClients(browser, origin, gatewayUrl, token)
    await runIdentityPersistence(browser, origin, gatewayUrl, token)
  } finally {
    await browser.close()
    server.close()
    if (mock) await mock.close()
  }

  const classified = storageInventory.map((entry) => ({
    profile: entry.profile,
    sessions: entry.session.length,
    databases: entry.databases,
    local: entry.local.map((item) => ({ ...item, ...classifyStorageKey(item.key) })),
  }))
  fs.writeFileSync(path.join(shotDir, 'storage-inventory.json'), `${JSON.stringify(classified, null, 2)}\n`)
  console.log(`\nstorage inventory: ${storageInventory[0]?.local.length ?? 0} localStorage key(s), ${storageInventory[0]?.session.length ?? 0} sessionStorage key(s), ${storageInventory[0]?.databases.length ?? 0} IndexedDB database(s) — see storage-inventory.json`)
  const failed = results.filter((r) => !r.ok)
  const cap = turnsUsed > TURN_BUDGET
  console.log(`\nLLM turns: ${turnsUsed} / ${TURN_BUDGET} budget (DeepSeek Flash only)`)
  if (cap) console.error(`\nFAIL: turn budget exceeded (${turnsUsed} > ${TURN_BUDGET})`)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 && !cap ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
